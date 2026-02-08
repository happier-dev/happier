import { vi } from 'vitest';

function applyEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

export function createEnvKeyScope(keys: readonly string[]): {
  patch: (values: Readonly<Record<string, string | undefined>>) => void;
  restore: () => void;
} {
  const baseline = Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Record<string, string | undefined>;

  return {
    patch(values: Readonly<Record<string, string | undefined>>): void {
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
        applyEnvValue(key, values[key]);
      }
    },
    restore(): void {
      for (const key of keys) {
        applyEnvValue(key, baseline[key]);
      }
    },
  };
}

export function setStdioTtyForTest(params: Readonly<{ stdin: boolean; stdout: boolean }>): () => void {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  Object.defineProperty(process.stdin, 'isTTY', { value: params.stdin, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: params.stdout, configurable: true });

  return () => {
    if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;

    if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  };
}

export function captureConsoleLogAndMuteStdout(): {
  logs: string[];
  restore: () => void;
} {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  });
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  return {
    logs,
    restore(): void {
      logSpy.mockRestore();
      writeSpy.mockRestore();
    },
  };
}
