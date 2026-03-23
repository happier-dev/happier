import { describe, expect, it } from 'vitest';

describe('CLI testkit index', () => {
  it('exposes the canonical env/fs/logger/http/process helpers', async () => {
    const testkit = await import('@/testkit').catch(() => null);

    expect(testkit).not.toBeNull();
    expect(testkit?.createEnvKeyScope).toBeTypeOf('function');
    expect(testkit?.snapshotProcessEnv).toBeTypeOf('function');
    expect(testkit?.createTempDir).toBeTypeOf('function');
    expect(testkit?.createExecutableShim).toBeTypeOf('function');
    expect(testkit?.resolveSystemJavaScriptRuntimeBinary).toBeTypeOf('function');
    expect(testkit?.writePnpmNodeBridge).toBeTypeOf('function');
    expect(testkit?.captureConsoleLogAndMuteStdout).toBeTypeOf('function');
    expect(testkit?.captureConsoleText).toBeTypeOf('function');
    expect(testkit?.captureConsoleJsonOutput).toBeTypeOf('function');
    expect(testkit?.captureStdoutJsonOutput).toBeTypeOf('function');
    expect(testkit?.captureStdout).toBeTypeOf('function');
    expect(testkit?.captureStderr).toBeTypeOf('function');
    expect(testkit?.installAxiosFastifyAdapter).toBeTypeOf('function');
    expect(testkit?.reserveEphemeralPort).toBeTypeOf('function');
    expect(testkit?.spawnTestProcess).toBeTypeOf('function');
    expect(testkit?.spawnInlineNodeParentWithChild).toBeTypeOf('function');
    expect(testkit?.waitForPidInspection).toBeTypeOf('function');
    expect(testkit?.waitForProcessExit).toBeTypeOf('function');
    expect(testkit?.setStdioTtyForTest).toBeTypeOf('function');
    expect(testkit?.bindApiSessionSocketMock).toBeTypeOf('function');
    expect(testkit?.bindApiSessionSocketPairMock).toBeTypeOf('function');
    expect(testkit?.bindApiSessionSocketSequenceMock).toBeTypeOf('function');
    expect(testkit?.createApiSessionSocketStub).toBeTypeOf('function');
  });
});
