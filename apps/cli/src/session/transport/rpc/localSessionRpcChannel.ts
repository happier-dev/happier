import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
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
import { createOwnerOnlyLocalEndpoint, type OwnerOnlyLocalEndpoint } from '@/utils/ipc/ownerOnlyLocalEndpoint';

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
 * directory (0600 files); the endpoint is a 0600 unix socket inside a private 0700 temp directory
 * whose ownership the caller verifies before connecting (a crashed host's temp directory may be gone
 * and recreated by another user). Windows hosts serve a named pipe with an owner-SID-only DACL, but
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
}>;

type RegisteredTarget = Readonly<{
  target: LocalSessionRpcTarget;
  accountId: string;
  authority: LocalCallerAuthority;
  descriptorPath: string;
}>;

type Ingress = {
  readonly server: Server;
  readonly endpoint: OwnerOnlyLocalEndpoint;
  readonly directory: string | null;
  readonly targets: Map<string, RegisteredTarget>;
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
    if (parsed.success && registered) registered.target.cancelRequest(parsed.data.requestId);
    reply(response, 200, { ok: true });
    return;
  }
  const admitted = admitLocalPacket(current, body);
  if ('status' in admitted) {
    reply(response, admitted.status, { error: admitted.error, errorCode: admitted.errorCode });
    return;
  }
  const { registered, request: packet } = admitted;
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
  const directory = isWindows ? null : await mkdtemp(join(resolveEndpointRoot(), 'happier-srpc-'));
  try {
    if (directory) await chmod(directory, 0o700);
    const endpoint = createOwnerOnlyLocalEndpoint({
      endpointPath: directory ? join(directory, 'rpc.sock') : `\\\\.\\pipe\\happier-session-rpc-${randomBytes(16).toString('hex')}`,
      windowsPipePrefix: 'happier-session-rpc-',
    });
    const server = createServer();
    const current: Ingress = { server, endpoint, directory, targets: new Map() };
    server.on('request', (request, response) => {
      void handleIngressRequest(current, request, response).catch(error => {
        logger.warnLocalFile('[SESSION LOCAL RPC] request failed', { error: error instanceof Error ? error.message : String(error) });
        reply(response, 500, { error: 'Local Session RPC failed', errorCode: 'local_session_unavailable' });
      });
    });
    await endpoint.listen(server);
    await endpoint.secure();
    // The hosted Sessions own the process lifetime; an idle listener never holds it open.
    server.unref();
    return current;
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** The per-user runtime directory when the platform provides one ($XDG_RUNTIME_DIR, 0700), else the user's temp dir. */
function resolveEndpointRoot(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  try {
    if (runtime && isOwnerOnly(runtime)) return runtime;
  } catch { /* unavailable: fall through */ }
  return tmpdir();
}

async function writeDescriptor(path: string, descriptor: LocalSessionRpcDescriptorV1): Promise<void> {
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
  let retired = false;
  return async () => {
    if (retired) return;
    retired = true;
    if (current.targets.get(target.sessionId) !== registered) return;
    current.targets.delete(target.sessionId);
    await removeOwnDescriptor(target.sessionId, process.pid, current.endpoint.endpointPath);
    if (current.targets.size > 0 || ingress === null || await ingress !== current) return;
    ingress = null;
    current.server.closeAllConnections();
    await new Promise<void>(resolve => current.server.close(() => resolve()));
    await current.endpoint.remove();
    if (current.directory) await rm(current.directory, { recursive: true, force: true });
  };
}

/** Delete a descriptor only while it still names this host (a successor may have replaced it). */
async function removeOwnDescriptor(sessionId: string, pid: number, endpointPath?: string): Promise<boolean> {
  const current = readDescriptor(sessionId);
  if (!current || current.pid !== pid || (endpointPath !== undefined && current.endpoint.path !== endpointPath)) return false;
  await rm(resolveDescriptorPath(sessionId), { force: true });
  return true;
}

/** Same-machine calls in flight from this process, by sessionId, so the liveness owner can end them. */
const inFlightLocalCalls = new Map<string, Set<() => void>>();

/**
 * The daemon's runner-liveness owner (session marker removal) reports that the host process `pid`
 * for `sessionId` is gone: retire its descriptor if it is still that host's, and end this process's
 * in-flight local calls to it (outcome unknown, exactly like a lost Socket.IO target).
 */
export async function retireGoneLocalSessionRpcHost(input: Readonly<{ sessionId: string; pid: number }>): Promise<void> {
  for (const abort of inFlightLocalCalls.get(input.sessionId) ?? []) abort();
  if (process.platform === 'win32') return;
  await removeOwnDescriptor(input.sessionId, input.pid).catch(() => false);
}

/** Owner-only check of a descriptor path on POSIX: our uid, no group/other bits on file and directory. */
function isOwnerOnly(path: string): boolean {
  if (process.platform === 'win32') return false;
  const uid = process.getuid?.();
  const entry = lstatSync(path);
  return entry.uid === uid && (entry.mode & 0o077) === 0 && !entry.isSymbolicLink();
}

function readDescriptor(sessionId: string): LocalSessionRpcDescriptorV1 | null {
  const path = resolveDescriptorPath(sessionId);
  try {
    if (!isOwnerOnly(resolveDescriptorDirectory()) || !isOwnerOnly(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LocalSessionRpcDescriptorV1>;
    if (parsed.v !== DESCRIPTOR_VERSION || parsed.sessionId !== sessionId || typeof parsed.accountId !== 'string'
      || !parsed.endpoint || typeof parsed.endpoint.path !== 'string' || parsed.endpoint.kind !== 'unix') return null;
    // The endpoint's own directory must still be ours: a crashed host's temp directory can be
    // recreated by another OS user (sticky /tmp keeps an owned directory ours, so no TOCTOU).
    if (!isOwnerOnly(dirname(parsed.endpoint.path))) return null;
    return parsed as LocalSessionRpcDescriptorV1;
  } catch {
    return null;
  }
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
    const calls = inFlightLocalCalls.get(descriptor.sessionId) ?? new Set<() => void>();
    inFlightLocalCalls.set(descriptor.sessionId, calls);
    const settle = () => { calls.delete(abort); if (calls.size === 0 && inFlightLocalCalls.get(descriptor.sessionId) === calls) inFlightLocalCalls.delete(descriptor.sessionId); };
    const outgoing = httpRequest({
      socketPath: descriptor.endpoint.path, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) },
    }, incoming => {
      readBody(incoming).then(raw => {
        settle();
        try { resolve({ status: incoming.statusCode ?? 0, body: JSON.parse(raw) }); } catch (error) { reject(error); }
      }, error => { settle(); reject(error); });
    });
    const abort = () => outgoing.destroy(new Error('Local Session host is gone'));
    calls.add(abort);
    outgoing.once('error', (error: NodeJS.ErrnoException) => {
      settle();
      // Connect-phase failures: no host is listening, so nothing was dispatched.
      reject(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
        ? new LocalSessionRpcUnavailableError('Local Session host is not listening') : error);
    });
    outgoing.end(text);
  });
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
      return response.body;
    },
  };
  return { socket };
}
