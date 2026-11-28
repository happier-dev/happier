import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import spawn from 'cross-spawn';

import { killProcessTree } from '@/agent/runtime/process/killProcessTree';

import { attachPiRpcJsonlLineReader, type PiRpcJsonlLineReader } from './attachPiRpcJsonlLineReader';

/** The interactive Pi cannot take a prompt now. No provider effect occurred, so retry is safe. */
export class PiSharedTerminalUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiSharedTerminalUnavailableError';
  }
}

/**
 * Transport between `PiRpcBackend` and one Pi process. The backend owns the RPC protocol, turn
 * lifecycle and event mapping; a channel only moves JSONL lines.
 *
 * - `spawned`: a headless `pi --mode rpc` child whose stdio this runner owns.
 * - `attached`: an interactive Pi that owns the user's terminal and reaches the runner through
 *   the Happier bridge extension (`sharedControl/piSharedTerminalHost.ts`).
 */
export type PiRpcChannelClosure =
  /** The Pi process exited. */
  | Readonly<{ kind: 'exited'; code: number | null; signal: NodeJS.Signals | null }>
  /** The transport failed: the child could not run, or an attached bridge vanished without `bye`. */
  | Readonly<{ kind: 'failed'; error: Error }>
  /**
   * An attached bridge said `bye` before closing. `reattachable` when Pi keeps running (`/reload`,
   * `/new`, `/resume`, `/fork`) and will connect again; false when it is quitting.
   */
  | Readonly<{ kind: 'detached'; reattachable: boolean }>;

export type PiRpcChannelListener = Readonly<{
  /** A record a spawned Pi would print on stdout (events, responses, notify markers). */
  onStdoutLine: (line: string) => void;
  /** A side-channel line a spawned Pi would print on stderr (model catalog, telemetry, logs). */
  onStderrLine: (line: string) => void;
  /** A stream error that does not by itself end the channel (for example EPIPE between turns). */
  onIoError: (error: Error) => void;
  onClosed: (closure: PiRpcChannelClosure) => void;
}>;

export type PiRpcChannel = Readonly<{
  /** Starts delivery. Anything observed before this call is delivered first, in order. */
  listen: (listener: PiRpcChannelListener) => void;
  /** Writes one JSONL line; resolves once the transport accepted it. */
  write: (line: string) => Promise<void>;
  /** Releases the channel: a spawned child's process tree is stopped; an attached Pi is only detached. */
  close: () => Promise<void>;
}>;

export type PiRpcChannelOpenSpec = Readonly<{
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}>;

export type PiRpcChannelOpenOptions = Readonly<{
  /** Aborts a wait for the Pi process (the backend's session-open lifecycle). */
  signal?: AbortSignal;
  /** Exact-resume identity for an attached terminal to admit before it forwards frames. */
  expectedSession?: Readonly<{ sessionId: string; sessionFile?: string | null }>;
  /**
   * Releases the protected launch artifacts named in `spec.args`. Passing it hands their lifetime
   * to the host, which keeps them while the Pi process that may re-read them (`/reload`) lives.
   */
  retainArtifacts?: () => Promise<void>;
}>;

export type PiRpcChannelHost = Readonly<{
  kind: 'spawned' | 'attached';
  open: (spec: PiRpcChannelOpenSpec, options?: PiRpcChannelOpenOptions) => Promise<PiRpcChannel>;
  /**
   * Attached only: calls `listener` when the interactive Pi is back on the session this runner is
   * bound to while no backend is attached or waiting (the terminal returned after `/resume`), so
   * the backend re-attaches without waiting for a web command. Returns the unsubscribe.
   */
  onSessionAvailable?: (listener: () => void) => () => void;
}>;

export type SpawnedPiRpcChannel = PiRpcChannel & Readonly<{ child: ChildProcessWithoutNullStreams }>;

async function stopPiRpcProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  // Register before signaling so a fast Windows exit cannot race the close listener. `close` is
  // later than `exit` and proves the child's stdio/OS handles have been released as well as its PID.
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });
  await killProcessTree(child, { graceMs: 2_000 });
  await closed;
}

type SpawnedChannelEvent =
  | Readonly<{ kind: 'io-error'; error: Error }>
  | Readonly<{ kind: 'closed'; closure: PiRpcChannelClosure }>;

export function createSpawnedPiRpcChannel(child: ChildProcessWithoutNullStreams): SpawnedPiRpcChannel {
  let listener: PiRpcChannelListener | null = null;
  let closed = false;
  const earlyEvents: SpawnedChannelEvent[] = [];
  const readers: PiRpcJsonlLineReader[] = [];

  const deliver = (event: SpawnedChannelEvent): void => {
    if (closed) return;
    if (!listener) {
      earlyEvents.push(event);
      return;
    }
    if (event.kind === 'io-error') {
      listener.onIoError(event.error);
      return;
    }
    closed = true;
    listener.onClosed(event.closure);
    for (const reader of readers) reader.close();
  };

  // Defensive: avoid unhandled EPIPE on stdio streams when the subprocess exits between turns.
  const handleIoError = (error: unknown): void => {
    deliver({ kind: 'io-error', error: error instanceof Error ? error : new Error(String(error)) });
  };
  child.stdin.on('error', handleIoError);
  child.stdout.on('error', handleIoError);
  child.stderr.on('error', handleIoError);
  child.on('error', (error) => {
    deliver({ kind: 'closed', closure: { kind: 'failed', error } });
  });
  child.on('exit', (code, signal) => {
    deliver({ kind: 'closed', closure: { kind: 'exited', code, signal } });
  });

  return {
    child,
    listen: (next) => {
      if (listener) throw new Error('Pi RPC channel already has a listener');
      listener = next;
      // Streams buffer until a reader attaches, so no line is lost before `listen`.
      readers.push(
        attachPiRpcJsonlLineReader(child.stdout, (line) => next.onStdoutLine(line)),
        attachPiRpcJsonlLineReader(child.stderr, (line) => next.onStderrLine(line)),
      );
      for (const event of earlyEvents.splice(0)) deliver(event);
    },
    write: (line) => new Promise<void>((resolve, reject) => {
      child.stdin.write(`${line}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
    close: async () => {
      closed = true;
      for (const reader of readers) reader.close();
      await stopPiRpcProcess(child);
    },
  };
}

/** Today's headless RPC transport: one `pi --mode rpc` child per open, with piped stdio. */
export const spawnedPiRpcChannelHost: PiRpcChannelHost = {
  kind: 'spawned',
  open: async (spec) => {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      stdio: 'pipe',
      windowsHide: true,
    });

    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error('Failed to start Pi RPC process with piped stdio');
    }
    return createSpawnedPiRpcChannel(child as ChildProcessWithoutNullStreams);
  },
};
