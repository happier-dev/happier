import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


const platformRef = vi.hoisted(() => ({ value: 'linux' }));
// Minimal stdio boundary fixtures: promptInput reads `isTTY` and passes stream identity to readline.
const stdinRef = vi.hoisted(() => ({ value: { isTTY: true, label: 'stdin' } as unknown as NodeJS.ReadStream }));
const stderrRef = vi.hoisted(() => ({ value: { isTTY: true, columns: 100, rows: 30 } as unknown as NodeJS.WriteStream }));
const stdoutRef = vi.hoisted(() => ({ value: { isTTY: true, label: 'stdout' } as unknown as NodeJS.WriteStream }));
const existsSyncMock = vi.hoisted(() => vi.fn(() => false));
const openSyncMock = vi.hoisted(() => vi.fn<(...args: Parameters<typeof import('node:fs').openSync>) => number>(() => { throw new Error('No controlling terminal'); }));
const closeSyncMock = vi.hoisted(() => vi.fn());
const ttyReadStreamMock = vi.hoisted(() => vi.fn());
const ttyWriteStreamMock = vi.hoisted(() => vi.fn());
const fsWriteStreamMock = vi.hoisted(() => vi.fn());
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
        if (prop === 'stderr') return stderrRef.value;
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
    closeSync: closeSyncMock,
    createWriteStream: fsWriteStreamMock,
  };
});

vi.mock('node:tty', () => ({
  ReadStream: ttyReadStreamMock,
  WriteStream: ttyWriteStreamMock,
}));

vi.mock('node:readline', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:readline')>(),
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
  it('settles a prompt after the private stdin pipe has already ended', async () => {
    platformRef.value = 'win32';
    const input = new PassThrough();
    input.end('disposable');
    for await (const chunk of input) { void chunk; }
    stdinRef.value = input as unknown as NodeJS.ReadStream;
    stdoutRef.value = new PassThrough() as unknown as NodeJS.WriteStream;
    const readline = await vi.importActual<typeof import('node:readline')>('node:readline');
    createInterfaceMock.mockImplementation(readline.createInterface);
    const { promptInput } = await import('./promptInput');
    const controller = new AbortController();
    let outcome = 'pending';
    const pending = promptInput('Approve?', { signal: controller.signal }).then(
      () => { outcome = 'answered'; },
      error => { outcome = error.name; },
    );
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(outcome).toBe('AbortError');
    } finally { controller.abort(); await pending; }
  });
  it('adapts arrow and Escape keypresses through the same readline prompt lifecycle', async () => {
    const input = Object.assign(new EventEmitter(), { isTTY: true, label: 'stdin' });
    stdinRef.value = input as unknown as NodeJS.ReadStream;
    stdoutRef.value = Object.assign(new PassThrough(), { isTTY: true, columns: 92, rows: 24 }) as unknown as NodeJS.WriteStream;
    const onMove = vi.fn();
    const onToggle = vi.fn();
    const rl = Object.assign(new EventEmitter(), {
      question: vi.fn(),
      setPrompt: vi.fn(),
      prompt: vi.fn(),
      getCursorPos: vi.fn(() => ({ cols: 0, rows: 3 })),
      write: vi.fn(),
      close: vi.fn(),
    });
    createInterfaceMock.mockReturnValue(rl);
    const { promptInput } = await import('./promptInput');
    const render = vi.fn(() => 'moved menu\nChoose ');
    const pending = promptInput('menu\nChoose ', {
      animation: {
        animate: false,
        render,
        onMove,
        onToggle,
        answerOnEmpty: () => 'b',
      },
    });
    await vi.waitFor(() => expect(rl.question).toHaveBeenCalled());
    input.emit('keypress', '', { name: 'down' });
    expect(onMove).toHaveBeenCalledWith(1);
    expect(render).toHaveBeenCalledWith(0);
    expect(rl.setPrompt).toHaveBeenCalledWith('moved menu\nChoose ');
    input.emit('keypress', ' ', { name: 'space' });
    expect(onToggle).toHaveBeenCalledOnce();
    expect(rl.write).toHaveBeenCalledWith(null, { ctrl: true, name: 'u' });
    (stdoutRef.value as NodeJS.WriteStream & { columns: number }).columns = 80;
    input.emit('keypress', '', { name: 'up' });
    expect(onMove).toHaveBeenCalledTimes(1);
    input.emit('keypress', '', { name: 'escape' });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(input.listenerCount('keypress')).toBe(0);
  });


  it('lets the multi-select choose multiple ids or explicit skip through the real static prompt boundary', async () => {
    stdinRef.value = { isTTY: false, label: 'stdin-pipe' } as unknown as NodeJS.ReadStream;
    stdoutRef.value = { isTTY: false, label: 'stdout-pipe' } as unknown as NodeJS.WriteStream;
    createInterfaceMock
      .mockReturnValueOnce(createPromptRl('1,codex'))
      .mockReturnValueOnce(createPromptRl('skip'));
    const { promptMultipleSelection } = await import('./promptMultipleChoice');
    const options = [
      { id: 'claude', label: 'Claude Code' },
      { id: 'codex', label: 'Codex' },
      { id: 'skip', label: 'Skip for now', kind: 'skip' as const },
    ];

    await expect(promptMultipleSelection('Choose agents', options)).resolves.toEqual(['claude', 'codex']);
    await expect(promptMultipleSelection('Choose agents', options)).resolves.toEqual([]);
  });


  beforeEach(() => {
    stdoutRef.value = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.WriteStream;
  });
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    platformRef.value = 'linux';
    stdinRef.value = { isTTY: true, label: 'stdin' } as unknown as NodeJS.ReadStream;
    stdoutRef.value = { isTTY: true, label: 'stdout' } as unknown as NodeJS.WriteStream;
    existsSyncMock.mockReturnValue(false);
    openSyncMock.mockReset().mockImplementation(() => { throw new Error('No controlling terminal'); });
    createInterfaceMock.mockReset();
    ttyReadStreamMock.mockReset();
    ttyWriteStreamMock.mockReset();
    fsWriteStreamMock.mockReset();
  });

  it('uses process stdio when stdin is piped and no controlling terminal can be opened', async () => {
    stdinRef.value = { isTTY: false, label: 'stdin-pipe' } as unknown as NodeJS.ReadStream;
    stdoutRef.value = { isTTY: true, label: 'stdout-tty' } as unknown as NodeJS.WriteStream;
    existsSyncMock.mockReturnValue(true);
    const rl = createPromptRl('piped value');
    createInterfaceMock.mockReturnValue(rl);

    const { promptInput } = await import('./promptInput');
    await expect(promptInput('Prompt: ')).resolves.toBe('piped value');

    expect(openSyncMock).toHaveBeenCalledWith('/dev/tty', 'r+');
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
    stdoutRef.value.isTTY = false;
    openSyncMock.mockReturnValueOnce(39).mockReturnValueOnce(40).mockReturnValueOnce(41);
    ttyReadStreamMock.mockReturnValue(input);
    fsWriteStreamMock.mockReturnValue(output);
    const rl = createPromptRl('typed value');
    createInterfaceMock.mockReturnValue(rl);
    const inputDestroy = vi.spyOn(input, 'destroy');
    const outputDestroy = vi.spyOn(output, 'destroy');
    const outputEnd = vi.spyOn(output, 'end');

    const { promptInput } = await import('./promptInput');
    await expect(promptInput('Prompt: ')).resolves.toBe('typed value');

    expect(openSyncMock).toHaveBeenNthCalledWith(1, '/dev/tty', 'r+');
    expect(openSyncMock).toHaveBeenNthCalledWith(2, '/dev/tty', 'r+');
    expect(openSyncMock).toHaveBeenNthCalledWith(3, '/dev/tty', 'r+');
    expect(closeSyncMock).toHaveBeenCalledWith(39);
    expect(ttyReadStreamMock).toHaveBeenCalledWith(40);
    expect(fsWriteStreamMock).toHaveBeenCalledWith('/dev/tty', { fd: 41, autoClose: true });
    expect(createInterfaceMock).toHaveBeenCalledWith({ input, output, terminal: true });
    expect(rl.close).toHaveBeenCalledTimes(1);
    expect(outputEnd).toHaveBeenCalledTimes(1);
    expect(outputEnd.mock.invocationCallOrder[0]).toBeLessThan(outputDestroy.mock.invocationCallOrder[0] ?? 0);
    expect(inputDestroy).toHaveBeenCalledTimes(1);
    expect(outputDestroy).toHaveBeenCalledTimes(1);
  });

  it('animates a /dev/tty prompt, moves on arrow keys and answers Enter with the highlighted choice', async () => {
    vi.useFakeTimers();
    try {
      platformRef.value = 'linux';
      existsSyncMock.mockReturnValue(true);
      const input = new PassThrough();
      const output = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
      stdoutRef.value.isTTY = false;
      openSyncMock.mockReturnValueOnce(39).mockReturnValueOnce(40).mockReturnValueOnce(41);
      ttyReadStreamMock.mockReturnValue(input);
      fsWriteStreamMock.mockReturnValue(output);
      let answer: ((value: string) => void) | null = null;
      const rl = Object.assign(new EventEmitter(), {
        question: vi.fn((_prompt: string, resolve: (value: string) => void) => { answer = resolve; }),
        close: vi.fn(),
        setPrompt: vi.fn(),
        prompt: vi.fn(),
        getCursorPos: () => ({ rows: 0, cols: 0 }),
      });
      createInterfaceMock.mockReturnValue(rl);
      const moves: number[] = [];

      const { promptInput } = await import('./promptInput');
      const pending = promptInput('Choose: ', {
        animation: {
          intervalMs: 50,
          render: (seconds) => `frame ${seconds.toFixed(2)}`,
          onMove: (delta) => moves.push(delta),
          answerOnEmpty: () => 'b',
        },
      });
      await vi.advanceTimersByTimeAsync(120);
      expect(rl.setPrompt).toHaveBeenCalledWith(expect.stringMatching(/^frame /u));
      input.emit('keypress', '', { name: 'down' });
      expect(moves).toEqual([1]);
      answer!('');
      await expect(pending).resolves.toBe('b');
      expect(input.listenerCount('keypress')).toBe(0);
      const redraws = rl.setPrompt.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(rl.setPrompt.mock.calls).toHaveLength(redraws);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([true, false])('reads fresh controlling-terminal input through real readline with terminal stdout=%s when fresh TTY output is unsupported', async (stdoutIsTTY) => {
    const actual = await vi.importActual<typeof import('node:readline')>('node:readline');
    createInterfaceMock.mockImplementation(actual.createInterface);
    platformRef.value = 'darwin';
    existsSyncMock.mockReturnValue(true);
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const stdout = Object.assign(new PassThrough(), { isTTY: stdoutIsTTY, columns: 100, rows: 30 });
    const ownedOutput = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
    fsWriteStreamMock.mockReturnValue(ownedOutput);
    stdinRef.value = stdin as unknown as NodeJS.ReadStream;
    stdoutRef.value = stdout as unknown as NodeJS.WriteStream;
    if (!stdoutIsTTY) openSyncMock.mockReturnValueOnce(39);
    openSyncMock.mockReturnValueOnce(40);
    if (!stdoutIsTTY) openSyncMock.mockReturnValueOnce(41);
    ttyReadStreamMock.mockReturnValue(input);
    ttyWriteStreamMock.mockImplementation(() => { throw Object.assign(new Error('Unsupported TTY output'), { code: 'EINVAL' }); });
    const { promptInput } = await import('./promptInput');
    let outcome: string | undefined;
    const pending = promptInput('Prompt: ').then((value) => { outcome = value; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      input.write('from-controlling-terminal\n');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(outcome).toBe('from-controlling-terminal');
      expect(input.destroyed).toBe(true);
      expect(stdin.destroyed).toBe(false);
      expect(stdout.destroyed).toBe(false);
      expect(stdout.writableEnded).toBe(false);
      if (!stdoutIsTTY) expect(ownedOutput.destroyed).toBe(true);
    } finally {
      stdin.write('cleanup\n');
      input.write('cleanup\n');
      await pending;
      stdin.destroy();
      stdout.destroy();
      ownedOutput.destroy();
      input.destroy();
    }
  });

  it('aborts a closed animated /dev/tty prompt and releases its redraw listeners', async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
    stdoutRef.value.isTTY = false;
    existsSyncMock.mockReturnValue(true);
    openSyncMock.mockReturnValueOnce(39).mockReturnValueOnce(40).mockReturnValueOnce(41);
    ttyReadStreamMock.mockReturnValue(input);
    fsWriteStreamMock.mockReturnValue(output);
    const rl = Object.assign(new EventEmitter(), {
      question: vi.fn(), close: vi.fn(), setPrompt: vi.fn(), prompt: vi.fn(),
      getCursorPos: () => ({ rows: 0, cols: 0 }),
    });
    createInterfaceMock.mockReturnValue(rl);
    const signals = process.listenerCount('SIGWINCH');
    try {
      const { promptInput } = await import('./promptInput');
      const pending = promptInput('Choose: ', { animation: { intervalMs: 50, render: () => 'frame' } });
      const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      rl.emit('close');
      await rejection;
      const redraws = rl.setPrompt.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(rl.setPrompt.mock.calls).toHaveLength(redraws);
      expect(input.listenerCount('keypress')).toBe(0);
      expect(output.listenerCount('resize')).toBe(0);
      expect(stdoutRef.value.listenerCount('resize')).toBe(0);
      expect(process.listenerCount('SIGWINCH')).toBe(signals);
      expect(rl.listenerCount('close')).toBe(0);
      expect(input.destroyed).toBe(true);
      expect(output.destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['signal', 'output', 'stdout', 'unavailable geometry'] as const)('stops unsafe /dev/tty redraws for %s and still accepts an answer', async (source) => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
    stdoutRef.value.isTTY = false;
    existsSyncMock.mockReturnValue(true);
    openSyncMock.mockReturnValueOnce(39).mockReturnValueOnce(40).mockReturnValueOnce(41);
    ttyReadStreamMock.mockReturnValue(input);
    fsWriteStreamMock.mockReturnValue(output);
    let answer!: (value: string) => void;
    const rl = Object.assign(new EventEmitter(), {
      question: vi.fn((_prompt: string, resolve: (value: string) => void) => { answer = resolve; }),
      close: vi.fn(), setPrompt: vi.fn(), prompt: vi.fn(),
      getCursorPos: () => ({ rows: 0, cols: 0 }),
    });
    createInterfaceMock.mockReturnValue(rl);
    const moves: number[] = [];
    const signals = process.listenerCount('SIGWINCH');
    if (source === 'unavailable geometry') stderrRef.value.isTTY = false;
    try {
      const { promptInput } = await import('./promptInput');
      const pending = promptInput('Choose: ', { animation: {
        intervalMs: 50, render: () => 'frame', onMove: (delta) => moves.push(delta),
      } });
      await vi.advanceTimersByTimeAsync(100);
      if (source === 'unavailable geometry') expect(rl.setPrompt).not.toHaveBeenCalled();
      else expect(rl.setPrompt.mock.calls.length).toBeGreaterThan(0);
      if (source === 'signal') process.emit('SIGWINCH');
      else if (source === 'output') output.emit('resize');
      else if (source === 'stdout') stdoutRef.value.emit('resize');
      const redraws = rl.setPrompt.mock.calls.length;
      input.emit('keypress', '', { name: 'down' });
      await vi.advanceTimersByTimeAsync(500);
      expect(rl.setPrompt.mock.calls).toHaveLength(redraws);
      expect(moves).toEqual([]);
      answer('typed alias');
      await expect(pending).resolves.toBe('typed alias');
      expect(input.listenerCount('keypress')).toBe(0);
      expect(output.listenerCount('resize')).toBe(0);
      expect(stdoutRef.value.listenerCount('resize')).toBe(0);
      expect(process.listenerCount('SIGWINCH')).toBe(signals);
    } finally {
      stderrRef.value.isTTY = true;
      vi.useRealTimers();
    }
  });

  it('keeps terminal raw input for a secret when Windows stdout is redirected', async () => {
    const actual = await vi.importActual<typeof import('node:readline')>('node:readline');
    createInterfaceMock.mockImplementation(actual.createInterface);
    const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(enabled: boolean) { this.isRaw = enabled; return this; } });
    const output = Object.assign(new PassThrough(), { isTTY: false });
    platformRef.value = 'win32';
    stdinRef.value = input as unknown as NodeJS.ReadStream;
    stdoutRef.value = output as unknown as NodeJS.WriteStream;
    let outcome: string | undefined;
    const { promptSecretInput } = await import('./promptInput');
    const pending = promptSecretInput('Credential: ').then((value) => { outcome = value; });
    try {
      expect(input.isRaw).toBe(true);
      input.write('entered-secret\n');
      await pending;
      expect(outcome).toBe('entered-secret');
      expect(input.isRaw).toBe(false);
      expect(input.destroyed).toBe(false);
      expect(output.destroyed).toBe(false);
    } finally {
      input.write('cleanup\n');
      await pending;
      input.destroy(); output.destroy();

    }
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

  it('releases an aborted prompt before a following prompt can accept a late answer', async () => {
    stdinRef.value = { isTTY: false, label: 'stdin-pipe' } as unknown as NodeJS.ReadStream;
    const controller = new AbortController();
    let firstAnswer: ((value: string) => void) | undefined;
    let secondAnswer: ((value: string) => void) | undefined;
    const firstRl = new EventEmitter() as EventEmitter & {
      question: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
    firstRl.question = vi.fn((_prompt: string, resolve: (value: string) => void) => {
      firstAnswer = resolve;
    });
    firstRl.close = vi.fn();
    const secondRl = new EventEmitter() as EventEmitter & {
      question: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
    secondRl.question = vi.fn((_prompt: string, resolve: (value: string) => void) => {
      secondAnswer = resolve;
    });
    secondRl.close = vi.fn();
    createInterfaceMock.mockReturnValueOnce(firstRl).mockReturnValueOnce(secondRl);

    const { promptInput } = await import('./promptInput');
    const first = promptInput('First: ', { signal: controller.signal });
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = promptInput('Second: ');
    if (!firstAnswer || !secondAnswer) throw new Error('Expected both readline callbacks');

    firstAnswer('late answer');
    await Promise.resolve();
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    secondAnswer('second answer');
    await expect(second).resolves.toBe('second answer');
    expect(firstRl.close).toHaveBeenCalledTimes(1);
    expect(secondRl.close).toHaveBeenCalledTimes(1);
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
    stdoutRef.value.isTTY = false;
    openSyncMock.mockReturnValueOnce(39).mockReturnValueOnce(40).mockReturnValueOnce(41);
    ttyReadStreamMock.mockReturnValue(input);
    fsWriteStreamMock.mockReturnValue(output);
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
    stdoutRef.value.isTTY = false;
    openSyncMock.mockReturnValueOnce(39).mockReturnValueOnce(40).mockReturnValueOnce(41);
    ttyReadStreamMock.mockReturnValue(input);
    fsWriteStreamMock.mockReturnValue(output);
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

describe('resolveInteractiveTerminal', () => {
    it('is interactive when stdin and stdout are both TTYs', async () => {
        const { resolveInteractiveTerminal } = await import('./promptInput');
        const hasControllingTty = vi.fn(() => false);

        expect(resolveInteractiveTerminal({
            stdinIsTty: true,
            stdoutIsTty: true,
            platform: 'darwin',
            hasControllingTty,
        })).toBe(true);

        // The cheap check answers it; no need to probe the device.
        expect(hasControllingTty).not.toHaveBeenCalled();
    });

    it('is interactive when stdin is a spent pipe but a controlling terminal is attached', async () => {
        const { resolveInteractiveTerminal } = await import('./promptInput');
        // This is the `curl -fsSL … | bash -s -- --run <cmd>` case: the installer
        // hands the CLI an exhausted pipe on stdin, but the user is still sitting
        // at a terminal. `promptInput` already prompts through a freshly-opened
        // /dev/tty here, so refusing to prompt at all is the bug.
        expect(resolveInteractiveTerminal({
            stdinIsTty: false,
            stdoutIsTty: true,
            platform: 'linux',
            hasControllingTty: () => true,
        })).toBe(true);
    });

    it('is interactive when stdout is redirected but a controlling terminal is attached', async () => {
        const { resolveInteractiveTerminal } = await import('./promptInput');
        expect(resolveInteractiveTerminal({
            stdinIsTty: true,
            stdoutIsTty: false,
            platform: 'darwin',
            hasControllingTty: () => true,
        })).toBe(true);
    });

    it('is not interactive when there is no TTY and no controlling terminal', async () => {
        const { resolveInteractiveTerminal } = await import('./promptInput');
        // CI: /dev/tty may exist as a device node but cannot be opened.
        expect(resolveInteractiveTerminal({
            stdinIsTty: false,
            stdoutIsTty: false,
            platform: 'linux',
            hasControllingTty: () => false,
        })).toBe(false);
    });

    it('does not probe for a controlling terminal on Windows', async () => {
        const { resolveInteractiveTerminal } = await import('./promptInput');
        const hasControllingTty = vi.fn(() => true);

        expect(resolveInteractiveTerminal({
            stdinIsTty: false,
            stdoutIsTty: true,
            platform: 'win32',
            hasControllingTty,
        })).toBe(false);
        expect(hasControllingTty).not.toHaveBeenCalled();
    });
});
