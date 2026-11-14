import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Isolated Happier home: the host publishes its endpoint descriptor under the active server directory.
const testHome = vi.hoisted(() => {
  const home = `${process.env.TMPDIR ?? '/tmp'}/happier-session-host-${process.pid}-${Date.now()}`;
  process.env.HAPPIER_HOME_DIR = home;
  return home;
});

import { runBackendSessionCliCommand } from '@/cli/runBackendSessionCliCommand';

import { endLocalSessionHostSession } from '@/session/transport/rpc/localSessionRpcChannel';

import { onHostedSessionHandover } from './hostedSessionScope';
import { bindHostedSessionStop, registerRunnerTerminationHandlers } from './runnerTerminationHandlers';
import { startSessionHost, type SessionHost } from './sessionHost';

type Deferred = { promise: Promise<void>; resolve: () => void };
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** The settled value within `ms`, or 'pending'. */
async function settledWithin<T>(promise: Promise<T>, ms = 1_000): Promise<T | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<'pending'>((resolve) => { timer = setTimeout(() => resolve('pending'), ms); });
  try {
    return await Promise.race([promise, pending]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Two Sessions in one session host. The OS process is the boundary: a fake process emitter carries
 * signals/fatal events and a spied exit; the host, the Session scopes, the termination owner and
 * the real runner command run unchanged.
 */
describe('session host', () => {
  const processExit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code}) called by a hosted Session`);
  }) as typeof process.exit);
  let hostProcess: EventEmitter;
  let hostExit: ReturnType<typeof vi.fn<(code: number) => void>>;
  let host: SessionHost | null = null;

  async function startHost(runSessionCommand: (argv: readonly string[]) => Promise<void>, trustedCallerPid = process.pid): Promise<SessionHost> {
    hostProcess = new EventEmitter();
    hostExit = vi.fn<(code: number) => void>();
    host = await startSessionHost({
      runSessionCommand,
      readTrustedCallerPid: async () => trustedCallerPid,
      process: hostProcess,
      exit: hostExit,
    });
    return host;
  }

  /** A Session whose runtime registered with the termination owner and is in the middle of a turn. */
  function sessionInTurn(turn: Deferred): () => Promise<void> {
    return async () => {
      const termination = registerRunnerTerminationHandlers({ process: hostProcess, exit: hostExit, onTerminate: () => undefined });
      await Promise.race([turn.promise, termination.whenTerminated]);
      termination.dispose();
    };
  }

  // The runner command's failure path loads its reporting module on demand; load it once up front
  // so the assertions below time the Session's end, not a cold module transform.
  beforeAll(async () => { await import('@/cli/resolveSessionRunnerFailureExitCode'); }, 120_000);

  const add = (trackingKey: string) => host!.addSession({ trackingKey, argv: [trackingKey], env: {}, cwd: testHome });

  afterEach(async () => {
    processExit.mockClear();
    if (host) hostProcess.emit('SIGTERM');
    host = null;
  });
  afterAll(async () => {
    processExit.mockRestore();
    await rm(testHome, { recursive: true, force: true });
  });

  it('distinguishes missing termination registration from an absent Session and transport refusal', async () => {
    const turn = deferred();
    await startHost(async () => { await turn.promise; });
    const ended = add('unregistered');
    try {
      await expect(endLocalSessionHostSession({ hostPid: process.pid, trackingKey: 'unregistered' }))
        .resolves.toEqual({ status: 'termination_unavailable' });
      await expect(endLocalSessionHostSession({ hostPid: process.pid, trackingKey: 'absent' }))
        .resolves.toEqual({ status: 'not_hosted' });
      await expect(endLocalSessionHostSession({ hostPid: 2147483647, trackingKey: 'absent' }))
        .resolves.toEqual({ status: 'host_unavailable' });
    } finally {
      turn.resolve();
      await ended;
    }
  });

  it('keeps startup Stop with its Session when a child delegates lifecycle to its caller', async () => {
    const stopped = deferred();
    const sibling = deferred();
    await startHost(async argv => {
      if (argv[0] === 'sibling') return await sessionInTurn(sibling)();
      bindHostedSessionStop(async () => { stopped.resolve(); });
      bindHostedSessionStop(async () => { throw new Error('Child must not own parent Stop'); }, 'caller');
      await stopped.promise;
    });
    const siblingEnded = add('sibling');
    const ended = add('startup');
    try {
      await expect(endLocalSessionHostSession({ hostPid: process.pid, trackingKey: 'startup' }))
        .resolves.toEqual({ status: 'termination_requested' });
      expect(await settledWithin(ended)).toEqual({ exitCode: 0 });
      expect(await settledWithin(siblingEnded, 50)).toBe('pending');
      expect(hostExit).not.toHaveBeenCalled();
    } finally {
      stopped.resolve(); sibling.resolve();
      await Promise.all([ended, siblingEnded]);
    }
  });

  it('retains peer refusal without ending the Session', async () => {
    const turn = deferred();
    await startHost(async () => { await turn.promise; }, process.pid + 1);
    const ended = add('refused');
    try {
      await expect(endLocalSessionHostSession({ hostPid: process.pid, trackingKey: 'refused' }))
        .resolves.toEqual({ status: 'peer_refused' });
      expect(await settledWithin(ended, 50)).toBe('pending');
    } finally {
      turn.resolve();
      await ended;
    }
  });

  it('saves each Session\'s pending transcript before a planned hand-over exits, without ending the Session', { timeout: 30_000 }, async () => {
    // Update: the newer host replays only what this host never acknowledged, and every chunk this host
    // took is already acknowledged. Its Sessions' pending transcript checkpoints must be saved first.
    const turns = { a: deferred(), b: deferred() };
    const saved: string[] = [];
    const order: string[] = [];
    const session = (key: 'a' | 'b') => async () => {
      onHostedSessionHandover(async () => { await new Promise(resolve => setImmediate(resolve)); saved.push(key); order.push(`save ${key}`); });
      await turns[key].promise;
    };
    await startHost((argv) => session(argv[0] as 'a' | 'b')());
    void add('a'); void add('b');
    await new Promise(resolve => setImmediate(resolve));
    hostExit.mockImplementation(code => { order.push(`exit ${code}`); });

    expect(host!.handOver()).toBe(true);
    await vi.waitFor(() => expect(hostExit).toHaveBeenCalled());
    expect({ saved: [...saved].sort(), exitLast: order.at(-1) }).toEqual({ saved: ['a', 'b'], exitLast: 'exit 75' });
    turns.a.resolve(); turns.b.resolve();
  });

  it('ends only the Session whose runner command failed while another keeps its turn', { timeout: 30_000 }, async () => {
    const turnB = deferred();
    const commands: Record<string, () => Promise<void>> = {
      // The real runner command, failing before any runtime exists (no backend id).
      'session-a': () => runBackendSessionCliCommand({
        context: { args: [], rawArgv: [], terminalRuntime: null },
        backendIdForSessionRuntime: ' ',
        resolveSessionRuntimePreferences: null,
      }),
      'session-b': sessionInTurn(turnB),
    };
    await startHost((argv) => commands[argv[0]!]!());

    const endedB = add('session-b');
    const endedA = add('session-a');

    expect(await settledWithin(endedA, 20_000)).toEqual({ exitCode: 1 });
    expect(processExit).not.toHaveBeenCalled();
    expect(await settledWithin(endedB, 50)).toBe('pending');
    expect(hostExit).not.toHaveBeenCalled();

    turnB.resolve();
    expect(await settledWithin(endedB)).toEqual({ exitCode: 0 });
    await host!.whenEnded;
    expect(hostExit).toHaveBeenCalledTimes(1);
  });

  it('ends only the Session whose own work raised a fatal error, and only on its own end', async () => {
    const turnB = deferred();
    const commands: Record<string, () => Promise<void>> = {
      'session-a': async () => {
        const termination = registerRunnerTerminationHandlers({ process: hostProcess, exit: hostExit, onTerminate: () => undefined });
        // A fatal error raised inside this Session's own work.
        hostProcess.emit('uncaughtException', new Error('Session A failed'));
        await termination.whenTerminated;
        // A terminated runtime never returns from its command on its own.
        await new Promise<void>(() => undefined);
      },
      'session-b': sessionInTurn(turnB),
    };
    await startHost((argv) => commands[argv[0]!]!());

    const endedB = add('session-b');
    const endedA = add('session-a');

    expect(await settledWithin(endedA)).toEqual({ exitCode: 1 });
    expect(await settledWithin(endedB, 50)).toBe('pending');
    expect(hostExit).not.toHaveBeenCalled();
    expect(processExit).not.toHaveBeenCalled();

    // The daemon's Stop of B ends B through the host; the host then ends with its last Session.
    expect(host!.endSession('session-b')).toEqual({ status: 'termination_requested' });
    expect(await settledWithin(endedB)).toEqual({ exitCode: 0 });
    await host!.whenEnded;
    expect(hostExit).toHaveBeenCalledTimes(1);
  });
});
