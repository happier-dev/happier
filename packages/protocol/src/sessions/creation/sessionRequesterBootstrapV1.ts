import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SessionSpawnNewInputV2Schema } from './sessionSpawnNewInputV2.js';
import { ed25519 } from '@noble/curves/ed25519';
import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import { sealBoxBundle, openBoxBundleWithSecretKey } from '../../crypto/boxBundle.js';
import { isValidEd25519PublicKey, ED25519_SECRET_KEY_BYTES } from '../../crypto/ed25519.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { SessionHandoffPrepareTargetPrivateRequestV1Schema } from '../control/handoff/handoffSchemas.js';
import { ExternalActionExecutionAuthorizationV1Schema, type ExternalActionExecutionAuthorizationV1 } from '../../actions/externalActionApi.js';
import { computeCanonicalDomainSeparatedDigest } from '../../crypto/canonicalDigest.js';
import { ManagedWakeTargetV1Schema, type ManagedWakeTargetV1 } from '../../machines/managed/managedIntentV1.js';
import type { AccessibleMachineAccessV1 } from '../../machines/machineAccessV1.js';

/** Same serialized fields as the credential custodian's access.key owner, on a private carrier only. */
export const SessionRequesterBootstrapCredentialsV1Schema = lazyZodSchema(() => z.object({
    token: z.string().min(1),
    secret: z.string().base64().nullish(),
    encryption: z.object({
      publicKey: z.string().base64(),
      machineKey: z.string().base64(),
    }).strict().nullish(),
  }).strict().refine(value => !(value.secret && value.encryption), {
    message: 'Requester credentials cannot select both encryption representations.',
  }));

/** Private Machine transport only. Never an Action input, output, or persisted metadata. */
export const SessionRequesterCreationContextV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  disposition: z.literal('ordinary_requester'),
  credentials: SessionRequesterBootstrapCredentialsV1Schema,
}).strict());
export type SessionRequesterCreationContextV1 = Readonly<z.infer<typeof SessionRequesterCreationContextV1Schema>>;

/** Safe projection of the selected D3 disposition, never credential material or a second decision. */
export function projectRequesterSessionCredentialDisclosure(input: Readonly<{
  disposition: SessionRequesterCreationContextV1['disposition'];
  accountId: string;
  machineId: string;
  custodian?: AccessibleMachineAccessV1['custodian'];
}>) {
  return { disposition: input.disposition, accountId: input.accountId, machineId: input.machineId,
    ...(input.custodian ? { custodian: input.custodian } : {}),
    fullSignIn: true, selectedPurposeRuntimeAuth: true, hostCanInspectLocalProcess: true } as const;
}

export const SessionRequesterBootstrapV1Schema = lazyZodSchema(() => z.union([
  SessionRequesterCreationContextV1Schema,
  SessionRequesterCreationContextV1Schema.extend({
    sessionId: z.string().trim().min(1),
    sessionCreationDisposition: z.enum(['created', 'rejoined']),
  }).strict(),
]));
export type SessionRequesterBootstrapV1 = Readonly<z.infer<typeof SessionRequesterBootstrapV1Schema>>;

/** C41 signs the complete existing Machine RPC envelope, including this private payload. */
export const SessionRequesterInstallationSealedBootstrapV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('installation_sealed_v1'),
  installationId: z.string().trim().min(1),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/u),
}).strict());

/** Private invocation scope, independent of Session birth or custody. Every boundary is closed. */
export type ExternalActionRequesterAccountContextPurposeV1 = Readonly<
  { kind: 'external_action' } | { kind: 'machine_rpc'; method: string; params: unknown }
  | { kind: 'managed_finite_wake'; target: ManagedWakeTargetV1 }
>;
const RequesterAccountContextPurposeV1Schema = lazyZodSchema(() => z.union([
  z.object({ kind: z.literal('external_action') }).strict(),
  z.object({ kind: z.literal('machine_rpc'), method: z.string().trim().min(1),
    paramsPresent: z.boolean(),
    requestDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }).strict(),
  z.object({ kind: z.literal('managed_finite_wake'), target: ManagedWakeTargetV1Schema }).strict()
    .refine(value => value.target.origin.kind === 'finite-command'),
]));
const RequesterAccountContextPlaintextV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), authorization: ExternalActionExecutionAuthorizationV1Schema.transform(value => ({
    v: value.v, token: value.token, binding: value.binding,
  })),
  purpose: RequesterAccountContextPurposeV1Schema, credentials: SessionRequesterBootstrapCredentialsV1Schema,
}).strict());

function projectRequesterAccountContextPurpose(input: ExternalActionRequesterAccountContextPurposeV1) {
  return RequesterAccountContextPurposeV1Schema.parse(input.kind !== 'machine_rpc' ? input : {
    kind: input.kind, method: input.method, paramsPresent: input.params !== undefined,
    requestDigest: computeCanonicalDomainSeparatedDigest('happier-external-action-rpc-payload-v1', [
      createCanonicalJsonSigningInput(input.params === undefined ? null : input.params),
    ]),
  });
}

/** Reuses the installed-key box and credential codec on the existing Home authorization carrier. */
export function sealExternalActionRequesterAccountContextV1(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  credentials: z.infer<typeof SessionRequesterBootstrapCredentialsV1Schema>;
  purpose: ExternalActionRequesterAccountContextPurposeV1;
  installationPublicKey: Uint8Array;
  randomBytes(length: number): Uint8Array;
}>): ExternalActionExecutionAuthorizationV1 {
  if (!isValidEd25519PublicKey(input.installationPublicKey)) throw new Error('invalid_installation_public_key');
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(input.authorization);
  const wake = input.purpose.kind === 'managed_finite_wake' ? authorization.managedFiniteWake : undefined;
  if (input.purpose.kind === 'managed_finite_wake' && (!wake
    || createCanonicalJsonSigningInput(wake.target) !== createCanonicalJsonSigningInput(input.purpose.target)
    || wake.installationPublicKey !== encodeBase64(input.installationPublicKey, 'base64url'))) {
    throw new Error('requester_account_controller_mismatch');
  }
  const plaintext = RequesterAccountContextPlaintextV1Schema.parse({ v: 1,
    authorization: { v: authorization.v, token: authorization.token, binding: authorization.binding },
    purpose: projectRequesterAccountContextPurpose(input.purpose), credentials: input.credentials });
  const mode = authorization.binding.accountEncryptionMode;
  if (mode === 'plain' && (plaintext.credentials.secret || plaintext.credentials.encryption)
    || mode === 'e2ee' && !plaintext.credentials.secret && !plaintext.credentials.encryption
    || mode === undefined) throw new Error('requester_account_mode_mismatch');
  const ciphertext = sealBoxBundle({ plaintext: new TextEncoder().encode(JSON.stringify(plaintext)),
    recipientPublicKey: ed25519.utils.toMontgomery(input.installationPublicKey), randomBytes: input.randomBytes });
  const sealed = { kind: 'installation_sealed_v1' as const,
    installationId: wake?.target.controller.installationId ?? authorization.binding.installationId,
    ciphertext: encodeBase64(ciphertext, 'base64url') };
  return wake ? { ...authorization, managedFiniteWake: { ...wake, requesterAccountContext: sealed } }
    : { ...authorization, requesterAccountContext: sealed };
}

/** Authority is verified by ingress first; opening can only recover this exact root's private custody. */
export function openExternalActionRequesterAccountContextV1(input: Readonly<{
  authorization: unknown;
  purpose: ExternalActionRequesterAccountContextPurposeV1;
  machineId: string;
  installationId: string;
  serverIdentityId: string;
  installationPrivateKey: Uint8Array;
}>): z.infer<typeof SessionRequesterBootstrapCredentialsV1Schema> | null {
  try {
    const parsed = ExternalActionExecutionAuthorizationV1Schema.safeParse(input.authorization);
    if (!parsed.success) return null;
    const authorization = parsed.data;
    const wake = input.purpose.kind === 'managed_finite_wake' ? authorization.managedFiniteWake : undefined;
    if (input.purpose.kind === 'managed_finite_wake' && (!wake
      || createCanonicalJsonSigningInput(wake.target) !== createCanonicalJsonSigningInput(input.purpose.target))) return null;
    const recipient = wake?.target.controller ?? { machineId: authorization.binding.machineId,
      installationId: authorization.binding.installationId };
    const sealed = wake ? wake.requesterAccountContext : authorization.requesterAccountContext;
    if (!sealed || sealed.installationId !== input.installationId
      || recipient.machineId !== input.machineId || recipient.installationId !== input.installationId
      || authorization.binding.serverIdentityId !== input.serverIdentityId
      || input.installationPrivateKey.length !== ED25519_SECRET_KEY_BYTES) return null;
    const bytes = openBoxBundleWithSecretKey({ bundle: decodeBase64(sealed.ciphertext, 'base64url'),
      recipientSecretKey: ed25519.utils.toMontgomerySecret(input.installationPrivateKey.subarray(0, 32)) });
    if (!bytes) return null;
    const plaintext = RequesterAccountContextPlaintextV1Schema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    if (!plaintext.success
      || createCanonicalJsonSigningInput(plaintext.data.authorization) !== createCanonicalJsonSigningInput({
        v: authorization.v, token: authorization.token, binding: authorization.binding,
      })
      || createCanonicalJsonSigningInput(plaintext.data.purpose) !== createCanonicalJsonSigningInput(projectRequesterAccountContextPurpose(input.purpose))) return null;
    return plaintext.data.credentials;
  } catch { return null; }
}
export const SessionRequesterBootstrapRpcRequestV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('requester_session_bootstrap_v1'),
  input: SessionSpawnNewInputV2Schema,
  requesterBootstrap: z.union([SessionRequesterBootstrapV1Schema, SessionRequesterInstallationSealedBootstrapV1Schema]),
}).strict());
export type SessionRequesterBootstrapRpcRequestV1 = Readonly<z.infer<typeof SessionRequesterBootstrapRpcRequestV1Schema>>;

const SessionRequesterBootstrapOpenedRequestV1Schema = lazyZodSchema(() => SessionRequesterBootstrapRpcRequestV1Schema.extend({
  requesterBootstrap: SessionRequesterBootstrapV1Schema,
}).strict());
type OpenedRequest = Readonly<z.infer<typeof SessionRequesterBootstrapOpenedRequestV1Schema>>;
export const SessionRequesterHandoffBootstrapRpcRequestV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('requester_session_handoff_bootstrap_v1'),
  input: SessionHandoffPrepareTargetPrivateRequestV1Schema,
  requesterBootstrap: z.union([SessionRequesterCreationContextV1Schema, SessionRequesterInstallationSealedBootstrapV1Schema]),
}).strict());
export type SessionRequesterHandoffBootstrapRpcRequestV1 = Readonly<z.infer<typeof SessionRequesterHandoffBootstrapRpcRequestV1Schema>>;
const SessionRequesterHandoffBootstrapOpenedRequestV1Schema = lazyZodSchema(() => SessionRequesterHandoffBootstrapRpcRequestV1Schema.extend({
  requesterBootstrap: SessionRequesterCreationContextV1Schema,
}).strict());
type OpenedHandoffRequest = Readonly<z.infer<typeof SessionRequesterHandoffBootstrapOpenedRequestV1Schema>>;
type InstalledRequest = OpenedRequest | OpenedHandoffRequest;
const InstallationPlaintextV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), machineId: z.string().min(1), installationId: z.string().min(1),
  request: z.union([SessionRequesterBootstrapOpenedRequestV1Schema, SessionRequesterHandoffBootstrapOpenedRequestV1Schema]),
}).strict());

function readInstalledRequestMachineId(request: InstalledRequest): string {
  return request.kind === 'requester_session_bootstrap_v1' ? request.input.executionTarget.machineId : request.input.targetMachineId;
}

function sealInstalledRequest<T extends InstalledRequest>(input: Readonly<{
  request: T; installationId: string; installationPublicKey: Uint8Array; randomBytes(length: number): Uint8Array;
}>): Readonly<{ kind: T['kind']; input: T['input'];
  requesterBootstrap: z.infer<typeof SessionRequesterInstallationSealedBootstrapV1Schema> }> {
  if (!isValidEd25519PublicKey(input.installationPublicKey)) throw new Error('invalid_installation_public_key');
  const plaintext = InstallationPlaintextV1Schema.parse({ v: 1, machineId: readInstalledRequestMachineId(input.request),
    installationId: input.installationId, request: input.request });
  const ciphertext = sealBoxBundle({ plaintext: new TextEncoder().encode(JSON.stringify(plaintext)),
    recipientPublicKey: ed25519.utils.toMontgomery(input.installationPublicKey), randomBytes: input.randomBytes });
  return { kind: input.request.kind, input: input.request.input,
    requesterBootstrap: { kind: 'installation_sealed_v1' as const, installationId: plaintext.installationId,
      ciphertext: encodeBase64(ciphertext, 'base64url') } };
}

/** Existing box framing; confidentiality is independent of Machine content storage mode. */
export function sealSessionRequesterBootstrapRpcRequestV1(input: Readonly<{
  request: OpenedRequest;
  installationId: string;
  installationPublicKey: Uint8Array;
  randomBytes(length: number): Uint8Array;
}>) {
  const request = SessionRequesterBootstrapOpenedRequestV1Schema.parse(input.request);
  return sealInstalledRequest({ ...input, request });
}

export function sealSessionRequesterHandoffBootstrapRpcRequestV1(input: Readonly<{
  request: OpenedHandoffRequest; installationId: string; installationPublicKey: Uint8Array; randomBytes(length: number): Uint8Array;
}>) {
  return sealInstalledRequest({ ...input, request: SessionRequesterHandoffBootstrapOpenedRequestV1Schema.parse(input.request) });
}

/** The host supplies its current local installation, never a caller-selected key. */
export function openSessionRequesterBootstrapRpcRequestV1(input: Readonly<{
  request: unknown; machineId: string; installationId: string; installationPrivateKey: Uint8Array;
}>): OpenedRequest | null {
  const request = openInstalledRequest(input);
  return request?.kind === 'requester_session_bootstrap_v1' ? request : null;
}

export function openSessionRequesterHandoffBootstrapRpcRequestV1(input: Readonly<{
  request: unknown; machineId: string; installationId: string; installationPrivateKey: Uint8Array;
}>): OpenedHandoffRequest | null {
  const request = openInstalledRequest(input);
  return request?.kind === 'requester_session_handoff_bootstrap_v1' ? request : null;
}

function openInstalledRequest(input: Readonly<{
  request: unknown; machineId: string; installationId: string; installationPrivateKey: Uint8Array;
}>): InstalledRequest | null {
  try {
    const parsed = z.union([SessionRequesterBootstrapRpcRequestV1Schema, SessionRequesterHandoffBootstrapRpcRequestV1Schema]).safeParse(input.request);
    if (!parsed.success || !('kind' in parsed.data.requesterBootstrap)
      || parsed.data.requesterBootstrap.installationId !== input.installationId
      || (parsed.data.kind === 'requester_session_bootstrap_v1' ? parsed.data.input.executionTarget.machineId
        : parsed.data.input.targetMachineId) !== input.machineId
      || input.installationPrivateKey.length !== ED25519_SECRET_KEY_BYTES) return null;
    const opened = openBoxBundleWithSecretKey({ bundle: decodeBase64(parsed.data.requesterBootstrap.ciphertext, 'base64url'),
      recipientSecretKey: ed25519.utils.toMontgomerySecret(input.installationPrivateKey.subarray(0, 32)) });
    if (!opened) return null;
    const plaintext = InstallationPlaintextV1Schema.safeParse(JSON.parse(new TextDecoder().decode(opened)));
    if (!plaintext.success || plaintext.data.machineId !== input.machineId
      || plaintext.data.installationId !== input.installationId
      || plaintext.data.request.kind !== parsed.data.kind
      || readInstalledRequestMachineId(plaintext.data.request) !== input.machineId
      || createCanonicalJsonSigningInput(plaintext.data.request.input) !== createCanonicalJsonSigningInput(parsed.data.input)) return null;
    return plaintext.data.request;
  } catch { return null; }
}
