import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { WORKSPACE_SYNC_MAX_PATTERN_BYTES, WORKSPACE_SYNC_MAX_PATTERNS, WorkspaceSyncSelectionDiagnoseV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

export const WORKSPACE_SYNC_BROKER_PROTOCOL = 1 as const;
export const WORKSPACE_SYNC_BROKER_MAX_FRAME_BYTES = 64 * 1024;
/** Maximum size for ordinary control and response envelopes. */
export const WORKSPACE_SYNC_BROKER_MAX_CONTROL_FRAME_BYTES = WORKSPACE_SYNC_BROKER_MAX_FRAME_BYTES;
export const WORKSPACE_SYNC_BROKER_MAX_ID_BYTES = 256;
export const WORKSPACE_SYNC_BROKER_MAX_MESSAGE_BYTES = 4096;
// Two 128×1024-byte Protocol policy arrays, worst-case JSON escaping, and envelope metadata.
export const WORKSPACE_SYNC_BROKER_MAX_REQUEST_FRAME_BYTES = 2 * 1024 * 1024;
export const WORKSPACE_SYNC_BROKER_ATTACH_TTL_MS = 30_000;
export const OPEN_REMOTE_DEADLINE_MS = 15_000;
export const MAX_CONCURRENT_DATA_STREAMS = 8;
export const MAX_CONTROL_FRAME_BYTES = WORKSPACE_SYNC_BROKER_MAX_FRAME_BYTES;

export type MutagenSynchronizationMode = 'one-way-safe' | 'one-way-replica' | 'two-way-safe';
export type MutagenContentPolicy = Readonly<{
  selection: 'git_worktree' | 'all_files';
  extraIgnorePatterns: readonly string[];
  extraIncludePatterns: readonly string[];
}>;
export type MutagenEndpointSummaryV1 = Readonly<{
  protocol: 'external';
  host: string;
  path: '';
  state: Readonly<{
    connected: boolean;
    scanned: boolean;
    scanProblemCount: number;
    transitionProblemCount: number;
  }> | null;
}>;
export type MutagenSessionSummaryV1 = Readonly<{
  identifier: string;
  name: string;
  labels: Readonly<Record<string, string>>;
  alpha: MutagenEndpointSummaryV1;
  beta: MutagenEndpointSummaryV1;
  mode: MutagenSynchronizationMode;
  paused: boolean;
  status: string;
  successfulCycles: number;
  conflictCount: number;
  lastError?: string;
  lastErrorCode?: 'git_selection_unavailable';
}>;
export type MutagenSessionListPageV1 = Readonly<{
  sessions: readonly MutagenSessionSummaryV1[];
  /** Opaque engine-view continuation; null means this view is complete. */
  nextCursor: string | null;
}>;
export type MutagenConflictSummaryV1 = Readonly<{
  root: string;
  alphaChanges: readonly unknown[];
  betaChanges: readonly unknown[];
}>;
export type MutagenConflictListPageV1 = Readonly<{
  totalCount: number;
  shownCount: number;
  truncatedCount: number;
  conflicts: readonly MutagenConflictSummaryV1[];
  /** Opaque engine-view continuation; null means this view is complete. */
  nextCursor: string | null;
}>;
export type MutagenPolicyPageV1 = Readonly<{
  selection: MutagenContentPolicy['selection'];
  patterns: readonly string[];
  /** Opaque engine-view continuation; null means this view is complete. */
  nextCursor: string | null;
}>;
export type MutagenSessionDefinition = Readonly<{
  alpha: string;
  beta: string;
  mode: MutagenSynchronizationMode;
  contentPolicy: MutagenContentPolicy;
  name: string;
  labels: Readonly<Record<string, string>>;
}>;
export type MutagenControlCommandV1 =
  | Readonly<{ t: 'create'; requestId: string; session: MutagenSessionDefinition }>
  | Readonly<{ t: 'get'; requestId: string; sessionIdentifier: string }>
  | Readonly<{ t: 'list'; requestId: string; cursor?: string; limit: number }>
  | Readonly<{ t: 'flush'; requestId: string; sessionIdentifier: string }>
  | Readonly<{ t: 'pause'; requestId: string; sessionIdentifier: string }>
  | Readonly<{ t: 'resume'; requestId: string; sessionIdentifier: string }>
  | Readonly<{ t: 'terminate'; requestId: string; sessionIdentifier: string }>
  | Readonly<{ t: 'get_policy'; requestId: string; sessionIdentifier: string; cursor?: string; limit: number }>
  | Readonly<{ t: 'list_conflicts'; requestId: string; sessionIdentifier: string; cursor?: string; limit: number }>
  | Readonly<{ t: 'diagnose_selection'; requestId: string; sessionIdentifier: string; side: 'alpha' | 'beta'; path: string }>
  | Readonly<{ t: 'shutdown'; requestId: string }>;

export const WORKSPACE_SYNC_BROKER_TERMINAL_ERROR_CODES = [
  'unauthorized',
  'malformed_control',
  'relationship_not_owned',
  'root_mismatch',
  'root_changed',
  'peer_unavailable',
  'agent_unavailable',
  'engine_unavailable',
  'git_selection_unavailable',
  'stream_limit',
  'expired_request',
  'data_attach_failed',
  'cancelled',
  'protocol_error',
  'cursor_invalidated',
  'indeterminate',
] as const;
export type BrokerTerminalErrorCode = (typeof WORKSPACE_SYNC_BROKER_TERMINAL_ERROR_CODES)[number];

export class BrokerProtocolError extends Error {
  constructor(readonly code: BrokerTerminalErrorCode, message: string) {
    super(message);
    this.name = 'BrokerProtocolError';
  }
}

export function isBrokerTerminalErrorCode(value: unknown): value is BrokerTerminalErrorCode {
  return typeof value === 'string'
    && (WORKSPACE_SYNC_BROKER_TERMINAL_ERROR_CODES as readonly string[]).includes(value);
}

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function base32NoPadding(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return result;
}

/** Stable, non-reversible identifier persisted as external://<id>. */
export function deriveWorkspaceSyncEndpointId(
  relationshipId: string,
  role: 'alpha' | 'beta',
): string {
  const relationship = relationshipId.trim();
  if (!relationship || Buffer.byteLength(relationship, 'utf8') > WORKSPACE_SYNC_BROKER_MAX_ID_BYTES) {
    throw new Error('invalid relationshipId');
  }
  if (role !== 'alpha' && role !== 'beta') throw new Error('invalid endpoint role');
  const digest = createHash('sha256')
    .update('happier-workspace-endpoint-v1\0', 'utf8')
    .update(relationship, 'utf8')
    .update('\0', 'utf8')
    .update(role, 'utf8')
    .digest()
    .subarray(0, 20);
  return `ws1_${base32NoPadding(digest)}`;
}

export type BrokerControlV1 =
  | { t: 'hello'; protocol: 1; brokerInstanceId: string; launchNonce: string; sidecarPid: number; proof: string }
  | { t: 'hello_ok'; protocol: 1; brokerInstanceId: string; proof: string }
  | { t: 'open_data'; requestId: string; endpointId: string; expiresAtMs: number }
  | { t: 'data_ready'; requestId: string; streamId: string; dataEndpoint: string; attachNonce: string; expiresAtMs: number }
  | { t: 'attach_data'; streamId: string; attachNonce: string }
  | { t: 'data_ok'; streamId: string }
  | { t: 'command'; requestId: string; command: unknown }
  | { t: 'result'; requestId: string; result: unknown }
  | { t: 'cancel'; requestId: string }
  | { t: 'close'; requestId: string; reason: string }
  | { t: 'close_ok'; requestId: string }
  | { t: 'error'; requestId?: string; code: string; message: string };

const fields: Record<BrokerControlV1['t'], readonly string[]> = {
  hello: ['t', 'protocol', 'brokerInstanceId', 'launchNonce', 'sidecarPid', 'proof'],
  hello_ok: ['t', 'protocol', 'brokerInstanceId', 'proof'],
  open_data: ['t', 'requestId', 'endpointId', 'expiresAtMs'],
  data_ready: ['t', 'requestId', 'streamId', 'dataEndpoint', 'attachNonce', 'expiresAtMs'],
  attach_data: ['t', 'streamId', 'attachNonce'],
  data_ok: ['t', 'streamId'],
  command: ['t', 'requestId', 'command'],
  result: ['t', 'requestId', 'result'],
  cancel: ['t', 'requestId'],
  close: ['t', 'requestId', 'reason'],
  close_ok: ['t', 'requestId'],
  error: ['t', 'requestId', 'code', 'message'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, name: string, max = WORKSPACE_SYNC_BROKER_MAX_ID_BYTES): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > max) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}
function boundedIdentifier(value: unknown, name: string): string {
  const result = boundedString(value, name);
  if (!/^[\x21-\x7e]+$/.test(result)) throw new Error(`invalid ${name}`);
  return result;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`invalid ${name}`);
  return value;
}

const commandFields: Record<MutagenControlCommandV1['t'], readonly string[]> = {
  create: ['t', 'requestId', 'session'],
  get: ['t', 'requestId', 'sessionIdentifier'], list: ['t', 'requestId', 'cursor', 'limit'], flush: ['t', 'requestId', 'sessionIdentifier'],
  pause: ['t', 'requestId', 'sessionIdentifier'], resume: ['t', 'requestId', 'sessionIdentifier'], terminate: ['t', 'requestId', 'sessionIdentifier'],
  get_policy: ['t', 'requestId', 'sessionIdentifier', 'cursor', 'limit'],
  list_conflicts: ['t', 'requestId', 'sessionIdentifier', 'cursor', 'limit'], shutdown: ['t', 'requestId'],
  diagnose_selection: ['t', 'requestId', 'sessionIdentifier', 'side', 'path'],
};

function strictFields(value: Record<string, unknown>, allowed: readonly string[], owner: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unknown ${owner} field: ${key}`);
}

function parseExternalEndpoint(value: unknown, name: string): string {
  const raw = boundedString(value, name, 267);
  const match = /^external:\/\/([\x21-\x7e]+)$/u.exec(raw);
  if (!match || !match[1] || match[1].includes('/') || match[1].includes('?') || match[1].includes('#')) {
    throw new Error(`invalid ${name}: expected opaque external endpoint`);
  }
  boundedIdentifier(match[1], `${name} identifier`);
  return raw;
}

function parsePatterns(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length > WORKSPACE_SYNC_MAX_PATTERNS) throw new Error(`invalid ${name}`);
  return value.map((pattern) => boundedString(pattern, name, WORKSPACE_SYNC_MAX_PATTERN_BYTES));
}

function parseIncludePatterns(value: unknown): readonly string[] {
  const patterns = parsePatterns(value, 'extraIncludePatterns');
  if (patterns.some((pattern) => pattern.startsWith('!'))) throw new Error('invalid extraIncludePatterns');
  return patterns;
}

function parseMutagenContentPolicy(value: unknown): MutagenContentPolicy {
  if (!isRecord(value)) throw new Error('invalid contentPolicy');
  strictFields(value, ['selection', 'extraIgnorePatterns', 'extraIncludePatterns'], 'contentPolicy');
  if (value.selection !== 'git_worktree' && value.selection !== 'all_files') throw new Error('invalid contentPolicy selection');
  return {
    selection: value.selection,
    extraIgnorePatterns: parsePatterns(value.extraIgnorePatterns, 'extraIgnorePatterns'),
    extraIncludePatterns: parseIncludePatterns(value.extraIncludePatterns),
  };
}

function parseMutagenSessionDefinition(value: unknown): MutagenSessionDefinition {
  if (!isRecord(value)) throw new Error('invalid session definition');
  strictFields(value, ['alpha', 'beta', 'mode', 'contentPolicy', 'name', 'labels'], 'session');
  const alpha = parseExternalEndpoint(value.alpha, 'alpha');
  const beta = parseExternalEndpoint(value.beta, 'beta');
  if (alpha === beta) throw new Error('session endpoints must be distinct');
  if (value.mode !== 'one-way-safe' && value.mode !== 'one-way-replica' && value.mode !== 'two-way-safe') {
    throw new Error('invalid synchronization mode');
  }
  if (!isRecord(value.labels) || Object.keys(value.labels).length > 16) throw new Error('invalid session labels');
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(value.labels)) {
    labels[boundedIdentifier(key, 'label key')] = boundedString(label, 'label value');
  }
  return {
    alpha,
    beta,
    mode: value.mode,
    contentPolicy: parseMutagenContentPolicy(value.contentPolicy),
    name: boundedIdentifier(value.name, 'session name'),
    labels,
  };
}

export function parseMutagenControlCommandV1(value: unknown): MutagenControlCommandV1 {
  if (!isRecord(value) || typeof value.t !== 'string' || !Object.hasOwn(commandFields, value.t)) throw new Error('unknown mutagen control command');
  const tag = value.t as MutagenControlCommandV1['t'];
  for (const key of Object.keys(value)) if (!commandFields[tag].includes(key)) throw new Error(`unknown mutagen command field: ${key}`);
  boundedIdentifier(value.requestId, 'requestId');
  const requestId = boundedIdentifier(value.requestId, 'requestId');
  switch (tag) {
    case 'create': {
      return { t: tag, requestId, session: parseMutagenSessionDefinition(value.session) };
    }
    case 'get':
    case 'flush':
    case 'pause':
    case 'resume':
    case 'terminate':
      return { t: tag, requestId, sessionIdentifier: boundedIdentifier(value.sessionIdentifier, 'sessionIdentifier') };
    case 'list': {
      if (!Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 100) {
        throw new Error('invalid list limit');
      }
      return {
        t: tag,
        requestId,
        ...(value.cursor === undefined ? {} : { cursor: boundedIdentifier(value.cursor, 'cursor') }),
        limit: value.limit as number,
      };
    }
    case 'shutdown':
      return { t: tag, requestId };
    case 'diagnose_selection': {
      if (value.side !== 'alpha' && value.side !== 'beta') throw new Error('invalid selection diagnosis side');
      const path = WorkspaceSyncSelectionDiagnoseV1Schema.shape.path.parse(value.path);
      if (path.includes('\\')) throw new Error('invalid selection diagnosis path');
      return { t: tag, requestId, sessionIdentifier: boundedIdentifier(value.sessionIdentifier, 'sessionIdentifier'), side: value.side, path };
    }
    case 'get_policy':
    case 'list_conflicts': {
      if (!Number.isInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 100) {
        throw new Error('invalid conflict limit');
      }
      return {
        t: tag,
        requestId,
        sessionIdentifier: boundedIdentifier(value.sessionIdentifier, 'sessionIdentifier'),
        ...(value.cursor === undefined ? {} : { cursor: boundedIdentifier(value.cursor, 'cursor') }),
        limit: value.limit as number,
      };
    }
  }
}

/** Parses and validates a complete v1 control envelope, rejecting unknown fields/tags. */
export function parseBrokerControlV1(value: unknown): BrokerControlV1 {
  if (!isRecord(value) || typeof value.t !== 'string' || !Object.hasOwn(fields, value.t)) throw new Error('unknown broker control tag');
  const tag = value.t as BrokerControlV1['t'];
  const allowed = fields[tag];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unknown broker control field: ${key}`);
  if (tag !== 'error' && value.protocol !== undefined && value.protocol !== WORKSPACE_SYNC_BROKER_PROTOCOL) {
    throw new Error('unsupported broker protocol');
  }
  switch (tag) {
    case 'hello':
      if (value.protocol !== 1 || typeof value.sidecarPid !== 'number' || !Number.isSafeInteger(value.sidecarPid) || value.sidecarPid < 1) throw new Error('invalid hello');
      return { t: tag, protocol: 1, brokerInstanceId: boundedIdentifier(value.brokerInstanceId, 'brokerInstanceId'), launchNonce: boundedIdentifier(value.launchNonce, 'launchNonce'), sidecarPid: value.sidecarPid, proof: boundedString(value.proof, 'proof', 512) };
    case 'hello_ok':
      if (value.protocol !== 1) throw new Error('invalid hello_ok');
      return { t: tag, protocol: 1, brokerInstanceId: boundedIdentifier(value.brokerInstanceId, 'brokerInstanceId'), proof: boundedString(value.proof, 'proof', 512) };
    case 'open_data':
      return { t: tag, requestId: boundedIdentifier(value.requestId, 'requestId'), endpointId: boundedIdentifier(value.endpointId, 'endpointId'), expiresAtMs: finiteNumber(value.expiresAtMs, 'expiresAtMs') };
    case 'data_ready':
      return { t: tag, requestId: boundedIdentifier(value.requestId, 'requestId'), streamId: boundedIdentifier(value.streamId, 'streamId'), dataEndpoint: boundedString(value.dataEndpoint, 'dataEndpoint'), attachNonce: boundedIdentifier(value.attachNonce, 'attachNonce'), expiresAtMs: finiteNumber(value.expiresAtMs, 'expiresAtMs') };
    case 'attach_data':
      return { t: tag, streamId: boundedIdentifier(value.streamId, 'streamId'), attachNonce: boundedIdentifier(value.attachNonce, 'attachNonce') };
    case 'data_ok':
      return { t: tag, streamId: boundedIdentifier(value.streamId, 'streamId') };
    case 'command':
      { const requestId = boundedIdentifier(value.requestId, 'requestId'); const command = parseMutagenControlCommandV1(value.command); if (command.requestId !== requestId) throw new Error('command requestId mismatch'); return { t: tag, requestId, command }; }
    case 'result':
      return { t: tag, requestId: boundedIdentifier(value.requestId, 'requestId'), result: value.result };
    case 'cancel':
      return { t: tag, requestId: boundedIdentifier(value.requestId, 'requestId') };
    case 'close':
      return { t: tag, requestId: boundedIdentifier(value.requestId, 'requestId'), reason: boundedString(value.reason, 'reason', WORKSPACE_SYNC_BROKER_MAX_MESSAGE_BYTES) };
    case 'close_ok':
      return { t: tag, requestId: boundedIdentifier(value.requestId, 'requestId') };
    case 'error':
      if (value.requestId !== undefined) boundedIdentifier(value.requestId, 'requestId');
      return { t: tag, ...(value.requestId === undefined ? {} : { requestId: value.requestId as string }), code: boundedString(value.code, 'code', 128), message: boundedString(value.message, 'message', WORKSPACE_SYNC_BROKER_MAX_MESSAGE_BYTES) };
  }
}

export function encodeBrokerControlFrame(control: BrokerControlV1): Buffer {
  const parsed = parseBrokerControlV1(control);
  const payload = Buffer.from(JSON.stringify(parsed), 'utf8');
  if (payload.byteLength > WORKSPACE_SYNC_BROKER_MAX_FRAME_BYTES) throw new Error('broker control frame too large');
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

/** Encodes a validated manager request using the request-specific frame budget. */
export function encodeBrokerCommandFrame(command: MutagenControlCommandV1): Buffer {
  const parsed = parseMutagenControlCommandV1(command);
  const envelope = { t: 'command' as const, requestId: parsed.requestId, command: parsed };
  const payload = Buffer.from(JSON.stringify(envelope), 'utf8');
  if (payload.byteLength > WORKSPACE_SYNC_BROKER_MAX_REQUEST_FRAME_BYTES) {
    throw new BrokerProtocolError('protocol_error', 'broker manager command exceeds bounded logical size');
  }
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}
export const encodeBrokerFrame = encodeBrokerControlFrame;
export const parseBrokerControlEnvelope = parseBrokerControlV1;

/** Incremental decoder for u32be + UTF-8 JSON control frames. */
export class BrokerControlFrameDecoder {
  private pending = Buffer.alloc(0);
  private readonly maxFrameBytes: number;

  constructor(options: Readonly<{ maxFrameBytes?: typeof WORKSPACE_SYNC_BROKER_MAX_FRAME_BYTES | typeof WORKSPACE_SYNC_BROKER_MAX_REQUEST_FRAME_BYTES }> = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? WORKSPACE_SYNC_BROKER_MAX_CONTROL_FRAME_BYTES;
    if (this.maxFrameBytes !== WORKSPACE_SYNC_BROKER_MAX_CONTROL_FRAME_BYTES
      && this.maxFrameBytes !== WORKSPACE_SYNC_BROKER_MAX_REQUEST_FRAME_BYTES) {
      throw new Error('invalid broker frame budget');
    }
  }

  push(chunk: Uint8Array): BrokerControlV1[] {
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
    const out: BrokerControlV1[] = [];
    while (this.pending.byteLength >= 4) {
      const length = this.pending.readUInt32BE(0);
      if (length === 0 || length > this.maxFrameBytes) throw new Error('invalid broker frame length');
      if (this.pending.byteLength < length + 4) break;
      const payload = this.pending.subarray(4, length + 4);
      this.pending = this.pending.subarray(length + 4);
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); } catch { throw new Error('malformed broker control JSON'); }
      if (length > WORKSPACE_SYNC_BROKER_MAX_CONTROL_FRAME_BYTES
        && (!isRecord(value) || value.t !== 'command')) {
        throw new Error('oversized broker frame is not a manager command');
      }
      out.push(parseBrokerControlV1(value));
    }
    return out;
  }
  get bufferedBytes(): number { return this.pending.byteLength; }
}
export const BrokerControlDecoder = BrokerControlFrameDecoder;

function transcriptPart(value: string | number): Buffer {
  const bytes = Buffer.from(String(value), 'utf8');
  const prefix = Buffer.allocUnsafe(4); prefix.writeUInt32BE(bytes.byteLength, 0);
  return Buffer.concat([prefix, bytes]);
}

function proofTranscript(label: string, protocol: number, instance: string, nonce: string, pid: number): Buffer {
  return Buffer.concat([transcriptPart(label), transcriptPart(protocol), transcriptPart(instance), transcriptPart(nonce), transcriptPart(pid)]);
}

export function createBrokerHelloProof(secret: Uint8Array, hello: Pick<Extract<BrokerControlV1, { t: 'hello' }>, 'protocol' | 'brokerInstanceId' | 'launchNonce' | 'sidecarPid'>): string {
  return createHmac('sha256', secret).update(proofTranscript('workspace-sync-broker-hello-v1', hello.protocol, hello.brokerInstanceId, hello.launchNonce, hello.sidecarPid)).digest('base64url');
}

export function createBrokerHelloOkProof(secret: Uint8Array, hello: Pick<Extract<BrokerControlV1, { t: 'hello' }>, 'protocol' | 'brokerInstanceId' | 'launchNonce' | 'sidecarPid'>): string {
  return createHmac('sha256', secret).update(proofTranscript('workspace-sync-broker-ok-v1', hello.protocol, hello.brokerInstanceId, hello.launchNonce, hello.sidecarPid)).digest('base64url');
}

export function verifyBrokerProof(expected: string, actual: string): boolean {
  const left = Buffer.from(expected); const right = Buffer.from(actual);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
