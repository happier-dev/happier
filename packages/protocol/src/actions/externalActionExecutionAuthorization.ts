import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import { computeCanonicalDomainSeparatedDigest, encodeCanonicalLengthDelimited } from '../crypto/canonicalDigest.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { signEd25519Message, verifyEd25519Signature } from '../crypto/ed25519.js';
import { MachineInstallationPrivateKeySchema, MachineInstallationPublicKeySchema } from '../machines/identity/installationIdentity.js';
import { SOCKET_RPC_EVENTS, WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema,
  type WorkspaceSyncSourceRoutingV1, type WorkspaceSyncSourceWriterTargetRoutingV1 } from '../rpc/socket.js';
import { SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1 } from '../sessions/messages/sessionPendingMachineAdmissionV1.js';
import { SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2 } from '../sessions/messages/sessionPendingExecutionRunMachineAdmissionV2.js';

export type ExternalActionMachineRpcEventV1 = typeof SOCKET_RPC_EVENTS.CALL
  | typeof SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1
  | typeof SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2;
import { ExternalActionRequestEnvelopeSchema, ExternalActionRequestIdV1Schema, ExternalActionTargetV1Schema, type ExternalActionTargetV1, type ExternalActionRequestEnvelope } from './externalActionApi.js';

export function computeExternalActionRequestEnvelopeDigestV1(envelope: ExternalActionRequestEnvelope): string {
  return computeCanonicalDomainSeparatedDigest('happier-external-action-envelope-v1', [
    createCanonicalJsonSigningInput(ExternalActionRequestEnvelopeSchema.parse(envelope)),
  ]);
}

/** Binds the real Session RPC carrier without reinterpreting its ciphertext as an Action envelope. */
export function computeExternalActionSocketRpcRequestDigestV1(request: Readonly<{
  method: string;
  requestId: string;
  params?: unknown;
  target: Extract<ExternalActionTargetV1, { kind: 'session' }>;
}>): string {
  const target = ExternalActionTargetV1Schema.parse(request.target);
  if (target.kind !== 'session') throw new TypeError('Session input RPC authorization requires a Session target');
  return computeCanonicalDomainSeparatedDigest('happier-external-action-session-rpc-v1', [
    request.method, ExternalActionRequestIdV1Schema.parse(request.requestId),
    createCanonicalJsonSigningInput(target),
    request.params === undefined ? 'absent' : 'json',
    createCanonicalJsonSigningInput(request.params === undefined ? null : request.params),
  ]);
}

export function encodeExternalActionResolvedTargetV1(target: ExternalActionTargetV1): string {
  return encodeBase64(new TextEncoder().encode(createCanonicalJsonSigningInput(ExternalActionTargetV1Schema.parse(target))), 'base64url');
}

export function decodeExternalActionResolvedTargetV1(value: string): ExternalActionTargetV1 | null {
  try {
    const target = ExternalActionTargetV1Schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(value, 'base64url'))));
    return encodeExternalActionResolvedTargetV1(target) === value ? target : null;
  } catch { return null; }
}

type MachineRequest = Readonly<{
  authorizationToken: string;
  effectActionId: string;
  target: ExternalActionTargetV1;
  installationId: string;
  requestId: string;
  method: string;
  path: string;
  body?: unknown;
}>;

function machineRequestBytes(request: MachineRequest): Uint8Array {
  return encodeCanonicalLengthDelimited([
    'happier-external-action-machine-request-v1', request.authorizationToken, request.effectActionId,
    request.installationId, request.requestId,
    createCanonicalJsonSigningInput(ExternalActionTargetV1Schema.parse(request.target)),
    request.method.toUpperCase(), request.path,
    request.body === undefined ? 'absent' : 'json',
    createCanonicalJsonSigningInput(request.body === undefined ? null : request.body),
  ]);
}

type ApprovalInput = Readonly<{ authorizationToken: string; actionId: string; target: ExternalActionTargetV1; input: unknown }>;
type MachineRpcRequest = Readonly<{
  authorizationToken: string;
  effectActionId: string;
  target: ExternalActionTargetV1;
  installationId: string;
  /** The transport owner supplies its finite carrier; omission retains the released CALL bytes. */
  event?: string;
  method: string;
  requestId: string;
  params?: unknown;
  workspaceSyncSourceRouting?: WorkspaceSyncSourceRoutingV1;
  workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
}>;

function machineRpcRequestBytes(request: MachineRpcRequest): Uint8Array {
  const event = request.event ?? SOCKET_RPC_EVENTS.CALL;
  if (event !== SOCKET_RPC_EVENTS.CALL && event !== SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1
    && event !== SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2) {
    throw new TypeError('Unsupported external Action Machine carrier');
  }
  return encodeCanonicalLengthDelimited([
    'happier-external-action-machine-rpc-v1', request.authorizationToken,
    request.effectActionId, request.installationId,
    event,
    createCanonicalJsonSigningInput(ExternalActionTargetV1Schema.parse(request.target)),
    request.method, request.requestId,
    request.params === undefined ? 'absent' : 'json',
    computeCanonicalDomainSeparatedDigest('happier-external-action-rpc-payload-v1', [
      createCanonicalJsonSigningInput(request.params === undefined ? null : request.params),
    ]),
    ...(request.workspaceSyncSourceWriterTargetRouting !== undefined ? [
      'workspace-sync-source-writer-target-v1',
      createCanonicalJsonSigningInput(WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(request.workspaceSyncSourceWriterTargetRouting)),
    ] : []),
    ...(request.workspaceSyncSourceRouting !== undefined ? [
      'workspace-sync-source-routing-v1',
      createCanonicalJsonSigningInput(WorkspaceSyncSourceRoutingV1Schema.parse(request.workspaceSyncSourceRouting)),
    ] : []),
  ]);
}

export function signExternalActionMachineRpcRequestV1(input: MachineRpcRequest & Readonly<{ privateKey: string | Uint8Array }>): string {
  const privateKey = typeof input.privateKey === 'string'
    ? decodeBase64(MachineInstallationPrivateKeySchema.parse(input.privateKey), 'base64url') : input.privateKey;
  return encodeBase64(signEd25519Message(machineRpcRequestBytes(input), privateKey), 'base64url');
}

export function verifyExternalActionMachineRpcRequestV1(input: MachineRpcRequest & Readonly<{ publicKey: string | Uint8Array; signature: string }>): boolean {
  try {
    const publicKey = typeof input.publicKey === 'string'
      ? decodeBase64(MachineInstallationPublicKeySchema.parse(input.publicKey), 'base64url') : input.publicKey;
    const signature = decodeBase64(input.signature, 'base64url');
    if (encodeBase64(signature, 'base64url') !== input.signature) return false;
    return verifyEd25519Signature(machineRpcRequestBytes(input), signature, publicKey);
  } catch { return false; }
}

function approvalInputBytes(input: ApprovalInput): Uint8Array {
  return encodeCanonicalLengthDelimited([
    'happier-external-action-approval-input-v1', input.authorizationToken,
    input.actionId, createCanonicalJsonSigningInput(ExternalActionTargetV1Schema.parse(input.target)),
    createCanonicalJsonSigningInput(input.input),
  ]);
}

export function signExternalActionApprovalInputV1(input: ApprovalInput & Readonly<{ privateKey: string | Uint8Array }>): string {
  const privateKey = typeof input.privateKey === 'string'
    ? decodeBase64(MachineInstallationPrivateKeySchema.parse(input.privateKey), 'base64url') : input.privateKey;
  return encodeBase64(signEd25519Message(approvalInputBytes(input), privateKey), 'base64url');
}

export function verifyExternalActionApprovalInputV1(input: ApprovalInput & Readonly<{ publicKey: string | Uint8Array; signature: string }>): boolean {
  try {
    const publicKey = typeof input.publicKey === 'string'
      ? decodeBase64(MachineInstallationPublicKeySchema.parse(input.publicKey), 'base64url') : input.publicKey;
    const signature = decodeBase64(input.signature, 'base64url');
    if (encodeBase64(signature, 'base64url') !== input.signature) return false;
    return verifyEd25519Signature(approvalInputBytes(input), signature, publicKey);
  } catch { return false; }
}

/** Uses the existing installation key; the Home authorization is never sufficient alone. */
export function signExternalActionMachineRequestV1(input: MachineRequest & Readonly<{ privateKey: string | Uint8Array }>): string {
  const privateKey = typeof input.privateKey === 'string'
    ? decodeBase64(MachineInstallationPrivateKeySchema.parse(input.privateKey), 'base64url') : input.privateKey;
  return encodeBase64(signEd25519Message(machineRequestBytes(input), privateKey), 'base64url');
}

export function verifyExternalActionMachineRequestV1(input: MachineRequest & Readonly<{ publicKey: string | Uint8Array; signature: string }>): boolean {
  try {
    const publicKey = typeof input.publicKey === 'string'
      ? decodeBase64(MachineInstallationPublicKeySchema.parse(input.publicKey), 'base64url') : input.publicKey;
    const signature = decodeBase64(input.signature, 'base64url');
    if (encodeBase64(signature, 'base64url') !== input.signature) return false;
    return verifyEd25519Signature(machineRequestBytes(input), signature, publicKey);
  } catch { return false; }
}
