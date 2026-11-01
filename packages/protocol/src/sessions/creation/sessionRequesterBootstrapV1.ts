import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SessionSpawnNewInputV2Schema } from './sessionSpawnNewInputV2.js';
import { ed25519 } from '@noble/curves/ed25519';
import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import { sealBoxBundle, openBoxBundleWithSecretKey } from '../../crypto/boxBundle.js';
import { isValidEd25519PublicKey, ED25519_SECRET_KEY_BYTES } from '../../crypto/ed25519.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { SessionHandoffPrepareTargetPrivateRequestV1Schema, SessionHandoffExistingStateCheckRequestV3Schema } from '../control/handoff/handoffSchemas.js';
import { ExternalActionExecutionAuthorizationV1Schema, type ExternalActionExecutionAuthorizationV1 } from '../../actions/externalActionApi.js';
import { computeCanonicalDomainSeparatedDigest } from '../../crypto/canonicalDigest.js';
import { ManagedWakeTargetV1Schema, type ManagedWakeTargetV1 } from '../../machines/managed/managedIntentV1.js';
import type { AccessibleMachineAccessV1 } from '../../machines/machineAccessV1.js';
import { SessionRequesterInstallationSealedBootstrapV1Schema } from './sessionRequesterBootstrapSchemasV1.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { PluginSourceCustodyV1Schema } from '../../plugins/runtime/sourceCustody.js';
import { PluginMachineMaterializationRefV1Schema } from '../../plugins/availability/materializationRefV1.js';
import { CallerInputConstraintsV1Schema } from '../../auth/callerInputConstraintsV1.js';
import { AgentPermissionIntentV1Schema } from '../../runtime/permissionIntentV1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { WorkspaceSyncPrepareBetweenRequestV1Schema, type WorkspaceSyncPrepareBetweenRequestV1 } from '../control/handoff/workspaceSyncSchemas.js';
import { isDiscussionSecondOpinionModelRpcMethodV1 } from '../../discussions/secondOpinionActions.js';
import { isProjectWorkspaceSyncPreparationActionV1 } from '../../actions/projectActionIdsV1.js';
export { SessionRequesterInstallationSealedBootstrapV1Schema } from './sessionRequesterBootstrapSchemasV1.js';

/** Same serialized fields as the credential custodian's access.key owner, on a private carrier only. */
export const SessionRequesterBootstrapCredentialsV1Schema = lazyZodSchema(() => z.strictObject({
    token: z.string().check(z.minLength(1)),
    secret: z.nullish(z.string().check(z.base64())),
    encryption: z.nullish(z.strictObject({
      publicKey: z.string().check(z.base64()),
      machineKey: z.string().check(z.base64()),
    })),
  }).check(z.refine(value => !(value.secret && value.encryption), {
    message: 'Requester credentials cannot select both encryption representations.',
  })));

/** Private Machine transport only. Never an Action input, output, or persisted metadata. */
export const SessionRequesterCreationContextV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  disposition: z.literal('ordinary_requester'),
  credentials: SessionRequesterBootstrapCredentialsV1Schema,
}));
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
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionRequesterCreationContextV1Schema, {
    sessionId: z.string().check(z.trim(), z.minLength(1)),
    sessionCreationDisposition: z.enum(['created', 'rejoined']),
  })),
]));
export type SessionRequesterBootstrapV1 = Readonly<z.infer<typeof SessionRequesterBootstrapV1Schema>>;

/** Private invocation scope, independent of Session birth or custody. Every boundary is closed. */
export type ExternalActionRequesterAccountContextPurposeV1 = Readonly<
  { kind: 'external_action' } | { kind: 'machine_rpc'; method: string; params: unknown;
    recipient?: Readonly<{ machineId: string; installationId: string }> }
  | { kind: 'managed_finite_wake'; target: ManagedWakeTargetV1 }
  | { kind: 'workspace_sync_prepare'; controller: Readonly<{ machineId: string; installationId: string }>;
    request: WorkspaceSyncPrepareBetweenRequestV1 }
>;
const RequesterAccountContextPurposeV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('external_action') }),
  z.strictObject({ kind: z.literal('machine_rpc'), method: z.string().check(z.trim(), z.minLength(1)),
    recipient: z.optional(z.strictObject({ machineId: z.string().check(z.trim(), z.minLength(1)),
      installationId: z.string().check(z.trim(), z.minLength(1)) })),
    paramsPresent: z.boolean(),
    requestDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)) }),
  z.strictObject({ kind: z.literal('managed_finite_wake'), target: ManagedWakeTargetV1Schema }).check(z.refine(value => value.target.origin.kind === 'finite-command')),
  z.strictObject({ kind: z.literal('workspace_sync_prepare'), controller: z.strictObject({
    machineId: z.string().check(z.trim(), z.minLength(1)), installationId: z.string().check(z.trim(), z.minLength(1)),
  }), request: WorkspaceSyncPrepareBetweenRequestV1Schema }),
]));
/** Host-stamped facts inside the existing private box, never a public Action field. */
export const ExternalActionRequesterInvocationV1Schema = lazyZodSchema(() => z.strictObject({
  caller: z.union([
    z.strictObject({ kind: z.literal('host') }),
    z.strictObject({ kind: z.literal('plugin'), pluginId: asProtocolZod(PluginIdSchema),
      contributionLocalId: asProtocolZod(PluginContributionLocalIdSchema), occurrenceId: z.optional(z.string().check(z.minLength(1))),
      sourceCustody: z.optional(PluginSourceCustodyV1Schema), materialization: z.optional(PluginMachineMaterializationRefV1Schema),
    }),
  ]),
  surface: z.enum(['ui', 'voice', 'agent', 'mcp', 'cli', 'rpc', 'api', 'plugin']),
  authority: z.enum(['present_user', 'account_automation']),
  callerPermissionMode: z.optional(z.nullable(asProtocolZod(AgentPermissionIntentV1Schema))),
  callerInputConstraints: z.optional(CallerInputConstraintsV1Schema),
  workspaceWrites: z.optional(z.enum(['allow', 'deny'])),
  defaultSessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
}).check(z.refine(value => value.caller.kind !== 'plugin' || value.authority === 'account_automation', {
  message: 'A Plugin invocation cannot carry present-user authority.',
})));
export type ExternalActionRequesterInvocationV1 = z.infer<typeof ExternalActionRequesterInvocationV1Schema>;
const installationContextRootShape = () => ({
  v: z.literal(1), authorization: z.pipe(ExternalActionExecutionAuthorizationV1Schema, z.transform(value => ({
    v: value.v, token: value.token, binding: value.binding,
  }))),
});
const RequesterAccountContextPlaintextV1Schema = lazyZodSchema(() => z.strictObject({
  ...installationContextRootShape(),
  purpose: RequesterAccountContextPurposeV1Schema, credentials: SessionRequesterBootstrapCredentialsV1Schema,
  invocation: z.optional(ExternalActionRequesterInvocationV1Schema),
}));
const ManagedControllerCodecPlaintextV1Schema = lazyZodSchema(() => z.strictObject({
  ...installationContextRootShape(), purpose: z.strictObject({ kind: z.literal('managed_controller_codec') }),
  codec: z.strictObject({ machineKey: z.string().check(z.base64(), z.refine(value => decodeBase64(value).length === 32)) }),
  invocation: z.optional(ExternalActionRequesterInvocationV1Schema),
}));
const InstallationContextPlaintextV1Schema = lazyZodSchema(() => z.union([
  RequesterAccountContextPlaintextV1Schema, ManagedControllerCodecPlaintextV1Schema,
]));

/** Nested purpose discriminants select an already parsed closed context arm. */
function hasManagedCodecPurpose<Kind extends 'managed_controller_codec'>(
  value: z.infer<typeof InstallationContextPlaintextV1Schema>, kind: Kind,
): value is Extract<z.infer<typeof InstallationContextPlaintextV1Schema>, { purpose: { kind: Kind } }> {
  return value.purpose.kind === kind;
}

function openInstallationSealedContext(sealed: z.infer<typeof SessionRequesterInstallationSealedBootstrapV1Schema>, privateKey: Uint8Array) {
  if (privateKey.length !== ED25519_SECRET_KEY_BYTES) return null;
  const bytes = openBoxBundleWithSecretKey({ bundle: decodeBase64(sealed.ciphertext, 'base64url'),
    recipientSecretKey: ed25519.utils.toMontgomerySecret(privateKey.subarray(0, 32)) });
  if (!bytes) return null;
  const plaintext = InstallationContextPlaintextV1Schema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
  return plaintext.success ? plaintext.data : null;
}

/** These Actions execute with controller custody; the box may carry only invocation codec material. */
export function isManagedControllerCodecActionV1(binding: Pick<ExternalActionExecutionAuthorizationV1['binding'],
  'actionId' | 'managedAdmission'>): boolean {
  return binding.actionId === 'machines.managed.acquire' || binding.actionId === 'machines.managed.inspect'
    || binding.actionId === 'machines.managed.bootstrap.retry';
}

export function sealManagedControllerActionCodecV1(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  material: Readonly<{ type: 'dataKey'; machineKey: Uint8Array }>;
  invocation?: ExternalActionRequesterInvocationV1;
  installationPublicKey: Uint8Array;
  randomBytes(length: number): Uint8Array;
}>): ExternalActionExecutionAuthorizationV1 {
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(input.authorization);
  if (!isManagedControllerCodecActionV1(authorization.binding) || !('authentication' in authorization.binding)
    || authorization.binding.target.kind !== 'machine' || authorization.binding.target.machineId !== authorization.binding.machineId)
    throw new Error('managed_controller_codec_root_mismatch');
  const plaintext = ManagedControllerCodecPlaintextV1Schema.parse({ v: 1,
    authorization: { v: authorization.v, token: authorization.token, binding: authorization.binding },
    purpose: { kind: 'managed_controller_codec' }, codec: { machineKey: encodeBase64(input.material.machineKey) },
    ...(input.invocation ? { invocation: input.invocation } : {}) });
  return { ...authorization, requesterAccountContext: sealInstallationContext({ ...input, plaintext,
    installationId: authorization.binding.installationId }) };
}

function sealInstallationContext(input: Readonly<{
  plaintext: z.infer<typeof InstallationContextPlaintextV1Schema>; installationId: string;
  installationPublicKey: Uint8Array; randomBytes(length: number): Uint8Array;
}>) {
  if (!isValidEd25519PublicKey(input.installationPublicKey)) throw new Error('invalid_installation_public_key');
  const ciphertext = sealBoxBundle({ plaintext: new TextEncoder().encode(JSON.stringify(input.plaintext)),
    recipientPublicKey: ed25519.utils.toMontgomery(input.installationPublicKey), randomBytes: input.randomBytes });
  return { kind: 'installation_sealed_v1' as const, installationId: input.installationId,
    ciphertext: encodeBase64(ciphertext, 'base64url') };
}

function projectRequesterAccountContextPurpose(input: ExternalActionRequesterAccountContextPurposeV1, machineId: string) {
  // Socket routing scopes methods with the Machine id already bound by the
  // signed root. Seal and open commit one unscoped method identity, never try
  // alternative signed purposes if opening fails.
  const prefix = `${machineId}:`;
  return RequesterAccountContextPurposeV1Schema.parse(input.kind !== 'machine_rpc' ? input : {
    kind: input.kind, method: input.method.startsWith(prefix) ? input.method.slice(prefix.length) : input.method,
    ...(input.recipient ? { recipient: input.recipient } : {}),
    paramsPresent: input.params !== undefined,
    requestDigest: computeCanonicalDomainSeparatedDigest('happier-external-action-rpc-payload-v1', [
      createCanonicalJsonSigningInput(input.params === undefined ? null : input.params),
    ]),
  });
}

/** Reuses the installed-key box and credential codec on the existing Home authorization carrier. */
export function sealExternalActionRequesterAccountContextV1(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  credentials: z.infer<typeof SessionRequesterBootstrapCredentialsV1Schema>;
  invocation?: ExternalActionRequesterInvocationV1;
  purpose: ExternalActionRequesterAccountContextPurposeV1;
  installationPublicKey: Uint8Array;
  randomBytes(length: number): Uint8Array;
}>): ExternalActionExecutionAuthorizationV1 {
  if (!isValidEd25519PublicKey(input.installationPublicKey)) throw new Error('invalid_installation_public_key');
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(input.authorization);
  if (input.purpose.kind === 'external_action' && isManagedControllerCodecActionV1(authorization.binding)
    && authorization.binding.accountId !== authorization.binding.custodianAccountId)
    throw new Error('managed_controller_credentials_forbidden');
  const preparation = input.purpose.kind === 'workspace_sync_prepare' ? input.purpose : undefined;
  const moveRecipient = input.purpose.kind === 'machine_rpc' ? input.purpose.recipient : undefined;
  if (moveRecipient && !isReviewedChildRecipientPurpose(authorization, input.purpose)) throw new Error('requester_account_move_root_mismatch');
  if (preparation && !isWorkspaceSyncPreparationRoot(authorization)) throw new Error('requester_account_prepare_root_mismatch');
  const wake = input.purpose.kind === 'managed_finite_wake' ? authorization.managedFiniteWake : undefined;
  if (input.purpose.kind === 'managed_finite_wake' && (!wake
    || createCanonicalJsonSigningInput(wake.target) !== createCanonicalJsonSigningInput(input.purpose.target)
    || wake.installationPublicKey !== encodeBase64(input.installationPublicKey, 'base64url'))) {
    throw new Error('requester_account_controller_mismatch');
  }
  const plaintext = RequesterAccountContextPlaintextV1Schema.parse({ v: 1,
    authorization: { v: authorization.v, token: authorization.token, binding: authorization.binding },
    purpose: projectRequesterAccountContextPurpose(input.purpose, authorization.binding.machineId), credentials: input.credentials,
    ...(input.invocation ? { invocation: input.invocation } : {}) });
  const mode = authorization.binding.accountEncryptionMode;
  if (mode === 'plain' && (plaintext.credentials.secret || plaintext.credentials.encryption)
    || mode === 'e2ee' && !plaintext.credentials.secret && !plaintext.credentials.encryption
    || mode === undefined) throw new Error('requester_account_mode_mismatch');
  const ciphertext = sealBoxBundle({ plaintext: new TextEncoder().encode(JSON.stringify(plaintext)),
    recipientPublicKey: ed25519.utils.toMontgomery(input.installationPublicKey), randomBytes: input.randomBytes });
  const sealed = { kind: 'installation_sealed_v1' as const,
    installationId: moveRecipient?.installationId ?? preparation?.controller.installationId ?? wake?.target.controller.installationId ?? authorization.binding.installationId,
    ciphertext: encodeBase64(ciphertext, 'base64url') };
  return wake ? { ...authorization, managedFiniteWake: { ...wake, requesterAccountContext: sealed } }
    : { ...authorization, requesterAccountContext: sealed };
}

/** Authority is verified by ingress first; opening can only recover this exact root's private custody. */
type OpenRequesterAccountContextInput = Readonly<{
  authorization: unknown;
  purpose: ExternalActionRequesterAccountContextPurposeV1;
  machineId: string;
  installationId: string;
  serverIdentityId: string;
  installationPrivateKey: Uint8Array;
}>;
export function openExternalActionRequesterAccountContextV1(input: OpenRequesterAccountContextInput & Readonly<{ includeInvocation: true }>):
  Readonly<{ credentials: z.infer<typeof SessionRequesterBootstrapCredentialsV1Schema>; invocation?: ExternalActionRequesterInvocationV1 }> | null;
export function openExternalActionRequesterAccountContextV1(input: OpenRequesterAccountContextInput): z.infer<typeof SessionRequesterBootstrapCredentialsV1Schema> | null;
export function openExternalActionRequesterAccountContextV1(input: OpenRequesterAccountContextInput & Readonly<{ includeInvocation?: boolean }>) {
  const plaintext = openInstallationContext(input);
  if (!plaintext || !('credentials' in plaintext)) return null;
  return input.includeInvocation ? { credentials: plaintext.credentials,
    ...(plaintext.invocation ? { invocation: plaintext.invocation } : {}) } : plaintext.credentials;
}

/** No Account credentials or requester execution context can be recovered from this purpose. */
type ManagedControllerCodecMaterial = Readonly<{ type: 'dataKey'; machineKey: Uint8Array }>;
export function openManagedControllerActionCodecV1(input: Omit<OpenRequesterAccountContextInput, 'purpose'> & Readonly<{ includeInvocation: true }>):
  Readonly<{ material: ManagedControllerCodecMaterial; invocation?: ExternalActionRequesterInvocationV1 }> | null;
export function openManagedControllerActionCodecV1(input: Omit<OpenRequesterAccountContextInput, 'purpose'>): ManagedControllerCodecMaterial | null;
export function openManagedControllerActionCodecV1(input: Omit<OpenRequesterAccountContextInput, 'purpose'> & Readonly<{ includeInvocation?: boolean }>) {
  const parsed = ExternalActionExecutionAuthorizationV1Schema.safeParse(input.authorization);
  if (!parsed.success || !isManagedControllerCodecActionV1(parsed.data.binding)
    || !('authentication' in parsed.data.binding) || parsed.data.binding.target.kind !== 'machine'
    || parsed.data.binding.target.machineId !== input.machineId) return null;
  const plaintext = openInstallationContext({ ...input, purpose: { kind: 'managed_controller_codec' } });
  if (!plaintext || !hasManagedCodecPurpose(plaintext, 'managed_controller_codec')) return null;
  const material: ManagedControllerCodecMaterial = { type: 'dataKey', machineKey: decodeBase64(plaintext.codec.machineKey) };
  return input.includeInvocation ? { material,
    ...('invocation' in plaintext && plaintext.invocation ? { invocation: plaintext.invocation } : {}) } : material;
}

function openInstallationContext(input: Omit<OpenRequesterAccountContextInput, 'purpose'> & Readonly<{
  purpose: ExternalActionRequesterAccountContextPurposeV1 | Readonly<{ kind: 'managed_controller_codec' }>;
}>) {
  try {
    const parsed = ExternalActionExecutionAuthorizationV1Schema.safeParse(input.authorization);
    if (!parsed.success) return null;
    const authorization = parsed.data;
    const preparation = input.purpose.kind === 'workspace_sync_prepare' ? input.purpose : undefined;
    const moveRecipient = input.purpose.kind === 'machine_rpc' ? input.purpose.recipient : undefined;
    if (input.purpose.kind === 'machine_rpc' && moveRecipient && !isReviewedChildRecipientPurpose(authorization, input.purpose)) return null;
    if (preparation && !isWorkspaceSyncPreparationRoot(authorization)) return null;
    const wake = input.purpose.kind === 'managed_finite_wake' ? authorization.managedFiniteWake : undefined;
    if (input.purpose.kind === 'managed_finite_wake' && (!wake
      || createCanonicalJsonSigningInput(wake.target) !== createCanonicalJsonSigningInput(input.purpose.target))) return null;
    const recipient = moveRecipient ?? preparation?.controller ?? wake?.target.controller ?? { machineId: authorization.binding.machineId,
      installationId: authorization.binding.installationId };
    const sealed = wake ? wake.requesterAccountContext : authorization.requesterAccountContext;
    if (!sealed || sealed.installationId !== input.installationId
      || recipient.machineId !== input.machineId || recipient.installationId !== input.installationId
      || authorization.binding.serverIdentityId !== input.serverIdentityId
      || input.installationPrivateKey.length !== ED25519_SECRET_KEY_BYTES) return null;
    const plaintext = openInstallationSealedContext(sealed, input.installationPrivateKey);
    if (!plaintext
      || createCanonicalJsonSigningInput(plaintext.authorization) !== createCanonicalJsonSigningInput({
        v: authorization.v, token: authorization.token, binding: authorization.binding,
      })
      || createCanonicalJsonSigningInput(plaintext.purpose) !== createCanonicalJsonSigningInput(input.purpose.kind === 'managed_controller_codec'
        ? input.purpose : projectRequesterAccountContextPurpose(input.purpose, authorization.binding.machineId))) return null;
    return plaintext;
  } catch { return null; }
}

function isReviewedChildRecipientPurpose(authorization: ExternalActionExecutionAuthorizationV1,
  purpose: ExternalActionRequesterAccountContextPurposeV1): boolean {
  return authorization.binding.actionId === 'projects.service.relocate'
    || authorization.binding.actionId === 'discussion.second_opinion.start'
      && purpose.kind === 'machine_rpc' && isDiscussionSecondOpinionModelRpcMethodV1(purpose.method);
}

function isWorkspaceSyncPreparationRoot(authorization: ExternalActionExecutionAuthorizationV1): boolean {
  const binding = authorization.binding;
  return isProjectWorkspaceSyncPreparationActionV1(binding.actionId)
    && binding.target.kind === 'machine' && binding.target.machineId === binding.machineId;
}
export const SessionRequesterBootstrapRpcRequestV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('requester_session_bootstrap_v1'),
  input: SessionSpawnNewInputV2Schema,
  requesterBootstrap: z.union([SessionRequesterBootstrapV1Schema, SessionRequesterInstallationSealedBootstrapV1Schema]),
}));
export type SessionRequesterBootstrapRpcRequestV1 = Readonly<z.infer<typeof SessionRequesterBootstrapRpcRequestV1Schema>>;

const SessionRequesterBootstrapOpenedRequestV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionRequesterBootstrapRpcRequestV1Schema, {
  requesterBootstrap: SessionRequesterBootstrapV1Schema,
})));
type OpenedRequest = Readonly<z.infer<typeof SessionRequesterBootstrapOpenedRequestV1Schema>>;
export const SessionRequesterHandoffBootstrapRpcRequestV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('requester_session_handoff_bootstrap_v1'),
  input: SessionHandoffPrepareTargetPrivateRequestV1Schema,
  requesterBootstrap: z.union([SessionRequesterCreationContextV1Schema, SessionRequesterInstallationSealedBootstrapV1Schema]),
}));
export type SessionRequesterHandoffBootstrapRpcRequestV1 = Readonly<z.infer<typeof SessionRequesterHandoffBootstrapRpcRequestV1Schema>>;
const SessionRequesterHandoffBootstrapOpenedRequestV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionRequesterHandoffBootstrapRpcRequestV1Schema, {
  requesterBootstrap: SessionRequesterCreationContextV1Schema,
})));
type OpenedHandoffRequest = Readonly<z.infer<typeof SessionRequesterHandoffBootstrapOpenedRequestV1Schema>>;
/** Read-only existing-state inspection shares the same private installed-key carrier. */
export const SessionRequesterHandoffPreflightBootstrapRpcRequestV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('requester_session_handoff_preflight_bootstrap_v1'),
  input: SessionHandoffExistingStateCheckRequestV3Schema,
  requesterBootstrap: z.union([SessionRequesterCreationContextV1Schema, SessionRequesterInstallationSealedBootstrapV1Schema]),
}));
const SessionRequesterHandoffPreflightBootstrapOpenedRequestV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionRequesterHandoffPreflightBootstrapRpcRequestV1Schema, {
  requesterBootstrap: SessionRequesterCreationContextV1Schema,
})));
type OpenedHandoffPreflightRequest = Readonly<z.infer<typeof SessionRequesterHandoffPreflightBootstrapOpenedRequestV1Schema>>;
type InstalledRequest = OpenedRequest | OpenedHandoffRequest | OpenedHandoffPreflightRequest;
const InstallationPlaintextV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), machineId: z.string().check(z.minLength(1)), installationId: z.string().check(z.minLength(1)),
  request: z.union([SessionRequesterBootstrapOpenedRequestV1Schema, SessionRequesterHandoffBootstrapOpenedRequestV1Schema,
    SessionRequesterHandoffPreflightBootstrapOpenedRequestV1Schema]),
}));

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

export function sealSessionRequesterHandoffPreflightBootstrapRpcRequestV1(input: Readonly<{
  request: OpenedHandoffPreflightRequest; installationId: string; installationPublicKey: Uint8Array; randomBytes(length: number): Uint8Array;
}>) {
  return sealInstalledRequest({ ...input, request: SessionRequesterHandoffPreflightBootstrapOpenedRequestV1Schema.parse(input.request) });
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

export function openSessionRequesterHandoffPreflightBootstrapRpcRequestV1(input: Readonly<{
  request: unknown; machineId: string; installationId: string; installationPrivateKey: Uint8Array;
}>): OpenedHandoffPreflightRequest | null {
  const request = openInstalledRequest(input);
  return request?.kind === 'requester_session_handoff_preflight_bootstrap_v1' ? request : null;
}

function openInstalledRequest(input: Readonly<{
  request: unknown; machineId: string; installationId: string; installationPrivateKey: Uint8Array;
}>): InstalledRequest | null {
  try {
    const parsed = z.union([SessionRequesterBootstrapRpcRequestV1Schema, SessionRequesterHandoffBootstrapRpcRequestV1Schema,
      SessionRequesterHandoffPreflightBootstrapRpcRequestV1Schema]).safeParse(input.request);
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
