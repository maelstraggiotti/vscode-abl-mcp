import * as assert from "assert";
import * as sinon from "sinon";
import * as proxyquireLib from "proxyquire";

// Configure proxyquire
const proxyquire = proxyquireLib.noPreserveCache().noCallThru();

// Stand-in for vscode.LanguageModelTextPart so instanceof checks work
class FakeTextPart {
  constructor(public readonly value: string) {}
}

type RegisteredTool = {
  config: { description: string; inputSchema: object };
  handler: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
};

suite("ABLUnit Bridge Tools Test Suite", () => {
  let fakeVscode: any;
  let getExtensionStub: sinon.SinonStub;
  let invokeToolStub: sinon.SinonStub;
  let tools: Map<string, RegisteredTool>;

  function loadAndRegister() {
    const ablUnitModule = proxyquire("../tools/ablunit", {
      vscode: fakeVscode,
      "../utils/logger": {
        logger: {
          info: sinon.spy(),
          warn: sinon.spy(),
          error: sinon.spy(),
          debug: sinon.spy(),
        },
      },
    });

    tools = new Map();
    const fakeServer = {
      registerTool: (name: string, config: any, handler: any) => {
        tools.set(name, { config, handler });
      },
    };
    ablUnitModule.registerAblUnitTools(fakeServer);
  }

  setup(() => {
    getExtensionStub = sinon.stub().returns({ isActive: true });
    invokeToolStub = sinon.stub().resolves({
      content: [new FakeTextPart("9 tests, 5 passed, 3 failures, 1 errors, 0 skipped")],
    });

    fakeVscode = {
      LanguageModelTextPart: FakeTextPart,
      extensions: { getExtension: getExtensionStub },
      lm: { tools: [], invokeTool: invokeToolStub },
    };

    loadAndRegister();
  });

  teardown(() => {
    sinon.restore();
  });

  test("Registers the two ABLUnit bridge tools", () => {
    assert.deepStrictEqual([...tools.keys()].sort(), [
      "list_tests_abl",
      "run_tests_abl",
    ]);
  });

  test("run_tests_abl forwards path and testName to ablunit_run_tests", async () => {
    const result = await tools
      .get("run_tests_abl")!
      .handler({ path: "src/testSuite.cls", testName: "testMethod" });

    assert.strictEqual(result.isError, undefined, "Expected success result");
    assert.strictEqual(
      result.content[0].text,
      "9 tests, 5 passed, 3 failures, 1 errors, 0 skipped"
    );

    assert.strictEqual(getExtensionStub.firstCall.args[0], "kherring.ablunit-test-runner");
    const [toolName, options] = invokeToolStub.firstCall.args;
    assert.strictEqual(toolName, "ablunit_run_tests");
    assert.deepStrictEqual(options.input, {
      fileUri: "src/testSuite.cls",
      testName: "testMethod",
    });
  });

  test("run_tests_abl without arguments sends an empty input (run all tests)", async () => {
    await tools.get("run_tests_abl")!.handler({});

    const [toolName, options] = invokeToolStub.firstCall.args;
    assert.strictEqual(toolName, "ablunit_run_tests");
    assert.deepStrictEqual(options.input, {});
  });

  test("list_tests_abl forwards path to ablunit_list_tests", async () => {
    await tools.get("list_tests_abl")!.handler({ path: "src/testSuite.cls" });

    const [toolName, options] = invokeToolStub.firstCall.args;
    assert.strictEqual(toolName, "ablunit_list_tests");
    assert.deepStrictEqual(options.input, { fileUri: "src/testSuite.cls" });
  });

  test("Activates the ABLUnit extension when it is not active yet", async () => {
    const activate = sinon.stub().resolves();
    getExtensionStub.returns({ isActive: false, activate });

    await tools.get("list_tests_abl")!.handler({});

    assert.strictEqual(activate.calledOnce, true);
    assert.strictEqual(invokeToolStub.calledOnce, true);
  });

  test("Returns an error when the ABLUnit extension is not installed", async () => {
    getExtensionStub.returns(undefined);

    const result = await tools.get("run_tests_abl")!.handler({});

    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /kherring\.ablunit-test-runner.*not installed/);
    assert.strictEqual(invokeToolStub.called, false);
  });

  test("Reports the detected version when the LM tool is not contributed", async () => {
    getExtensionStub.returns({ isActive: true, packageJSON: { version: "1.4.43" } });
    invokeToolStub.rejects(new Error("Tool ablunit_run_tests was not contributed"));

    const result = await tools.get("run_tests_abl")!.handler({});

    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /was not contributed/);
    assert.match(result.content[0].text, /Detected version: 1\.4\.43/);
  });
});
