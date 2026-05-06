import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

const platformRef = vi.hoisted(() => ({ value: 'linux' }));
// Minimal stdio boundary fixtures: promptInput reads `isTTY` and passes stream identity to readline.
const stdinRef = vi.hoisted(() => ({ value: { isTTY: true, label: 'stdin' } as unknown as NodeJS.ReadStream }));
const stdoutRef = vi.hoisted(() => ({ value: { isTTY: true, label: 'stdout' } as unknown as NodeJS.WriteStream }));
const existsSyncMock = vi.hoisted(() => vi.fn(() => false));
const openMock = vi.hoisted(() => vi.fn());
const createInterfaceMock = vi.hoisted(() => vi.fn());

vi.mock('node:process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:process') & { default?: NodeJS.Process }>();
  return {
    ...actual,
    default: new Proxy(actual.default ?? globalThis.process, {
      get(target, prop, receiver) {
        if (prop === 'platform') return platformRef.value;
        if (prop === 'stdin') return stdinRef.value;
        if (prop === 'stdout') return stdoutRef.value;
        return Reflect.get(target, prop, receiver);
      },
    }),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: existsSyncMock,
  };
});

vi.mock('node:fs/promises', () => ({
  open: openMock,
}));

vi.mock('node:readline', () => ({
  createInterface: createInterfaceMock,
}));

function createPromptRl(answer: string, onQuestion?: () => void) {
  return {
    question: vi.fn((prompt: string, resolve: (value: string) => void) => {
      onQuestion?.();
      resolve(answer);
    }),
    close: vi.fn(),
  };
}

describe('promptInput', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    platformRef.value = 'linux';
    stdinRef.value = { isTTY: true, label: 'stdin' } as unknown as NodeJS.ReadStream;
    stdoutRef.value = { isTTY: true, label: 'stdout' } as unknown as NodeJS.WriteStream;
    existsSyncMock.mockReturnValue(false);
  });

  it('uses process stdio when stdin is piped even if /dev/tty exists', async () => {
    stdinRef.value = { isTTY: false, label: 'stdin-pipe' } as unknown as NodeJS.ReadStream;
    stdoutRef.value = { isTTY: true, label: 'stdout-tty' } as unknown as NodeJS.WriteStream;
    existsSyncMock.mockReturnValue(true);
    const rl = createPromptRl('piped value');
    createInterfaceMock.mockReturnValue(rl);

    const { promptInput } = await import('./promptInput');
    await expect(promptInput('Prompt: ')).resolves.toBe('piped value');

    expect(openMock).not.toHaveBeenCalled();
    expect(createInterfaceMock).toHaveBeenCalledWith({
      input: stdinRef.value,
      output: stdoutRef.value,
    });
    expect(rl.close).toHaveBeenCalledTimes(1);
  });

  it('opens /dev/tty on POSIX interactive terminals and closes readline streams and file handle', async () => {
    platformRef.value = 'linux';
    existsSyncMock.mockReturnValue(true);
    const input = new PassThrough();
    const output = new PassThrough();
    const handle = {
      createReadStream: vi.fn(() => input),
      createWriteStream: vi.fn(() => output),
      close: vi.fn(async () => {}),
    };
    openMock.mockResolvedValue(handle);
    const rl = createPromptRl('typed value');
    createInterfaceMock.mockReturnValue(rl);
    const inputDestroy = vi.spyOn(input, 'destroy');
    const outputDestroy = vi.spyOn(output, 'destroy');

    const { promptInput } = await import('./promptInput');
    await expect(promptInput('Prompt: ')).resolves.toBe('typed value');

    expect(openMock).toHaveBeenCalledWith('/dev/tty', 'r+');
    expect(createInterfaceMock).toHaveBeenCalledWith({ input, output, terminal: true });
    expect(rl.close).toHaveBeenCalledTimes(1);
    expect(inputDestroy).toHaveBeenCalledTimes(1);
    expect(outputDestroy).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it('falls back to process stdio when /dev/tty cannot be opened', async () => {
    platformRef.value = 'linux';
    existsSyncMock.mockReturnValue(true);
    openMock.mockRejectedValue(new Error('no tty'));
    const rl = createPromptRl('fallback value');
    createInterfaceMock.mockReturnValue(rl);

    const { promptInput } = await import('./promptInput');
    await expect(promptInput('Prompt: ')).resolves.toBe('fallback value');

    expect(createInterfaceMock).toHaveBeenCalledWith({
      input: stdinRef.value,
      output: stdoutRef.value,
    });
    expect(rl.close).toHaveBeenCalledTimes(1);
  });

  it('suppresses readline echo for secret process-stdio prompts', async () => {
    stdinRef.value = { isTTY: false, label: 'stdin-pipe' } as unknown as NodeJS.ReadStream;
    const writeSpy = vi.fn();
    stdoutRef.value = { isTTY: true, label: 'stdout-tty', write: writeSpy } as unknown as NodeJS.WriteStream;
    const rl = {
      question: vi.fn((prompt: string, resolve: (value: string) => void) => {
        expect(prompt).toBe('');
        resolve('secret value');
      }),
      close: vi.fn(),
      _writeToOutput: vi.fn(),
    };
    createInterfaceMock.mockReturnValue(rl);

    const { promptSecretInput } = await import('./promptInput');
    await expect(promptSecretInput('Secret: ')).resolves.toBe('secret value');

    expect(writeSpy).toHaveBeenNthCalledWith(1, 'Secret: ');
    expect(writeSpy).toHaveBeenNthCalledWith(2, '\n');
    expect(rl._writeToOutput).not.toHaveBeenCalled();
    expect(rl.close).toHaveBeenCalledTimes(1);
  });

  it('does not attempt /dev/tty on Windows', async () => {
    platformRef.value = 'win32';
    existsSyncMock.mockReturnValue(true);
    const rl = createPromptRl('windows value');
    createInterfaceMock.mockReturnValue(rl);

    const { promptInput } = await import('./promptInput');
    await expect(promptInput('Prompt: ')).resolves.toBe('windows value');

    expect(openMock).not.toHaveBeenCalled();
    expect(createInterfaceMock).toHaveBeenCalledWith({
      input: stdinRef.value,
      output: stdoutRef.value,
    });
  });

  it('closes /dev/tty resources when readline question throws', async () => {
    platformRef.value = 'linux';
    existsSyncMock.mockReturnValue(true);
    const input = new PassThrough();
    const output = new PassThrough();
    const handle = {
      createReadStream: vi.fn(() => input),
      createWriteStream: vi.fn(() => output),
      close: vi.fn(async () => {}),
    };
    openMock.mockResolvedValue(handle);
    const rl = new EventEmitter() as EventEmitter & {
      question: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
    rl.question = vi.fn(() => {
      throw new Error('question failed');
    });
    rl.close = vi.fn();
    createInterfaceMock.mockReturnValue(rl);
    const inputDestroy = vi.spyOn(input, 'destroy');
    const outputDestroy = vi.spyOn(output, 'destroy');

    const { promptInput } = await import('./promptInput');
    await expect(promptInput('Prompt: ')).rejects.toThrow('question failed');

    expect(rl.close).toHaveBeenCalledTimes(1);
    expect(inputDestroy).toHaveBeenCalledTimes(1);
    expect(outputDestroy).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalledTimes(1);
  });
});
