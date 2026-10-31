import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { stripVTControlCharacters } from 'node:util';

import chalk from 'chalk';
import { planetFrameIntervalMs } from '../../planetFrame.mjs';
import { isTerminalAnimationDisabled, renderPlanet, shimmerText, supportsBrailleArt } from './planet.js';
import { ACCENT_HEX } from './presentation.js';

type ChalkLike = typeof chalk;

const PLANET_COLUMNS = 24;
const PLANET_GAP = 3;
const SPINNER_INTERVAL_MS = 80;
const SHIMMER_SECONDS = 2.4;

function isTty(): boolean {
  return Boolean(process.stdout.isTTY && process.stderr.isTTY);
}

function spinnerFrames(): string[] {
  return supportsBrailleArt()
    ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
    : ['|', '/', '-', '\\'];
}

function colorResult(chalkLike: ChalkLike, result: string): string {
  const normalized = String(result);
  if (chalkLike.level <= 0) return normalized;
  if (normalized === '✓') return chalkLike.green(normalized);
  if (normalized === 'x' || normalized === '✗') return chalkLike.red(normalized);
  if (normalized === '!') return chalkLike.yellow(normalized);
  return normalized;
}

export type StepPrinter = Readonly<{
  start: (label: string) => void;
  stop: (result: string, label: string) => void;
  info: (line: string) => void;
  pause: () => void;
  run: <T>(label: string, work: () => Promise<T>, doneLabel?: (value: T) => string) => Promise<T>;
}>;

export function createStepPrinter({ enabled = true, chalkLike = chalk, appearance = 'compact' }: Readonly<{
  enabled?: boolean;
  chalkLike?: ChalkLike;
  appearance?: 'compact' | 'planet';
}> = {}): StepPrinter {
  if (!enabled) {
    return {
      start: () => {},
      stop: () => {},
      info: () => {},
      pause: () => {},
      run: (_label, work) => work(),
    };
  }

  const tty = enabled && isTty() && process.env.TERM !== 'dumb';
  const animate = tty && !isTerminalAnimationDisabled();
  const color = tty && !process.env.NO_COLOR;
  const colors = chalkLike;
  const frames = spinnerFrames();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let currentLine = '';
  let drawnRows = 0;
  let initialColumns = 0;
  let initialRows = 0;
  let activeLabel: string | null = null;
  let activeSince = 0;

  const write = (value: string) => process.stdout.write(value);
  const resized = () => (process.stdout.columns ?? 80) !== initialColumns || (process.stdout.rows ?? 24) !== initialRows;
  // An active step: a gold Braille spinner and a slow highlight moving across its label.
  const activity = (label: string, seconds: number) => {
    const frame = frames[Math.floor((seconds * 1000) / SPINNER_INTERVAL_MS) % frames.length] ?? frames[0]!;
    if (!color || colors.level <= 0) return `${frame} ${label}`;
    return `${colors.hex(ACCENT_HEX)(frame)} ${shimmerText(label, (seconds % SHIMMER_SECONDS) / SHIMMER_SECONDS, colors)}`;
  };

  // Called before yielding the terminal to another message/prompt/child.
  // Never move above our own region (in particular, never redraw an auth QR).
  const pause = () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (resized()) {
      // Resize may occur immediately before completion, not just on a tick.
      // The terminal owns any reflowed output; leave it intact.
      if (currentLine) write('\n');
    } else if (drawnRows > 0) {
      write(`\r\x1b[${drawnRows}A\x1b[J`);
    } else if (currentLine) {
      write('\r\x1b[2K');
    }
    currentLine = '';
    drawnRows = 0;
  };

  const start = (label: string) => {
    pause();
    activeLabel = label;
    activeSince = Date.now();
    if (!animate) {
      write(`- [..] ${label}\n`);
      return;
    }
    initialColumns = process.stdout.columns ?? 80;
    initialRows = process.stdout.rows ?? 24;
    if (appearance === 'planet' && initialColumns >= 40 && initialRows >= 18 && supportsBrailleArt()) {
      // A short label sits beside the planet. A long one (or a URL) stays outside
      // the redrawn region so it can wrap without invalidating cursor geometry.
      const beside = PLANET_COLUMNS + PLANET_GAP + 2 + label.length <= initialColumns;
      if (!beside) write(`${label}\n`);
      let lastFrame = '';
      const draw = () => {
        if (resized()) {
          // Once resized, let the terminal keep its reflowed scrollback. Do
          // not guess where those previous rows moved or erase user content.
          if (timer) clearInterval(timer);
          timer = null;
          drawnRows = 0;
          return;
        }
        const seconds = (Date.now() - activeSince) / 1000;
        // A waiting indicator, not a welcome: the planet is simply there, breathing.
        const rows = renderPlanet({ columns: PLANET_COLUMNS, seconds, intro: false, chalkLike: colors, color });
        if (beside) {
          const middle = Math.floor(rows.length / 2);
          const planetRow = rows[middle] ?? '';
          rows[middle] = `${planetRow}${' '.repeat(Math.max(0, PLANET_COLUMNS - stripVTControlCharacters(planetRow).length) + PLANET_GAP)}${activity(label, seconds)}`;
        }
        const frame = rows.map((row) => `\r\x1b[2K${row}\n`).join('');
        // A slow breath often leaves the picture unchanged between ticks: write nothing then.
        if (frame === lastFrame && drawnRows === rows.length) return;
        // One write per frame: the cursor move and the rows land together.
        write(`${drawnRows > 0 ? `\x1b[${drawnRows}A` : ''}${frame}`);
        lastFrame = frame;
        drawnRows = rows.length;
      };
      // Smooth while the planet turns, calm once it only breathes.
      const tick = () => {
        draw();
        if (timer === null) return;
        timer = setTimeout(tick, planetFrameIntervalMs((Date.now() - activeSince) / 1000));
        timer.unref?.();
      };
      draw();
      timer = setTimeout(tick, planetFrameIntervalMs(0));
      timer.unref?.();
      return;
    }
    // Long compact labels use the linear mode rather than wrapping a cursor
    // animation onto multiple unowned rows.
    if (label.length + 8 >= initialColumns) { write(`- [..] ${label}\n`); return; }
    currentLine = activity(label, 0);
    write(currentLine);
    timer = setInterval(() => {
      if (resized()) {
        if (timer) clearInterval(timer);
        timer = null;
        currentLine = '';
        write('\n');
        return;
      }
      const next = activity(label, (Date.now() - activeSince) / 1000);
      const overhang = stripVTControlCharacters(currentLine).length - stripVTControlCharacters(next).length;
      currentLine = next;
      write(`\r${next}${overhang > 0 ? ' '.repeat(overhang) : ''}`);
    }, SPINNER_INTERVAL_MS);
    timer.unref?.();
  };

  const stop = (result: string, label: string) => {
    pause();
    // stop() completes the active step, whatever label it finishes with ("… (already installed)").
    const elapsed = activeLabel !== null ? (Date.now() - activeSince) / 1000 : null;
    activeLabel = null;
    if (!animate) {
      write(`- [${color ? colorResult(colors, result) : result}] ${label}\n`);
      return;
    }
    const took = elapsed === null ? '' : `  ${(color ? colors.dim : String)(`${elapsed.toFixed(1)}s`)}`;
    write(`${color ? colorResult(colors, result) : result} ${label}${took}\n`);
  };

  const info = (line: string) => {
    pause();
    write(`${line}\n`);
  };

  // One step around one piece of work: ✓ (optionally with a label naming the outcome), or x and rethrow.
  const run = async <T>(label: string, work: () => Promise<T>, doneLabel?: (value: T) => string): Promise<T> => {
    start(label);
    try {
      const value = await work();
      stop('✓', doneLabel ? doneLabel(value) : label);
      return value;
    } catch (error) {
      stop('x', label);
      throw error;
    }
  };

  return { start, stop, info, pause, run };
}

export async function runCommandLogged({
  label,
  cmd,
  args,
  cwd,
  env,
  logPath,
  showSteps = true,
  quiet = true,
}: Readonly<{
  label: string;
  cmd: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logPath: string;
  showSteps?: boolean;
  quiet?: boolean;
}>) {
  const steps = createStepPrinter({ enabled: showSteps });
  if (quiet) {
    await mkdir(dirname(logPath), { recursive: true }).catch(() => {});
  }

  // An inherited child owns the terminal, so only buffered commands animate.
  if (quiet) steps.start(label);
  else steps.info(`- [..] ${label}`);

  let logStream: ReturnType<typeof createWriteStream> | null = null;
  try {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: quiet,
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    if (quiet) {
      logStream = createWriteStream(logPath, { flags: 'a' });
      child.stdout?.on('data', (d) => {
        const s = d.toString();
        stdout += s;
        logStream?.write(s);
      });
      child.stderr?.on('data', (d) => {
        const s = d.toString();
        stderr += s;
        logStream?.write(s);
      });
    }

    const res = await new Promise<Readonly<{ code: number; signal: NodeJS.Signals | null }>>((resolvePromise, rejectPromise) => {
      child.on('error', rejectPromise);
      child.on('close', (code, signal) => resolvePromise({ code: code ?? 1, signal: signal ?? null }));
    });

    if (res.code === 0) {
      steps.stop('✓', label);
      return { ok: true, code: 0, stdout, stderr, logPath };
    }

    steps.stop('x', label);
    const err = new Error(`${cmd} failed (code=${res.code}${res.signal ? `, sig=${res.signal}` : ''})`);
    (err as Error & {
      code?: string;
      exitCode?: number;
      signal?: NodeJS.Signals | null;
      stdout?: string;
      stderr?: string;
      logPath?: string;
    }).code = 'EEXIT';
    (err as Error & { exitCode?: number }).exitCode = res.code;
    (err as Error & { signal?: NodeJS.Signals | null }).signal = res.signal;
    (err as Error & { stdout?: string }).stdout = stdout;
    (err as Error & { stderr?: string }).stderr = stderr;
    (err as Error & { logPath?: string }).logPath = logPath;
    throw err;
  } finally {
    // Spawn errors reject before a normal exit status exists. Always release
    // terminal ownership and the log stream before the caller reports failure.
    steps.pause();
    logStream?.end();
  }
}
