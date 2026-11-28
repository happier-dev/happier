import { connect, Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentState } from '@/api/types';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { RunnerTerminationEvent } from '@/agent/runtime/runnerTerminationOutcome';
import { PiSharedTerminalUnavailableError, type PiRpcChannel, type PiRpcChannelClosure, type PiRpcChannelOpenSpec } from '@/backends/pi/rpc/piRpcChannel';
import { createDeferred } from '@/testkit/async/deferred';
import { logger } from '@/ui/logger';
import * as protectedArtifact from '@/utils/fs/protectedTempTextArtifact';

import {
  createPiSharedTerminalHost,
  type PiSharedTerminalHost,
  type PiSharedTerminalProcess,
  type PiSharedTerminalSession,
} from './piSharedTerminalHost';
import {
  PI_SHARED_CONTROL_ADMISSION_FRAME,
  PI_SHARED_CONTROL_BRIDGE_UNAVAILABLE_ERROR,
  PI_SHARED_CONTROL_HELLO_MAX_BYTES,
  PI_SHARED_CONTROL_PROTOCOL_VERSION,
  type PiSharedControlConfig,
} from './piSharedControlProtocol';

const SPEC: PiRpcChannelOpenSpec = { command: 'pi', args: ['--session', 'pi-session-1'], env: {}, cwd: '/tmp' };

/** The launched interactive Pi is the process boundary; its exit is driven by the test. */
function createFakePi() {
  let resolveExit!: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const whenExited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveExit = resolve;
  });
  const terminate = vi.fn(async () => { resolveExit({ code: null, signal: 'SIGTERM' }); });
  const process: PiSharedTerminalProcess = { whenExited, terminate };
  return { process, terminate, exit: (code: number) => resolveExit({ code, signal: null }) };
}

/** A bridge extension instance dialling the runner over real loopback TCP. */
async function connectBridge(config: PiSharedControlConfig, hello: Partial<Record<string, unknown>> = {}) {
  const socket: Socket = connect(config.port, config.host);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const received: string[] = [];
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      received.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.on('error', () => undefined);
  const writeLine = (value: unknown) => socket.write(`${JSON.stringify(value)}\n`);
  const helloFrame = {
    type: 'hello',
    v: PI_SHARED_CONTROL_PROTOCOL_VERSION,
    token: config.token,
    sessionId: 'pi-session-1',
    sessionFile: null,
    ...hello,
  };
  return {
    socket,
    received,
    closed,
    sendRaw: (text: string) => socket.write(text),
    sendHello: (...frames: unknown[]) => socket.write([helloFrame, ...frames].map((frame) => `${JSON.stringify(frame)}\n`).join('')),
    out: (record: Record<string, unknown>) => writeLine({ ch: 'out', line: JSON.stringify(record) }),
    err: (record: Record<string, unknown>) => writeLine({ ch: 'err', line: JSON.stringify(record) }),
    bye: (reason: string) => writeLine({ type: 'bye', reason }),
    end: () => new Promise<void>((resolve) => socket.end(resolve)),
  };
}

function listenTo(channel: PiRpcChannel) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const closures: PiRpcChannelClosure[] = [];
  channel.listen({
    onStdoutLine: (line) => stdout.push(line),
    onStderrLine: (line) => stderr.push(line),
    onIoError: () => undefined,
    onClosed: (closure) => closures.push(closure),
  });
  return { stdout, stderr, closures };
}

function createSessionPort() {
  let state: AgentState = {};
  const notices: string[] = [];
  const listeners = new Set<Parameters<ApiSessionClient['subscribeToSessionConnectionState']>[0]>();
  const session = {
    sendAgentMessage: vi.fn((_provider, body) => {
      if (body.type === 'message') notices.push(body.message);
    }) as PiSharedTerminalSession['sendAgentMessage'],
    updateAgentState: vi.fn(async (updater: (current: AgentState) => AgentState) => {
      state = updater(state);
    }) as PiSharedTerminalSession['updateAgentState'],
    subscribeToSessionConnectionState: ((listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }) as ApiSessionClient['subscribeToSessionConnectionState'],
  };
  return {
    session,
    notices,
    localControl: () => state.localControl,
    reconnect: () => {
      for (const listener of listeners) {
        listener({
          phase: 'online', reason: null, attempt: 0, nextRetryAt: null,
          lastConnectedAt: 1, lastDisconnectedAt: 0, lastErrorMessage: null,
        });
      }
    },
  };
}

const hosts: PiSharedTerminalHost[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const host of hosts.splice(0)) await host.dispose();
});

function createHost() {
  const fakePi = createFakePi();
  const launch = vi.fn(async (_spec: PiRpcChannelOpenSpec) => fakePi.process);
  const terminations: RunnerTerminationEvent[] = [];
  const host = createPiSharedTerminalHost({
    launch,
    requestRunnerTermination: (event) => terminations.push(event),
  });
  hosts.push(host);
  return { host, launch, fakePi, terminations };
}

async function attachFirstBridge(host: PiSharedTerminalHost, hello: Partial<Record<string, unknown>> = {}) {
  const config = await host.ensureListening();
  const opening = host.channelHost.open(SPEC);
  const bridge = await connectBridge(config, hello);
  sockets.push(bridge.socket);
  bridge.sendHello();
  const channel = await opening;
  return { config, bridge, channel };
}

describe('Pi shared terminal host', () => {
  it('closes a connection with a wrong token without attaching it', async () => {
    const { host } = createHost();
    const config = await host.ensureListening();
    const opening = host.channelHost.open(SPEC);

    const intruder = await connectBridge(config, { token: 'not-the-token' });
    sockets.push(intruder.socket);
    intruder.sendHello();
    await intruder.closed;

    const bridge = await connectBridge(config);
    sockets.push(bridge.socket);
    bridge.sendHello();
    const channel = await opening;
    const { stdout } = listenTo(channel);
    bridge.out({ type: 'agent_start' });
    await vi.waitFor(() => expect(stdout).toEqual([JSON.stringify({ type: 'agent_start' })]));
  });

  it('closes an unauthenticated connection that exceeds the pre-auth bound', async () => {
    const { host } = createHost();
    const config = await host.ensureListening();
    const peer = await connectBridge(config);
    sockets.push(peer.socket);

    peer.sendRaw('x'.repeat(PI_SHARED_CONTROL_HELLO_MAX_BYTES + 1));

    await peer.closed;
  });

  it('accepts a hello with a long Unicode Windows session file path', async () => {
    const { host } = createHost();
    const config = await host.ensureListening();
    const opening = host.channelHost.open(SPEC);
    const sessionFile = ['\\\\?\\C:', ...Array.from({ length: 128 }, () => '界'.repeat(250)), 'session.jsonl'].join('\\');
    const bridge = await connectBridge(config, { sessionFile });
    sockets.push(bridge.socket);
    bridge.sendHello();

    await expect(Promise.race([
      opening.then(() => 'admitted'),
      bridge.closed.then(() => 'closed'),
    ])).resolves.toBe('admitted');
  });

  it('launches Pi once and re-attaches later backends to the live bridge', async () => {
    const { host, launch } = createHost();
    const { bridge, channel } = await attachFirstBridge(host);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]![0].args).toEqual(SPEC.args);

    await channel.close();
    const second = await host.channelHost.open(SPEC);
    await second.write(JSON.stringify({ id: 'cmd-1', type: 'get_state' }));

    expect(launch).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(bridge.received.map((line) => JSON.parse(line))).toEqual([
      { type: PI_SHARED_CONTROL_ADMISSION_FRAME },
      { id: 'cmd-1', type: 'get_state' },
    ]));
  });

  it('refuses a second backend while one is attached', async () => {
    const { host } = createHost();
    await attachFirstBridge(host);

    await expect(host.channelHost.open(SPEC)).rejects.toThrow(/already has an attached backend/);
  });

  it('delivers frames sent with the hello, in order, once the backend listens', async () => {
    const { host } = createHost();
    const config = await host.ensureListening();
    const opening = host.channelHost.open(SPEC);
    const bridge = await connectBridge(config);
    sockets.push(bridge.socket);

    bridge.sendHello(
      { ch: 'err', line: JSON.stringify({ type: 'happy-pi-model-catalog' }) },
      { ch: 'out', line: JSON.stringify({ type: 'agent_start' }) },
    );
    const channel = await opening;
    // TCP close after our FIN witnesses host-side receipt of every preceding frame.
    await bridge.end();
    await bridge.closed;
    const order: string[] = [];
    channel.listen({
      onStdoutLine: (line) => order.push(`out:${line}`),
      onStderrLine: (line) => order.push(`err:${line}`),
      onIoError: () => undefined,
      onClosed: () => undefined,
    });

    expect(order).toEqual([
      `err:${JSON.stringify({ type: 'happy-pi-model-catalog' })}`,
      `out:${JSON.stringify({ type: 'agent_start' })}`,
    ]);
  });

  it('delivers startup frames received before the process handle arrives', async () => {
    const { host, launch, fakePi } = createHost();
    const config = await host.ensureListening();
    const launchGate = createDeferred<PiSharedTerminalProcess>();
    launch.mockReturnValueOnce(launchGate.promise);
    const opening = host.channelHost.open(SPEC);
    const bridge = await connectBridge(config);
    sockets.push(bridge.socket);
    const receipt = vi.spyOn(logger, 'debug');
    try {
      expect(launch).toHaveBeenCalledTimes(1);
      // The ignored sentinel follows both startup frames on the same TCP stream.
      bridge.sendHello({ ch: 'err', line: 'catalog' }, { ch: 'out', line: 'start' }, {});
      await vi.waitFor(() => expect(receipt).toHaveBeenCalledWith('[pi] Ignored an unknown shared terminal frame'));
      launchGate.resolve(fakePi.process);
      const received: string[] = [];
      (await opening).listen({
        onStdoutLine: (line) => received.push(line),
        onStderrLine: (line) => received.push(line),
        onIoError: () => undefined,
        onClosed: () => undefined,
      });
      expect(received).toEqual(['catalog', 'start']);
    } finally {
      launchGate.resolve(fakePi.process);
      receipt.mockRestore();
    }
  });

  it('waits for the next hello after bye{reload}', async () => {
    const { host, launch } = createHost();
    const { config, bridge, channel } = await attachFirstBridge(host);
    const first = listenTo(channel);

    bridge.bye('reload');
    await bridge.end();
    await vi.waitFor(() => expect(first.closures).toEqual([{ kind: 'detached', reattachable: true }]));

    const reopening = host.channelHost.open(SPEC);
    const reloaded = await connectBridge(config);
    sockets.push(reloaded.socket);
    reloaded.sendHello();
    const second = listenTo(await reopening);
    reloaded.out({ type: 'agent_start' });

    await vi.waitFor(() => expect(second.stdout).toEqual([JSON.stringify({ type: 'agent_start' })]));
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('refuses startup frames from a native file other than the explicitly requested session', async () => {
    const { host } = createHost();
    const config = await host.ensureListening();
    const opening = host.channelHost.open(SPEC, {
      expectedSession: { sessionId: 'pi-session-1', sessionFile: '/tmp/original.jsonl' },
    }).then((channel) => channel, (error: unknown) => error);
    const foreign = await connectBridge(config, { sessionFile: '/tmp/imported-copy.jsonl' });
    sockets.push(foreign.socket);
    foreign.sendHello({ ch: 'out', line: JSON.stringify({ type: 'agent_start' }) });

    expect(await opening).toBeInstanceOf(PiSharedTerminalUnavailableError);
  });

  it('fails fast when the bridge closes without bye', async () => {
    const { host } = createHost();
    const { bridge, channel } = await attachFirstBridge(host);
    const first = listenTo(channel);

    await bridge.end();
    await vi.waitFor(() => expect(first.closures).toHaveLength(1));

    expect(first.closures[0]).toMatchObject({ kind: 'failed', error: { message: PI_SHARED_CONTROL_BRIDGE_UNAVAILABLE_ERROR } });
    await expect(host.channelHost.open(SPEC)).rejects.toBeInstanceOf(PiSharedTerminalUnavailableError);
  });

  it.each([
    { sessionId: 'pi-session-2', sessionFile: '/tmp/original.jsonl' },
    { sessionId: 'pi-session-1', sessionFile: '/tmp/imported-copy.jsonl' },
  ])('fences a replaced terminal session ($sessionId, $sessionFile)', async (replacement) => {
    const { host } = createHost();
    const port = createSessionPort();
    const { config, bridge, channel } = await attachFirstBridge(host, { sessionFile: '/tmp/original.jsonl' });
    const initial = listenTo(channel);
    host.publishLocalControl(port.session);
    expect(port.localControl()).toEqual({
      attached: true,
      topology: 'shared',
      remoteWritable: true,
      canAttach: false,
      canDetach: false,
    });

    bridge.bye('new');
    await bridge.end();
    await vi.waitFor(() => expect(initial.closures).toEqual([{ kind: 'detached', reattachable: true }]));

    const stdout = vi.fn();
    const stderr = vi.fn();
    const reopening = host.channelHost.open(SPEC).then((next) => {
      next.listen({ onStdoutLine: stdout, onStderrLine: stderr, onIoError: () => {}, onClosed: () => {} });
    }, (error: unknown) => error);
    const replaced = await connectBridge(config, replacement);
    sockets.push(replaced.socket);
    replaced.sendHello(
      { ch: 'out', line: JSON.stringify({ type: 'agent_start' }) },
      { ch: 'err', line: JSON.stringify({ type: 'happy-pi-model-catalog' }) },
    );

    await vi.waitFor(() => expect(port.localControl()?.remoteWritable).toBe(false));
    expect(port.notices).toHaveLength(1);
    expect(await reopening).toBeInstanceOf(PiSharedTerminalUnavailableError);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    await expect(host.channelHost.open(SPEC)).rejects.toBeInstanceOf(PiSharedTerminalUnavailableError);
  });

  it('asks for a re-attach when the terminal returns to the bound session, and is writable again only once attached', async () => {
    const { host } = createHost();
    const port = createSessionPort();
    const available = vi.fn();
    host.channelHost.onSessionAvailable?.(available);
    const { config, bridge, channel } = await attachFirstBridge(host);
    host.publishLocalControl(port.session);
    await channel.close();
    bridge.bye('new');
    await bridge.end();
    const replaced = await connectBridge(config, { sessionId: 'pi-session-2' });
    sockets.push(replaced.socket);
    replaced.sendHello();
    await vi.waitFor(() => expect(port.localControl()?.remoteWritable).toBe(false));

    replaced.bye('resume');
    await replaced.end();
    const returned = await connectBridge(config);
    sockets.push(returned.socket);
    returned.sendHello();

    await vi.waitFor(() => expect(available).toHaveBeenCalledTimes(1));
    expect(port.localControl()?.remoteWritable).toBe(false);
    const reattached = listenTo(await host.channelHost.open(SPEC));
    await vi.waitFor(() => expect(port.localControl()?.remoteWritable).toBe(true));
    returned.out({ type: 'agent_start' });
    await vi.waitFor(() => expect(reattached.stdout).toEqual([JSON.stringify({ type: 'agent_start' })]));
    expect(port.notices).toHaveLength(1);
  });

  it('restores remote delivery after a relay reconnect even without another terminal reattach', async () => {
    const { host } = createHost();
    const port = createSessionPort();
    const { config, bridge, channel } = await attachFirstBridge(host);
    host.publishLocalControl(port.session);
    await channel.close();
    bridge.bye('new');
    await bridge.end();
    const foreign = await connectBridge(config, { sessionId: 'pi-session-2' });
    sockets.push(foreign.socket);
    foreign.sendHello();
    await vi.waitFor(() => expect(port.localControl()?.remoteWritable).toBe(false));
    foreign.bye('resume');
    await foreign.end();
    await foreign.closed;

    vi.mocked(port.session.updateAgentState).mockRejectedValueOnce(new Error('state write failed'));
    const returning = host.channelHost.open(SPEC);
    const returned = await connectBridge(config);
    sockets.push(returned.socket);
    returned.sendHello();
    await returning;
    expect(port.localControl()?.remoteWritable).toBe(false);

    port.reconnect();
    await vi.waitFor(() => expect(port.localControl()?.remoteWritable).toBe(true));
    expect(port.notices).toHaveLength(1);
  });

  it('ends the runner with Pi exit code and releases the launch artifacts', async () => {
    const { host, fakePi, terminations } = createHost();
    const config = await host.ensureListening();
    const releaseArtifacts = vi.fn(async () => undefined);
    const opening = host.channelHost.open(SPEC, { retainArtifacts: releaseArtifacts });
    const bridge = await connectBridge(config);
    sockets.push(bridge.socket);
    bridge.sendHello();
    await opening;
    expect(releaseArtifacts).not.toHaveBeenCalled();

    fakePi.exit(3);

    await vi.waitFor(() => expect(terminations).toEqual([{ kind: 'exit', code: 3 }]));
    await vi.waitFor(() => expect(releaseArtifacts).toHaveBeenCalledTimes(1));
  });

  // Pi's TUI owns the screen from launch until it exits: a runner console line would corrupt it.
  it('keeps the runner console silent from Pi launch until Pi exits', async () => {
    const { host, fakePi, terminations } = createHost();
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await attachFirstBridge(host);
      logger.info('[TEST] while Pi owns the terminal');
      expect(consoleLog).not.toHaveBeenCalled();

      fakePi.exit(0);
      await vi.waitFor(() => expect(terminations).toHaveLength(1));
      logger.info('[TEST] after Pi exited');
      expect(consoleLog).toHaveBeenCalledTimes(1);
    } finally {
      consoleLog.mockRestore();
    }
  });

  it('releases launch artifacts handed to it after disposal instead of keeping them forever', async () => {
    const { host } = createHost();
    await host.dispose();
    const releaseArtifacts = vi.fn(async () => undefined);

    await expect(host.channelHost.open(SPEC, { retainArtifacts: releaseArtifacts })).rejects.toThrow(PI_SHARED_CONTROL_BRIDGE_UNAVAILABLE_ERROR);

    await vi.waitFor(() => expect(releaseArtifacts).toHaveBeenCalledTimes(1));
  });

  it('retries a fenced local-control write that failed before committing', async () => {
    const { host } = createHost();
    const port = createSessionPort();
    const { config, channel } = await attachFirstBridge(host);
    host.publishLocalControl(port.session);
    const update = vi.mocked(port.session.updateAgentState);
    update.mockRejectedValueOnce(new Error('state write failed'));
    await channel.close();
    const foreign = await connectBridge(config, { sessionId: 'pi-session-2' });
    sockets.push(foreign.socket);
    foreign.sendHello();
    await foreign.end();
    await foreign.closed;
    expect(port.localControl()?.remoteWritable).toBe(true);
    expect(update).toHaveBeenCalledTimes(2);

    host.publishLocalControl(port.session);
    expect(port.localControl()?.remoteWritable).toBe(false);
    expect(update).toHaveBeenCalledTimes(3);
  });

  it('does not mute the console or launch Pi when opening is cancelled during listener startup', async () => {
    const { host, launch } = createHost();
    const muteConsole = vi.spyOn(logger, 'muteConsole');
    const abort = new AbortController();
    const reason = new Error('startup cancelled');
    try {
      const releaseArtifacts = vi.fn(async () => {});
      const opening = host.channelHost.open(SPEC, { signal: abort.signal, retainArtifacts: releaseArtifacts });
      abort.abort(reason);
      await expect(opening).rejects.toBe(reason);
      expect(launch).not.toHaveBeenCalled();
      expect(muteConsole).not.toHaveBeenCalled();
      expect(releaseArtifacts).toHaveBeenCalledTimes(1);

      const replacement = await attachFirstBridge(host);
      await replacement.channel.close();
      await host.dispose();
      expect(releaseArtifacts).toHaveBeenCalledTimes(1);
    } finally {
      muteConsole.mockRestore();
    }
  });

  it('waits for the listener close event before disposal completes', async () => {
    const { host } = createHost();
    const config = await host.ensureListening();
    const peer = await connectBridge(config);
    sockets.push(peer.socket);
    const originalClose = Server.prototype.close;
    const listenerClosed = vi.fn();
    const close = vi.spyOn(Server.prototype, 'close').mockImplementation(function (this: Server, callback) {
      this.once('close', listenerClosed);
      return originalClose.call(this, callback);
    });
    try {
      await host.dispose();
      expect(listenerClosed).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
      await peer.closed;
    }
  });

  it('cleans up a bridge extension that finishes materializing during disposal', async () => {
    const { host } = createHost();
    const artifactGate = createDeferred<protectedArtifact.ProtectedTempTextArtifact>();
    const cleanup = vi.fn(async () => undefined);
    const materialize = vi.spyOn(protectedArtifact, 'materializeProtectedTempTextArtifact').mockReturnValueOnce(artifactGate.promise);
    try {
      const extension = host.ensureBridgeExtension();
      const disposal = host.dispose();
      artifactGate.resolve({ path: '/tmp/late-bridge.mjs', cleanup });
      await expect(extension).rejects.toThrow(PI_SHARED_CONTROL_BRIDGE_UNAVAILABLE_ERROR);
      await disposal;
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      materialize.mockRestore();
    }
  });

  it('terminates a process that arrives during disposal before releasing its launch artifacts', async () => {
    const { host, launch, fakePi, terminations } = createHost();
    const launchGate = createDeferred<PiSharedTerminalProcess>();
    const launchStarted = createDeferred();
    launch.mockImplementationOnce(() => {
      launchStarted.resolve();
      return launchGate.promise;
    });
    const releaseArtifacts = vi.fn(async () => undefined);
    const abort = new AbortController();
    const outcome = host.channelHost.open(SPEC, { retainArtifacts: releaseArtifacts, signal: abort.signal }).catch((error: unknown) => error);
    await launchStarted.promise;
    const disposal = host.dispose();
    try {
      launchGate.resolve(fakePi.process);
      await disposal;
      expect(fakePi.terminate).toHaveBeenCalledBefore(releaseArtifacts);
      expect(releaseArtifacts).toHaveBeenCalledTimes(1);
      await expect(outcome).resolves.toMatchObject({ message: PI_SHARED_CONTROL_BRIDGE_UNAVAILABLE_ERROR });
      expect(terminations).toEqual([]);
    } finally {
      abort.abort();
      await outcome;
    }
  });

  it('terminates Pi on dispose without asking the runner to terminate again', async () => {
    const { host, fakePi, terminations } = createHost();
    await attachFirstBridge(host);

    await host.dispose();

    expect(fakePi.terminate).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(terminations).toEqual([]);
  });
});
