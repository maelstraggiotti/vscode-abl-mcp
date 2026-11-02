import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "../utils/logger";

const ABLUNIT_EXTENSION_ID = "kherring.ablunit-test-runner";

/**
 * Invokes a Language Model tool contributed by the ABLUnit Test Runner
 * extension (kherring.ablunit-test-runner) and maps its text output onto
 * an MCP CallToolResult.
 *
 * The path is forwarded as-is: the ABLUnit tools resolve workspace-relative
 * paths, absolute paths and URIs themselves.
 */
async function runAblUnitTool(
  mcpToolName: string,
  lmToolName: string,
  input: Record<string, unknown>
): Promise<CallToolResult> {
  logger.info(`[${mcpToolName}] Tool called with input: ${JSON.stringify(input)}`);

  try {
    const extension = vscode.extensions.getExtension(ABLUNIT_EXTENSION_ID);
    if (!extension) {
      throw new Error(
        `The ABLUnit Test Runner extension (${ABLUNIT_EXTENSION_ID}) is not installed. ` +
          `Install a version that contributes the ablunit_list_tests/ablunit_run_tests Language Model tools to use the ABLUnit tools.`
      );
    }
    if (!extension.isActive) {
      logger.info(`[${mcpToolName}] Activating ${ABLUNIT_EXTENSION_ID}`);
      await extension.activate();
    }

    // Do not pre-check vscode.lm.tools: its listing is not reliable for
    // tools registered by other extensions. Invoke directly.
    let result: vscode.LanguageModelToolResult;
    try {
      result = await vscode.lm.invokeTool(lmToolName, {
        input,
        toolInvocationToken: undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const version = extension.packageJSON?.version ?? "unknown";
      throw new Error(
        `Invoking language model tool "${lmToolName}" failed: ${message}. ` +
          `The ABLUnit tools require a version of ${ABLUNIT_EXTENSION_ID} that contributes Language Model tools. ` +
          `Detected version: ${version} (active: ${extension.isActive}).`
      );
    }

    const text = result.content
      .filter(
        (part): part is vscode.LanguageModelTextPart =>
          part instanceof vscode.LanguageModelTextPart
      )
      .map((part) => part.value)
      .join("\n");

    logger.info(`[${mcpToolName}] ${lmToolName} returned ${text.length} chars`);
    return {
      content: [{ type: "text", text }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[${mcpToolName}] Error: ${errorMessage}`);
    return {
      content: [{ type: "text", text: errorMessage }],
      isError: true,
    };
  }
}

/** Drops undefined properties so optional arguments are omitted from the LM tool input. */
function definedOnly(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  );
}

/**
 * Registers MCP tools for ABLUnit tests. These bridge to the Language Model
 * tools contributed by the kherring.ablunit-test-runner extension
 * (ablunit_list_tests, ablunit_run_tests), which discover and run the
 * tests with the same configuration as its Test Explorer integration.
 * @param server MCP server instance
 */
export function registerAblUnitTools(server: McpServer): void {
  server.registerTool(
    "list_tests_abl",
    {
      description: `Lists the OpenEdge ABLUnit tests (test classes, test programs, test suites and their test methods/procedures) discovered by the ABLUnit Test Runner extension.

        WHEN TO USE: To find which tests exist and their exact names before running them with run_tests_abl.
        If path is omitted, every test in the workspace is listed.`,
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Test file (.cls or .p) to list the tests of (workspace-relative or absolute). If omitted, all tests in the workspace are listed."
          ),
      },
    },
    async ({ path: filePath }): Promise<CallToolResult> =>
      runAblUnitTool("list_tests_abl", "ablunit_list_tests", definedOnly({
        fileUri: filePath,
      }))
  );

  server.registerTool(
    "run_tests_abl",
    {
      description: `Runs OpenEdge ABLUnit tests with the ABLUnit Test Runner extension and returns the totals plus, for every test that did not pass, its failure message, expected/actual values and call stack. Compile errors and ABLUnit runtime errors are reported as well.

        WHEN TO USE: After changing ABL code, to check that its unit tests still pass.
        Tests run against the files saved on disk, using .vscode/ablunit-test-profile.json and openedge-project.json.
        Omit path to run every test in the workspace (can take a long time); pass path to run one file; pass path and testName to run a single test.`,
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Test file (.cls or .p) to run (workspace-relative or absolute). If omitted, all tests in the workspace are run."
          ),
        testName: z
          .string()
          .optional()
          .describe(
            "Name of a single test method or procedure inside path, as returned by list_tests_abl. Case-insensitive. Requires path."
          ),
      },
    },
    async ({ path: filePath, testName }): Promise<CallToolResult> =>
      runAblUnitTool("run_tests_abl", "ablunit_run_tests", definedOnly({
        fileUri: filePath,
        testName,
      }))
  );
}
