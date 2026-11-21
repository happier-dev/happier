import { ActionExecuteFailureSchema, createActionExecuteFailureError } from '../../actions/actionExecutionResult.js';
import { computeMachineInstallationKeyFingerprintV1 } from '../../machines/identity/installationKeySchemas.js';
import { isMachineSetupNativeCodecActionIdV1 } from '../../machines/managed/actionIdsV1.js';
import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { deploymentChildEffectActionIdForRootV1 } from '../../deployments/deploymentActionIdsV1.js';
import { isSessionStopChildRootV1, readSessionStopChildTargetV1 } from '../../actions/sessionSectionArchive.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { SessionSpawnNewInputV2Schema } from './sessionSpawnNewInputV2.js';
import { ed25519 } from '@noble/curves/ed25519';
import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import { sealBoxBundle, openBoxBundleWithSecretKey } from '../../crypto/boxBundle.js';
import { isValidEd25519PublicKey, ED25519_SECRET_KEY_BYTES } from '../../crypto/ed25519.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { SessionHandoffPrepareTargetPrivateRequestV1Schema, SessionHandoffExistingStateCheckRequestV3Schema } from '../control/handoff/handoffSchemas.js';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionManagedContinuationV1Schema, ExternalActionRequestEnvelopeSchema, ExternalActionTargetV1Schema,
  isExternalActionRequestVersionAllowedForAccountModeV1, externalActionTargetsEqualV1,
  type ExternalActionExecutionAuthorizationV1, type ExternalActionManagedAdmissionV1, type ReviewedActionChildHttpProofV1,
  type ExternalActionRequestEnvelope, type ExternalActionRequestEnvelopeV2 } from '../../actions/externalActionApi.js';
import { computeExternalActionRequestEnvelopeDigestV1 } from '../../actions/externalActionExecutionAuthorization.js';
import { readExternalActionBindingAuthority } from '../../actions/externalActionBindingAuthority.js';
import { MANAGED_MACHINE_CREATION_CHILD_ACTION_IDS_V1 } from '../../machines/managed/enrollmentIdentityV1.js';
import { ManagedAcquireInputV1Schema, ManagedEnrollmentInstallationV1Schema } from '../../machines/managed/actionsV1.js';
import { computeCanonicalDomainSeparatedDigest } from '../../crypto/canonicalDigest.js';
import { ManagedWakeTargetV1Schema, type ManagedWakeTargetV1 } from '../../machines/managed/managedIntentV1.js';
import type { AccessibleMachineAccessV1 } from '../../machines/machineAccessV1.js';
import { SessionRequesterInstallationSealedBootstrapV1Schema } from './sessionRequesterBootstrapSchemasV1.js';
import { ExternalActionRequesterInvocationBaseV1Schema } from './externalActionRequesterInvocationBaseV1.js';
import { CallerInputConstraintsV1Schema } from '../../auth/callerInputConstraintsV1.js';
import { AgentPermissionIntentV1Schema, parseAgentPermissionIntentV1Alias } from '../../runtime/permissionIntentV1.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { WorkspaceSyncPrepareBetweenRequestV1Schema, SessionHandoffWorkspaceCaptureRequestV3Schema, type WorkspaceSyncPrepareBetweenRequestV1 } from '../control/handoff/workspaceSyncSchemas.js';
import { readSessionActionChildCreationRpcEffectV1 } from './sessionCreationActionIdsV1.js';
import { isProjectWorkspaceSyncPreparationActionV1 } from '../../actions/projectActionIdsV1.js';
import { DeploymentChildRpcV1Schema, readDeploymentChildRpcV1 } from '../../deployments/deploymentChildRpcV1.js';
import { MachineSetupPlanInputV1Schema, isMachineSetupPlanRpcChildV1 } from '../../machines/managed/actionsV1.js';
import { WorkflowApprovedOperationParentV1Schema } from '../../actions/approvedOperationV1.js';
import { MACHINE_SETUP_APPLY_ACTION_ID_V1, MANAGED_EXEC_ACTION_ID_V1, isManagedControlAdmissionActionIdV1, isManagedCreationContinuationRootV1, isManagedCreationMutationActionIdV1 } from '../../machines/managed/actionIdsV1.js';
import { ActionIdSchema, SESSION_SPAWN_NEW_ACTION_ID_V1, WORKFLOW_RUN_START_ACTION_ID_V1 } from '../../actions/actionIds.js';
import { SessionCreationTagV1Schema, type SessionCreationTagV1 } from './sessionCreationIdentityV1.js';
import { getActionSpec } from '../../actions/actionSpecs.js';
import { MACHINE_SERVICE_FRONTDOOR_ACTION_IDS } from '../../local/services/actionIdsV1.js';
import { isPresentUserHostInvocation, isPluginActionInvokeConfirmationV1 } from '../../actions/invocationAuthority.js';
import { ActionRequestAttributionV1Schema, materializeActionRequestAttributionV1, type ActionRequestAttributionV1 } from '../../actions/actionRequestAttributionV1.js';
import type { ActionExecutorContext } from '../../actions/executor/types.js';
import { readHostReviewedParentV1, readHostReviewedChildPresentUserApprovalV1 } from '../../actions/executor/deploymentRoleChild.js';
import { ManagedSessionDefaultsContextV1Schema } from '../../teams/managedDefaults.js';
import { SessionPlacementSelectionV1Schema } from './sessionPlacementSelectionV1.js';
import { ManagedControllerAccessV1Schema } from '../../machines/managed/managedMachineV1.js';
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
    /** Private ingress proof; the signed RPC packet carries it, not the sealed purpose. */
    reviewedChild?: ReviewedActionChildHttpProofV1;
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
export const ExternalActionRequesterInvocationV1Schema = lazyZodSchema(() => z.extend(ExternalActionRequesterInvocationBaseV1Schema, {
  actionRequestAttributionV1: z.optional(ActionRequestAttributionV1Schema),
  callerPermissionMode: z.optional(z.nullable(asProtocolZod(AgentPermissionIntentV1Schema))),
  callerInputConstraints: z.optional(CallerInputConstraintsV1Schema),
  workspaceWrites: z.optional(z.enum(['allow', 'deny'])),
  defaultSessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  /** Creation-owner selection bound to this request by the existing private admission box. */
  sessionCreationDefaults: z.optional(z.strictObject({
    context: ManagedSessionDefaultsContextV1Schema,
    unavailableDefaults: z.optional(z.array(ActionExecuteFailureSchema)),
    managedPresetAcquisition: z.optional(ManagedAcquireInputV1Schema),
    managedPresetControllerAccess: z.optional(ManagedControllerAccessV1Schema),
    authoredChoices: z.strictObject({
      executionTarget: z.optional(SessionSpawnNewInputV2Schema.shape.executionTarget),
      agentTarget: z.optional(SessionSpawnNewInputV2Schema.shape.agentTarget),
      sessionPlacement: z.optional(SessionPlacementSelectionV1Schema),
    }),
  })),
  /** Admitted host operation facts; the receiving issuer still matches the declared child plan. */
  reviewedParent: z.optional(WorkflowApprovedOperationParentV1Schema),
  /** The designed host confirmation, bound before dispatch; the common review owner admits it once. */
  presentUserConfirmation: z.optional(z.strictObject({
    actionId: ActionIdSchema,
    inputDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
    /** The receiving executor's reviewed consequences the person confirmed (computeActionReviewDigestV1). */
    reviewDigest: z.optional(z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u))),
    reviewedDeploymentInput: z.optional(StrictJsonValueSchema),
    requestId: z.string().check(z.minLength(1)),
    accountId: z.string().check(z.minLength(1)),
    serverId: z.string().check(z.minLength(1)),
    target: z.nullable(ExternalActionTargetV1Schema),
  })),
}).check(z.refine(value => value.caller.kind !== 'plugin' || value.authority === 'account_automation', {
  message: 'A Plugin invocation cannot carry present-user authority.',
}), z.refine(value => !value.reviewedParent || value.caller.kind === 'host', {
  message: 'A reviewed parent belongs to a host invocation.',
}), z.refine(value => !value.presentUserConfirmation
  || value.caller.kind === 'host' && isPresentUserHostInvocation({ surface: value.surface,
    authority: value.authority, actionCaller: { kind: 'host' } })
  || isPluginActionInvokeConfirmationV1({ surface: value.surface, authority: value.authority,
    actionCaller: value.caller, presentUserConfirmation: value.presentUserConfirmation }), {
  message: 'An in-flow confirmation belongs to a present-person host or Plugin action.invoke.',
})));
export type ExternalActionRequesterInvocationV1 = z.infer<typeof ExternalActionRequesterInvocationV1Schema>;

/** Project process-local descriptors onto the incumbent private caller contract. */
export function projectExternalActionRequesterCallerV1(caller: ActionExecutorContext['actionCaller']): unknown {
  const projected = z.union(ExternalActionRequesterInvocationV1Schema.shape.caller.def.options.map(option =>
    z.object(option.shape))).safeParse(caller);
  return projected.success ? projected.data : caller;
}

/** Project process-local context without inventing a Session or admitting a review. */
export function projectExternalActionRequesterInvocationContextV1(
  context: ActionExecutorContext,
  retained: Readonly<Pick<ExternalActionRequesterInvocationV1, 'actionRequestAttributionV1' | 'reviewedParent'>
    & Pick<ActionExecutorContext, 'presentUserConfirmation'>> = {},
): ExternalActionRequesterInvocationV1 | null {
  const workspaceWrites = context.workspaceWrites === 'deny' || context.agentStartWorkspaceWrites === 'deny'
    ? 'deny' : context.workspaceWrites ?? context.agentStartWorkspaceWrites;
  const parsed = ExternalActionRequesterInvocationV1Schema.safeParse({
    caller: projectExternalActionRequesterCallerV1(context.actionCaller), surface: context.surface, authority: context.authority,
    ...(context.callerPermissionMode !== undefined ? { callerPermissionMode: typeof context.callerPermissionMode === 'string'
      ? parseAgentPermissionIntentV1Alias(context.callerPermissionMode) ?? context.callerPermissionMode : context.callerPermissionMode } : {}),
    ...(context.callerInputConstraints !== undefined ? { callerInputConstraints: context.callerInputConstraints } : {}),
    ...(workspaceWrites !== undefined ? { workspaceWrites } : {}),
    ...(context.defaultSessionId != null ? { defaultSessionId: context.defaultSessionId } : {}),
    ...(context.sessionCreationDefaults ? { sessionCreationDefaults: context.sessionCreationDefaults } : {}),
    ...retained,
  });
  return parsed.success ? parsed.data : null;
}

/** Preserve the host's admitted caller and exact review across Account transport. */
export function projectExternalActionRequesterInvocationV1(args: Readonly<{
  actionId: string;
  context: ActionExecutorContext;
  account: Readonly<{ accountId: string; serverId: string; serverIdentityId?: string }>;
  target: Extract<NonNullable<ActionExecutorContext['externalActionTarget']>, { kind: 'machine' }>;
  authentication?: Readonly<{ kind: 'account' | 'terminal' }>;
}>): ExternalActionRequesterInvocationV1 | null {
  const childReview = readHostReviewedChildPresentUserApprovalV1(args.context, args.actionId);
  const review = childReview ?? args.context.presentUserApproval;
  if (review?.actionId === args.actionId && review.decidingAccountId !== undefined
    && review.decidingAccountId !== args.account.accountId) return null;
  const reviewedParent = readHostReviewedParentV1(args.context);
  const confirmation = !childReview && args.context.presentUserConfirmation?.inputDigest !== undefined
    ? args.context.presentUserConfirmation
    : review?.actionId === args.actionId ? {
      actionId: review.actionId, inputDigest: review.inputDigest, requestId: review.requestId,
      ...(review.reviewDigest ? { reviewDigest: review.reviewDigest } : {}),
      accountId: args.account.accountId, serverId: args.context.serverIdentityId ?? args.account.serverId,
      target: args.target,
    } : undefined;
  const provenance = !args.context.externalActionCredential
    ? projectExternalActionRequesterInvocationContextV1(args.context, {
      ...(args.context.actionRequestAttributionV1 ? { actionRequestAttributionV1: args.context.actionRequestAttributionV1 } : {}),
      ...(confirmation ? { presentUserConfirmation: confirmation } : {}),
      ...(reviewedParent ? { reviewedParent } : {}),
    }) : null;
  if (!provenance) return null;
  const attribution = admitExternalActionRequesterInvocationAttributionV1(provenance, {
    accountId: args.account.accountId, serverIdentityId: args.account.serverIdentityId ?? args.account.serverId,
    authentication: args.authentication ?? { kind: 'account' },
  });
  return attribution.ok ? provenance : null;
}

/** An Account's private host invocation can retain its own cause, never name another person. */
export function admitExternalActionRequesterInvocationAttributionV1(
  invocation: ExternalActionRequesterInvocationV1 | undefined,
  principal: Readonly<{ accountId: string; serverIdentityId: string; authentication?: Readonly<{ kind: 'account' | 'terminal' }>;
    sessionActionOrigin?: unknown; workflowActionOrigin?: unknown }> | undefined,
  caller: Readonly<{ kind: string }> | undefined = invocation?.caller,
): Readonly<{ ok: true; actionRequestAttributionV1?: ActionRequestAttributionV1 }> | Readonly<{ ok: false }> {
  const cause = invocation?.actionRequestAttributionV1;
  if (!cause) return { ok: true };
  if (!principal || readExternalActionBindingAuthority(principal) !== 'present_user'
    || caller?.kind !== 'host' || cause.requester && (cause.requester.accountId !== principal.accountId
      || cause.requester.serverId !== principal.serverIdentityId)) return { ok: false };
  return { ok: true, actionRequestAttributionV1: materializeActionRequestAttributionV1(cause) };
}
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
const ManagedCreationCodecPlaintextV1Schema = lazyZodSchema(() => z.strictObject({
  ...installationContextRootShape(),
  invocation: z.optional(ExternalActionRequesterInvocationV1Schema),
  /** Existing parent facts; meaningful only after the source-signed domain continuation is admitted. */
  reviewedParent: z.optional(WorkflowApprovedOperationParentV1Schema),
  sessionCreationTag: z.optional(SessionCreationTagV1Schema),
  purpose: z.strictObject({ kind: z.literal('managed_creation_codec'),
    actionId: z.enum(MANAGED_MACHINE_CREATION_CHILD_ACTION_IDS_V1),
    continuation: ExternalActionManagedContinuationV1Schema,
    recipient: z.strictObject({ machineId: z.string().check(z.minLength(1)), installationId: z.string().check(z.minLength(1)) }),
    requestEnvelopeDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
  }),
  codec: z.optional(z.strictObject({ machineKey: z.string().check(z.base64(), z.refine(value => decodeBase64(value).length === 32)) })),
}));
const InstallationContextPlaintextV1Schema = lazyZodSchema(() => z.union([
  RequesterAccountContextPlaintextV1Schema, ManagedControllerCodecPlaintextV1Schema, ManagedCreationCodecPlaintextV1Schema,
]));

/** Nested purpose discriminants select an already parsed closed context arm. */
function hasManagedCodecPurpose<Kind extends 'managed_creation_codec' | 'managed_controller_codec'>(
  value: z.infer<typeof InstallationContextPlaintextV1Schema>, kind: Kind,
): value is Extract<z.infer<typeof InstallationContextPlaintextV1Schema>, { purpose: { kind: Kind } }> {
  return value.purpose.kind === kind;
}

type SealManagedCreationActionCodecInput = Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  actionId: typeof MANAGED_MACHINE_CREATION_CHILD_ACTION_IDS_V1[number];
  invocation?: ExternalActionRequesterInvocationV1;
  reviewedParent?: z.infer<typeof WorkflowApprovedOperationParentV1Schema>;
  sessionCreationTag?: SessionCreationTagV1;
  continuation: Pick<z.infer<typeof ExternalActionManagedContinuationV1Schema>, 'managedId' | 'creationRequestId' | 'expectedIntentRevision'>;
  envelope: ExternalActionRequestEnvelope;
  recipient: z.infer<typeof ManagedEnrollmentInstallationV1Schema>;
  material?: Readonly<{ type: 'dataKey'; machineKey: Uint8Array }>;
  randomBytes(length: number): Uint8Array;
}>;

/** The existing source signature, not recipient encryption, authenticates this continuation. */
export function sealManagedCreationActionCodecV1(input: SealManagedCreationActionCodecInput & Readonly<{ envelope: ExternalActionRequestEnvelopeV2 }>): ExternalActionRequestEnvelopeV2;
export function sealManagedCreationActionCodecV1(input: SealManagedCreationActionCodecInput): ExternalActionRequestEnvelope;
export function sealManagedCreationActionCodecV1(input: SealManagedCreationActionCodecInput): ExternalActionRequestEnvelope {
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(input.authorization);
  const root = authorization.binding;
  const recipient = ManagedEnrollmentInstallationV1Schema.parse(input.recipient);
  const envelope = ExternalActionRequestEnvelopeSchema.parse(input.envelope);
  const needsCodecMaterial = root.accountEncryptionMode === 'e2ee' && root.accountId !== root.custodianAccountId;
  const continuesSession = root.actionId === SESSION_SPAWN_NEW_ACTION_ID_V1 && input.actionId === SESSION_SPAWN_NEW_ACTION_ID_V1;
  if (!isManagedCreationCodecParent(root, input.actionId) || envelope.managedCreationCodec
    || envelope.target?.kind !== 'machine' || envelope.target.machineId !== recipient.machineId
    || envelope.requestId !== root.requestId
    || (root.actionId === 'machines.managed.acquire' || root.actionId === SESSION_SPAWN_NEW_ACTION_ID_V1)
      && input.continuation.creationRequestId !== root.requestId
    || continuesSession !== (input.sessionCreationTag !== undefined)
    || !root.accountEncryptionMode || !isExternalActionRequestVersionAllowedForAccountModeV1({ accountEncryptionMode: root.accountEncryptionMode, envelopeVersion: envelope.v })
    || needsCodecMaterial && !input.material)
    throw new Error('managed_creation_codec_root_mismatch');
  const plaintext = ManagedCreationCodecPlaintextV1Schema.parse({ v: 1, authorization,
    ...(input.invocation ? { invocation: input.invocation } : {}),
    ...(input.reviewedParent ? { reviewedParent: input.reviewedParent } : {}),
    ...(input.sessionCreationTag ? { sessionCreationTag: input.sessionCreationTag } : {}),
    purpose: { kind: 'managed_creation_codec', actionId: input.actionId,
      continuation: { ...input.continuation, controller: { machineId: root.machineId, installationId: root.installationId },
        acquireRequestEnvelopeDigest: root.requestEnvelopeDigest },
      recipient: { machineId: recipient.machineId, installationId: recipient.installationId },
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) },
    ...(needsCodecMaterial ? { codec: { machineKey: encodeBase64(input.material!.machineKey) } } : {}) });
  return { ...envelope, managedCreationCodec: sealInstallationContext({ plaintext, installationId: recipient.installationId,
    installationPublicKey: decodeBase64(recipient.installationPublicKey, 'base64url'), randomBytes: input.randomBytes }) };
}

function isManagedCreationCodecParent(root: ExternalActionExecutionAuthorizationV1['binding'], actionId: string) {
  return 'authentication' in root && (root.accountEncryptionMode === 'plain' || root.accountEncryptionMode === 'e2ee')
    && root.target.kind === 'machine' && root.target.machineId === root.machineId
    && (root.actionId !== SESSION_SPAWN_NEW_ACTION_ID_V1 || root.sessionPresetAcquisition?.admission !== undefined)
    && isManagedCreationContinuationRootV1(root.actionId, actionId);
}

/** Called only after Home verifies the child root; no Account credentials are recovered. */
type OpenManagedCreationActionCodecInput = Readonly<{
  authorization: unknown; envelope: ExternalActionRequestEnvelope;
  machineId: string; installationId: string; serverIdentityId: string; installationPrivateKey: Uint8Array;
}>;
export function openManagedCreationActionCodecV1(input: OpenManagedCreationActionCodecInput & Readonly<{ includeInvocation: true }>):
  Readonly<{ material: ManagedControllerCodecMaterial | null; invocation?: ExternalActionRequesterInvocationV1;
    reviewedParent?: z.infer<typeof WorkflowApprovedOperationParentV1Schema>; sessionCreationTag?: SessionCreationTagV1 }> | null;
export function openManagedCreationActionCodecV1(input: OpenManagedCreationActionCodecInput): ManagedControllerCodecMaterial | null;
export function openManagedCreationActionCodecV1(input: OpenManagedCreationActionCodecInput & Readonly<{ includeInvocation?: boolean }>) {
  try {
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(input.authorization);
    const root = authorization.binding;
    const envelope = ExternalActionRequestEnvelopeSchema.parse(input.envelope);
    const sealed = envelope.managedCreationCodec;
    if (!sealed || !root.managedContinuation || !('authentication' in root) || root.accountId !== root.custodianAccountId
      || !root.accountEncryptionMode || !isExternalActionRequestVersionAllowedForAccountModeV1({ accountEncryptionMode: root.accountEncryptionMode, envelopeVersion: envelope.v })
      || root.serverIdentityId !== input.serverIdentityId
      || root.machineId !== input.machineId || root.installationId !== input.installationId
      || root.target.kind !== 'machine' || root.target.machineId !== input.machineId
      || envelope.target?.kind !== 'machine' || envelope.target.machineId !== input.machineId
      || envelope.requestId !== root.requestId || sealed.installationId !== input.installationId
      || root.requestEnvelopeDigest !== computeExternalActionRequestEnvelopeDigestV1(envelope)) return null;
    const plaintext = openInstallationSealedContext(sealed, input.installationPrivateKey);
    if (!plaintext || !hasManagedCodecPurpose(plaintext, 'managed_creation_codec')) return null;
    const parent = plaintext.authorization.binding;
    const continuesSession = parent.actionId === SESSION_SPAWN_NEW_ACTION_ID_V1 && root.actionId === SESSION_SPAWN_NEW_ACTION_ID_V1;
    // The final Home-signed digest includes the box. Its internal base digest
    // commits all other envelope bytes, avoiding a circular digest definition.
    const { managedCreationCodec: _codec, ...baseEnvelope } = envelope;
    if (!isManagedCreationCodecParent(parent, root.actionId) || parent.serverIdentityId !== root.serverIdentityId
      || parent.accountId !== root.accountId || !('authentication' in parent)
      || createCanonicalJsonSigningInput(parent.authentication) !== createCanonicalJsonSigningInput(root.authentication)
      || parent.requestId !== root.requestId || plaintext.purpose.actionId !== root.actionId
      || plaintext.purpose.recipient.machineId !== input.machineId || plaintext.purpose.recipient.installationId !== input.installationId
      || plaintext.purpose.continuation.controller?.machineId !== parent.machineId
      || plaintext.purpose.continuation.controller?.installationId !== parent.installationId
      || plaintext.purpose.continuation.acquireRequestEnvelopeDigest !== parent.requestEnvelopeDigest
      || createCanonicalJsonSigningInput(plaintext.purpose.continuation) !== createCanonicalJsonSigningInput(root.managedContinuation)
      || plaintext.reviewedParent && plaintext.reviewedParent.actionId !== parent.actionId
      || continuesSession !== (plaintext.sessionCreationTag !== undefined)
      || continuesSession && root.managedContinuation.creationRequestId !== parent.requestId
      || plaintext.purpose.requestEnvelopeDigest !== computeExternalActionRequestEnvelopeDigestV1(baseEnvelope)) return null;
    if (parent.actionId === WORKFLOW_RUN_START_ACTION_ID_V1) {
      if (parent.target.kind !== 'machine' || !parent.target.project) return null;
      // Setup and enrollment children are Machine-scoped; the canonical
      // continuation declaration above already admitted their exact Action.
      // The continued Run alone retains the original signed Project binding.
      if (root.actionId === WORKFLOW_RUN_START_ACTION_ID_V1) {
        const { workspaceRefId: _previousWorkspace, ...project } = parent.target.project;
        const expected = { kind: 'machine' as const, machineId: input.machineId,
          project: { ...project, machineId: input.machineId } };
        if (!externalActionTargetsEqualV1(expected, root.target)
          || !externalActionTargetsEqualV1(expected, envelope.target)) return null;
      }
    }
    const needsCodecMaterial = parent.accountEncryptionMode === 'e2ee' && parent.accountId !== parent.custodianAccountId;
    if (parent.accountEncryptionMode !== root.accountEncryptionMode || needsCodecMaterial !== Boolean(plaintext.codec)) return null;
    const material: ManagedControllerCodecMaterial | null = plaintext.codec
      ? { type: 'dataKey', machineKey: decodeBase64(plaintext.codec.machineKey) } : null;
    return input.includeInvocation ? { material,
      ...('reviewedParent' in plaintext && plaintext.reviewedParent ? { reviewedParent: plaintext.reviewedParent } : {}),
      ...(plaintext.sessionCreationTag ? { sessionCreationTag: plaintext.sessionCreationTag } : {}),
      ...('invocation' in plaintext && plaintext.invocation ? { invocation: plaintext.invocation } : {}) } : material;
  } catch { return null; }
}

function openInstallationSealedContext(sealed: z.infer<typeof SessionRequesterInstallationSealedBootstrapV1Schema>, privateKey: Uint8Array) {
  if (privateKey.length !== ED25519_SECRET_KEY_BYTES) return null;
  const bytes = openBoxBundleWithSecretKey({ bundle: decodeBase64(sealed.ciphertext, 'base64url'),
    recipientSecretKey: ed25519.utils.toMontgomerySecret(privateKey.subarray(0, 32)) });
  if (!bytes) return null;
  const plaintext = InstallationContextPlaintextV1Schema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
  return plaintext.success ? plaintext.data : null;
}

/** A Home-admitted finite Setup leaf needs only its existing invocation codec. */
export function isReviewedMachineSetupCodecV1(binding: Readonly<{
  actionId: string; workflowActionOrigin?: ExternalActionExecutionAuthorizationV1['binding']['workflowActionOrigin'];
}>): boolean {
  return isMachineSetupNativeCodecActionIdV1(binding.actionId)
    && binding.workflowActionOrigin !== undefined;
}

export function isManagedControllerCodecActionV1(binding: Readonly<{
  actionId: string;
  managedAdmission?: ExternalActionManagedAdmissionV1;
  workflowActionOrigin?: ExternalActionExecutionAuthorizationV1['binding']['workflowActionOrigin'];
}>): boolean {
  const actionId = ActionIdSchema.safeParse(binding.actionId);
  const spec = actionId.success ? getActionSpec(actionId.data) : undefined;
  return isReviewedMachineSetupCodecV1(binding)
    || spec?.originalExecution?.requesterCredentials === 'none'
    || spec?.sideEffectClass === 'read' && MACHINE_SERVICE_FRONTDOOR_ACTION_IDS.some(id => id === binding.actionId)
    || binding.actionId === 'machines.managed.acquire' || binding.actionId === 'machines.managed.inspect'
    || binding.actionId === 'machines.managed.bootstrap.retry'
    || binding.actionId === MANAGED_EXEC_ACTION_ID_V1 && binding.managedAdmission?.actionId === binding.actionId
    || isManagedCreationMutationActionIdV1(binding.actionId)
    || isManagedControlAdmissionActionIdV1(binding.actionId) && binding.managedAdmission?.actionId === binding.actionId
    || binding.actionId === 'machines.managed.credentials.install'
      && binding.managedAdmission?.actionId === binding.actionId
    || (binding.actionId === 'action.operations.list' || binding.actionId === 'action.operations.get')
      && binding.managedAdmission?.actionId === binding.actionId;
}

/** Account roots and reviewed Setup leaves carry this codec; ordinary PAT roots use their own transport. */
export function isManagedControllerCodecRootV1(binding: ExternalActionExecutionAuthorizationV1['binding']): boolean {
  return binding.telemetryCollectorCodec === true || binding.requesterOperationRead === true || isManagedControllerCodecActionV1(binding)
    && ('authentication' in binding || isReviewedMachineSetupCodecV1(binding));
}

/** One admitted Environment's private collector pin, read from its content by the reader. */
export type TelemetryCollectorKeyPinV1 = Readonly<{
  environmentId: string;
  collector?: Readonly<{ machineId: string; installationKeyFingerprint: string }>;
}>;

/**
 * Home delivers the collector key for an Environment read. An E2EE reader seals
 * only to the key its Environment's private content pins; plain content is
 * server-readable by contract, so a plain reader keeps the delivered key.
 */
export function isTelemetryCollectorKeyPinRequiredV1(binding: Pick<ExternalActionExecutionAuthorizationV1['binding'],
  'telemetryCollectorCodec' | 'accountEncryptionMode'>): boolean {
  return binding.telemetryCollectorCodec === true && binding.accountEncryptionMode === 'e2ee';
}

function assertTelemetryCollectorKeyPinnedV1(binding: ExternalActionExecutionAuthorizationV1['binding'],
  installationPublicKey: Uint8Array, pins: readonly TelemetryCollectorKeyPinV1[] | undefined): void {
  const admission = binding.deploymentReadAdmission;
  const environmentIds = admission && 'telemetryCollector' in admission ? admission.telemetryCollector.environmentIds : [];
  const byEnvironment = new Map(pins?.map(pin => [pin.environmentId, pin.collector]));
  const unbound = environmentIds.filter(environmentId => !byEnvironment.get(environmentId));
  const refuse = (code: 'telemetry_collector_key_unbound' | 'telemetry_collector_key_mismatch', ids: readonly string[]) => {
    throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code, effectAttempted: false,
      details: { environmentIds: [...ids], recovery: 'telemetry_setup' } });
  };
  if (!environmentIds.length || unbound.length) refuse('telemetry_collector_key_unbound', unbound);
  const fingerprint = computeMachineInstallationKeyFingerprintV1(installationPublicKey);
  const mismatched = environmentIds.filter(environmentId => {
    const collector = byEnvironment.get(environmentId)!;
    return collector.machineId !== binding.machineId || collector.installationKeyFingerprint !== fingerprint;
  });
  if (mismatched.length) refuse('telemetry_collector_key_mismatch', mismatched);
}

export function sealManagedControllerActionCodecV1(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  material: Readonly<{ type: 'dataKey'; machineKey: Uint8Array }>;
  invocation?: ExternalActionRequesterInvocationV1;
  installationPublicKey: Uint8Array;
  /** Required for an E2EE Environment collector read; see isTelemetryCollectorKeyPinRequiredV1. */
  collectorKeyPins?: readonly TelemetryCollectorKeyPinV1[];
  randomBytes(length: number): Uint8Array;
}>): ExternalActionExecutionAuthorizationV1 {
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(input.authorization);
  if (!isManagedControllerCodecRootV1(authorization.binding)
    || authorization.binding.target.kind !== 'machine' || authorization.binding.target.machineId !== authorization.binding.machineId)
    throw new Error('managed_controller_codec_root_mismatch');
  if (isTelemetryCollectorKeyPinRequiredV1(authorization.binding))
    assertTelemetryCollectorKeyPinnedV1(authorization.binding, input.installationPublicKey, input.collectorKeyPins);
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
  if (input.purpose.kind === 'managed_finite_wake' && (!wake?.target.controller
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
  const sealed = sealInstallationContext({ ...input, plaintext,
    installationId: moveRecipient?.installationId ?? preparation?.controller.installationId ?? wake?.target.controller?.installationId ?? authorization.binding.installationId,
  });
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
  if (!parsed.success || !isManagedControllerCodecRootV1(parsed.data.binding)
    || parsed.data.binding.target.kind !== 'machine'
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
  if (purpose.kind === 'machine_rpc') {
    if (isMachineSetupPlanRpcChildV1({ rootActionId: authorization.binding.actionId,
      effectActionId: 'machines.setup.plan', method: purpose.method })) {
      const input = MachineSetupPlanInputV1Schema.safeParse(purpose.params);
      return input.success && input.data.homeId === authorization.binding.serverIdentityId
        && purpose.recipient?.machineId === input.data.machineId;
    }
    const requestedChild = DeploymentChildRpcV1Schema.safeParse(purpose.params);
    const child = readDeploymentChildRpcV1({ deploymentChildRoot: authorization.binding.deploymentChildRoot, rootActionId: authorization.binding.actionId,
      rootPreparationAdmission: authorization.binding.deploymentPreparationAdmission,
      effectActionId: deploymentChildEffectActionIdForRootV1(authorization.binding.actionId,
        authorization.binding.deploymentPreparationAdmission, requestedChild.success ? requestedChild.data.actionId : undefined) ?? '',
      method: purpose.method, params: purpose.params });
    if (child) return purpose.recipient?.machineId === child.machineId
      && purpose.recipient.installationId === child.installationId;
  }
  return authorization.binding.actionId === 'projects.service.relocate'
    || purpose.kind === 'machine_rpc' && readSessionActionChildCreationRpcEffectV1(
      purpose.method, authorization.binding, purpose.recipient, purpose.reviewedChild) !== null
    || isSessionStopChildRootV1(authorization.binding.actionId)
      && purpose.kind === 'machine_rpc' && purpose.method === RPC_METHODS.STOP_SESSION
      && readSessionStopChildTargetV1(purpose.params) !== null;
}

function isWorkspaceSyncPreparationRoot(authorization: ExternalActionExecutionAuthorizationV1): boolean {
  const binding = authorization.binding;
  return isProjectWorkspaceSyncPreparationActionV1(binding.actionId)
    && binding.target.kind === 'machine' && binding.target.machineId === binding.machineId;
}
const SessionRequesterSessionBootstrapRpcRequestV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('requester_session_bootstrap_v1'),
  scope: z.optional(z.literal('session')),
  input: SessionSpawnNewInputV2Schema,
  requesterBootstrap: z.union([SessionRequesterBootstrapV1Schema, SessionRequesterInstallationSealedBootstrapV1Schema]),
}));
const SessionRequesterWorkflowBootstrapRpcRequestV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('requester_session_bootstrap_v1'),
  scope: z.literal('workflow_trigger'),
  input: z.strictObject({
    executionTarget: z.strictObject({ serverId: z.string().check(z.minLength(1)), machineId: z.string().check(z.minLength(1)) }),
    scopeId: z.string().check(z.minLength(1)),
    automationId: z.optional(z.string().check(z.minLength(1))),
    operation: z.enum(['retain', 'retire']),
  }),
  requesterBootstrap: z.union([SessionRequesterCreationContextV1Schema, SessionRequesterInstallationSealedBootstrapV1Schema]),
}));
/** Existing private delivery, with an explicit finite/trigger custody scope instead of Session birth. */
export const SessionRequesterBootstrapRpcRequestV1Schema = lazyZodSchema(() => z.union([
  SessionRequesterSessionBootstrapRpcRequestV1Schema, SessionRequesterWorkflowBootstrapRpcRequestV1Schema,
]));
export type SessionRequesterBootstrapRpcRequestV1 = Readonly<z.infer<typeof SessionRequesterBootstrapRpcRequestV1Schema>>;

const SessionRequesterSessionBootstrapOpenedRequestV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionRequesterSessionBootstrapRpcRequestV1Schema, {
  requesterBootstrap: SessionRequesterBootstrapV1Schema,
})));
const SessionRequesterWorkflowBootstrapOpenedRequestV1Schema = lazyZodSchema(() => z.strictObject({
  ...SessionRequesterWorkflowBootstrapRpcRequestV1Schema.shape,
  requesterBootstrap: SessionRequesterCreationContextV1Schema,
}));
const SessionRequesterBootstrapOpenedRequestV1Schema = lazyZodSchema(() => z.union([
  SessionRequesterSessionBootstrapOpenedRequestV1Schema, SessionRequesterWorkflowBootstrapOpenedRequestV1Schema,
]));
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
/** Pre-start TARGET workspace capture keeps the requester custody for the handoff's workspace lifetime. */
export const SessionRequesterHandoffWorkspaceCaptureRpcRequestV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('requester_session_handoff_workspace_capture_v1'),
  input: SessionHandoffWorkspaceCaptureRequestV3Schema,
  requesterBootstrap: z.union([SessionRequesterCreationContextV1Schema, SessionRequesterInstallationSealedBootstrapV1Schema]),
}));
const SessionRequesterHandoffWorkspaceCaptureOpenedRequestV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionRequesterHandoffWorkspaceCaptureRpcRequestV1Schema, {
  requesterBootstrap: SessionRequesterCreationContextV1Schema,
})));
type OpenedHandoffWorkspaceCaptureRequest = Readonly<z.infer<typeof SessionRequesterHandoffWorkspaceCaptureOpenedRequestV1Schema>>;
type InstalledRequest = OpenedRequest | OpenedHandoffRequest | OpenedHandoffPreflightRequest | OpenedHandoffWorkspaceCaptureRequest;
const InstallationPlaintextV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), machineId: z.string().check(z.minLength(1)), installationId: z.string().check(z.minLength(1)),
  request: z.union([SessionRequesterBootstrapOpenedRequestV1Schema, SessionRequesterHandoffBootstrapOpenedRequestV1Schema,
    SessionRequesterHandoffPreflightBootstrapOpenedRequestV1Schema, SessionRequesterHandoffWorkspaceCaptureOpenedRequestV1Schema]),
}));

function readInstalledRequestMachineId(request: InstalledRequest): string {
  return request.kind === 'requester_session_bootstrap_v1' ? request.input.executionTarget.machineId : request.input.targetMachineId;
}

function sealInstalledRequest<T extends InstalledRequest>(input: Readonly<{
  request: T; installationId: string; installationPublicKey: Uint8Array; randomBytes(length: number): Uint8Array;
}>) {
  if (!isValidEd25519PublicKey(input.installationPublicKey)) throw new Error('invalid_installation_public_key');
  const plaintext = InstallationPlaintextV1Schema.parse({ v: 1, machineId: readInstalledRequestMachineId(input.request),
    installationId: input.installationId, request: input.request });
  const ciphertext = sealBoxBundle({ plaintext: new TextEncoder().encode(JSON.stringify(plaintext)),
    recipientPublicKey: ed25519.utils.toMontgomery(input.installationPublicKey), randomBytes: input.randomBytes });
  const { requesterBootstrap: _requesterBootstrap, ...request } = input.request;
  return { ...request,
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

export function sealSessionRequesterHandoffWorkspaceCaptureRpcRequestV1(input: Readonly<{
  request: OpenedHandoffWorkspaceCaptureRequest; installationId: string; installationPublicKey: Uint8Array; randomBytes(length: number): Uint8Array;
}>) {
  return sealInstalledRequest({ ...input, request: SessionRequesterHandoffWorkspaceCaptureOpenedRequestV1Schema.parse(input.request) });
}

/** The host supplies its current local installation, never a caller-selected key. */
export function openSessionRequesterBootstrapRpcRequestV1(input: Readonly<{
  request: unknown; machineId: string; installationId: string; installationPrivateKey: Uint8Array;
}>): OpenedRequest | null {
  const request = openInstalledRequest(input, true);
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

export function openSessionRequesterHandoffWorkspaceCaptureRpcRequestV1(input: Readonly<{
  request: unknown; machineId: string; installationId: string; installationPrivateKey: Uint8Array;
}>): OpenedHandoffWorkspaceCaptureRequest | null {
  const request = openInstalledRequest(input);
  return request?.kind === 'requester_session_handoff_workspace_capture_v1' ? request : null;
}

function openInstalledRequest(input: Readonly<{
  request: unknown; machineId: string; installationId: string; installationPrivateKey: Uint8Array;
}>, allowSealedSessionBirth = false): InstalledRequest | null {
  try {
    const parsed = z.union([SessionRequesterBootstrapRpcRequestV1Schema, SessionRequesterHandoffBootstrapRpcRequestV1Schema,
      SessionRequesterHandoffPreflightBootstrapRpcRequestV1Schema, SessionRequesterHandoffWorkspaceCaptureRpcRequestV1Schema]).safeParse(input.request);
    const sealedBirth = allowSealedSessionBirth ? SessionRequesterInstallationSealedBootstrapV1Schema.safeParse(input.request) : null;
    const sealed = sealedBirth?.success ? sealedBirth.data
      : parsed.success && 'kind' in parsed.data.requesterBootstrap ? parsed.data.requesterBootstrap : null;
    if (!sealed || sealed.installationId !== input.installationId
      || parsed.success && (parsed.data.kind === 'requester_session_bootstrap_v1' ? parsed.data.input.executionTarget.machineId
        : parsed.data.input.targetMachineId) !== input.machineId
      || input.installationPrivateKey.length !== ED25519_SECRET_KEY_BYTES) return null;
    const opened = openBoxBundleWithSecretKey({ bundle: decodeBase64(sealed.ciphertext, 'base64url'),
      recipientSecretKey: ed25519.utils.toMontgomerySecret(input.installationPrivateKey.subarray(0, 32)) });
    if (!opened) return null;
    const plaintext = InstallationPlaintextV1Schema.safeParse(JSON.parse(new TextDecoder().decode(opened)));
    if (!plaintext.success || plaintext.data.machineId !== input.machineId
      || plaintext.data.installationId !== input.installationId
      || readInstalledRequestMachineId(plaintext.data.request) !== input.machineId) return null;
    if (!parsed.success) {
      // Pending retains the existing box only. It must contain an already
      // committed Session, never an unbound birth or Workflow credential.
      return sealedBirth?.success && plaintext.data.request.kind === 'requester_session_bootstrap_v1'
        && plaintext.data.request.scope !== 'workflow_trigger' && 'sessionId' in plaintext.data.request.requesterBootstrap
        ? plaintext.data.request : null;
    }
    if (plaintext.data.request.kind !== parsed.data.kind
      || (plaintext.data.request.kind === 'requester_session_bootstrap_v1' && parsed.data.kind === 'requester_session_bootstrap_v1'
        && plaintext.data.request.scope !== parsed.data.scope)
      || createCanonicalJsonSigningInput(plaintext.data.request.input) !== createCanonicalJsonSigningInput(parsed.data.input)) return null;
    return plaintext.data.request;
  } catch { return null; }
}
