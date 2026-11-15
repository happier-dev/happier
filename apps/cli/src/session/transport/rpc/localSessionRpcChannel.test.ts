import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { SESSION_RPC_METHODS, RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { projectSocketRpcTargetAcknowledgementV1, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createSocketIoManagerStub } from '@/testkit/backends/apiSessionSocketHarness';

// Isolated Happier home: descriptors are written under the active server directory.
const testHome = vi.hoisted(() => {
  const home = `${process.env.TMPDIR ?? '/tmp'}/happier-lsrpc-${process.pid}-${Date.now()}`;
  process.env.HAPPIER_HOME_DIR = home;
  return home;
});

/**
 * The server is the genuine network boundary here: `socket.io-client` is replaced by a relay stub
 * that counts every `rpc-call` round trip and forwards it to the Session host the way the server
 * does (Session context + caller authority stamped, target response projected into the ack).
 */
const relay = vi.hoisted(() => ({
  calls: 0,
  forward: null as null | ((payload: SocketRpcRequestPayload) => Promise<unknown>),
}));

/**
 * Peer identity is proven by the shipped native helper (SO_PEERCRED / LOCAL_PEERPID). The staged
 * binary is used when it runs on this OS; otherwise it is built from source for this platform.
 */
const peerHelper = vi.hoisted(() => ({ path: null as string | null }));
vi.mock('@/subprocess/supervision/processCustody', async (original) => ({
  ...(await original<typeof import('@/subprocess/supervision/processCustody')>()),
  resolveProcessCustodyPeerIdentityExecutable: () => peerHelper.path,
}));

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => {
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const socket = {
      io: createSocketIoManagerStub(),
      connected: false,
      on(event: string, handler: (...args: unknown[]) => void) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]); return socket;
      },
      off(event: string, handler: (...args: unknown[]) => void) {
        handlers.set(event, (handlers.get(event) ?? []).filter(item => item !== handler)); return socket;
      },
      removeListener(event: string, handler: (...args: unknown[]) => void) { return socket.off(event, handler); },
      listenerCount(event: string) { return handlers.get(event)?.length ?? 0; },
      removeAllListeners() { handlers.clear(); },
      connect() {
        socket.connected = true;
        for (const handler of handlers.get('connect') ?? []) handler();
        return socket;
      },
      disconnect() { socket.connected = false; },
      close() {},
      emit(event: string, payload: unknown, callback?: (value: unknown) => void) {
        void socket.emitWithAck(event, payload).then(callback);
        return socket;
      },
      async emitWithAck(event: string, payload: unknown) {
        if (event !== 'rpc-call') return { ok: true };
        relay.calls += 1;
        if (!relay.forward) return { ok: false, error: 'RPC method not available', errorCode: 'RPC_METHOD_NOT_AVAILABLE' };
        return projectSocketRpcTargetAcknowledgementV1(await relay.forward(payload as SocketRpcRequestPayload));
      },
    };
    return socket;
  }),
}));

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { callSessionRpc } from './sessionRpc';
import { enableLocalSessionRpcCalls, registerLocalSessionRpcTarget, retireGoneLocalSessionRpcHost } from './localSessionRpcChannel';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { captureProcessBirthWitness, type ProcessBirthWitness } from '@/daemon/processIdentity';
import type { RpcLocalActionContext } from '@/api/rpc/types';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { join, resolve as resolvePath } from 'node:path';

// This test process plays the daemon: the only caller its Session hosts admit (its published birth).
enableLocalSessionRpcCalls();
const trusted = { birth: null as ProcessBirthWitness | null, reads: 0 };
let ownBirth: ProcessBirthWitness | null = null;

function resolvePeerHelper(): string {
  const staged = resolveProcessCustodySupportExecutable(process.platform);
  if (staged) {
    try { execFileSync(staged, ['peer-identity'], { stdio: 'ignore', timeout: 10_000 }); return staged; } catch (error) {
      // A runnable helper exits non-zero without an inherited descriptor; only an unrunnable binary throws ENOEXEC/EACCES.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOEXEC' && code !== 'EACCES' && code !== 'ENOENT') return staged;
    }
  }
  const out = join(testHome, 'happier-process-custody-test');
  execFileSync('go', ['build', '-o', out, '.'], { cwd: resolvePath(__dirname, '../../../../native/processcustody'), stdio: 'ignore', timeout: 600_000 });
  return out;
}
import { EXTERNAL_ACTION_SOCKET_MIN_BUFFER_BYTES_V2 } from '@happier-dev/protocol/actions/externalActionLimits';

function token(sub: string, kind: 'account' | 'terminal' | 'api_token' | 'ephemeral_session_runner' = 'terminal'): string {
  // Canonical kind→authority pairs (AUTH_TOKEN_KIND_AUTHORITIES).
  const authority = kind === 'account' ? 'present_user'
    : kind === 'ephemeral_session_runner' ? 'session_runtime' : 'account_automation';
  const payload = Buffer.from(JSON.stringify({ sub, extras: { provenance: { v: 1, kind, authority } } })).toString('base64url');
  return `h.${payload}.s`;
}

const key = new Uint8Array(randomBytes(32));
const ctx = { encryptionKey: key, encryptionVariant: 'legacy' as const };
const SESSION = 'sess-local-1';
const OWNER = token('acct-owner');

function createHost(sessionId = SESSION) {
  const manager = new RpcHandlerManager({ scopePrefix: sessionId, scopeKind: 'session', localMachineId: 'machine-1',
    encryptionMode: 'e2ee', encryptionKey: key, encryptionVariant: 'legacy', logger: () => {} });
  const seen: Array<Readonly<{ method: string; callerAuthority: unknown; authorization: unknown; contentMode: unknown; params: unknown; aborted: () => boolean }>> = [];
  let release: (() => void) | null = null;
  const handler = (method: string) => async (params: unknown, context: any) => {
    seen.push({ method, callerAuthority: context?.callerAuthority, authorization: context?.authorization,
      contentMode: context?.contentMode, params, aborted: () => context?.signal?.aborted === true });
    if ((params as { hold?: boolean } | null)?.hold) await new Promise<void>(resolve => { release = resolve; context.signal.addEventListener('abort', () => resolve()); });
    return { runs: [], echoed: params };
  };
  manager.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, handler(SESSION_RPC_METHODS.EXECUTION_RUN_LIST));
  manager.registerHandler(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1,
    handler(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1));
  manager.registerHandler(SESSION_RPC_METHODS.SESSION_COMPACT, handler(SESSION_RPC_METHODS.SESSION_COMPACT));
  manager.registerHandler(SESSION_RPC_METHODS.SESSION_MANAGED_SERVICES_CUSTODY_V1, handler(SESSION_RPC_METHODS.SESSION_MANAGED_SERVICES_CUSTODY_V1));
  manager.registerHandler(RPC_METHODS.SESSION_PERMISSION_RESPOND, handler(RPC_METHODS.SESSION_PERMISSION_RESPOND));
  relay.forward = payload => manager.handleRequest({ ...payload, callerAuthority: 'present_user' });
  return { manager, seen, release: () => release?.() };
}

async function host(sessionId = SESSION, credentialToken = OWNER) {
  const created = createHost(sessionId);
  const retire = await registerLocalSessionRpcTarget({ sessionId, credentialToken,
    handleRequest: (request, localActionContext) => created.manager.handleRequest(request, undefined, 'local_session_channel', localActionContext),
    cancelRequest: requestId => created.manager.cancelTransportRequest(requestId),
    readTrustedCaller: async () => { trusted.reads += 1; return trusted.birth; } });
  return { ...created, retire };
}

const call = (method: string, request: unknown = { probe: 1 }, extra: Partial<Parameters<typeof callSessionRpc>[0]> = {}) =>
  callSessionRpc({ token: OWNER, sessionId: SESSION, method, request, mode: 'e2ee', ctx, ...extra } as Parameters<typeof callSessionRpc>[0]);

describe('same-machine Session RPC channel (callSessionRpc router)', () => {
  beforeAll(async () => {
    peerHelper.path = resolvePeerHelper();
    ownBirth = await captureProcessBirthWitness(process.pid);
    expect(ownBirth).not.toBeNull();
    trusted.birth = ownBirth;
  }, 600_000);
  afterEach(() => { trusted.birth = ownBirth; });

  it('retains admitted execution-run facts only on the daemon-authenticated local Session hop', async () => {
    const person = token('acct-owner', 'account');
    const live = await host(SESSION, person);
    const admitted = {
      surface: 'agent', authority: 'account_automation', actionRequestId: 'workflow/review/0',
      actionCaller: { kind: 'workflowRun', runId: 'workflow', authorization: {
        principal: { kind: 'host' }, admittedPermissionCeiling: 'default',
      } },
      agentStartWorkDepth: 3, agentStartWorkspaceWrites: 'deny',
      agentStartContext: { caller: { kind: 'originless', runId: 'workflow', runDepth: 2 },
        baseline: { machineId: 'machine-1', directory: '/repo' }, ledSubtreeSessionIds: [],
        workDepthLimit: 4, roles: {}, callerPermissionCeiling: 'default' },
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' },
      callerPermissionMode: 'read_only', executionRunWorkflowRunId: 'workflow',
    } satisfies RpcLocalActionContext;
    live.manager.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START, async (params, context) => {
      const action = buildActionExecutorContextForRpc({ ...context, actionId: 'execution.run.start', defaultSessionId: SESSION });
      return { sessionId: action.defaultSessionId, admitted: context?.localActionContext, input: params,
        ...(context?.localActionContext ? { effective: { authority: action.authority, depth: action.agentStartWorkDepth,
          writes: action.agentStartWorkspaceWrites, mode: action.callerPermissionMode,
          causal: action.causalPermissionAuthority, caller: action.actionCaller, workflowRunId: action.executionRunWorkflowRunId } } : {}) };
    });
    try {
      await expect(call(SESSION_RPC_METHODS.EXECUTION_RUN_START, { instructions: 'Review' }, {
        token: person, localActionContext: admitted,
      })).resolves.toEqual({ sessionId: SESSION, admitted, input: { instructions: 'Review' },
        effective: { authority: 'account_automation', depth: 3, writes: 'deny', mode: 'read_only', causal: admitted.causalPermissionAuthority,
          caller: admitted.actionCaller, workflowRunId: 'workflow' } });
      expect(relay.calls).toBe(0);
      // A public request operand cannot supply the private transport context.
      await expect(call(SESSION_RPC_METHODS.EXECUTION_RUN_START, {
        instructions: 'Review', localActionContext: admitted,
      }, { token: person })).resolves.toEqual({ sessionId: SESSION, input: { instructions: 'Review', localActionContext: admitted } });
      expect(relay.calls).toBe(1);
    } finally { await live.retire(); }
    // Losing the private route must not spill or silently drop its admission on Home RPC.
    await expect(call(SESSION_RPC_METHODS.EXECUTION_RUN_START, { instructions: 'Review' }, {
      token: person, localActionContext: admitted,
    })).rejects.toMatchObject({ code: 'execution_run_target_unavailable' });
    expect(relay.calls).toBe(1);
  });

  it('refuses an admitted start on a retained host without the private context capability', async () => {
    const live = await host();
    try {
      const [file] = await findDescriptors(`${testHome}/servers`);
      const descriptor = JSON.parse(await readFile(file!, 'utf8'));
      delete descriptor.admittedStartContextVersion;
      await writeFile(file!, JSON.stringify(descriptor));
      await expect(call(SESSION_RPC_METHODS.EXECUTION_RUN_START, { instructions: 'Review' }, {
        localActionContext: { agentStartWorkDepth: 3, agentStartWorkspaceWrites: 'deny' },
      })).rejects.toMatchObject({ code: 'execution_run_target_unavailable' });
      expect(live.seen).toHaveLength(0);
      expect(relay.calls).toBe(0);
    } finally { await live.retire(); }
  });

  it('publishes usable local provider input after late handler installation without a Home registration ACK', async () => {
    const created = createHost();
    const published = vi.fn();
    const retire = await registerLocalSessionRpcTarget({ sessionId: SESSION, credentialToken: OWNER,
      handleRequest: request => created.manager.handleRequest(request, undefined, 'local_session_channel'),
      cancelRequest: requestId => created.manager.cancelTransportRequest(requestId),
      readTrustedCaller: async () => trusted.birth, onPublished: published });
    try {
      expect(published).toHaveBeenCalledOnce();
      created.manager.registerHandler(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION, async () => ({ status: 'enforced' }));
      await expect(call(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION, {
        action: 'enforce', serviceId: 'service', groupId: 'group', reason: 'group_unavailable',
      })).resolves.toEqual({ status: 'enforced' });
      expect(relay.calls).toBe(0);
      expect(created.manager.isHandlerRegistrationAcknowledged(SESSION_RPC_METHODS.SESSION_PROVIDER_INPUT_ADMISSION)).toBe(false);
    } finally { await retire(); }
    const unsupported = vi.fn();
    const retireUnsupported = await registerLocalSessionRpcTarget({ sessionId: SESSION, credentialToken: token('acct-owner', 'api_token'),
      handleRequest: async () => ({}), cancelRequest: () => {}, readTrustedCaller: async () => trusted.birth,
      onPublished: unsupported });
    try { expect(unsupported).not.toHaveBeenCalled(); } finally { await retireUnsupported(); }
  });

  it('admits only the daemon that spawned or adopted the host: another same-user process is refused', async () => {
    const live = await host();
    try {
      const [file] = await findDescriptors(`${testHome}/servers`);
      const socketPath = JSON.parse(await readFile(file!, 'utf8')).endpoint.path;
      const body = JSON.stringify({ packet: { method: `${SESSION}:${SESSION_RPC_METHODS.EXECUTION_RUN_LIST}`, params: {} },
        callerAuthority: 'present_user', localActionContext: { authority: 'present_user', agentStartWorkDepth: 0 } });
      // A separate same-uid process (e.g. a sandboxed agent shell) posting straight to the socket.
      const script = `const r=require('node:http').request({socketPath:process.argv[1],path:'/v1/session-rpc/call',method:'POST',
        headers:{'content-type':'application/json'}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{process.stdout.write(res.statusCode+' '+b)})});
        r.end(process.argv[2]);`;
      const child = spawn(process.execPath, ['-e', script, socketPath, body], { stdio: ['ignore', 'pipe', 'inherit'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      await new Promise(resolve => child.once('close', resolve));
      expect(output).toMatch(/^403 .*local_session_peer_refused/);
      expect(live.seen).toHaveLength(0);
      // The daemon itself (this process) is admitted on the same socket.
      await expect(call(SESSION_RPC_METHODS.EXECUTION_RUN_LIST)).resolves.toMatchObject({ runs: [] });
      expect([live.seen.length, relay.calls]).toEqual([1, 0]);
    } finally { await live.retire(); }
  }, 60_000);

  it('refuses a peer holding a recycled daemon pid (stale state after an unclean daemon exit): served through the server', async () => {
    const live = await host();
    const remote = createHost();
    try {
      // The published state names this pid, but a daemon generation born at another instant.
      const start = ownBirth!.start;
      trusted.birth = { pid: process.pid, start: { startTimeMs: start.startTimeMs + 1_000,
        ...(start.native ? { native: `${start.native}-previous-generation` } : {}) } };
      await expect(call(SESSION_RPC_METHODS.EXECUTION_RUN_LIST)).resolves.toMatchObject({ runs: [] });
      expect([live.seen.length, remote.seen.length, relay.calls]).toEqual([0, 1, 1]);
      // The real daemon generation is admitted on the same kept-alive connection.
      trusted.birth = ownBirth;
      await expect(call(SESSION_RPC_METHODS.EXECUTION_RUN_LIST)).resolves.toMatchObject({ runs: [] });
      expect([live.seen.length, remote.seen.length, relay.calls]).toEqual([1, 1, 1]);
    } finally { await live.retire(); }
  });

  it('admits the daemon peer once per accepted connection: 20 calls on one kept-alive connection read the daemon state once', async () => {
    const live = await host();
    try {
      trusted.reads = 0;
      for (let index = 0; index < 20; index += 1) {
        await expect(call(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, { index })).resolves.toMatchObject({ runs: [] });
      }
      expect([live.seen.length, relay.calls, trusted.reads]).toEqual([20, 0, 1]);
    } finally { await live.retire(); }
  });

  it('a host adopted by another daemon refuses this process; the call is served through the server instead', async () => {
    const live = await host();
    const remote = createHost();
    try {
      trusted.birth = { ...ownBirth!, pid: process.pid + 1_000_000 };
      await expect(call(SESSION_RPC_METHODS.EXECUTION_RUN_LIST)).resolves.toMatchObject({ runs: [] });
      expect([live.seen.length, remote.seen.length, relay.calls]).toEqual([0, 1, 1]);
    } finally { await live.retire(); }
  });

  afterEach(() => { relay.calls = 0; relay.forward = null; });
  afterAll(async () => { await rm(testHome, { recursive: true, force: true }); });

  it('serves a daemon→runner call with 0 server round trips once the Session host publishes its channel (paired: 1 before)', async () => {
    // Before: no local host published for the Session → today's server relay path.
    createHost();
    await expect(call(SESSION_RPC_METHODS.EXECUTION_RUN_LIST)).resolves.toEqual({ runs: [], echoed: { probe: 1 } });
    expect(relay.calls).toBe(1);

    relay.calls = 0;
    const live = await host();
    try {
      await expect(call(SESSION_RPC_METHODS.EXECUTION_RUN_LIST)).resolves.toEqual({ runs: [], echoed: { probe: 1 } });
      await expect(call(SESSION_RPC_METHODS.SESSION_PENDING_QUEUE_WAKE_CAPABILITY_GET_V1)).resolves.toMatchObject({ runs: [] });
      expect(relay.calls).toBe(0);
      // The host saw the same Session context the server mints for the Session's own Account.
      expect(live.seen.map(entry => entry.authorization)).toEqual([
        { kind: 'session.write', sessionId: SESSION }, { kind: 'session.write', sessionId: SESSION }]);
      expect(live.seen[0]!.callerAuthority).toBe('present_user');
    } finally { await live.retire(); }
  });

  it('goes local only for Account/terminal credentials: restricted kinds keep the server admission', async () => {
    const live = await host();
    const remote = createHost();
    try {
      await call(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {}, { token: token('acct-owner', 'ephemeral_session_runner') });
      await call(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {}, { token: token('acct-owner', 'api_token') });
      expect(relay.calls).toBe(2);
      expect([live.seen.length, remote.seen.length]).toEqual([0, 2]);
    } finally { await live.retire(); }
  });

  it('retire and the liveness owner delete only their own descriptor; a gone host ends in-flight local calls', async () => {
    const live = await host();
    const [file] = await findDescriptors(`${testHome}/servers`);
    const original = await readFile(file!, 'utf8');
    const { writeFile } = await import('node:fs/promises');
    try {
      // A successor host replaced the descriptor: the predecessor's liveness retirement keeps it.
      await writeFile(file!, JSON.stringify({ ...JSON.parse(original), pid: 999_999 }), { mode: 0o600 });
      await retireGoneLocalSessionRpcHost({ sessionId: SESSION, pid: process.pid });
      expect(await findDescriptors(`${testHome}/servers`)).toHaveLength(1);
      await writeFile(file!, original, { mode: 0o600 });
      // The liveness owner reports this host gone while a call is in flight: the call ends, unsent to the server.
      const pending = call(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, { hold: true }, { timeoutMs: null })
        .then(() => 'resolved', () => 'rejected');
      await vi.waitFor(() => expect(live.seen).toHaveLength(1));
      await retireGoneLocalSessionRpcHost({ sessionId: SESSION, pid: process.pid });
      await expect(pending).resolves.toBe('rejected');
      expect(relay.calls).toBe(0);
      expect(await findDescriptors(`${testHome}/servers`)).toEqual([]);
    } finally { live.release(); await live.retire(); }
  });

  it('enforces the relay transport budget on local bodies (nothing dispatched above it)', async () => {
    const live = await host();
    try {
      const [file] = await findDescriptors(`${testHome}/servers`);
      const descriptor = JSON.parse(await readFile(file!, 'utf8'));
      const oversized = 'x'.repeat(EXTERNAL_ACTION_SOCKET_MIN_BUFFER_BYTES_V2 + 1);
      // The host stops reading at the budget: the writer sees 413 or a reset, never a dispatched handler.
      const direct = await post(descriptor.endpoint.path, { packet: { method: `${SESSION}:${SESSION_RPC_METHODS.EXECUTION_RUN_LIST}`, params: oversized },
        callerAuthority: 'present_user' }).then(result => result.status, () => 'reset');
      expect([413, 'reset']).toContain(direct);
      await expect(call(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, { blob: oversized })).rejects.toBeDefined();
      expect([live.seen.length, relay.calls]).toEqual([0, 0]);
    } finally { await live.retire(); }
  });

  it('routes daemon managed-services custody locally under the same Session-owner rule', async () => {
    const live = await host();
    try {
      await expect(call(SESSION_RPC_METHODS.SESSION_MANAGED_SERVICES_CUSTODY_V1, { v: 1, kind: 'readAdoptedPublicOutcome' }))
        .resolves.toMatchObject({ runs: [] });
      expect(relay.calls).toBe(0);
      expect(live.seen.at(-1)!.authorization).toEqual({ kind: 'session.write', sessionId: SESSION });
    } finally { await live.retire(); }
  });

  it('reads no Session record on the local hop; the server path reads it once and stays sealed', async () => {
    let recordReads = 0;
    const deferred = () => ({ mode: 'deferred' as const, resolveEncryption: async () => { recordReads += 1; return { mode: 'e2ee' as const, ctx }; } });
    // Server path (no host published): the record is read and the packet is Session-key sealed.
    const relayed: unknown[] = [];
    const remote = createHost();
    relay.forward = payload => { relayed.push(payload.params); return remote.manager.handleRequest({ ...payload, callerAuthority: 'present_user' }); };
    await callSessionRpc({ token: OWNER, sessionId: SESSION, method: SESSION_RPC_METHODS.EXECUTION_RUN_LIST,
      request: { secret: 'never-to-server' }, ...deferred() });
    expect([recordReads, relay.calls]).toEqual([1, 1]);
    expect(typeof relayed[0]).toBe('string');
    expect(String(relayed[0])).not.toContain('never-to-server');

    recordReads = 0; relay.calls = 0;
    const live = await host();
    try {
      await expect(callSessionRpc({ token: OWNER, sessionId: SESSION, method: SESSION_RPC_METHODS.EXECUTION_RUN_LIST,
        request: { secret: 'stays-local' }, ...deferred() })).resolves.toEqual({ runs: [], echoed: { secret: 'stays-local' } });
      expect([recordReads, relay.calls]).toEqual([0, 0]);
      // Handlers keep the Session's real content mode even though the local hop uses the plain codec.
      expect(live.seen.at(-1)).toMatchObject({ contentMode: 'e2ee', params: { secret: 'stays-local' } });
    } finally { await live.retire(); }
  });

  it('narrows caller authority to the caller ceiling and never above the Session credential', async () => {
    const live = await host();
    try {
      await call(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {}, { authorityCeiling: 'account_automation' });
      expect(live.seen.at(-1)!.callerAuthority).toBe('account_automation');
      expect(relay.calls).toBe(0);
    } finally { await live.retire(); }
    // A restricted host credential (API token, ephemeral runner) never serves locally.
    for (const kind of ['api_token', 'ephemeral_session_runner'] as const) {
      const restricted = await host(SESSION, token('acct-owner', kind));
      try {
        expect(await findDescriptors(`${testHome}/servers`)).toEqual([]);
        await call(SESSION_RPC_METHODS.EXECUTION_RUN_LIST);
        expect(relay.calls).toBeGreaterThan(0);
      } finally { await restricted.retire(); relay.calls = 0; }
    }
  });

  it('keeps the server path for another Account, server-proven actors, fresh Machine admission and external Actions', async () => {
    const live = await host();
    try {
      await call(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {}, { token: token('acct-other') });
      expect(relay.calls).toBe(1);
      await call(RPC_METHODS.SESSION_PERMISSION_RESPOND, {});
      expect(relay.calls).toBe(2);
      await call(SESSION_RPC_METHODS.SESSION_COMPACT, {});
      expect(relay.calls).toBe(3);
      expect(live.seen.every(entry => entry.callerAuthority === 'present_user')).toBe(true);
    } finally { await live.retire(); }
  });

  it('routes through the server when the published host is gone (not dispatched locally)', async () => {
    const live = await host();
    // Simulate a crashed host: the endpoint closes while its descriptor stays on disk.
    const descriptorDir = `${testHome}/servers`;
    await live.retire();
    const stale = await host();
    const files = await findDescriptors(descriptorDir);
    const descriptor = JSON.parse(await readFile(files[0]!, 'utf8'));
    await stale.retire();
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(files[0]!.slice(0, files[0]!.lastIndexOf('/')), { recursive: true, mode: 0o700 });
    await writeFile(files[0]!, JSON.stringify(descriptor), { mode: 0o600 });
    createHost();
    await expect(call(SESSION_RPC_METHODS.EXECUTION_RUN_LIST)).resolves.toMatchObject({ runs: [] });
    expect(relay.calls).toBe(1);
    await rm(files[0]!, { force: true });
  });

  it('propagates caller cancellation to the hosted handler', async () => {
    const live = await host();
    try {
      const controller = new AbortController();
      const pending = call(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, { hold: true }, { signal: controller.signal, timeoutMs: null });
      await vi.waitFor(() => expect(live.seen).toHaveLength(1));
      controller.abort();
      await expect(pending).rejects.toBeDefined();
      await vi.waitFor(() => expect(live.seen[0]!.aborted()).toBe(true));
      expect(relay.calls).toBe(0);
    } finally { live.release(); await live.retire(); }
  });

  it('never connects to an endpoint whose directory is no longer owner-only (crashed host, recreated temp dir)', async () => {
    const live = await host();
    const [file] = await findDescriptors(`${testHome}/servers`);
    const endpointDir = JSON.parse(await readFile(file!, 'utf8')).endpoint.path.replace(/\/[^/]+$/, '');
    const { chmod } = await import('node:fs/promises');
    try {
      const remote = createHost();
      await chmod(endpointDir, 0o777);
      await expect(call(SESSION_RPC_METHODS.EXECUTION_RUN_LIST)).resolves.toMatchObject({ runs: [] });
      expect(relay.calls).toBe(1);
      expect([live.seen.length, remote.seen.length]).toEqual([0, 1]);
    } finally { await chmod(endpointDir, 0o700); await live.retire(); }
  });

  it('never connects to a listener whose endpoint directory sits in a shared world-writable directory (sticky /tmp)', async () => {
    const { chmod, mkdtemp, writeFile } = await import('node:fs/promises');
    const { realpathSync } = await import('node:fs');
    const { createServer } = await import('node:http');
    const live = await host();
    const [file] = await findDescriptors(`${testHome}/servers`);
    const descriptor = JSON.parse(await readFile(file!, 'utf8'));
    // A same-uid process able to write the shared temp root binds its own listener there.
    const shared = realpathSync('/tmp');
    const spoofDir = await mkdtemp(join(shared, 'happier-srpc-'));
    await chmod(spoofDir, 0o700);
    let spoofed = 0;
    const spoof = createServer((_request, response) => { spoofed += 1; response.end(JSON.stringify({ ok: true, result: { runs: ['forged'] } })); });
    await new Promise<void>(resolve => spoof.listen(join(spoofDir, 'rpc.sock'), resolve));
    try {
      const remote = createHost();
      await writeFile(file!, JSON.stringify({ ...descriptor, endpoint: { ...descriptor.endpoint, path: join(spoofDir, 'rpc.sock') } }));
      await expect(call(SESSION_RPC_METHODS.EXECUTION_RUN_LIST)).resolves.toMatchObject({ runs: [] });
      expect([spoofed, live.seen.length, remote.seen.length, relay.calls]).toEqual([0, 0, 1, 1]);
    } finally {
      await new Promise<void>(resolve => spoof.close(() => resolve()));
      await rm(spoofDir, { recursive: true, force: true });
      await writeFile(file!, JSON.stringify(descriptor));
      await live.retire();
    }
  });

  it('is owner-only: 0700 descriptor dir, 0600 descriptor and socket, server-only fields refused', async () => {
    const live = await host();
    try {
      const [file] = await findDescriptors(`${testHome}/servers`);
      const descriptor = JSON.parse(await readFile(file!, 'utf8'));
      expect((await lstat(file!)).mode & 0o777).toBe(0o600);
      expect((await lstat(file!.slice(0, file!.lastIndexOf('/')))).mode & 0o777).toBe(0o700);
      expect(descriptor.endpoint.kind).toBe('unix');
      expect((await lstat(descriptor.endpoint.path)).mode & 0o777).toBe(0o600);
      expect((await lstat(descriptor.endpoint.path.slice(0, descriptor.endpoint.path.lastIndexOf('/')))).mode & 0o777).toBe(0o700);
      expect(JSON.stringify(descriptor)).not.toContain(OWNER);

      expect(descriptor).not.toHaveProperty('bearer');
      const packet = { method: `${SESSION}:${SESSION_RPC_METHODS.EXECUTION_RUN_LIST}`, params: 'x' };
      const smuggled = await post(descriptor.endpoint.path, {
        packet: { ...packet, machineAdmission: { machineId: 'machine-1' } }, callerAuthority: 'present_user' });
      expect(smuggled.status).toBe(403);
      const actor = await post(descriptor.endpoint.path, {
        packet: { ...packet, method: `${SESSION}:${RPC_METHODS.SESSION_PERMISSION_RESPOND}` }, callerAuthority: 'present_user' });
      expect(actor.status).toBe(403);
      expect(live.seen).toHaveLength(0);
    } finally { await live.retire(); }
    expect(await findDescriptors(`${testHome}/servers`)).toEqual([]);
  });

  it('addresses Sessions by sessionId: one listener serves several hosted Sessions', async () => {
    const first = await host('sess-a');
    const second = await host('sess-b');
    try {
      const descriptors = await Promise.all((await findDescriptors(`${testHome}/servers`)).map(async f => JSON.parse(await readFile(f, 'utf8'))));
      expect(new Set(descriptors.map(d => d.endpoint.path)).size).toBe(1);
      expect(descriptors.map(d => d.sessionId).sort()).toEqual(['sess-a', 'sess-b']);
      await callSessionRpc({ token: OWNER, sessionId: 'sess-a', method: SESSION_RPC_METHODS.EXECUTION_RUN_LIST, request: {}, mode: 'e2ee', ctx });
      await callSessionRpc({ token: OWNER, sessionId: 'sess-b', method: SESSION_RPC_METHODS.EXECUTION_RUN_LIST, request: {}, mode: 'e2ee', ctx });
      expect(first.seen).toHaveLength(1);
      expect(second.seen).toHaveLength(1);
      expect(relay.calls).toBe(0);
    } finally { await first.retire(); await second.retire(); }
  });
});

async function findDescriptors(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (dir.endsWith('/session-rpc') && entry.name.endsWith('.json')) out.push(path);
    }
  };
  await walk(root);
  return out;
}

function post(socketPath: string, body: unknown): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = httpRequest({ socketPath, path: '/v1/session-rpc/call', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } }, res => {
      res.resume(); res.once('end', () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.once('error', reject);
    req.end(text);
  });
}
