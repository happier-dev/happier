import { createHmac, timingSafeEqual } from 'node:crypto';

export const WORKSPACE_SYNC_BROKER_PROTOCOL = 1 as const;
export const WORKSPACE_SYNC_BROKER_MAX_FRAME_BYTES = 64 * 1024;
export const WORKSPACE_SYNC_BROKER_MAX_ID_BYTES = 256;
export const WORKSPACE_SYNC_BROKER_MAX_MESSAGE_BYTES = 4096;
export const WORKSPACE_SYNC_BROKER_ATTACH_TTL_MS = 30_000;
export const OPEN_REMOTE_DEADLINE_MS = 15_000;
export const MAX_CONCURRENT_DATA_STREAMS = 8;
export const MAX_CONTROL_FRAME_BYTES = WORKSPACE_SYNC_BROKER_MAX_FRAME_BYTES;

export type MutagenControlCommandV1 = Readonly<{ t: 'create' | 'copy_once' | 'get' | 'list' | 'flush' | 'pause' | 'resume' | 'terminate' | 'list_conflicts' | 'delete_conflict_loser' | 'shutdown'; requestId: string; [key: string]: unknown }>;

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
  create: ['t', 'requestId', 'relationship', 'sessionName'], copy_once: ['t', 'requestId', 'operation', 'sessionName'],
  get: ['t', 'requestId', 'relationshipId'], list: ['t', 'requestId'], flush: ['t', 'requestId', 'relationshipId'],
  pause: ['t', 'requestId', 'relationshipId'], resume: ['t', 'requestId', 'relationshipId'], terminate: ['t', 'requestId', 'relationshipId'],
  list_conflicts: ['t', 'requestId', 'relationshipId', 'limit'], delete_conflict_loser: ['t', 'requestId', 'relationshipId', 'path', 'keep', 'expectedDigest', 'expectedKind'], shutdown: ['t', 'requestId'],
};

export function parseMutagenControlCommandV1(value: unknown): MutagenControlCommandV1 {
  if (!isRecord(value) || typeof value.t !== 'string' || !Object.hasOwn(commandFields, value.t)) throw new Error('unknown mutagen control command');
  const tag = value.t as MutagenControlCommandV1['t'];
  for (const key of Object.keys(value)) if (!commandFields[tag].includes(key)) throw new Error(`unknown mutagen command field: ${key}`);
  boundedIdentifier(value.requestId, 'requestId');
  if (tag === 'list_conflicts' && (!Number.isInteger(value.limit) || (value.limit as number) < 0 || (value.limit as number) > 1000)) throw new Error('invalid conflict limit');
  if (tag === 'delete_conflict_loser') {
    boundedIdentifier(value.relationshipId, 'relationshipId'); boundedString(value.path, 'path');
    if (value.keep !== 'alpha' && value.keep !== 'beta') throw new Error('invalid conflict keep');
    if (!['missing', 'file', 'directory', 'symlink'].includes(String(value.expectedKind))) throw new Error('invalid conflict kind');
    if (value.expectedDigest !== undefined) boundedString(value.expectedDigest, 'expectedDigest', 512);
  }
  for (const key of ['relationshipId', 'sessionName']) if (key in value) boundedIdentifier(value[key], key);
  return value as MutagenControlCommandV1;
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
export const encodeBrokerFrame = encodeBrokerControlFrame;
export const parseBrokerControlEnvelope = parseBrokerControlV1;

/** Incremental decoder for u32be + UTF-8 JSON control frames. */
export class BrokerControlFrameDecoder {
  private pending = Buffer.alloc(0);
  push(chunk: Uint8Array): BrokerControlV1[] {
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
    const out: BrokerControlV1[] = [];
    while (this.pending.byteLength >= 4) {
      const length = this.pending.readUInt32BE(0);
      if (length === 0 || length > WORKSPACE_SYNC_BROKER_MAX_FRAME_BYTES) throw new Error('invalid broker frame length');
      if (this.pending.byteLength < length + 4) break;
      const payload = this.pending.subarray(4, length + 4);
      this.pending = this.pending.subarray(length + 4);
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); } catch { throw new Error('malformed broker control JSON'); }
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

export type BrokerRequestState = 'LISTEN' | 'CONTROL_AUTHENTICATING' | 'CONTROL_READY' | 'OPEN_VALIDATING' | 'REMOTE_OPENING' | 'DATA_ATTACH_PENDING' | 'STREAMING' | 'CLOSING' | 'CLOSED';
const transitions: Record<BrokerRequestState, readonly BrokerRequestState[]> = {
  LISTEN: ['CONTROL_AUTHENTICATING'], CONTROL_AUTHENTICATING: ['CONTROL_READY', 'CLOSED'], CONTROL_READY: ['OPEN_VALIDATING', 'CLOSING', 'CLOSED'], OPEN_VALIDATING: ['REMOTE_OPENING', 'CLOSING', 'CLOSED'], REMOTE_OPENING: ['DATA_ATTACH_PENDING', 'CLOSING', 'CLOSED'], DATA_ATTACH_PENDING: ['STREAMING', 'CLOSING', 'CLOSED'], STREAMING: ['CLOSING', 'CLOSED'], CLOSING: ['CLOSED'], CLOSED: [],
};

export class BrokerRequestStateMachine {
  private currentState: BrokerRequestState = 'LISTEN';
  get state(): BrokerRequestState { return this.currentState; }
  transition(next: BrokerRequestState): void {
    if (!transitions[this.currentState].includes(next)) throw new Error(`invalid broker state transition: ${this.currentState} -> ${next}`);
    this.currentState = next;
  }
  fail(): void { if (this.currentState !== 'CLOSED') this.currentState = 'CLOSED'; }
}
