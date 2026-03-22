import { describe, expect, it } from 'vitest';

describe('stdio helpers', () => {
  it('toggles and restores tty flags for tests', async () => {
    const processHelpers = await import('@/testkit/process/stdio').catch(() => null);

    expect(processHelpers).not.toBeNull();
    expect(processHelpers?.setStdioTtyForTest).toBeTypeOf('function');

    const originalStdin = process.stdin.isTTY;
    const originalStdout = process.stdout.isTTY;
    const restore = processHelpers!.setStdioTtyForTest({ stdin: false, stdout: false });
    try {
      expect(process.stdin.isTTY).toBe(false);
      expect(process.stdout.isTTY).toBe(false);
    } finally {
      restore();
    }
    expect(process.stdin.isTTY).toBe(originalStdin);
    expect(process.stdout.isTTY).toBe(originalStdout);
  });
});
