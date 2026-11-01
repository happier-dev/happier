import { afterEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';
import { spawn } from 'node:child_process';

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStepPrinter, runCommandLogged } from './progress';

// Observe the OS launch boundary while preserving real child execution.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

describe('createStepPrinter', () => {
  const writeSpy = vi.spyOn(process.stdout, 'write');

  afterEach(() => {
    writeSpy.mockReset();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('prints compact non-tty step lines', () => {
    writeSpy.mockImplementation(() => true);

    const printer = createStepPrinter({ enabled: true });
    printer.start('Installing');
    printer.stop('✓', 'Installing');

    const output = writeSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('- [..] Installing');
    expect(output).toContain('- [✓] Installing');
  });

  it('keeps redirected planet progress linear and free of terminal control bytes', () => {
    writeSpy.mockImplementation(() => true);
    const colorChalk = Object.create(chalk) as typeof chalk;
    colorChalk.level = 3;
    const printer = createStepPrinter({ appearance: 'planet', chalkLike: colorChalk });
    printer.start('Waiting for approval');
    printer.info('Request ended');
    printer.pause();
    const output = writeSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('Waiting for approval');
    expect(output).toContain('Request ended');
    expect(output).not.toMatch(/[\x1b\r]/u);
  });

  const withTerminal = (columns: number, run: () => void) => {
    const descriptors = [
      [process.stdout, 'isTTY', Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')],
      [process.stderr, 'isTTY', Object.getOwnPropertyDescriptor(process.stderr, 'isTTY')],
      [process.stdout, 'columns', Object.getOwnPropertyDescriptor(process.stdout, 'columns')],
      [process.stdout, 'rows', Object.getOwnPropertyDescriptor(process.stdout, 'rows')],
    ] as const;
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: columns });
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 30 });
    try {
      run();
    } finally {
      for (const [stream, key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(stream, key, descriptor);
        else Reflect.deleteProperty(stream, key);
      }
    }
  };

  it('animates a TTY step with a Braille spinner and reports how long it took', () => {
    vi.useFakeTimers();
    writeSpy.mockImplementation(() => true);
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('HAPPIER_NO_ANIMATION', '');
    withTerminal(80, () => {
      const printer = createStepPrinter({ enabled: true });
      printer.start('Installing');
      vi.advanceTimersByTime(2400);
      const spinning = writeSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(spinning).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
      expect(spinning).not.toContain('- [|]');
      printer.stop('✓', 'Installing');
      const done = String(writeSpy.mock.calls.at(-1)?.[0]);
      expect(done.replace(/\x1b\[[0-9;]*m/gu, '')).toMatch(/^✓ Installing {2}2\.4s\n$/u);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('reports how long a step took even when it completes under a longer label', () => {
    vi.useFakeTimers();
    writeSpy.mockImplementation(() => true);
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('HAPPIER_NO_ANIMATION', '');
    withTerminal(80, () => {
      const printer = createStepPrinter({ enabled: true });
      printer.start('Codex');
      vi.advanceTimersByTime(1200);
      printer.stop('✓', 'Codex (already installed)');
      const done = String(writeSpy.mock.calls.at(-1)?.[0]).replace(/\x1b\[[0-9;]*m/gu, '');
      expect(done).toMatch(/^✓ Codex \(already installed\) {2}1\.2s\n$/u);
    });
  });

  it('runs a piece of work as one step: ✓ with its outcome, x when it throws', async () => {
    writeSpy.mockImplementation(() => true);
    const printer = createStepPrinter({ enabled: true });
    await expect(printer.run('Installing Codex', async () => 'npm', (via) => `Installed Codex via ${via}`)).resolves.toBe('npm');
    const failure = new Error('offline');
    await expect(printer.run('Installing Gemini', async () => { throw failure; })).rejects.toBe(failure);
    const output = writeSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('- [..] Installing Codex\n- [✓] Installed Codex via npm\n');
    expect(output).toContain('- [..] Installing Gemini\n- [x] Installing Gemini\n');

    writeSpy.mockClear();
    await expect(createStepPrinter({ enabled: false }).run('Hidden', async () => 1)).resolves.toBe(1);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('redraws a settled, breathing planet at a calm cadence and never repeats an identical frame', () => {
    vi.useFakeTimers();
    writeSpy.mockImplementation(() => true);
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('HAPPIER_NO_ANIMATION', '');
    withTerminal(80, () => {
      const printer = createStepPrinter({ appearance: 'planet' });
      printer.start('Waiting for authentication');
      vi.advanceTimersByTime(1000);
      const whileTurning = writeSpy.mock.calls.length;
      vi.advanceTimersByTime(9000);
      const settled = writeSpy.mock.calls.length;
      vi.advanceTimersByTime(4000);
      const redrawsWhileBreathing = writeSpy.mock.calls.length - settled;
      // Smooth while it turns (about 15 fps)...
      expect(whileTurning).toBeGreaterThan(10);
      // ...then at most one redraw per 200ms: a slow breath needs no more.
      expect(redrawsWhileBreathing).toBeLessThanOrEqual(4000 / 200);
      expect(redrawsWhileBreathing).toBeGreaterThan(0);
      const frames = writeSpy.mock.calls.slice(settled).map((call) => String(call[0])).filter((frame) => frame.includes('\r\x1b[2K'));
      frames.forEach((frame, index) => { if (index > 0) expect(frame).not.toBe(frames[index - 1]); });
      printer.pause();
    });
  });

  it('keeps an ASCII spinner on consoles without Braille glyphs', () => {
    vi.useFakeTimers();
    writeSpy.mockImplementation(() => true);
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('HAPPIER_NO_ANIMATION', '');
    vi.stubEnv('WT_SESSION', '');
    vi.stubEnv('TERM_PROGRAM', '');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      withTerminal(80, () => {
        const printer = createStepPrinter({ enabled: true, appearance: 'planet' });
        printer.start('Waiting for authentication');
        vi.advanceTimersByTime(600);
        const output = writeSpy.mock.calls.map((call) => String(call[0])).join('');
        expect(output).not.toMatch(/[⠀-⣿]/u);
        expect(output).toMatch(/[|/\\-]/u);
        printer.pause();
      });
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('shows the waiting label beside the breathing planet', () => {
    vi.useFakeTimers();
    writeSpy.mockImplementation(() => true);
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('HAPPIER_NO_ANIMATION', '');
    withTerminal(80, () => {
      const printer = createStepPrinter({ appearance: 'planet' });
      printer.start('Waiting for authentication');
      vi.advanceTimersByTime(3000);
      const frame = writeSpy.mock.calls.map((call) => String(call[0])).join('').split('\n')
        .map((line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]|\r/gu, ''));
      expect(frame.some((line) => /[⠁-⣿].* Waiting for authentication/u.test(line))).toBe(true);
      printer.stop('✓', 'Waiting for authentication');
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it.each(['message', 'no-motion', 'resize', 'resize-before-pause', 'dumb', 'child-output', 'spawn-error'] as const)('respects terminal ownership and motion controls: %s', async (scenario) => {
    vi.useFakeTimers();
    writeSpy.mockImplementation(() => true);
    const outTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const errTty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    const columns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 80 });
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('HAPPIER_NO_ANIMATION', '');
    if (scenario === 'no-motion') vi.stubEnv('HAPPIER_NO_ANIMATION', '1');
    if (scenario === 'dumb') vi.stubEnv('TERM', 'dumb');
    try {
      if (scenario === 'spawn-error') {
        const directory = await mkdtemp(join(tmpdir(), 'happier-progress-'));
        try {
          await expect(runCommandLogged({
            label: 'Missing child', cmd: join(directory, 'missing-command'), args: [],
            logPath: join(directory, 'command.log'),
          })).rejects.toThrow();
          expect(vi.getTimerCount()).toBe(0);
          const writesAfterFailure = writeSpy.mock.calls.length;
          vi.advanceTimersByTime(1000);
          expect(writeSpy.mock.calls).toHaveLength(writesAfterFailure);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
        return;
      }
      if (scenario === 'child-output') {
        const spawnIndex = vi.mocked(spawn).mock.calls.length;
        const pending = runCommandLogged({
          label: 'Child command', cmd: process.execPath,
          args: ['-e', 'process.stdout.write("child output\\n")'],
          logPath: '', quiet: false,
        });
        try {
          // A real child owns inherited output until it exits.
          expect(vi.getTimerCount()).toBe(0);
          expect(vi.mocked(spawn).mock.calls[spawnIndex]?.[2]?.windowsHide).not.toBe(true);
        } finally {
          await pending;
        }
        return;
      }
      const printer = createStepPrinter({ appearance: 'planet' });
      printer.start('Waiting');
      vi.advanceTimersByTime(600);
      if (scenario === 'no-motion' || scenario === 'dumb') {
        expect(writeSpy.mock.calls).toHaveLength(1);
        expect(writeSpy.mock.calls.map((call) => String(call[0])).join('')).not.toMatch(/[\x1b\r]/u);
      } else {
        expect(writeSpy.mock.calls.length).toBeGreaterThan(1);
      }
      if (scenario === 'resize') {
        Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 35 });
        const beforeResize = writeSpy.mock.calls.length;
        vi.advanceTimersByTime(200);
        expect(writeSpy.mock.calls).toHaveLength(beforeResize);
      }
      if (scenario === 'resize-before-pause') {
        Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 35 });
        writeSpy.mockClear();
      }
      printer.info('Approved');
      if (scenario === 'resize-before-pause') {
        expect(writeSpy.mock.calls.map((call) => String(call[0])).join('')).not.toMatch(/\x1b\[/u);
      }
      const writesAfterMessage = writeSpy.mock.calls.length;
      vi.advanceTimersByTime(1000);
      expect(writeSpy.mock.calls).toHaveLength(writesAfterMessage);
      expect(vi.getTimerCount()).toBe(0);
      expect(writeSpy.mock.calls.map((call) => String(call[0])).join('')).not.toContain('\x1b[2J');
    } finally {
      for (const [stream, key, descriptor] of [
        [process.stdout, 'isTTY', outTty], [process.stderr, 'isTTY', errTty],
        [process.stdout, 'columns', columns],
      ] as const) {
        if (descriptor) Object.defineProperty(stream, key, descriptor);
        else Reflect.deleteProperty(stream, key);
      }
    }
  });
});

describe('runCommandLogged', () => {
  it('stays silent when steps are hidden but still logs the child output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-progress-silent-'));
    const writes = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const logPath = join(directory, 'command.log');
      const spawnIndex = vi.mocked(spawn).mock.calls.length;
      const result = await runCommandLogged({
        label: 'noop', cmd: process.execPath, args: ['-e', "process.stdout.write('hello')"],
        logPath, showSteps: false,
      });
      expect(result.ok).toBe(true);
      expect(vi.mocked(spawn).mock.calls[spawnIndex]?.[2]).toMatchObject({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      expect(writes).not.toHaveBeenCalled();
      expect(await readFile(logPath, 'utf8')).toContain('hello');
    } finally {
      writes.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
