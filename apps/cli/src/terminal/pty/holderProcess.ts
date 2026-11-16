import { constants } from 'node:os';

import type { SessionHolderChild } from '@/subprocess/supervision/sessionHolder';
import { createUtf8StreamDecoder } from './decode';
import type { PtyExitEvent, PtyProcess } from './provider';

/** Adapts the holder's existing PTY stream; target pids never enter host process tracking. */
export async function spawnHolderPtyProcess(holder: SessionHolderChild, request: Readonly<{
  argv: readonly string[]; cwd?: string; env?: Readonly<Record<string, string>>; cols: number; rows: number;
}>, releaseHolder?: () => void): Promise<PtyProcess> {
  const stream = holder.spawnStream({ op: 'pty', ...request });
  const output = new Set<(bytes: Buffer) => void>();
  const pending: Buffer[] = [];
  const exits = new Set<(event: PtyExitEvent) => void>();
  let exit: PtyExitEvent | undefined;
  let subscribed = false;
  stream.stdout.on('data', (bytes: Buffer) => {
    if (!subscribed) pending.push(bytes);
    else for (const listener of output) listener(bytes);
  });
  stream.stderr.resume();
  stream.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
    exit = { exitCode: code, ...(signal ? { signal: constants.signals[signal] } : {}) };
    for (const listener of exits) listener(exit);
    releaseHolder?.();
  });
  // A channel failure must settle startup and never become an unhandled stream error.
  stream.stdin.on('error', () => {});
  try {
    await new Promise<void>((resolve, reject) => { stream.once('spawn', resolve); stream.on('error', reject); });
  } catch (error) {
    releaseHolder?.();
    throw error;
  }
  const onDataBytes = (listener: (bytes: Buffer | string) => void) => {
    output.add(listener);
    subscribed = true;
    for (const bytes of pending.splice(0)) listener(bytes);
    return { dispose: () => { output.delete(listener); } };
  };
  return {
    pid: 0,
    write: data => { stream.stdin.write(data); },
    resize: (cols, rows) => { stream.resize(cols, rows); },
    kill: signal => { stream.kill(signal as NodeJS.Signals | undefined); },
    terminateTree: () => stream.terminateTree(),
    onDataBytes,
    onData: listener => {
      const decoder = createUtf8StreamDecoder();
      const subscription = onDataBytes(bytes => { const text = decoder.decode(bytes); if (text) listener(text); });
      const flush = () => { const text = decoder.flush(); if (text) listener(text); };
      if (stream.stdout.readableEnded) flush();
      else stream.stdout.once('end', flush);
      return { dispose: () => { subscription.dispose(); stream.stdout.off('end', flush); } };
    },
    onExit: listener => {
      exits.add(listener);
      if (exit) { const observed = exit; queueMicrotask(() => { if (exits.has(listener)) listener(observed); }); }
      return { dispose: () => { exits.delete(listener); } };
    },
  };
}
