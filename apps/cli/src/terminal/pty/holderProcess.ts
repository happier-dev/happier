import { constants } from 'node:os';
import type { Readable } from 'node:stream';

import {
  adoptSessionHolderChild,
  resolveAgentSessionHolderLaunch,
  spawnSessionHolderChild,
  type SessionHolderChild,
} from '@/subprocess/supervision/sessionHolder';
import { PROCESS_TERMINATION_GRACE_MS } from '@/subprocess/supervision/terminationPolicy';
import { createUtf8StreamDecoder } from './decode';
import type { PtyExitEvent, PtyProcess } from './provider';

/** One holder-carried terminal (a workspace stream or the held Agent) as a `PtyProcess`. */
function holderTerminalProcess(terminal: Readonly<{
  pid: number;
  output: Readable;
  /** Subscribes to the terminal's end (the process exit). */
  onEnd(listener: (event: PtyExitEvent) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  terminateTree(): Promise<void>;
}>): PtyProcess {
  const output = new Set<(bytes: Buffer) => void>();
  const pending: Buffer[] = [];
  const exits = new Set<(event: PtyExitEvent) => void>();
  let exit: PtyExitEvent | undefined;
  let subscribed = false;
  terminal.output.on('data', (bytes: Buffer) => {
    if (!subscribed) pending.push(bytes);
    else for (const listener of output) listener(bytes);
  });
  terminal.onEnd((event) => {
    exit = event;
    for (const listener of exits) listener(event);
  });
  const onDataBytes = (listener: (bytes: Buffer | string) => void) => {
    output.add(listener);
    subscribed = true;
    for (const bytes of pending.splice(0)) listener(bytes);
    return { dispose: () => { output.delete(listener); } };
  };
  return {
    pid: terminal.pid,
    write: terminal.write,
    resize: terminal.resize,
    kill: terminal.kill,
    terminateTree: terminal.terminateTree,
    onDataBytes,
    onData: listener => {
      const decoder = createUtf8StreamDecoder();
      const subscription = onDataBytes(bytes => { const text = decoder.decode(bytes); if (text) listener(text); });
      const flush = () => { const text = decoder.flush(); if (text) listener(text); };
      if (terminal.output.readableEnded) flush();
      else terminal.output.once('end', flush);
      return { dispose: () => { subscription.dispose(); terminal.output.off('end', flush); } };
    },
    onExit: listener => {
      exits.add(listener);
      if (exit) { const observed = exit; queueMicrotask(() => { if (exits.has(listener)) listener(observed); }); }
      return { dispose: () => { exits.delete(listener); } };
    },
  };
}

function exitEvent(code: number | null, signal: NodeJS.Signals | null): PtyExitEvent {
  return { exitCode: code, ...(signal ? { signal: constants.signals[signal] } : {}) };
}

/** Adapts the holder's existing PTY stream; target pids never enter host process tracking. */
export async function spawnHolderPtyProcess(holder: SessionHolderChild, request: Readonly<{
  argv: readonly string[]; cwd?: string; env?: Readonly<Record<string, string>>; cols: number; rows: number;
}>, releaseHolder?: () => void): Promise<PtyProcess> {
  const stream = holder.spawnStream({ op: 'pty', ...request });
  stream.stderr.resume();
  // A channel failure must settle startup and never become an unhandled stream error.
  stream.stdin.on('error', () => {});
  const pty = holderTerminalProcess({
    pid: 0,
    output: stream.stdout,
    onEnd: listener => stream.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      listener(exitEvent(code, signal));
      releaseHolder?.();
    }),
    write: data => { stream.stdin.write(data); },
    resize: (cols, rows) => { stream.resize(cols, rows); },
    kill: signal => { stream.kill(signal as NodeJS.Signals | undefined); },
    terminateTree: () => stream.terminateTree(),
  });
  try {
    await new Promise<void>((resolve, reject) => { stream.once('spawn', resolve); stream.on('error', reject); });
  } catch (error) {
    releaseHolder?.();
    throw error;
  }
  return pty;
}

/** The adopt state a terminal-mode primary Agent stores: the daemon spares only adoptable primaries. */
const HELD_TERMINAL_AGENT_META = Object.freeze({ role: 'primary', terminal: 'pty' });

export type HeldAgentPtyProcess = Readonly<{
  pty: PtyProcess;
  /** The Agent was already running in its holder (a previous runner started it). */
  adopted: boolean;
  /**
   * Starts output delivery once the caller's listeners are wired. An adopted Agent's
   * screen is then restored: its terminal is nudged one row smaller and back once it
   * redraws, so the TUI repaints in full (a same-size resize sends it nothing).
   */
  start(): void;
}>;

/**
 * The Session's terminal-mode Agent as the holder's held primary Agent in a pseudo-terminal:
 * it survives this runner, the daemon spares it on a runner crash, and the respawned runner
 * adopts it here through the one launch decision (`resolveAgentSessionHolderLaunch`).
 */
export async function startHeldAgentPtyProcess(request: Readonly<{
  command: string;
  args: readonly string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  requiredFiles?: readonly string[];
  windowsVerbatimArguments?: boolean;
  cols: number;
  rows: number;
}>): Promise<HeldAgentPtyProcess> {
  const launch = resolveAgentSessionHolderLaunch({ role: 'primary' });
  const holder = launch.kind === 'adopt'
    ? adoptSessionHolderChild(launch)
    : spawnSessionHolderChild({
      executablePath: launch.executablePath,
      socketPath: launch.socketPath,
      role: launch.role,
      ...(launch.target ? { target: launch.target } : {}),
      command: request.command,
      args: request.args,
      ...(request.cwd ? { cwd: request.cwd } : {}),
      env: request.env,
      ...(request.requiredFiles ? { requiredFiles: request.requiredFiles } : {}),
      ...(request.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      terminal: { cols: request.cols, rows: request.rows },
    });
  holder.stderr.resume();
  holder.stdin.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    holder.once('spawn', resolve);
    holder.once('error', reject);
  });
  if (launch.kind === 'spawn') holder.publishAdoptState(HELD_TERMINAL_AGENT_META);
  const pty = holderTerminalProcess({
    // A target's pids are not this Machine's.
    pid: holder.target ? 0 : holder.pid ?? 0,
    output: holder.stdout,
    onEnd: listener => holder.once('exit', (code: number | null, signal: NodeJS.Signals | null) => listener(exitEvent(code, signal))),
    write: data => { holder.stdin.write(data); },
    resize: (cols, rows) => { void holder.resizeTerminal(cols, rows); },
    kill: signal => { holder.kill(signal as NodeJS.Signals | undefined); },
    terminateTree: () => holder.terminateGroup({ graceMs: PROCESS_TERMINATION_GRACE_MS }),
  });
  return {
    pty,
    adopted: launch.kind === 'adopt',
    start: () => {
      if (launch.kind !== 'adopt') return;
      holder.resumeDelivery();
      const nudged = Math.max(1, request.rows - 1);
      if (nudged === request.rows) return;
      // Restored on the TUI's first output after the nudge; a TUI that never redraws keeps one row less.
      void holder.resizeTerminal(request.cols, nudged).then((resized) => {
        if (resized) holder.stdout.once('data', () => { void holder.resizeTerminal(request.cols, request.rows); });
      });
    },
  };
}
