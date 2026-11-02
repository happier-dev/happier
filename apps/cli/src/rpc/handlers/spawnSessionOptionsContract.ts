import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { z } from 'zod/mini';
import { AgentSessionToolPolicyShapeV1 } from '@happier-dev/protocol/runtime/permissionIntentV1';
import { SpawnSessionTerminalSchema } from '@happier-dev/protocol/spawnSession';
import { AcpConfigOptionOverridesV1Schema } from '@happier-dev/protocol/sessions/metadata/overrides';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import { AgentSessionStartupInstructionsV1Schema } from '@happier-dev/protocol/runtime/agentSessionStartupInstructionsV1';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { ConnectedServiceMaterializationIdentityV1Schema } from '@happier-dev/protocol/sessions/metadata/connectedServiceMaterializationIdentityV1';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { SessionCreationTagV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { SessionInitialAccessDraftV1Schema } from '@happier-dev/protocol/sessions/access/sessionInitialAccessDraftV1';
import { SessionInitialTriggerAdmissionV1Schema } from '@happier-dev/protocol/sessions/creation/sessionInitialTriggerAdmissionV1';
import { SessionCreateOriginFieldsV1Schema, refineSessionCreateOriginFieldsV1 } from '@happier-dev/protocol/sessions/creation/sessionCreateOriginV1';
import { SessionAttachMetadataIdentityPolicySchema } from '@happier-dev/protocol/sessions/attach/metadataIdentityPolicy';
import { readCapabilitySelectionCarrierV1, SessionCapabilitySelectionAuthoringV1Schema } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { SessionInputRequestSchema, SessionMessageProvenanceSchema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionUserMessageSendRequestSchema } from '@happier-dev/protocol/sessions/userMessageRpc';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/model-selection';
import { SessionManagerV1Schema } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { SessionIdentityAdditionsV1Schema } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { SessionPromptStackV1Schema } from '@happier-dev/protocol/sessions/context/sessionContextV1';
import { SessionRolesV1Schema } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { SessionInitialGoalRequestV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import { SessionIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import { MachinePoolSelectionOriginV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import { NonBlankOpaqueIdentifierSchema } from '@happier-dev/protocol/strings/opaqueIdentifier';
import { SecretReferenceOverlayV1Schema } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import { SessionProviderBindingSecurityChangeConfirmationV1Schema } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { SpawnSessionExecutionAuthorizationSchema } from '@happier-dev/protocol/spawnSession';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { AgentExecutionTargetV1, BackendTargetRefV2 } from '@happier-dev/protocol';
import { SessionTeamCredentialBindingIntentsV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { PluginUiNewSessionSeedOriginV1Schema } from '@happier-dev/protocol/plugins/ui';

import { PERMISSION_MODES } from '@/api/types';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import { isCatalogAgentId } from '@/agent/catalog/resolution';
import { normalizeDaemonBackendTargetV2Input } from '@/daemon/backendTargetRouting';
import { ConnectedServicesBindingsIngressSchema } from '@/daemon/connectedServices/parseConnectedServicesBindings';

import {
  NativeForkSourceSchema,
  type SpawnSessionOptions,
} from '@/session/shared/spawnSessionContract';
import { readCanonicalSpawnRuntimeSelectionFromCompatIngress } from './spawnRuntimeSelection';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';

/** Actual private lifecycle registrations; not the public fresh-spawn Action. */
export const PRIVATE_SPAWN_SESSION_RPC_METHODS = Object.freeze({
  primary: RPC_METHODS.SPAWN_HAPPY_SESSION,
  providerSafe: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
});

function asNonEmptyStringTuple<T extends string>(values: readonly T[]): [T, ...T[]] {
  if (values.length === 0) {
    throw new Error('Expected non-empty string tuple');
  }
  return values as [T, ...T[]];
}

export const SpawnSessionPermissionModeSchema = z.enum(asNonEmptyStringTuple(PERMISSION_MODES));
function parseSpawnBackendTargetCandidate(value: unknown): CanonicalSpawnBackendTarget | null {
  const backendTarget = normalizeDaemonBackendTargetV2Input(value);
  if (!backendTarget) {
    return null;
  }
  if (!isSupportedSpawnBackendTarget(backendTarget)) {
    return null;
  }
  return backendTarget;
}

function isSupportedSpawnBackendTarget(backendTarget: CanonicalSpawnBackendTarget): boolean {
  if (backendTarget.backendId === 'customAcp' || backendTarget.configuredBackendId === 'customAcp') {
    return false;
  }

  if (backendTarget.sourceKind === 'built_in' && !isCatalogAgentId(backendTarget.backendId)) {
    return false;
  }

  return true;
}

function isKnownCatalogAgentId(value: string): value is CatalogAgentId {
  return isCatalogAgentId(value);
}

type CanonicalSpawnBackendTarget = BackendTargetRefV2;

export type SpawnDaemonSessionRequest = Omit<
  SpawnSessionOptions,
  | 'backendTarget'
  | 'providerBindingMetadataV1'
  | 'creationAuthorization'
  | 'callerInputConstraints'
  | 'requesterWorkAttributionV1'
  | 'verifyRequesterMachineAdmissionCurrent'
  | 'beforeSessionRunnerLaunch'
  | 'requesterSessionCredentialFile'
  | 'requesterSessionBootstrap'
  | 'requesterSessionRuntimeContext'
> & {
  /** Private machine transport discriminator retained for lifecycle routing. */
  type?: 'spawn-in-directory' | 'resume-session';
  backendTarget?: BackendTargetRefV2;
  agentTarget?: AgentExecutionTargetV1;
};

export function canonicalizeSpawnBackendTargetFromTransportInput(params: Readonly<{
  backendTarget?: unknown;
  legacyAgent?: unknown;
}>): Readonly<{ backendTarget?: CanonicalSpawnBackendTarget; errorMessage?: string }> {
  if (params.backendTarget !== undefined) {
    const parsedBackendTarget = parseSpawnBackendTargetCandidate(params.backendTarget);
    if (!parsedBackendTarget) {
      return { errorMessage: 'Unknown backend target' };
    }
    return { backendTarget: parsedBackendTarget };
  }

  const normalizedLegacyAgent = typeof params.legacyAgent === 'string' ? params.legacyAgent.trim() : '';
  if (!normalizedLegacyAgent) {
    return {};
  }
  if (!isKnownCatalogAgentId(normalizedLegacyAgent)) {
    return { errorMessage: 'Unknown backend target' };
  }
  return {
    backendTarget: {
      kind: 'backend',
      backendId: normalizedLegacyAgent,
      sourceKind: 'built_in',
    },
  };
}

export { SpawnSessionTerminalSchema };

function canonicalizeSpawnDaemonSessionRequestIngress(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const request = value as Record<string, unknown>;
  if (
    request.codexBackendMode !== undefined
    && request.codexBackendMode !== 'mcp'
    && request.codexBackendMode !== 'acp'
    && request.codexBackendMode !== 'appServer'
  ) {
    return value;
  }
  if (
    request.experimentalCodexAcp !== undefined
    && typeof request.experimentalCodexAcp !== 'boolean'
  ) {
    return value;
  }
  const runtimeSelection = (() => {
    try {
      return readCanonicalSpawnRuntimeSelectionFromCompatIngress({
        codexBackendMode: request.codexBackendMode,
        experimentalCodexAcp: request.experimentalCodexAcp,
        runtimeDescriptorV1: request.runtimeDescriptorV1,
        legacyAgentRuntimeDescriptorV1: request.agentRuntimeDescriptorV1,
      });
    } catch {
      return null;
    }
  })();
  if (!runtimeSelection) return value;
  if (request.capabilitySelection !== undefined && !SessionCapabilitySelectionAuthoringV1Schema.safeParse(request.capabilitySelection).success) return value;
  const capabilitySelection = readCapabilitySelectionCarrierV1(request);
  if ((request.capabilitySelection !== undefined || request.mcpSelection !== undefined) && !capabilitySelection) return value;
  const { runtimeDescriptorV1 } = runtimeSelection;
  const {
    agentRuntimeDescriptorV1: _legacyAgentRuntimeDescriptorV1,
    codexBackendMode: _legacyCodexBackendMode,
    experimentalCodexAcp: _legacyExperimentalCodexAcp,
    mcpSelection: _legacyMcpSelection,
    capabilitySelection: _capabilitySelection,
    ...rest
  } = request;

  return runtimeDescriptorV1
    ? {
      ...rest,
      ...(capabilitySelection ? { capabilitySelection } : {}),
      runtimeDescriptorV1,
    }
    : { ...rest, ...(capabilitySelection ? { capabilitySelection } : {}) };
}

const SpawnDaemonSessionRequestCompatSchema = (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(canonicalizeSpawnDaemonSessionRequestIngress), z.strictObject({
  type: z.optional(z.enum(['spawn-in-directory', 'resume-session'])),
  directory: z.string(),
  directoryKind: z.optional(z.enum(['path', 'managed'])),
  freshSessionCreation: z.optional(z.boolean()),
  managedDirectorySeed: z.optional(z.strictObject({
    sourceSessionId: z.string().check(z.trim(), z.minLength(1)),
    sourceSessionCreationTag: z.optional(z.string().check(z.trim(), z.minLength(1))),
    sourcePath: z.string().check(z.trim(), z.minLength(1)),
  })),
  ...SessionCreateOriginFieldsV1Schema.shape,
  approvedNewDirectoryCreation: z.optional(z.boolean()),
  machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  spawnNonce: z.optional(z.string().check(z.trim(), z.minLength(1))),
  sessionCreationTag: z.optional(SessionCreationTagV1Schema),
  sessionCreationCorrespondence: z.optional(SessionCreationCorrespondenceV1Schema),
  placementOrigin: z.optional(MachinePoolSelectionOriginV1Schema),
  initialTitle: z.optional(z.string().check(z.trim(), z.minLength(1))),
  authoringOrigin: z.optional(asHostProtocolZod(PluginUiNewSessionSeedOriginV1Schema)),
  identity: z.optional(asHostProtocolZod(SessionIdentityAdditionsV1Schema)),
  memoryEnabled: z.optional(z.boolean()),
  promptStack: z.optional(asHostProtocolZod(SessionPromptStackV1Schema)),
  initialAccess: z.optional(SessionInitialAccessDraftV1Schema),
  initialTriggers: z.optional(z.array(asHostProtocolZod(SessionInitialTriggerAdmissionV1Schema))),
  manager: z.optional(SessionManagerV1Schema),
  initialSessionRolesV1: z.optional(asHostProtocolZod(SessionRolesV1Schema)),
  primaryTeamId: z.optional(z.nullable(z.string().check(z.minLength(1)))),
  teamCredentialBindings: z.optional(SessionTeamCredentialBindingIntentsV1Schema),
  pendingFirstInput: z.optional(z.strictObject({
    text: z.string(),
    localId: z.string().check(z.refine((value) => value.trim().length > 0)),
    meta: z.optional(z.record(z.string(), z.unknown())),
    inputAdmission: z.optional(z.strictObject({
      provenance: SessionMessageProvenanceSchema,
      request: SessionInputRequestSchema,
    })),
  }).check(z.superRefine((value, ctx) => {
    const parsed = SessionUserMessageSendRequestSchema.safeParse({
      text: value.text,
      meta: value.meta ?? {},
    });
    if (parsed.success) return;
    ctx.addIssue({
      code: "custom",
      path: ['text'],
      message: 'Pending first input requires text or a valid Composer attachment.',
    });
  }))),
  accountSettingsVersionHint: z.optional(z.number().check(z.int(), z.minimum(0))),
  sessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  existingSessionId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  initialTranscriptAfterSeq: z.optional(z.number().check(z.int(), z.minimum(0))),
  initialGoal: z.optional(SessionInitialGoalRequestV1Schema),
  executionAuthorization: z.optional(SpawnSessionExecutionAuthorizationSchema),
  attachMetadataIdentityPolicy: z.optional(SessionAttachMetadataIdentityPolicySchema),
  /** Agent-issued and opaque: admitted for presence, carried byte for byte. */
  resume: z.optional(NonBlankOpaqueIdentifierSchema),
  handoffStateTransfer: z.optional(z.enum(['transfer', 'existing'])),
  nativeForkSource: z.optional(NativeForkSourceSchema),
  agentSessionStartupInstructionsV1:
    z.optional(AgentSessionStartupInstructionsV1Schema),
  runtimeDescriptorV1: z.optional(RuntimeDescriptorV1Schema),
  permissionMode: z.optional(SpawnSessionPermissionModeSchema),
  ...AgentSessionToolPolicyShapeV1,
  workspaceWrites: z.optional(z.enum(['allow', 'deny'])),
  permissionModeUpdatedAt: z.optional(z.number().check(z.int())),
  agentModeId: z.optional(z.string().check(z.trim(), z.minLength(1))),
  agentModeUpdatedAt: z.optional(z.number().check(z.int())),
  modelId: z.optional(z.string()),
  modelUpdatedAt: z.optional(z.number().check(z.int())),
  modelSelection: z.optional(SessionModelSelectionV1Schema),
  providerBindingSecurityChangeConfirmationV1: z.optional(SessionProviderBindingSecurityChangeConfirmationV1Schema),
  sessionConfigOptionOverrides: z.optional(AcpConfigOptionOverridesV1Schema),
  backendTarget: z.optional(z.any()),
  agentTarget: z.optional(AgentExecutionTargetV1Schema),
  agent: z.optional(z.string().check(z.trim(), z.minLength(1))),
  terminal: z.optional(SpawnSessionTerminalSchema),
  windowsRemoteSessionLaunchMode: z.optional(z.enum(['hidden', 'windows_terminal', 'console'])),
  windowsRemoteSessionConsole: z.optional(z.enum(['hidden', 'visible'])),
  windowsTerminalWindowName: z.optional(z.string()),
  profileId: z.optional(z.string()),
  secretReferenceOverlay: z.optional(SecretReferenceOverlayV1Schema),
  environmentVariables: z.optional(z.record(z.string(), z.string())),
  connectedServices: ConnectedServicesBindingsIngressSchema,
  connectedServicesUpdatedAt: z.optional(z.number().check(z.int())),
  connectedServiceMaterializationIdentityV1: z.optional(ConnectedServiceMaterializationIdentityV1Schema),
  capabilitySelection: z.optional(SessionCapabilitySelectionAuthoringV1Schema),
  transcriptStorage: z.optional(z.enum(['persisted', 'direct'])),
}));

export const SpawnDaemonSessionRequestSchema = z.pipe(SpawnDaemonSessionRequestCompatSchema, z.transform((request, ctx) => {
  refineSessionCreateOriginFieldsV1(request, ctx);
  const freshCreation = !request.existingSessionId && request.type !== 'resume-session';
  const discussionRecipe = request.sessionCreationCorrespondence?.recipe.discussionParticipant;
  if (freshCreation && discussionRecipe && (request.originKind !== 'discussion'
    || request.discussionParticipant?.discussionId !== discussionRecipe.discussionId
    || request.discussionParticipant?.participantSlotId !== discussionRecipe.participantSlotId)) {
    ctx.issues.push({ code: "custom", path: ['discussionParticipant'],
      message: 'Discussion creation correspondence requires its matching explicit birth origin', input: ctx.value });
    return z.NEVER;
  }
  if (freshCreation && (request.discussionParticipant || discussionRecipe)
    && (request.pendingFirstInput !== undefined || (request.initialTriggers?.length ?? 0) > 0)) {
    ctx.issues.push({ code: "custom", path: request.pendingFirstInput !== undefined ? ['pendingFirstInput'] : ['initialTriggers'],
      message: 'Discussion participant creation cannot submit initial work', input: ctx.value });
    return z.NEVER;
  }
  if ((request.identity !== undefined || request.memoryEnabled !== undefined || request.promptStack !== undefined)
    && (request.existingSessionId || request.type === 'resume-session')) {
    ctx.issues.push({ code: "custom", path: ['identity'], message: 'Initial identity, memory choice and context require fresh Session creation', input: ctx.value });
    return z.NEVER;
  }
  if (request.initialGoal && !request.existingSessionId && request.type !== 'resume-session') {
    ctx.issues.push({
      code: "custom",
      path: ['initialGoal'],
      message: 'Initial goals require Session resume', input: ctx.value });
    return z.NEVER;
  }
  if (request.manager !== undefined && (request.existingSessionId || request.type === 'resume-session')) {
    ctx.issues.push({ code: "custom", path: ['manager'], message: 'The lead relation requires fresh Session creation', input: ctx.value });
    return z.NEVER;
  }
  if (request.authoringOrigin !== undefined && (request.existingSessionId || request.type === 'resume-session')) {
    ctx.issues.push({ code: 'custom', path: ['authoringOrigin'], message: 'Authoring provenance requires fresh Session creation', input: ctx.value });
    return z.NEVER;
  }
  if (request.initialSessionRolesV1 !== undefined && (request.existingSessionId || request.type === 'resume-session')) {
    ctx.issues.push({ code: "custom", path: ['initialSessionRolesV1'], message: 'Initial roles require fresh Session creation', input: ctx.value });
    return z.NEVER;
  }
  if ((request.initialAccess !== undefined || request.primaryTeamId !== undefined)
    && (request.existingSessionId || request.type === 'resume-session')) {
    ctx.issues.push({ code: "custom", path: ['initialAccess'], message: 'Initial access and Team context require fresh Session creation', input: ctx.value });
    return z.NEVER;
  }
  if (request.placementOrigin && request.existingSessionId) {
    ctx.issues.push({
      code: "custom",
      message: 'Session placement origin is valid only for fresh creation',
      path: ['placementOrigin'], input: ctx.value });
    return z.NEVER;
  }
  if (request.resume && request.nativeForkSource) {
    ctx.issues.push({
      code: "custom",
      message: 'resume and nativeForkSource are mutually exclusive',
      path: ['nativeForkSource'], input: ctx.value });
    return z.NEVER;
  }
  if (
    request.nativeForkSource
    && request.agentSessionStartupInstructionsV1
  ) {
    ctx.issues.push({
      code: "custom",
      message: 'Startup instructions are not supported for fork requests',
      path: ['agentSessionStartupInstructionsV1'], input: ctx.value });
    return z.NEVER;
  }
  if (
    request.sessionCreationCorrespondence
    && request.sessionCreationCorrespondence.sessionCreationTag !== request.sessionCreationTag
  ) {
    ctx.issues.push({
      code: "custom",
      message: 'Session creation correspondence must match sessionCreationTag',
      path: ['sessionCreationCorrespondence'], input: ctx.value });
    return z.NEVER;
  }
  const {
    agent,
    approvedNewDirectoryCreation,
    modelId: legacyModelId,
    modelUpdatedAt: legacyModelUpdatedAt,
    ...rest
  } = request;
  const canonicalBackendTarget = rest.backendTarget !== undefined
    ? canonicalizeSpawnBackendTargetFromTransportInput({
      backendTarget: rest.backendTarget,
    }).backendTarget
    : canonicalizeSpawnBackendTargetFromTransportInput({
      legacyAgent: agent,
    }).backendTarget;
  const hasBackendTargetInput = rest.backendTarget !== undefined || Boolean(typeof agent === 'string' && agent.trim().length > 0);
  if (hasBackendTargetInput && !canonicalBackendTarget) {
    ctx.issues.push({
      code: "custom",
      message: 'Unknown backend target',
      path: ['backendTarget'], input: ctx.value });
    return z.NEVER;
  }
  const targetKey = rest.agentTarget
    ? buildBackendTargetKeyV2(rest.agentTarget)
    : canonicalBackendTarget
      ? buildBackendTargetKeyV2(canonicalBackendTarget)
      : null;
  if (rest.modelSelection && (!targetKey || rest.modelSelection.ref.agentTargetKey !== targetKey)) {
    ctx.issues.push({
      code: "custom",
      message: 'Model selection agent target must match the selected target',
      path: ['modelSelection', 'ref', 'agentTargetKey'], input: ctx.value });
    return z.NEVER;
  }
  const normalizedLegacyModelId = typeof legacyModelId === 'string' ? legacyModelId.trim() : '';
  if (normalizedLegacyModelId && !targetKey) {
    ctx.issues.push({
      code: "custom",
      message: 'An Agent or backend target is required when modelId is provided',
      path: ['agentTarget'], input: ctx.value });
    return z.NEVER;
  }
  const modelSelection = rest.modelSelection ?? (normalizedLegacyModelId && targetKey
    ? SessionModelSelectionV1Schema.parse({
      v: 1,
      updatedAt: legacyModelUpdatedAt ?? Date.now(),
      ref: { agentTargetKey: targetKey, providerConnectionId: null, modelId: normalizedLegacyModelId },
    })
    : undefined);
  const {
    runtimeDescriptorV1,
  } = readCanonicalSpawnRuntimeSelectionFromCompatIngress({
    agentId: canonicalBackendTarget?.sourceKind === 'built_in'
      ? canonicalBackendTarget.backendId
      : undefined,
    runtimeDescriptorV1: request.runtimeDescriptorV1,
  });

  return {
    ...rest,
    ...(approvedNewDirectoryCreation !== undefined ? { approvedNewDirectoryCreation } : {}),
    ...(canonicalBackendTarget ? { backendTarget: canonicalBackendTarget } : {}),
    ...(modelSelection ? { modelSelection } : {}),
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
  };
})) as z.ZodMiniType<SpawnDaemonSessionRequest>;

const SPAWN_SESSION_OPTION_KEYS = [
  'machineId',
  'directory',
  'directoryKind',
  'freshSessionCreation',
  'managedDirectorySeed',
  'originKind',
  'originSessionId',
  'originRunId',
  'discussionParticipant',
  'discussionParticipantLaunch',
  'workDepth',
  'spawnNonce',
  'sessionCreationTag',
  'sessionCreationCorrespondence',
  'placementOrigin',
  'initialTitle',
  'authoringOrigin',
  'identity',
  'memoryEnabled',
  'promptStack',
  'initialAccess',
  'initialTriggers',
  'manager',
  'initialSessionRolesV1',
  'primaryTeamId',
  'teamCredentialBindings',
  'pendingFirstInput',
  'accountSettingsVersionHint',
  'sessionId',
  'resume',
  'handoffStateTransfer',
  'nativeForkSource',
  'agentSessionStartupInstructionsV1',
  'runtimeDescriptorV1',
  'existingSessionId',
  'initialTranscriptAfterSeq',
  'initialGoal',
  'executionAuthorization',
  'attachMetadataIdentityPolicy',
  'permissionMode',
  'allowedTools',
  'unlistedTools',
  'workspaceWrites',
  'permissionModeUpdatedAt',
  'agentModeId',
  'agentModeUpdatedAt',
  'modelSelection',
  'sessionConfigOptionOverrides',
  'approvedNewDirectoryCreation',
  'backendTarget',
  'agentTarget',
  'terminal',
  'windowsRemoteSessionLaunchMode',
  'windowsRemoteSessionConsole',
  'windowsTerminalWindowName',
  'profileId',
  'secretReferenceOverlay',
  'environmentVariables',
  'connectedServices',
  'connectedServicesUpdatedAt',
  'connectedServiceMaterializationIdentityV1',
  'capabilitySelection',
  'transcriptStorage',
] as const satisfies readonly (keyof SpawnSessionOptions)[];

type SpawnSessionOptionKey = (typeof SPAWN_SESSION_OPTION_KEYS)[number];

export function pickDefinedSpawnSessionOptions(options: Partial<SpawnSessionOptions>): Partial<SpawnSessionOptions> {
  const result: Partial<SpawnSessionOptions> = {};

  for (const key of SPAWN_SESSION_OPTION_KEYS) {
    const value = options[key];
    if (value !== undefined) {
      (result as Record<SpawnSessionOptionKey, unknown>)[key] = value;
    }
  }

  return result;
}

export function mergeSpawnSessionOptions(
  options: Partial<SpawnSessionOptions>,
  overrides: Partial<SpawnSessionOptions> = {},
  params: { omit?: readonly SpawnSessionOptionKey[] } = {},
): Partial<SpawnSessionOptions> {
  const result = pickDefinedSpawnSessionOptions(options);

  for (const key of params.omit ?? []) {
    delete result[key];
  }

  return {
    ...result,
    ...pickDefinedSpawnSessionOptions(overrides),
  };
}
