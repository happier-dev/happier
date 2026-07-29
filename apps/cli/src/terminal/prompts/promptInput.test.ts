import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

const platformRef = vi.hoisted(() => ({ value: 'linux' }));
// Minimal stdio boundary fixtures: promptInput reads `isTTY` and passes stream identity to readline.
const stdinRef = vi.hoisted(() => ({ value: { isTTY: true, label: 'stdin' } as unknown as NodeJS.ReadStream }));
const stdoutRef = vi.hoisted(() => ({ value: { isTTY: true, label: 'stdout' } as unknown as NodeJS.WriteStream }));
const existsSyncMock = vi.hoisted(() => vi.fn(() => false));
const openSyncMock = vi.hoisted(() => vi.fn());
const ttyReadStreamMock = vi.hoisted(() => vi.fn());
const ttyWriteStreamMock = vi.hoisted(() => vi.fn());
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
    openSync: openSyncMock,
  };
});

vi.mock('node:tty', () => ({
  ReadStream: ttyReadStreamMock,
  WriteStream: ttyWriteStreamMock,
}));

vi.mock('node:readline', () => ({
  createInterface: createInterfaceMock,
}));

function createPromptRl(answer: string, onQuestion?: () => void) {
  const rl = new EventEmitter() as EventEmitter & {
    question: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  rl.question = vi.fn((_prompt: string, resolve: (value: string) => void) => {
    onQuestion?.();
    resolve(answer);
  });
  rl.close = vi.fn();
  return rl;
}

describe('promptInput', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    platformRef.value = 'linux';
    stdinRef.value = { isTTY: true, label: 'stdin' } as unknown as NodeJS.ReadStream;
    stdoutRef.value = { isTTY: true, label: 'stdout' } as unknown as NodeJS.WriteStream;
    existsSyncMock.mockReturnValue(false);
    openSyncMock.mockReset();
    ttyReadStreamMock.mockReset();
    ttyWriteStreamMock.mockReset();
  });

  it('uses process stdio when stdin is piped even if /dev/tty exists', async () => {
    stdinRef.value = { isTTY: false, label: 'stdin-pipe' } as unknown as NodeJS.ReadStream;
    stdoutRef.value = { isTTY: true, label: 'stdout-tty' } as unknown as NodeJS.WriteStream;
    existsSyncMock.mockReturnValue(true);
    const rl = createPromptRl('piped value');
    createInterfaceMock.mockReturnValue(rl);

    const { promptInput } = await import('./promptInput');
    await expect(promptInput('Prompt: ')).resolves.toBe('piped value');

    expect(openSyncMock).not.toHaveBeenCalled();
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
    openSyncMock.mockReturnValueOnce(40).mockReturnValueOnce(41);
    ttyReadStreamMock.mockReturnValue(input);
    ttyWriteStreamMock.mockReturnValue(output);
    const rl = createPromptRl('typed value');
    createInterfaceMock.mockReturnValue(rl);
    const inputDestroy = vi.spyOn(input, 'destroy');
    const outputDestroy = vi.spyOn(output, 'destroy');
    const outputEnd = vi.spyOn(output, 'end');

    const { promptInput } = await import('./promptInput');
    await expect(promptInput('Prompt: ')).resolves.toBe('typed value');

    expect(openSyncMock).toHaveBeenNthCalledWith(1, '/dev/tty', 'r+');
    expect(openSyncMock).toHaveBeenNthCalledWith(2, '/dev/tty', 'r+');
    expect(ttyReadStreamMock).toHaveBeenCalledWith(40);
    expect(ttyWriteStreamMock).toHaveBeenCalledWith(41);
    expect(createInterfaceMock).toHaveBeenCalledWith({ input, output, terminal: true });
    expect(rl.close).toHaveBeenCalledTimes(1);
    expect(outputEnd).toHaveBeenCalledTimes(1);
    expect(outputEnd.mock.invocationCallOrder[0]).toBeLessThan(outputDestroy.mock.invocationCallOrder[0] ?? 0);
    expect(inputDestroy).toHaveBeenCalledTimes(1);
    expect(outputDestroy).toHaveBeenCalledTimes(1);
  });

  it('falls back to process stdio when /dev/tty cannot be opened', async () => {
    platformRef.value = 'linux';
    existsSyncMock.mockReturnValue(true);
    openSyncMock.mockImplementation(() => {
      throw new Error('no tty');
    });
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
    const rl = Object.assign(new EventEmitter(), {
      question: vi.fn((prompt: string, resolve: (value: string) => void) => {
        expect(prompt).toBe('');
        resolve('secret value');
      }),
      close: vi.fn(),
      _writeToOutput: vi.fn(),
    });
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

    expect(openSyncMock).not.toHaveBeenCalled();
    expect(createInterfaceMock).toHaveBeenCalledWith({
      input: stdinRef.value,
      output: stdoutRef.value,
    });
  });

  it('closes readline and rejects when an active prompt is aborted', async () => {
    stdinRef.value = { isTTY: false, label: 'stdin-pipe' } as unknown as NodeJS.ReadStream;
    const controller = new AbortController();
    const rl = Object.assign(new EventEmitter(), {
      question: vi.fn((_prompt: string, resolve: (value: string) => void) => {
        controller.abort();
        resolve('late answer');
      }),
      close: vi.fn(),
    });
    createInterfaceMock.mockReturnValue(rl);

    const { promptInput } = await import('./promptInput');
    await expect(promptInput('Prompt: ', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(rl.close).toHaveBeenCalledTimes(1);
  });

  it('treats readline SIGINT as one aborted process-stdio prompt and ignores a late answer', async () => {
    stdinRef.value = { isTTY: false, label: 'stdin-pipe' } as unknown as NodeJS.ReadStream;
    let answer!: (value: string) => void;
    const rl = new EventEmitter() as EventEmitter & {
      question: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
    rl.question = vi.fn((_prompt: string, resolve: (value: string) => void) => {
      answer = resolve;
      rl.emit('SIGINT');
    });
    rl.close = vi.fn();
    createInterfaceMock.mockReturnValue(rl);

    const { promptInput } = await import('./promptInput');
    const pending = promptInput('Prompt: ');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    answer('late answer');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    expect(rl.close).toHaveBeenCalledTimes(1);
    expect(rl.listenerCount('SIGINT')).toBe(0);
  });

  it('treats readline SIGINT as one aborted /dev/tty prompt and closes every owned resource', async () => {
    platformRef.value = 'linux';
    existsSyncMock.mockReturnValue(true);
    const input = new PassThrough();
    const output = new PassThrough();
    openSyncMock.mockReturnValueOnce(40).mockReturnValueOnce(41);
    ttyReadStreamMock.mockReturnValue(input);
    ttyWriteStreamMock.mockReturnValue(output);
    let answer!: (value: string) => void;
    const rl = new EventEmitter() as EventEmitter & {
      question: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
    rl.question = vi.fn((_prompt: string, resolve: (value: string) => void) => {
      answer = resolve;
      rl.emit('SIGINT');
    });
    rl.close = vi.fn();
    createInterfaceMock.mockReturnValue(rl);
    const inputDestroy = vi.spyOn(input, 'destroy');
    const outputDestroy = vi.spyOn(output, 'destroy');
    const outputEnd = vi.spyOn(output, 'end');

    const { promptInput } = await import('./promptInput');
    const pending = promptInput('Prompt: ');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    answer('late answer');
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    expect(rl.close).toHaveBeenCalledTimes(1);
    expect(rl.listenerCount('SIGINT')).toBe(0);
    expect(inputDestroy).toHaveBeenCalledTimes(1);
    expect(inputDestroy.mock.invocationCallOrder[0]).toBeLessThan(outputEnd.mock.invocationCallOrder[0] ?? 0);
    expect(outputDestroy).toHaveBeenCalledTimes(1);
  });

  it('closes /dev/tty resources when readline question throws', async () => {
    platformRef.value = 'linux';
    existsSyncMock.mockReturnValue(true);
    const input = new PassThrough();
    const output = new PassThrough();
    openSyncMock.mockReturnValueOnce(40).mockReturnValueOnce(41);
    ttyReadStreamMock.mockReturnValue(input);
    ttyWriteStreamMock.mockReturnValue(output);
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
  });
});
