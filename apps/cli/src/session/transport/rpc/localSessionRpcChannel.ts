import { SessionLifecycleStateReasonSchema, type SessionLifecycleStateReason } from '@happier-dev/protocol/sessions/control/sessionLifecycleStateReason';
import { SessionRuntimeFailureCauseV1Schema, type SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { SessionSpawnLaunchErrorV1Schema, type SessionSpawnLaunchErrorV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnLaunchErrorV1';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type Agent, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { readAuthTokenProvenance, type AuthTokenKind } from '@happier-dev/protocol/auth/authToken';
import { resolveSocketRpcCallerAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { EXTERNAL_ACTION_SOCKET_MIN_BUFFER_BYTES_V2 } from '@happier-dev/protocol/actions/externalActionLimits';
import { projectSocketRpcTargetAcknowledgementV1, SOCKET_RPC_EVENTS, SocketRpcCancellationPayloadSchema } from '@happier-dev/protocol/rpc/socketTransport';
import { resolveSocketRpcSameAccountSessionAuthorizationV1 } from '@happier-dev/protocol/rpc/socketSessionAuthorization';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import type { SocketRpcSocket } from '@happier-dev/sync-client';
import { decodeJwtPayload, readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { createOwnerOnlyLocalEndpoint, isOwnerOnlyPath, resolveOwnerOnlySocketRoot, type OwnerOnlyLocalEndpoint } from '@/utils/ipc/ownerOnlyLocalEndpoint';
import { observeLocalIpcPeerIdentity, resolveProcessCustodyPeerIdentityExecutable,
  type ProcessCustodyPeerIdentity } from '@/subprocess/supervision/processCustody';
import type { ProcessBirthWitness } from '@/daemon/processIdentity';
import type { RpcLocalActionContext } from '@/api/rpc/types';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { AgentRuntimeRunnerBootstrapV1 } from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { createLocalSessionRpcAgent } from './localSessionRpcAgent';

/**
 * Same-machine Session RPC channel.
 *
 * A Session host process (today one runner, later one host for many Sessions) serves every Session
 * it hosts on ONE owner-only local endpoint and publishes one descriptor per sessionId. The
 * existing Session RPC router (`callSessionRpc`) reads the descriptor for its target sessionId and,
 * when the caller holds the same Account, issues the SocketRpc packet over this endpoint instead.
 * The host feeds it into the same Session `RpcHandlerManager` admission and handlers, with the
 * Session context the server would mint for the Session's own Account. The local hop uses the plain
 * codec: both ends already hold the Session key, the hop never leaves the machine, so the caller
 * needs no Session record read. Every server-path packet stays sealed (E2EE toward the server is
 * unchanged); handlers keep the Session's real content mode.
 *
 * Trust boundary: the OS user. Descriptors live in a 0700 directory under the active server
 * directory (0600 files); the endpoint is a 0600 unix socket inside a private 0700 directory under
 * an owner-only root (never shared temp), and the caller verifies both before connecting. The
 * caller must be the daemon's published process generation (kernel peer pid + birth). Windows hosts serve a named pipe with an owner-SID-only DACL, but
 * clients verify the connected pipe server's user SID before sending private input.
 */

const DESCRIPTOR_VERSION = 1;
const CALL_PATH = '/v1/session-rpc/call';
const CANCEL_PATH = '/v1/session-rpc/cancel';
/** The daemon hands a hosted Session a secret before serving it to that Session's Agent. */
const TRANSCRIPT_SECRETS_PATH = '/v1/session-rpc/transcript-secrets';
/** Ordinary Session RPC packet fields a caller may send; routing/authority fields are server-only. */
const LOCAL_PACKET_FIELDS: ReadonlySet<string> = new Set([
  'method', 'params', 'requestId', 'traceId', 'timeoutMs', 'waitForResultOnCancel', 'authorization',
  'transportResponseEnvelopeVersion',
]);

type LocalCallerAuthority = 'present_user' | 'account_automation';
/** Admitted facts only: Account credential material and callable services are not transport fields. */
export type LocalSessionRpcActionContext = Readonly<Pick<RpcLocalActionContext,
  'surface' | 'authority' | 'actionCaller' | 'actionRequestId' | 'callerPermissionMode' | 'causalPermissionAuthority'
  | 'agentStartContext' | 'agentStartWorkDepth' | 'agentStartWorkspaceWrites' | 'sessionAgentSpawnPolicyV1'
  | 'executionRunWorkflowRunId' | 'executionRunWorkflowScope' | 'requesterWorkAttributionV1'>>;
const LOCAL_ROUTE_CREDENTIAL_KINDS: ReadonlySet<AuthTokenKind> = new Set(['account', 'account_directory', 'terminal']);

type LocalSessionRpcDescriptorV1 = Readonly<{
  v: typeof DESCRIPTOR_VERSION;
  sessionId: string;
  accountId: string;
  endpoint: Readonly<{ kind: 'unix' | 'named_pipe'; path: string }>;
  pid: number;
  admittedStartContextVersion?: 1;
  /** Published only for transcript registration: Session RPC keeps the server path. */
  rpcCalls?: false;
}>;

export type LocalSessionRpcTarget = Readonly<{
  sessionId: string;
  /** The Session's own credential: its Account and authority bound what local callers receive. */
  credentialToken: string;
  /** The Session's existing RPC admission and handlers (`RpcHandlerManager.handleRequest` with source `local_session_channel`). */
  handleRequest(request: SocketRpcRequestPayload, localActionContext?: LocalSessionRpcActionContext): Promise<unknown>;
  cancelRequest(requestId: string): void;
  /**
   * The process generation of the daemon that spawned or adopted this host (its current published
   * state). Only a connection whose kernel-proven peer is that process, under this OS user, may call.
   */
  readTrustedCaller(): Promise<ProcessBirthWitness | null>;
  /** Called only after the eligible local target is published; retirement invalidates the predicate. */
  onPublished?: (isMethodAvailable: (method: string) => boolean) => void;
  /**
   * Registers secret values the daemon is about to serve to this Session's Agent (request-auth
   * credentials) in this Session's transcript scope, for the Session's life.
   */
  registerTranscriptSecrets?: (values: readonly string[]) => void;
  /**
   * False when this runtime writes the Session's transcript but its Session RPC must keep the
   * server admission (another person's runtime of a shared Session). Restricted credential kinds
   * keep the server path regardless.
   */
  rpcCalls?: false;
}>;

type RegisteredTarget = Readonly<{
  target: LocalSessionRpcTarget;
  /** Whether this target serves Session RPC locally; otherwise it only takes transcript registration. */
  rpcCalls: boolean;
  accountId: string;
  authority: LocalCallerAuthority;
  descriptorPath: string;
}>;

type Ingress = {
  readonly server: Server;
  front?: NetServer;
  readonly sockets: Set<Socket>;
  readonly endpoint: OwnerOnlyLocalEndpoint;
  readonly directory: string | null;
  readonly targets: Map<string, RegisteredTarget>;
  /** Set while this process is a session host: its daemon adds and ends Sessions here. */
  host?: LocalSessionHostAdmission;
};

let ingress: Promise<Ingress> | null = null;

function readCredentialKind(token: string): AuthTokenKind | null {
  const payload = decodeJwtPayload(token);
  return payload ? readAuthTokenProvenance(payload, { allowLegacyHome: true })?.provenance.kind ?? null : null;
}

function resolveDescriptorDirectory(): string {
  return join(configuration.activeServerDir, 'session-rpc');
}

function resolveDescriptorPath(sessionId: string): string {
  return join(resolveDescriptorDirectory(), `${createHash('sha256').update(sessionId).digest('hex').slice(0, 40)}.json`);
}

function minAuthority(a: LocalCallerAuthority, b: LocalCallerAuthority): LocalCallerAuthority {
  return a === 'present_user' && b === 'present_user' ? 'present_user' : 'account_automation';
}

/** A body over the server's Socket.IO transport budget: the same packet would not cross the relay. */
export class LocalSessionRpcBodyTooLargeError extends Error {
  readonly code = 'local_session_rpc_body_too_large';
}

/** Reads one body within the relay's packet budget (`EXTERNAL_ACTION_SOCKET_MIN_BUFFER_BYTES_V2`). */
function readBody(stream: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > EXTERNAL_ACTION_SOCKET_MIN_BUFFER_BYTES_V2) {
        stream.destroy();
        reject(new LocalSessionRpcBodyTooLargeError('Local Session RPC body exceeds the transport budget'));
        return;
      }
      chunks.push(chunk);
    });
    stream.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.once('error', reject);
  });
}

const LOCAL_SESSION_PEER_REFUSED = 'local_session_peer_refused';
/** A connection's kernel-proven peer under this OS user, with the process generation holding that pid. */
type CallerPeer = ProcessCustodyPeerIdentity & Readonly<{ birth: ProcessBirthWitness | null }>;
const peerIdentities = new WeakMap<Socket, CallerPeer | null>();

async function observeCallerPeer(socket: Socket, endpoint: OwnerOnlyLocalEndpoint): Promise<CallerPeer | null> {
  // The Windows relay owns the SID-only pipe and authenticates its kernel client
  // PID before handing us the loopback stream; querying that stream sees the relay.
  const relayPid = endpoint.peerPid(socket);
  const executablePath = process.platform === 'win32' ? null : resolveProcessCustodyPeerIdentityExecutable(process.platform);
  const identity = process.platform === 'win32'
    ? relayPid === undefined ? null : { pid: relayPid, uid: null }
    : executablePath ? await observeLocalIpcPeerIdentity({ socket, executablePath }).catch(() => null) : null;
  if (!identity || (process.platform !== 'win32' && identity.uid !== process.getuid?.())) return null;
  // Read right after accept: a pid recycled after an unclean daemon exit carries another birth.
  const { captureProcessBirthWitness } = await import('@/daemon/processIdentity');
  return { ...identity, birth: await captureProcessBirthWitness(identity.pid).catch(() => null) };
}

/**
 * Connections admitted as the daemon, per daemon-generation reader. The kernel peer of a connection
 * never changes, so the admission holds for the connection's life (owner ruling 2026-11-14 O2: the
 * peer check runs at connect only); a recycled pid or another process opens its own connection and
 * is checked there. Only admissions are kept: a refused connection is checked again on its next
 * request, so a daemon that connected before publishing its state is admitted once it has.
 */
const admittedConnections = new WeakMap<Socket, Set<() => Promise<ProcessBirthWitness | null>>>();

/**
 * The caller is the host's own daemon under this OS user: its kernel-proven pid and that pid's
 * process birth both match the daemon's published generation. Anything unprovable is refused.
 */
async function isTrustedCaller(
  owner: Readonly<{ readTrustedCaller(): Promise<ProcessBirthWitness | null> }>,
  request: IncomingMessage,
): Promise<boolean> {
  const socket = request.socket as Socket;
  if (admittedConnections.get(socket)?.has(owner.readTrustedCaller)) return true;
  const refuse = (reason: string): false => {
    logger.warnLocalFile('[SESSION LOCAL RPC] Caller peer refused', { reason });
    return false;
  };
  const peer = peerIdentities.get(socket);
  if (!peer) return refuse('peer_identity_unproven');
  if (!peer.birth) return refuse('peer_birth_unproven');
  if (process.platform !== 'win32' && peer.uid !== process.getuid?.()) return refuse('peer_uid_mismatch');
  const trusted = await owner.readTrustedCaller().catch(() => null);
  if (!trusted) return refuse('daemon_birth_unpublished');
  if (trusted.pid !== peer.pid) return refuse('daemon_pid_mismatch');
  const { compareProcessBirth } = await import('@/daemon/processIdentity');
  if (compareProcessBirth(trusted, { status: 'same', witness: peer.birth }).status !== 'same') return refuse('daemon_birth_mismatch');
  const admitted = admittedConnections.get(socket) ?? new Set();
  admitted.add(owner.readTrustedCaller);
  admittedConnections.set(socket, admitted);
  return true;
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

/** Admit one local packet into the exact shape the server forwards to a Session for its own Account. */
function admitLocalPacket(current: Ingress, body: unknown): Readonly<{ registered: RegisteredTarget; request: SocketRpcRequestPayload }>
  | Readonly<{ status: number; error: string; errorCode: string }> {
  const forbidden = { status: 403, error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' } as const;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return forbidden;
  const { packet, callerAuthority, localActionContext } = body as {
    packet?: unknown; callerAuthority?: unknown; localActionContext?: LocalSessionRpcActionContext;
  };
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return forbidden;
  if (callerAuthority !== 'present_user' && callerAuthority !== 'account_automation') return forbidden;
  const fields = packet as Record<string, unknown>;
  if (Object.keys(fields).some(key => !LOCAL_PACKET_FIELDS.has(key))) return forbidden;
  const method = fields.method;
  if (typeof method !== 'string') return forbidden;
  const separator = method.indexOf(':');
  const sessionId = separator > 0 ? method.slice(0, separator) : '';
  const registered = current.targets.get(sessionId);
  if (!registered?.rpcCalls) return { status: 404, error: 'Session is not hosted on this local channel', errorCode: 'local_session_unavailable' };
  const authorization = resolveSocketRpcSameAccountSessionAuthorizationV1(method.slice(separator + 1), sessionId,
    { admittedAgentStart: Boolean(localActionContext) });
  if (!authorization) return forbidden;
  const request: SocketRpcRequestPayload = {
    method,
    params: fields.params,
    callerAuthority: minAuthority(registered.authority, callerAuthority),
    authorization,
    ...(typeof fields.requestId === 'string' ? { requestId: fields.requestId } : {}),
    ...(typeof fields.traceId === 'string' ? { traceId: fields.traceId } : {}),
    ...(typeof fields.timeoutMs === 'number' ? { timeoutMs: fields.timeoutMs } : {}),
    ...(fields.waitForResultOnCancel === true ? { waitForResultOnCancel: true } : {}),
    ...(fields.transportResponseEnvelopeVersion === 1 ? { transportResponseEnvelopeVersion: 1 as const } : {}),
  };
  return { registered, request };
}

async function handleIngressRequest(current: Ingress, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === 'POST' && (request.url === HOST_ADD_PATH || request.url === HOST_END_PATH || request.url === HOST_WATCH_PATH
    || request.url === HOST_HANDOVER_PATH || request.url === HOST_HOLD_PATH || request.url === HOST_LIVE_WORK_PATH
    || request.url === HOST_IDLE_PATH || request.url === HOST_STOP_IF_IDLE_PATH)) {
    await handleSessionHostRequest(current, request, response);
    return;
  }
  if (request.method !== 'POST' || (request.url !== CALL_PATH && request.url !== CANCEL_PATH
    && request.url !== TRANSCRIPT_SECRETS_PATH)) {
    reply(response, 404, { error: 'Not found', errorCode: 'local_session_unavailable' });
    return;
  }
  let body: unknown;
  try { body = JSON.parse(await readBody(request)); } catch (error) {
    if (error instanceof LocalSessionRpcBodyTooLargeError) {
      reply(response, 413, { error: error.message, errorCode: error.code });
      return;
    }
    reply(response, 400, { error: 'Invalid local Session RPC request', errorCode: 'RPC_FORBIDDEN' });
    return;
  }
  if (request.url === TRANSCRIPT_SECRETS_PATH) {
    const { sessionId, values } = (body && typeof body === 'object' ? body : {}) as { sessionId?: unknown; values?: unknown };
    const registered = typeof sessionId === 'string' ? current.targets.get(sessionId) : undefined;
    if (!registered?.target.registerTranscriptSecrets) {
      reply(response, 404, { error: 'Session is not hosted on this local channel', errorCode: 'local_session_unavailable' });
      return;
    }
    if (!Array.isArray(values) || !values.every((value): value is string => typeof value === 'string' && value.length > 0)) {
      reply(response, 400, { error: 'Invalid transcript secret registration', errorCode: 'RPC_FORBIDDEN' });
      return;
    }
    if (!await isTrustedCaller(registered.target, request)) {
      reply(response, 403, { error: 'Only the daemon of this host may call it', errorCode: LOCAL_SESSION_PEER_REFUSED });
      return;
    }
    registered.target.registerTranscriptSecrets(values);
    reply(response, 200, { ok: true });
    return;
  }
  if (request.url === CANCEL_PATH) {
    const parsed = SocketRpcCancellationPayloadSchema.safeParse(body && typeof body === 'object' ? (body as { cancel?: unknown }).cancel : undefined);
    const sessionId = body && typeof body === 'object' ? (body as { sessionId?: unknown }).sessionId : undefined;
    const registered = typeof sessionId === 'string' ? current.targets.get(sessionId) : undefined;
    if (parsed.success && registered?.rpcCalls && await isTrustedCaller(registered.target, request)) registered.target.cancelRequest(parsed.data.requestId);
    reply(response, 200, { ok: true });
    return;
  }
  const admitted = admitLocalPacket(current, body);
  if ('status' in admitted) {
    reply(response, admitted.status, { error: admitted.error, errorCode: admitted.errorCode });
    return;
  }
  const { registered, request: packet } = admitted;
  if (!await isTrustedCaller(registered.target, request)) {
    reply(response, 403, { error: 'Only the daemon of this host may call it', errorCode: LOCAL_SESSION_PEER_REFUSED });
    return;
  }
  // This outer body belongs to the peer-admitted daemon, never the public RPC packet.
  const admittedContext = (body as { localActionContext?: unknown }).localActionContext;
  if (admittedContext !== undefined && (packet.method !== `${registered.target.sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_START}`
    || !admittedContext || typeof admittedContext !== 'object' || Array.isArray(admittedContext))) {
    reply(response, 403, { error: 'Invalid local Action context', errorCode: 'RPC_FORBIDDEN' });
    return;
  }
  const localActionContext = admittedContext === undefined ? undefined : {
    ...admittedContext as LocalSessionRpcActionContext,
    authority: minAuthority(packet.callerAuthority === 'present_user' ? 'present_user' : 'account_automation',
      (admittedContext as LocalSessionRpcActionContext).authority === 'present_user' ? 'present_user' : 'account_automation'),
  };
  // A caller that disconnects before the reply has the same meaning as a Socket.IO caller cancel.
  const onClose = () => {
    if (!response.writableEnded && typeof packet.requestId === 'string') registered.target.cancelRequest(packet.requestId);
  };
  response.once('close', onClose);
  try {
    const result = await registered.target.handleRequest(localActionContext
      ? { ...packet, callerAuthority: localActionContext.authority } : packet, localActionContext);
    reply(response, 200, projectSocketRpcTargetAcknowledgementV1(result));
  } catch (error) {
    reply(response, 200, { ok: false, error: error instanceof Error ? error.message : 'RPC call failed' });
  } finally {
    response.off('close', onClose);
  }
}

async function startIngress(): Promise<Ingress> {
  const isWindows = process.platform === 'win32';
  const directory = isWindows ? null : await mkdtemp(join(resolveOwnerOnlySocketRoot(`${ENDPOINT_DIRECTORY_PREFIX}XXXXXX/${ENDPOINT_SOCKET_NAME}`), ENDPOINT_DIRECTORY_PREFIX));
  try {
    if (directory) await chmod(directory, 0o700);
    const endpoint = createOwnerOnlyLocalEndpoint({
      endpointPath: directory ? join(directory, ENDPOINT_SOCKET_NAME) : `\\\\.\\pipe\\happier-session-rpc-${randomBytes(16).toString('hex')}`,
      windowsPipePrefix: 'happier-session-rpc-',
    });
    const server = createServer();
    const current: Ingress = { server, endpoint, directory, targets: new Map(), sockets: new Set() };
    // Kernel-proven peer of each accepted connection (SO_PEERCRED / LOCAL_PEERPID+LOCAL_PEERCRED via
    // the shipped process-custody helper), observed once per connection before HTTP parsing starts.
    const front = createNetServer(socket => {
      current.sockets.add(socket);
      socket.once('close', () => current.sockets.delete(socket));
      void observeCallerPeer(socket, endpoint).then(identity => {
        if (socket.destroyed) return;
        peerIdentities.set(socket, identity);
        server.emit('connection', socket);
      }, () => socket.destroy());
    });
    current.front = front;
    server.on('request', (request, response) => {
      void handleIngressRequest(current, request, response).catch(error => {
        logger.warnLocalFile('[SESSION LOCAL RPC] request failed', { error: error instanceof Error ? error.message : String(error) });
        reply(response, 500, { error: 'Local Session RPC failed', errorCode: 'local_session_unavailable' });
      });
    });
    await endpoint.listen(front);
    await endpoint.secure();
    // The hosted Sessions own the process lifetime; an idle listener never holds it open.
    front.unref();
    return current;
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Short leaf names leave the most room for the owner-only root under the socket path limit. */
const ENDPOINT_DIRECTORY_PREFIX = 'hs-';
const ENDPOINT_SOCKET_NAME = 'rpc';

async function writeDescriptor(path: string, descriptor: LocalSessionRpcDescriptorV1 | LocalSessionHostDescriptorV1): Promise<void> {
  const directory = resolveDescriptorDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  const staging = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(staging, JSON.stringify(descriptor), { mode: 0o600, flag: 'wx' });
  await rename(staging, path);
}

/**
 * Serve one hosted Session on this process's local channel and publish its descriptor. Returns the
 * retirement that removes the descriptor and, after the last Session, closes the endpoint.
 */
export async function registerLocalSessionRpcTarget(target: LocalSessionRpcTarget): Promise<() => Promise<void>> {
  // Only a host holding a full Account/terminal credential of the Session owner serves Session RPC
  // locally; a restricted host (ephemeral runner, API token) or another person's runtime keeps every
  // call on the server's admission. Any runtime that writes the transcript still takes the daemon's
  // transcript registration here (register-then-serve).
  const hostKind = readCredentialKind(target.credentialToken);
  const rpcCalls = target.rpcCalls !== false && hostKind !== null && LOCAL_ROUTE_CREDENTIAL_KINDS.has(hostKind);
  if (!rpcCalls && !target.registerTranscriptSecrets) return async () => {};
  const accountId = readAccountIdFromToken(target.credentialToken);
  if (rpcCalls && !accountId) throw new Error('Local Session RPC requires the Session Account credential');
  ingress ??= startIngress().catch(error => { ingress = null; throw error; });
  const current = await ingress;
  const descriptorPath = resolveDescriptorPath(target.sessionId);
  const registered: RegisteredTarget = {
    target, rpcCalls, accountId: accountId ?? '', descriptorPath,
    authority: resolveSocketRpcCallerAuthority({ credentialKind: readCredentialKind(target.credentialToken) }),
  };
  current.targets.set(target.sessionId, registered);
  try {
    await writeDescriptor(descriptorPath, {
      v: DESCRIPTOR_VERSION, sessionId: target.sessionId, accountId: accountId ?? '',
      admittedStartContextVersion: 1,
      ...(rpcCalls ? {} : { rpcCalls: false as const }),
      endpoint: { kind: current.endpoint.kind, path: current.endpoint.endpointPath }, pid: process.pid,
    });
  } catch (error) {
    if (current.targets.get(target.sessionId) === registered) current.targets.delete(target.sessionId);
    throw error;
  }
  if (rpcCalls) target.onPublished?.(method => current.targets.get(target.sessionId) === registered
    && resolveSocketRpcSameAccountSessionAuthorizationV1(method, target.sessionId) !== null);
  let retired = false;
  return async () => {
    if (retired) return;
    retired = true;
    if (current.targets.get(target.sessionId) !== registered) return;
    current.targets.delete(target.sessionId);
    await removeOwnDescriptor(target.sessionId, process.pid, current.endpoint.endpointPath);
    await closeIngressWhenIdle(current);
  };
}

/** Close this process's endpoint once it serves neither a Session nor a session host. */
async function closeIngressWhenIdle(current: Ingress): Promise<void> {
  if (current.targets.size > 0 || current.host || ingress === null || await ingress !== current) return;
  ingress = null;
  // Kept-alive caller connections would otherwise hold the listener open until they idle out.
  for (const socket of current.sockets) socket.destroy();
  await new Promise<void>(resolve => current.front ? current.front.close(() => resolve()) : resolve());
  await current.endpoint.remove();
  if (current.directory) await rm(current.directory, { recursive: true, force: true });
}

/** Delete a descriptor only while it still names this host (a successor may have replaced it). */
async function removeOwnDescriptor(sessionId: string, pid: number, endpointPath?: string): Promise<boolean> {
  const current = readDescriptor(sessionId);
  if (!current || current.pid !== pid || (endpointPath !== undefined && current.endpoint.path !== endpointPath)) return false;
  await rm(resolveDescriptorPath(sessionId), { force: true });
  return true;
}

/** One kept-alive connection pool per host endpoint, so the host proves our peer identity once per connection. */
const endpointAgents = new Map<string, Agent>();
function keepAliveAgent(endpointPath: string): Agent {
  let agent = endpointAgents.get(endpointPath);
  if (!agent) {
    agent = createLocalSessionRpcAgent(endpointPath);
    endpointAgents.set(endpointPath, agent);
  }
  return agent;
}

/** Same-machine calls in flight from this process, by sessionId, so the liveness owner can end them. */
const inFlightLocalCalls = new Map<string, Set<Readonly<{ pid: number; abort: () => void }>>>();

/**
 * The daemon's runner-liveness owner (session marker removal) reports that the host process `pid`
 * for `sessionId` is gone: retire its descriptor if it is still that host's, and end this process's
 * in-flight local calls to it (outcome unknown, exactly like a lost Socket.IO target).
 */
export async function retireGoneLocalSessionRpcHost(input: Readonly<{ sessionId: string; pid: number }>): Promise<void> {
  // Only calls to that host process: a successor already serving the Session keeps its calls.
  for (const call of inFlightLocalCalls.get(input.sessionId) ?? []) if (call.pid === input.pid) call.abort();
  const descriptor = readDescriptor(input.sessionId);
  if (descriptor?.pid === input.pid) {
    endpointAgents.get(descriptor.endpoint.path)?.destroy();
    endpointAgents.delete(descriptor.endpoint.path);
  }
  await removeOwnDescriptor(input.sessionId, input.pid).catch(() => false);
}

/** An owner-only descriptor file naming an endpoint whose directory is still ours, or null. */
function readVerifiedDescriptorFile(path: string): Record<string, unknown> | null {
  try {
    if (process.platform !== 'win32' && (!isOwnerOnlyPath(resolveDescriptorDirectory()) || !isOwnerOnlyPath(path))) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
    const endpoint = parsed?.endpoint as Partial<LocalSessionRpcDescriptorV1['endpoint']> | undefined;
    if (!parsed || parsed.v !== DESCRIPTOR_VERSION || !endpoint || typeof endpoint.path !== 'string') return null;
    if (process.platform === 'win32') {
      // No POSIX ownership bits on Windows: these are routing hints only. Each
      // actual connection proves the server SID before HTTP sends any bytes.
      return endpoint.kind === 'named_pipe' && /^\\\\\.\\pipe\\happier-session-rpc-[A-Za-z0-9-]+$/u.test(endpoint.path) ? parsed : null;
    }
    if (endpoint.kind !== 'unix') return null;
    // The endpoint's own directory must still be ours, and so must its parent (an owner-only socket
    // root): in a shared world-writable directory (sticky or not) another user could recreate a
    // crashed host's leaf, or swap it between this check and connect. Hosts never place endpoints there.
    const endpointDir = dirname(endpoint.path);
    if (!isOwnerOnlyPath(endpointDir) || !isOwnerOnlyPath(dirname(endpointDir))) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readDescriptor(sessionId: string): LocalSessionRpcDescriptorV1 | null {
  const parsed = readVerifiedDescriptorFile(resolveDescriptorPath(sessionId));
  if (!parsed || parsed.sessionId !== sessionId || typeof parsed.accountId !== 'string') return null;
  return parsed as LocalSessionRpcDescriptorV1;
}

/** The host refused or was unreachable before any handler ran: the packet was provably not dispatched. */
export class LocalSessionRpcUnavailableError extends Error {
  readonly code = 'local_session_unavailable';
}

function postJson(descriptor: LocalSessionRpcDescriptorV1, path: string, body: unknown): Promise<Readonly<{ status: number; body: unknown }>> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    if (Buffer.byteLength(text) > EXTERNAL_ACTION_SOCKET_MIN_BUFFER_BYTES_V2) {
      // Never dispatched; the relay would refuse the same packet.
      reject(new LocalSessionRpcBodyTooLargeError('Local Session RPC body exceeds the transport budget'));
      return;
    }
    const calls = inFlightLocalCalls.get(descriptor.sessionId) ?? new Set<Readonly<{ pid: number; abort: () => void }>>();
    inFlightLocalCalls.set(descriptor.sessionId, calls);
    const settle = () => { calls.delete(entry); if (calls.size === 0 && inFlightLocalCalls.get(descriptor.sessionId) === calls) inFlightLocalCalls.delete(descriptor.sessionId); };
    const outgoing = httpRequest({
      socketPath: descriptor.endpoint.path, path, method: 'POST', agent: keepAliveAgent(descriptor.endpoint.path),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
    }, incoming => {
      readBody(incoming).then(raw => {
        settle();
        try { resolve({ status: incoming.statusCode ?? 0, body: JSON.parse(raw) }); } catch (error) { reject(error); }
      }, error => { settle(); reject(error); });
    });
    const entry = { pid: descriptor.pid, abort: () => outgoing.destroy(new Error('Local Session host is gone')) };
    calls.add(entry);
    outgoing.once('error', (error: NodeJS.ErrnoException) => {
      settle();
      // Connect-phase failures: no host is listening, so nothing was dispatched.
      reject(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
        ? new LocalSessionRpcUnavailableError('Local Session host is not listening') : error);
    });
    outgoing.end(text);
  });
}

/**
 * Daemon side of register-then-serve: the Session's runner holds `values` in that Session's
 * transcript scope when this resolves. Throws `LocalSessionRpcUnavailableError` when no published,
 * peer-accepting host serves the Session; the caller must then refuse to serve the values.
 */
export async function registerLocalSessionTranscriptSecrets(input: Readonly<{
  sessionId: string;
  values: readonly string[];
}>): Promise<void> {
  if (input.values.length === 0) return;
  const descriptor = readDescriptor(input.sessionId);
  if (!descriptor) throw new SessionTranscriptRuntimeUnavailableError();
  const response = await postJson(descriptor, TRANSCRIPT_SECRETS_PATH, { sessionId: input.sessionId, values: [...input.values] })
    .catch((error: unknown) => {
      if (error instanceof LocalSessionRpcUnavailableError) throw new SessionTranscriptRuntimeUnavailableError();
      throw error;
    });
  if (response.status !== 200) throw new SessionTranscriptRuntimeUnavailableError();
}

/** The runtime that writes this Session's transcript is not reachable: a served secret would leak. */
export class SessionTranscriptRuntimeUnavailableError extends Error {
  readonly code = 'session_transcript_runtime_unavailable';
  constructor() {
    super("The runtime that writes this Session's transcript is not reachable, so its credential is not served");
  }
}

let localSessionRpcCallerEnabled = false;
/** The daemon process (the only caller its Session hosts admit) opts its router into the local channel. */
export function enableLocalSessionRpcCalls(): void {
  localSessionRpcCallerEnabled = true;
}

export type LocalSessionRpcRoute = Readonly<{ socket: SocketRpcSocket }>;

/**
 * The router's local decision for one Session RPC: a published same-user host for this sessionId,
 * the same Account as the caller's credential, and a method whose Session context the server mints
 * from the Session id alone. Anything else (another machine, another Account, a server-proven actor
 * or a fresh Machine-access check) keeps the server path.
 */
export function resolveLocalSessionRpcRoute(input: Readonly<{
  sessionId: string;
  method: string;
  token: string;
  authorityCeiling?: 'account_automation';
  localActionContext?: LocalSessionRpcActionContext;
}>): LocalSessionRpcRoute | null {
  // Hosts admit only their daemon (kernel peer identity); other processes keep the server path.
  if (!localSessionRpcCallerEnabled) return null;
  if (!resolveSocketRpcSameAccountSessionAuthorizationV1(input.method, input.sessionId,
    { admittedAgentStart: Boolean(input.localActionContext) })) return null;
  // Only credentials whose server admission is exactly "Account + Session access" go local. Restricted
  // kinds (ephemeral Session runners, API tokens) keep the server's extra principal checks.
  const credentialKind = readCredentialKind(input.token);
  if (!credentialKind || !LOCAL_ROUTE_CREDENTIAL_KINDS.has(credentialKind)) return null;
  const descriptor = readDescriptor(input.sessionId);
  if (!descriptor || descriptor.rpcCalls === false || descriptor.accountId !== readAccountIdFromToken(input.token)) return null;
  if (input.localActionContext && (descriptor.admittedStartContextVersion !== 1
    || input.method !== SESSION_RPC_METHODS.EXECUTION_RUN_START)) return null;
  const callerAuthority = resolveSocketRpcCallerAuthority({ credentialKind, authorityCeiling: input.authorityCeiling });
  const socket: SocketRpcSocket = {
    emit: (event: string, payload?: unknown) => {
      if (event !== SOCKET_RPC_EVENTS.CANCEL) return false;
      void postJson(descriptor, CANCEL_PATH, { sessionId: input.sessionId, cancel: payload }).catch(() => {});
      return true;
    },
    emitWithAck: async (event: string, packet?: unknown) => {
      if (event !== SOCKET_RPC_EVENTS.CALL) throw new Error(`Local Session RPC cannot emit ${event}`);
      const response = await postJson(descriptor, CALL_PATH, { packet, callerAuthority,
        ...(input.localActionContext ? { localActionContext: input.localActionContext } : {}) });
      if (response.status === 200) return response.body;
      if (response.status === 404) throw new LocalSessionRpcUnavailableError('Session is not hosted on this local channel');
      if (response.status === 403 && (response.body as { errorCode?: unknown } | null)?.errorCode === LOCAL_SESSION_PEER_REFUSED) {
        throw new LocalSessionRpcUnavailableError('Local Session host refused this caller');
      }
      return response.body;
    },
  };
  return { socket };
}

// Session host admission. One session host process per daemon runs many daemon-started Sessions;
// its daemon adds and ends them on this same owner-only, peer-checked endpoint.

const HOST_ADD_PATH = '/v1/session-host/add';
const HOST_END_PATH = '/v1/session-host/end';
const HOST_IDLE_PATH = '/v1/session-host/idle';
const HOST_STOP_IF_IDLE_PATH = '/v1/session-host/stop-if-idle';
/** A restarted daemon re-observes a running Session's end (the add request's body, re-attached). */
const HOST_WATCH_PATH = '/v1/session-host/watch';
/** A newer daemon moves this host's Sessions to a current host: the host hands over and exits. */
const HOST_HANDOVER_PATH = '/v1/session-host/handover';
/** A Session is about to be created: the host stays (and loads the runner code) while this connection is open. */
const HOST_HOLD_PATH = '/v1/session-host/hold';
/** A re-attached daemon reads a running Session's current live work once (it holds no earlier report). */
const HOST_LIVE_WORK_PATH = '/v1/session-host/live-work';
const SESSION_HOST_CLOSING = 'session_host_closing';
const SESSION_NOT_HOSTED = 'session_not_hosted';
/**
 * A host handing its Sessions to a newer host exits with this code, leaving each Session's Agent in
 * its holder: like a crash, every Session's end is unexpected, so each is respawned and adopts.
 */
export const SESSION_HOST_HANDOVER_EXIT_CODE = 75;
/** First stdout line of a ready session host; its daemon waits for it before adding Sessions. */
export const SESSION_HOST_READY_LINE = 'happier-session-host-ready';

type LocalSessionHostDescriptorV1 = Readonly<{
  v: typeof DESCRIPTOR_VERSION;
  kind: 'session_host';
  endpoint: Readonly<{ kind: 'unix' | 'named_pipe'; path: string }>;
  pid: number;
}>;

export type SessionHostAddRequest = Readonly<{
  /** The daemon's tracking key for this Session (echoed by its session-started report). */
  trackingKey: string;
  /** The runner command line for this Session; the host never reads its own argv for it. */
  argv: readonly string[];
  /** The Session's process environment (what a runner would have received). */
  env: Readonly<Record<string, string>>;
  cwd: string;
  /** The daemon's admitted launch facts for this Session (non-secret; no credential crosses here). */
  launch?: SessionHostLaunchRecordV1;
}>;

/**
 * What the daemon's spawn admission already decided for one hosted Session, so the host does not
 * re-derive it from disk. `account` names the Machine Account the daemon admitted (absent for
 * requester-custody and API-token launches, which keep their own per-launch credential read); the
 * host serves the credential from its own hold keyed by (Home, Account) and re-reads it once when
 * the held one differs. `runnerBootstrap` is the parsed content of the bootstrap file the Session's
 * environment names.
 */
export type SessionHostLaunchRecordV1 = Readonly<{
  /** `settingsVersion`: the Account Settings version the daemon admitted with, a floor for the Session (never the settings or their keys). */
  account?: Readonly<{ accountId: string; credentialEpoch: number; machineId: string; settingsVersion?: number }>;
  runnerBootstrap?: Readonly<{ path: string; bootstrap: AgentRuntimeRunnerBootstrapV1 }>;
}>;

async function parseSessionHostLaunchRecord(value: unknown): Promise<SessionHostLaunchRecordV1 | null> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { account, runnerBootstrap, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return null;
  let parsedAccount: SessionHostLaunchRecordV1['account'];
  if (account !== undefined) {
    const { accountId, credentialEpoch, machineId, settingsVersion, ...accountRest } = (account ?? {}) as Record<string, unknown>;
    const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    if (Object.keys(accountRest).length > 0 || typeof accountId !== 'string' || !accountId || typeof machineId !== 'string' || !machineId
      || !isCount(credentialEpoch) || (settingsVersion !== undefined && !isCount(settingsVersion))) return null;
    parsedAccount = { accountId, credentialEpoch, machineId, ...(settingsVersion === undefined ? {} : { settingsVersion }) };
  }
  let parsedBootstrap: SessionHostLaunchRecordV1['runnerBootstrap'];
  if (runnerBootstrap !== undefined) {
    const { path, bootstrap } = (runnerBootstrap ?? {}) as Record<string, unknown>;
    if (typeof path !== 'string' || !path) return null;
    const { AgentRuntimeRunnerBootstrapV1Schema } = await import('@/agent/runtime/session/process/agentRuntimeRunnerProtocol');
    const parsed = AgentRuntimeRunnerBootstrapV1Schema.safeParse(bootstrap);
    if (!parsed.success) return null;
    parsedBootstrap = { path, bootstrap: parsed.data };
  }
  return { ...(parsedAccount ? { account: parsedAccount } : {}), ...(parsedBootstrap ? { runnerBootstrap: parsedBootstrap } : {}) };
}

/** The host no longer admits Sessions (it is ending); the daemon starts a new host. */
export class SessionHostClosingError extends Error {
  readonly code = SESSION_HOST_CLOSING;
}

export type LocalSessionHostEndResult = Readonly<{
  status: 'termination_requested' | 'not_hosted' | 'termination_unavailable' | 'peer_refused' | 'host_unavailable';
}>;

export type LocalSessionHostAdmission = Readonly<{
  /**
   * Start one Session. Throws `SessionHostClosingError` synchronously when the host no longer
   * admits; otherwise resolves with the Session's exit code when that Session ends.
   */
  addSession(request: SessionHostAddRequest): Promise<SessionHostCommandEnd>;
  /** Ask one hosted Session to end, distinguishing absence from unavailable termination. */
  endSession(trackingKey: string, lifecycleStateReason?: SessionLifecycleStateReason): LocalSessionHostEndResult;
  /** This running Session's end (same result as its add), or null when this host does not run it. */
  watchSession(trackingKey: string): Promise<SessionHostCommandEnd> | null;
  /** This running Session's current live work (unparsed), or null when it has none to report. */
  readSessionLiveWork?(trackingKey: string): Promise<unknown> | null;
  /**
   * Stop admitting, leave every Session's Agent in its holder and exit with
   * `SESSION_HOST_HANDOVER_EXIT_CODE`; false when the host is already ending.
   */
  handOver(): boolean;
  /** Only the host sees every admitted Session and in-flight hold. */
  isIdle(): boolean;
  /** Retire only if the host still has no Session or hold. */
  stopIfIdle(): boolean;
  /**
   * Keep the host alive until the returned release is called. A New Session intent also preloads
   * the runner by default. Throws `SessionHostClosingError` when the host no longer admits.
   */
  hold(preloadRunner?: boolean): () => void;
  /** The daemon that launched this host (or adopted it after a restart): the only caller admitted. */
  readTrustedCaller(): Promise<ProcessBirthWitness | null>;
}>;

// A detached host publishes one descriptor of its own before admitting any Sessions.
const HOST_DESCRIPTOR_PREFIX = 'session-host-';
const HOST_DESCRIPTOR_SUFFIX = '.json';

function resolveHostDescriptorPath(hostPid: number): string {
  return join(resolveDescriptorDirectory(), `${HOST_DESCRIPTOR_PREFIX}${hostPid}${HOST_DESCRIPTOR_SUFFIX}`);
}

/** Candidate hosts for daemon startup. Each endpoint is verified when it is opened. */
export async function listLocalSessionHostPids(): Promise<number[]> {
  const files = await readdir(resolveDescriptorDirectory()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const pids: number[] = [];
  for (const file of files) {
    if (!file.startsWith(HOST_DESCRIPTOR_PREFIX) || !file.endsWith(HOST_DESCRIPTOR_SUFFIX)) continue;
    const name = file.slice(HOST_DESCRIPTOR_PREFIX.length, -HOST_DESCRIPTOR_SUFFIX.length);
    const pid = Number(name);
    if (Number.isSafeInteger(pid) && pid > 0 && String(pid) === name) pids.push(pid);
  }
  return pids;
}

async function parseSessionHostAddRequest(body: unknown): Promise<SessionHostAddRequest | null> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { trackingKey, argv, env, cwd, launch } = body as Record<string, unknown>;
  if (typeof trackingKey !== 'string' || !trackingKey || typeof cwd !== 'string' || !cwd) return null;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(arg => typeof arg !== 'string')) return null;
  if (!env || typeof env !== 'object' || Array.isArray(env)
    || Object.values(env).some(value => typeof value !== 'string')) return null;
  const parsedLaunch = await parseSessionHostLaunchRecord(launch);
  if (!parsedLaunch) return null;
  return { trackingKey, argv: argv as string[], env: env as Record<string, string>, cwd,
    ...(launch === undefined ? {} : { launch: parsedLaunch }) };
}

async function handleSessionHostRequest(current: Ingress, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const host = current.host;
  if (!host) {
    if (request.url === HOST_ADD_PATH) {
      reply(response, 503, { error: 'The session host is ending', errorCode: SESSION_HOST_CLOSING });
      return;
    }
    reply(response, 404, { error: 'No session host on this endpoint', errorCode: 'local_session_unavailable' });
    return;
  }
  let releasePendingAdd: (() => void) | undefined;
  if (request.url === HOST_ADD_PATH) {
    // Count the Add before reading its body or checking the daemon's birth: the last intent
    // hold can close while either is pending. A disconnect before admission releases this hold.
    try {
      releasePendingAdd = host.hold(false);
      response.once('close', releasePendingAdd);
    } catch (error) {
      if (!(error instanceof SessionHostClosingError)) throw error;
      reply(response, 503, { error: error.message, errorCode: SESSION_HOST_CLOSING });
      return;
    }
  }
  let body: unknown;
  try { body = JSON.parse(await readBody(request)); } catch {
    reply(response, 400, { error: 'Invalid session host request', errorCode: 'RPC_FORBIDDEN' });
    return;
  }
  if (!await isTrustedCaller(host, request)) {
    reply(response, 403, { error: 'Only the daemon of this host may call it', errorCode: LOCAL_SESSION_PEER_REFUSED });
    return;
  }
  const trackingKey = (body as { trackingKey?: unknown } | null)?.trackingKey;
  if (request.url === HOST_END_PATH) {
    // Only this host's daemon reaches here; the reason it names rides on the Session's exit write.
    const reason = SessionLifecycleStateReasonSchema.safeParse((body as { lifecycleStateReason?: unknown } | null)?.lifecycleStateReason);
    reply(response, 200, typeof trackingKey === 'string'
      ? host.endSession(trackingKey, reason.success ? reason.data : undefined) : { status: 'not_hosted' });
    return;
  }
  if (request.url === HOST_IDLE_PATH) {
    reply(response, 200, { idle: host.isIdle() });
    return;
  }
  if (request.url === HOST_STOP_IF_IDLE_PATH) {
    reply(response, 200, { stopping: host.stopIfIdle() });
    return;
  }
  if (request.url === HOST_HANDOVER_PATH) {
    reply(response, 200, { handingOver: host.handOver() });
    return;
  }
  if (request.url === HOST_LIVE_WORK_PATH) {
    const liveWork = typeof trackingKey === 'string'
      ? await (host.readSessionLiveWork?.(trackingKey) ?? Promise.resolve(null)).catch(() => null) : null;
    reply(response, 200, { liveWork });
    return;
  }
  if (request.url === HOST_HOLD_PATH) {
    const preloadRunner = (body as { preloadRunner?: unknown } | null)?.preloadRunner !== false;
    let release: () => void;
    try {
      release = host.hold(preloadRunner);
    } catch (error) {
      if (!(error instanceof SessionHostClosingError)) throw error;
      reply(response, 503, { error: error.message, errorCode: SESSION_HOST_CLOSING });
      return;
    }
    // Held while the connection lives: its daemon releasing it, or the daemon process ending, closes it.
    response.once('close', release);
    // Peer admission can finish after this connection's close event.
    if (response.destroyed) {
      release();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.flushHeaders();
    return;
  }
  let ended: Promise<SessionHostCommandEnd>;
  if (request.url === HOST_WATCH_PATH) {
    const watched = typeof trackingKey === 'string' ? host.watchSession(trackingKey) : null;
    if (!watched) {
      reply(response, 404, { error: 'This host does not run that Session', errorCode: SESSION_NOT_HOSTED });
      return;
    }
    ended = watched;
  } else {
    const add = await parseSessionHostAddRequest(body);
    if (!add) {
      reply(response, 400, { error: 'Invalid session host request', errorCode: 'RPC_FORBIDDEN' });
      return;
    }
    try {
      ended = host.addSession(add);
      // The host now owns the admitted Session. The Add response stays open for its exit code.
      if (releasePendingAdd) {
        response.removeListener('close', releasePendingAdd);
        releasePendingAdd();
      }
    } catch (error) {
      if (!(error instanceof SessionHostClosingError)) throw error;
      reply(response, 503, { error: error.message, errorCode: SESSION_HOST_CLOSING });
      return;
    }
  }
  // Admitted: the headers say so now; the body is the Session's exit code when it ends. A daemon
  // that disconnects meanwhile (restart) does not end the Session.
  response.writeHead(200, { 'content-type': 'application/json' });
  response.flushHeaders();
  const end = await ended;
  if (!response.writableEnded && !response.destroyed) response.end(JSON.stringify(end));
}

/**
 * Serve this process as its daemon's session host and publish the host descriptor. Returns the
 * retirement that stops admitting Sessions (and closes the endpoint when nothing else is served).
 */
export async function serveLocalSessionHost(admission: LocalSessionHostAdmission): Promise<() => Promise<void>> {
  ingress ??= startIngress().catch(error => { ingress = null; throw error; });
  const current = await ingress;
  if (current.host) throw new Error('This process already serves a session host');
  current.host = admission;
  const endpointPath = current.endpoint.endpointPath;
  try {
    await writeDescriptor(resolveHostDescriptorPath(process.pid), {
      v: DESCRIPTOR_VERSION, kind: 'session_host', endpoint: { kind: current.endpoint.kind, path: endpointPath }, pid: process.pid,
    });
  } catch (error) {
    current.host = undefined;
    await closeIngressWhenIdle(current);
    throw error;
  }
  return async () => {
    if (current.host !== admission) return;
    current.host = undefined;
    const descriptor = readHostDescriptor(process.pid);
    if (descriptor?.endpoint.path === endpointPath) {
      await rm(resolveHostDescriptorPath(process.pid), { force: true });
    }
    await closeIngressWhenIdle(current);
  };
}

/** The daemon observed host `hostPid` exit: a host that died without retiring leaves its descriptor. */
export async function removeExitedSessionHostDescriptor(hostPid: number): Promise<void> {
  await rm(resolveHostDescriptorPath(hostPid), { force: true });
}

function readHostDescriptor(hostPid: number): LocalSessionHostDescriptorV1 | null {
  const parsed = readVerifiedDescriptorFile(resolveHostDescriptorPath(hostPid));
  if (!parsed || parsed.kind !== 'session_host' || parsed.pid !== hostPid) return null;
  return parsed as LocalSessionHostDescriptorV1;
}

/**
 * A hosted Session's end as its daemon observes it: the exit code, or null when the request was
 * refused (`closing`: the host no longer admits; `notHosted`: the live host does not run that
 * Session) or the connection broke.
 */
export type SessionHostCommandEnd = Readonly<{ exitCode: number; failureCause?: SessionRuntimeIssueV1['failureCause'] }>;
export type LocalSessionHostSessionEnd = Readonly<{ exitCode: number | null; closing: boolean; notHosted: boolean; failureCause?: SessionRuntimeIssueV1['failureCause']; admissionFailure?: SessionSpawnLaunchErrorV1 }>;

/** A Session added to a session host, as its daemon observes it. */
export type LocalSessionHostSession = Readonly<{
  /** True once the host admitted the Session; false when it refused or was unreachable (nothing started). */
  admitted: Promise<boolean>;
  /** The Session's end: its exit code, or null when the host connection broke (the host is gone). */
  ended: Promise<LocalSessionHostSessionEnd>;
}>;

/** Add one Session to the session host `hostPid` (this daemon launched it). */
export function addLocalSessionHostSession(input: Readonly<{ hostPid: number; request: SessionHostAddRequest }>): LocalSessionHostSession {
  return openLocalSessionHostSession({ hostPid: input.hostPid, path: HOST_ADD_PATH, body: input.request });
}

/**
 * Re-observe a Session that runs in the session host `hostPid` (a restarted daemon adopting the
 * host). Not admitted when the host does not run it (any more).
 */
export function watchLocalSessionHostSession(input: Readonly<{ hostPid: number; trackingKey: string }>): LocalSessionHostSession {
  return openLocalSessionHostSession({ hostPid: input.hostPid, path: HOST_WATCH_PATH, body: { trackingKey: input.trackingKey } });
}

/** One Session's request on the host: admitted by its headers, ended by its body (the Session's exit code). */
function openLocalSessionHostSession(input: Readonly<{ hostPid: number; path: string; body: unknown }>): LocalSessionHostSession {
  let resolveAdmitted!: (admitted: boolean) => void;
  let resolveEnded!: (end: LocalSessionHostSessionEnd) => void;
  const admitted = new Promise<boolean>(resolve => { resolveAdmitted = resolve; });
  const ended = new Promise<LocalSessionHostSessionEnd>(resolve => { resolveEnded = resolve; });
  const refuse = (closing: boolean, notHosted = false, code?: unknown, httpStatus?: number) => {
    // Retain boundary facts, never a response body, launch environment, or OS error message.
    const parsedCode = SessionSpawnLaunchErrorV1Schema.shape.code.safeParse(code);
    const resetBeforeHeaders = code === 'ECONNRESET' && httpStatus === undefined;
    const admissionFailure: SessionSpawnLaunchErrorV1 = {
      kind: 'launch_error', code: parsedCode.success ? parsedCode.data : 'SPAWN_FAILED',
      message: 'Session host admission failed',
      failureCause: { phase: 'client_start', failureReason: 'unknown', ...(httpStatus === undefined ? {} : { httpStatus }),
        ...(resetBeforeHeaders ? {
          carrierFailure: { closingSide: 'peer_or_transport', closingStage: 'local_http_head' },
          actionCause: { phase: 'session_host.admission', errorClass: 'Error', errorCode: code, httpStatus: null },
        } : {}),
      },
    };
    resolveAdmitted(false);
    resolveEnded({ exitCode: null, closing, notHosted, admissionFailure });
  };
  const descriptor = readHostDescriptor(input.hostPid);
  const text = JSON.stringify(input.body);
  if (Buffer.byteLength(text) > EXTERNAL_ACTION_SOCKET_MIN_BUFFER_BYTES_V2) {
    refuse(false, false, 'local_session_rpc_body_too_large');
    return { admitted, ended };
  }
  if (!descriptor) {
    // That host no longer publishes its endpoint: it ended (or is ending); a new host takes the Session.
    refuse(true);
    return { admitted, ended };
  }
  // Its own connection: the request lives as long as the Session.
  const outgoing = httpRequest({
    socketPath: descriptor.endpoint.path, path: input.path, method: 'POST',
    agent: process.platform === 'win32' ? createLocalSessionRpcAgent(descriptor.endpoint.path, 'win32', false) : false,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
  }, incoming => {
    if (incoming.statusCode !== 200) {
      void readBody(incoming).then(raw => {
        let errorCode: unknown;
        try { errorCode = (JSON.parse(raw) as { errorCode?: unknown } | null)?.errorCode; } catch { errorCode = undefined; }
        refuse(errorCode === SESSION_HOST_CLOSING, errorCode === SESSION_NOT_HOSTED, errorCode, incoming.statusCode);
      }, (error: unknown) => refuse(false, false,
        error && typeof error === 'object' && 'code' in error ? error.code : undefined, incoming.statusCode));
      return;
    }
    resolveAdmitted(true);
    readBody(incoming).then(raw => {
      const end = JSON.parse(raw) as { exitCode?: unknown; failureCause?: unknown };
      const cause = SessionRuntimeFailureCauseV1Schema.safeParse(end.failureCause);
      resolveEnded({ exitCode: typeof end.exitCode === 'number' ? end.exitCode : null, closing: false, notHosted: false,
        ...(cause.success ? { failureCause: cause.data } : {}) });
    }).catch(() => resolveEnded({ exitCode: null, closing: false, notHosted: false }));
  });
  outgoing.once('error', error => {
    // Before admission nothing was started; after it, the host connection broke.
    const code = (error as NodeJS.ErrnoException).code;
    // A connect failure cannot have admitted an Add. A reset may have occurred after
    // admission, so preserve it without replaying the request.
    refuse(input.path === HOST_ADD_PATH && (code === 'ENOENT' || code === 'ECONNREFUSED'), false, code);
  });
  outgoing.end(text);
  return { admitted, ended };
}

/**
 * Hold the session host `hostPid`. `held` is true once the host admitted the hold; it lasts until
 * `release()` (or this process ends) closes the connection. `closed` settles when the connection is gone.
 */
export function holdLocalSessionHost(input: Readonly<{ hostPid: number; preloadRunner?: false }>): Readonly<{
  held: Promise<boolean>;
  closed: Promise<void>;
  release(): void;
}> {
  const descriptor = readHostDescriptor(input.hostPid);
  if (!descriptor) return { held: Promise.resolve(false), closed: Promise.resolve(), release: () => {} };
  const body = input.preloadRunner === false ? JSON.stringify({ preloadRunner: false }) : '{}';
  let resolveHeld!: (held: boolean) => void;
  const held = new Promise<boolean>(resolve => { resolveHeld = resolve; });
  const outgoing = httpRequest({
    socketPath: descriptor.endpoint.path, path: HOST_HOLD_PATH, method: 'POST',
    agent: process.platform === 'win32' ? createLocalSessionRpcAgent(descriptor.endpoint.path, 'win32', false) : false,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
  }, incoming => {
    resolveHeld(incoming.statusCode === 200);
    incoming.resume();
  });
  const closed = new Promise<void>(resolve => {
    outgoing.once('close', () => { resolveHeld(false); resolve(); });
  });
  outgoing.once('error', () => resolveHeld(false));
  outgoing.end(body);
  return { held, closed, release: () => { outgoing.destroy(); } };
}

/** Ask the session host to end one Session, retaining its refusal or transport outcome. */
export async function endLocalSessionHostSession(input: Readonly<{ hostPid: number; trackingKey: string;
  lifecycleStateReason?: SessionLifecycleStateReason }>): Promise<LocalSessionHostEndResult> {
  const result = await callLocalSessionHost(input.hostPid, HOST_END_PATH, { trackingKey: input.trackingKey,
    ...(input.lifecycleStateReason ? { lifecycleStateReason: input.lifecycleStateReason } : {}) });
  if (result?.errorCode === LOCAL_SESSION_PEER_REFUSED) return { status: 'peer_refused' };
  const status = result?.status;
  if (status === 'termination_requested' || status === 'not_hosted' || status === 'termination_unavailable') return { status };
  return { status: 'host_unavailable' };
}

/** Ask the peer-checked host to retire immediately if it has no Session or hold. */
export async function stopIdleLocalSessionHost(hostPid: number): Promise<boolean> {
  return (await callLocalSessionHost(hostPid, HOST_STOP_IF_IDLE_PATH, {}))?.stopping === true;
}

/**
 * Read idleness through the host itself and pin any later retirement to that endpoint.
 * The stop request rechecks Sessions and holds after peer admission.
 */
export async function readIdleLocalSessionHost(hostPid: number, signal: AbortSignal):
    Promise<((signal: AbortSignal) => Promise<boolean>) | undefined> {
  const descriptor = readHostDescriptor(hostPid);
  if (!descriptor || (await callSessionHostEndpoint(descriptor.endpoint.path, HOST_IDLE_PATH, {}, signal))?.idle !== true) return;
  return async stopSignal => (await callSessionHostEndpoint(descriptor.endpoint.path, HOST_STOP_IF_IDLE_PATH, {}, stopSignal))?.stopping === true;
}

/** One read of a hosted Session's current live work (unparsed); null when the host has none or is unreachable. */
export async function readLocalSessionHostLiveWork(input: Readonly<{ hostPid: number; trackingKey: string }>): Promise<unknown> {
  return (await callLocalSessionHost(input.hostPid, HOST_LIVE_WORK_PATH, { trackingKey: input.trackingKey }))?.liveWork ?? null;
}

/**
 * Ask the session host `hostPid` (an older runtime) to hand its Sessions over: it exits and each of
 * its Sessions ends unexpectedly, so the daemon respawns them into its current host, where they
 * adopt their held Agents. False when that host is unreachable or already ending.
 */
export async function handOverLocalSessionHost(input: Readonly<{ hostPid: number }>): Promise<boolean> {
  return (await callLocalSessionHost(input.hostPid, HOST_HANDOVER_PATH, {}))?.handingOver === true;
}

/** One short request on the host endpoint; null when the host is unreachable or refused it. */
async function callLocalSessionHost(hostPid: number, path: string, body: unknown): Promise<Record<string, unknown> | null> {
  const descriptor = readHostDescriptor(hostPid);
  return descriptor ? await callSessionHostEndpoint(descriptor.endpoint.path, path, body) : null;
}

async function callSessionHostEndpoint(socketPath: string, path: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  if (signal?.aborted) return null;
  const text = JSON.stringify(body);
  return await new Promise<Record<string, unknown> | null>(resolve => {
    const outgoing = httpRequest({
      socketPath, path, signal, method: 'POST',
      agent: process.platform === 'win32' ? createLocalSessionRpcAgent(socketPath, 'win32', false) : false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
    }, incoming => {
      readBody(incoming).then(raw => {
        try {
          const parsed: unknown = JSON.parse(raw);
          resolve(parsed && typeof parsed === 'object' && (incoming.statusCode === 200
            || (incoming.statusCode === 403 && (parsed as Record<string, unknown>).errorCode === LOCAL_SESSION_PEER_REFUSED))
            ? parsed as Record<string, unknown> : null);
        } catch { resolve(null); }
      }, () => resolve(null));
    });
    outgoing.once('error', () => resolve(null));
    outgoing.end(text);
  });
}
