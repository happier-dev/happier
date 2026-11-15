import { SessionRuntimeFailureCauseV1Schema, type SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { Agent, createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { readAuthTokenProvenance, type AuthTokenKind } from '@happier-dev/protocol/auth/authToken';
import { resolveSocketRpcCallerAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { EXTERNAL_ACTION_SOCKET_MIN_BUFFER_BYTES_V2 } from '@happier-dev/protocol/actions/externalActionLimits';
import {
  projectSocketRpcTargetAcknowledgementV1,
  resolveSocketRpcSameAccountSessionAuthorizationV1,
  SOCKET_RPC_EVENTS,
  SocketRpcCancellationPayloadSchema,
  type SocketRpcRequestPayload,
} from '@happier-dev/protocol/socketRpc';
import type { SocketRpcSocket } from '@happier-dev/sync-client';
import { decodeJwtPayload, readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { createOwnerOnlyLocalEndpoint, isOwnerOnlyPath, resolveOwnerOnlySocketRoot, type OwnerOnlyLocalEndpoint } from '@/utils/ipc/ownerOnlyLocalEndpoint';
import { observeLocalIpcPeerIdentity, resolveProcessCustodyPeerIdentityExecutable,
  type ProcessCustodyPeerIdentity } from '@/subprocess/supervision/processCustody';
import type { ProcessBirthWitness } from '@/daemon/processIdentity';

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
 * callers keep the server path there until the client can verify the pipe server's user SID.
 */

const DESCRIPTOR_VERSION = 1;
const CALL_PATH = '/v1/session-rpc/call';
const CANCEL_PATH = '/v1/session-rpc/cancel';
/** Ordinary Session RPC packet fields a caller may send; routing/authority fields are server-only. */
const LOCAL_PACKET_FIELDS: ReadonlySet<string> = new Set([
  'method', 'params', 'requestId', 'traceId', 'timeoutMs', 'waitForResultOnCancel', 'authorization',
  'transportResponseEnvelopeVersion',
]);

type LocalCallerAuthority = 'present_user' | 'account_automation';
const LOCAL_ROUTE_CREDENTIAL_KINDS: ReadonlySet<AuthTokenKind> = new Set(['account', 'account_directory', 'terminal']);

type LocalSessionRpcDescriptorV1 = Readonly<{
  v: typeof DESCRIPTOR_VERSION;
  sessionId: string;
  accountId: string;
  endpoint: Readonly<{ kind: 'unix' | 'named_pipe'; path: string }>;
  pid: number;
}>;

export type LocalSessionRpcTarget = Readonly<{
  sessionId: string;
  /** The Session's own credential: its Account and authority bound what local callers receive. */
  credentialToken: string;
  /** The Session's existing RPC admission and handlers (`RpcHandlerManager.handleRequest` with source `local_session_channel`). */
  handleRequest(request: SocketRpcRequestPayload): Promise<unknown>;
  cancelRequest(requestId: string): void;
  /**
   * The process generation of the daemon that spawned or adopted this host (its current published
   * state). Only a connection whose kernel-proven peer is that process, under this OS user, may call.
   */
  readTrustedCaller(): Promise<ProcessBirthWitness | null>;
  /** Called only after the eligible local target is published; retirement invalidates the predicate. */
  onPublished?: (isMethodAvailable: (method: string) => boolean) => void;
}>;

type RegisteredTarget = Readonly<{
  target: LocalSessionRpcTarget;
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

async function observeCallerPeer(socket: Socket): Promise<CallerPeer | null> {
  const executablePath = resolveProcessCustodyPeerIdentityExecutable(process.platform);
  if (!executablePath) return null;
  const identity = await observeLocalIpcPeerIdentity({ socket, executablePath }).catch(() => null);
  if (!identity || identity.uid !== process.getuid?.()) return null;
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
  const peer = peerIdentities.get(socket);
  if (!peer?.birth || peer.uid !== process.getuid?.()) return false;
  const trusted = await owner.readTrustedCaller().catch(() => null);
  if (!trusted || trusted.pid !== peer.pid) return false;
  const { compareProcessBirth } = await import('@/daemon/processIdentity');
  if (compareProcessBirth(trusted, { status: 'same', witness: peer.birth }).status !== 'same') return false;
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
  const { packet, callerAuthority } = body as { packet?: unknown; callerAuthority?: unknown };
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return forbidden;
  if (callerAuthority !== 'present_user' && callerAuthority !== 'account_automation') return forbidden;
  const fields = packet as Record<string, unknown>;
  if (Object.keys(fields).some(key => !LOCAL_PACKET_FIELDS.has(key))) return forbidden;
  const method = fields.method;
  if (typeof method !== 'string') return forbidden;
  const separator = method.indexOf(':');
  const sessionId = separator > 0 ? method.slice(0, separator) : '';
  const registered = current.targets.get(sessionId);
  if (!registered) return { status: 404, error: 'Session is not hosted on this local channel', errorCode: 'local_session_unavailable' };
  const authorization = resolveSocketRpcSameAccountSessionAuthorizationV1(method.slice(separator + 1), sessionId);
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
    || request.url === HOST_HANDOVER_PATH)) {
    await handleSessionHostRequest(current, request, response);
    return;
  }
  if (request.method !== 'POST' || (request.url !== CALL_PATH && request.url !== CANCEL_PATH)) {
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
  if (request.url === CANCEL_PATH) {
    const parsed = SocketRpcCancellationPayloadSchema.safeParse(body && typeof body === 'object' ? (body as { cancel?: unknown }).cancel : undefined);
    const sessionId = body && typeof body === 'object' ? (body as { sessionId?: unknown }).sessionId : undefined;
    const registered = typeof sessionId === 'string' ? current.targets.get(sessionId) : undefined;
    if (parsed.success && registered && await isTrustedCaller(registered.target, request)) registered.target.cancelRequest(parsed.data.requestId);
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
  // A caller that disconnects before the reply has the same meaning as a Socket.IO caller cancel.
  const onClose = () => {
    if (!response.writableEnded && typeof packet.requestId === 'string') registered.target.cancelRequest(packet.requestId);
  };
  response.once('close', onClose);
  try {
    const result = await registered.target.handleRequest(packet);
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
      void observeCallerPeer(socket).then(identity => {
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
  // Callers cannot yet verify a Windows pipe server's user SID, so they never route there; serving
  // a pipe nobody may use would only add a listener.
  if (process.platform === 'win32') return async () => {};
  // Only a host holding a full Account/terminal credential of the Session owner serves locally; a
  // restricted host (ephemeral runner, API token) keeps every call on the server's admission.
  const hostKind = readCredentialKind(target.credentialToken);
  if (!hostKind || !LOCAL_ROUTE_CREDENTIAL_KINDS.has(hostKind)) return async () => {};
  const accountId = readAccountIdFromToken(target.credentialToken);
  if (!accountId) throw new Error('Local Session RPC requires the Session Account credential');
  ingress ??= startIngress().catch(error => { ingress = null; throw error; });
  const current = await ingress;
  const descriptorPath = resolveDescriptorPath(target.sessionId);
  const registered: RegisteredTarget = {
    target, accountId, descriptorPath,
    authority: resolveSocketRpcCallerAuthority({ credentialKind: readCredentialKind(target.credentialToken) }),
  };
  current.targets.set(target.sessionId, registered);
  try {
    await writeDescriptor(descriptorPath, {
      v: DESCRIPTOR_VERSION, sessionId: target.sessionId, accountId,
      endpoint: { kind: current.endpoint.kind, path: current.endpoint.endpointPath }, pid: process.pid,
    });
  } catch (error) {
    if (current.targets.get(target.sessionId) === registered) current.targets.delete(target.sessionId);
    throw error;
  }
  target.onPublished?.(method => current.targets.get(target.sessionId) === registered
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
    agent = new Agent({ keepAlive: true });
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
  if (process.platform === 'win32') return;
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
    if (!isOwnerOnlyPath(resolveDescriptorDirectory()) || !isOwnerOnlyPath(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
    const endpoint = parsed?.endpoint as Partial<LocalSessionRpcDescriptorV1['endpoint']> | undefined;
    if (!parsed || parsed.v !== DESCRIPTOR_VERSION || !endpoint || typeof endpoint.path !== 'string' || endpoint.kind !== 'unix') return null;
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
}>): LocalSessionRpcRoute | null {
  // Windows: callers cannot yet verify the pipe server's user SID (relay follow-up), so never local.
  if (process.platform === 'win32') return null;
  // Hosts admit only their daemon (kernel peer identity); other processes keep the server path.
  if (!localSessionRpcCallerEnabled) return null;
  if (!resolveSocketRpcSameAccountSessionAuthorizationV1(input.method, input.sessionId)) return null;
  // Only credentials whose server admission is exactly "Account + Session access" go local. Restricted
  // kinds (ephemeral Session runners, API tokens) keep the server's extra principal checks.
  const credentialKind = readCredentialKind(input.token);
  if (!credentialKind || !LOCAL_ROUTE_CREDENTIAL_KINDS.has(credentialKind)) return null;
  const descriptor = readDescriptor(input.sessionId);
  if (!descriptor || descriptor.accountId !== readAccountIdFromToken(input.token)) return null;
  const callerAuthority = resolveSocketRpcCallerAuthority({ credentialKind, authorityCeiling: input.authorityCeiling });
  const socket: SocketRpcSocket = {
    emit: (event: string, payload?: unknown) => {
      if (event !== SOCKET_RPC_EVENTS.CANCEL) return false;
      void postJson(descriptor, CANCEL_PATH, { sessionId: input.sessionId, cancel: payload }).catch(() => {});
      return true;
    },
    emitWithAck: async (event: string, packet?: unknown) => {
      if (event !== SOCKET_RPC_EVENTS.CALL) throw new Error(`Local Session RPC cannot emit ${event}`);
      const response = await postJson(descriptor, CALL_PATH, { packet, callerAuthority });
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
/** A restarted daemon re-observes a running Session's end (the add request's body, re-attached). */
const HOST_WATCH_PATH = '/v1/session-host/watch';
/** A newer daemon moves this host's Sessions to a current host: the host hands over and exits. */
const HOST_HANDOVER_PATH = '/v1/session-host/handover';
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
}>;

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
  endSession(trackingKey: string): LocalSessionHostEndResult;
  /** This running Session's end (same result as its add), or null when this host does not run it. */
  watchSession(trackingKey: string): Promise<SessionHostCommandEnd> | null;
  /**
   * Stop admitting, leave every Session's Agent in its holder and exit with
   * `SESSION_HOST_HANDOVER_EXIT_CODE`; false when the host is already ending.
   */
  handOver(): boolean;
  /** The daemon that launched this host (or adopted it after a restart): the only caller admitted. */
  readTrustedCaller(): Promise<ProcessBirthWitness | null>;
}>;

/**
 * One descriptor per host process: a host started before a CLI update keeps serving its Sessions
 * while the updated daemon starts a current host for new ones.
 */
function resolveHostDescriptorPath(hostPid: number): string {
  return join(resolveDescriptorDirectory(), `session-host-${hostPid}.json`);
}

function parseSessionHostAddRequest(body: unknown): SessionHostAddRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { trackingKey, argv, env, cwd } = body as Record<string, unknown>;
  if (typeof trackingKey !== 'string' || !trackingKey || typeof cwd !== 'string' || !cwd) return null;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(arg => typeof arg !== 'string')) return null;
  if (!env || typeof env !== 'object' || Array.isArray(env)
    || Object.values(env).some(value => typeof value !== 'string')) return null;
  return { trackingKey, argv: argv as string[], env: env as Record<string, string>, cwd };
}

async function handleSessionHostRequest(current: Ingress, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const host = current.host;
  if (!host) {
    reply(response, 404, { error: 'No session host on this endpoint', errorCode: 'local_session_unavailable' });
    return;
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
    reply(response, 200, typeof trackingKey === 'string' ? host.endSession(trackingKey) : { status: 'not_hosted' });
    return;
  }
  if (request.url === HOST_HANDOVER_PATH) {
    reply(response, 200, { handingOver: host.handOver() });
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
    const add = parseSessionHostAddRequest(body);
    if (!add) {
      reply(response, 400, { error: 'Invalid session host request', errorCode: 'RPC_FORBIDDEN' });
      return;
    }
    try {
      ended = host.addSession(add);
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
  // Windows callers cannot yet verify a pipe server's user SID (see the Session RPC router).
  if (process.platform === 'win32') throw new Error('A session host needs a peer-verified local endpoint');
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
export type LocalSessionHostSessionEnd = Readonly<{ exitCode: number | null; closing: boolean; notHosted: boolean; failureCause?: SessionRuntimeIssueV1['failureCause'] }>;

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
  const refuse = (closing: boolean, notHosted = false) => {
    resolveAdmitted(false);
    resolveEnded({ exitCode: null, closing, notHosted });
  };
  const descriptor = readHostDescriptor(input.hostPid);
  const text = JSON.stringify(input.body);
  if (Buffer.byteLength(text) > EXTERNAL_ACTION_SOCKET_MIN_BUFFER_BYTES_V2) {
    refuse(false);
    return { admitted, ended };
  }
  if (!descriptor) {
    // That host no longer publishes its endpoint: it ended (or is ending); a new host takes the Session.
    refuse(true);
    return { admitted, ended };
  }
  // Its own connection: the request lives as long as the Session.
  const outgoing = httpRequest({
    socketPath: descriptor.endpoint.path, path: input.path, method: 'POST', agent: false,
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
  }, incoming => {
    if (incoming.statusCode !== 200) {
      void readBody(incoming).then(raw => {
        let errorCode: unknown;
        try { errorCode = (JSON.parse(raw) as { errorCode?: unknown } | null)?.errorCode; } catch { errorCode = undefined; }
        refuse(errorCode === SESSION_HOST_CLOSING, errorCode === SESSION_NOT_HOSTED);
      }, () => refuse(false));
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
  outgoing.once('error', () => {
    // Before admission nothing was started; after it, the host connection broke.
    refuse(false);
  });
  outgoing.end(text);
  return { admitted, ended };
}

/** Ask the session host to end one Session, retaining its refusal or transport outcome. */
export async function endLocalSessionHostSession(input: Readonly<{ hostPid: number; trackingKey: string }>): Promise<LocalSessionHostEndResult> {
  const result = await callLocalSessionHost(input.hostPid, HOST_END_PATH, { trackingKey: input.trackingKey });
  if (result?.errorCode === LOCAL_SESSION_PEER_REFUSED) return { status: 'peer_refused' };
  const status = result?.status;
  if (status === 'termination_requested' || status === 'not_hosted' || status === 'termination_unavailable') return { status };
  return { status: 'host_unavailable' };
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
  if (!descriptor) return null;
  const text = JSON.stringify(body);
  return await new Promise<Record<string, unknown> | null>(resolve => {
    const outgoing = httpRequest({
      socketPath: descriptor.endpoint.path, path, method: 'POST', agent: false,
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
