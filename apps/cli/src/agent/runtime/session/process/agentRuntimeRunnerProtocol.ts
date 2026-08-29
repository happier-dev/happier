import { z } from 'zod';

import {
  AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1,
  AgentLaunchEnvironmentV1Schema,
  AgentRuntimeJsonValueV1Schema,
  AgentSessionConfigurationSnapshotV1Schema,
  AgentSessionProviderCheckpointV1Schema,
  AgentSessionStartupInstructionsV1Schema,
} from '@happier-dev/protocol/runtime';
import {
  AgentSessionProviderBindingV1Schema,
  AgentIdV1Schema,
  ActionInputHintsSchema,
  ActionSafetySchema,
  ComposerAttachmentMessageAcceptedV1Schema,
  ComposerAttachmentResolveRequestV1Schema,
  ComposerAttachmentResolveResultV1Schema,
  ComposerContentHandleV1Schema,
  ComposerInstanceIdSchema,
  ComposerRefV1Schema,
  ComposerReferenceCandidateV1Schema,
  ComposerReferenceResolutionV1Schema,
  ConnectedServicesProviderStateSharingPolicyV1Schema,
  ModelSelectionApplyPolicySchema,
  PluginContributionIdentityV1Schema,
  PluginActionAvailabilityV2Schema,
  PluginActionDefinitionExamplesV1Schema,
  PluginJsonSchemaV2Schema,
  PluginAgentContributionV2Schema,
  PluginRuntimeCapabilityFamilyV1Schema,
  ProviderAgentTargetKeySchema,
  ProviderConnectionIdSchema,
  ProviderModelDescriptorV1Schema,
  ProviderModelIdSchema,
    ProviderRuntimeBindingBasisV1Schema,
    RuntimeDescriptorV1Schema,
  SessionProviderBindingMetadataV1Schema,
  SessionExecutionTargetV1Schema,
  PluginSourceKindV1Schema,
} from '@happier-dev/protocol';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';

/**
 * Private descriptor-only runner bootstrap carrier. It contains no bearer and
 * grants no daemon or Provider operation authority.
 */
export const HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY =
  'HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE';

const BoundedIdSchema = z.string().trim().min(1).max(256);
const BoundedPathSchema = z.string().min(1).max(32_768);
const BoundedFeatureIdsSchema = z.array(BoundedIdSchema).max(256);
const HostPluginContributionIdentityV1Schema = asHostProtocolZod(
  PluginContributionIdentityV1Schema,
);

const ComposerStagedMediaReleaseIntentV1Schema = z.object({
  handle: ComposerContentHandleV1Schema,
  executionTarget: SessionExecutionTargetV1Schema,
  owner: HostPluginContributionIdentityV1Schema,
  claimant: z.object({
    composer: asHostProtocolZod(ComposerRefV1Schema),
    attachmentInstanceId: ComposerInstanceIdSchema,
  }).strict(),
}).strict();

/**
 * Private runner↔daemon carrier for work that must stay request-local until
 * Session admission reports a known result. It is never transcript metadata.
 */
export const ComposerStagedMediaAdmissionSettlementV1Schema = z.object({
  v: z.literal(1),
  releaseIntents: z.array(ComposerStagedMediaReleaseIntentV1Schema).max(64),
  createdWorkspaceRelativePaths: z.array(BoundedPathSchema).max(64),
  /**
   * The workspace the finalizer actually wrote `createdWorkspaceRelativePaths` into. It
   * travels with the receipt because the settlement outlives the tracked Session process:
   * a definitive admission failure that lands after teardown still has to delete exactly
   * the media this Message created, and by then no live Session can name its directory.
   */
  workingDirectory: BoundedPathSchema,
}).strict();
export type ComposerStagedMediaAdmissionSettlementV1 = z.infer<
  typeof ComposerStagedMediaAdmissionSettlementV1Schema
>;

export const COMPOSER_STAGED_MEDIA_ADMISSION_SETTLEMENT_FIELD =
  '__happierComposerStagedMediaAdmissionSettlementV1';

export function extractComposerStagedMediaAdmissionSettlement(
  payload: Readonly<Record<string, unknown>>,
): Readonly<{
  transformed: Readonly<Record<string, unknown>>;
  settlement: ComposerStagedMediaAdmissionSettlementV1 | null;
}> {
  const {
    [COMPOSER_STAGED_MEDIA_ADMISSION_SETTLEMENT_FIELD]: rawSettlement,
    ...transformed
  } = payload;
  if (rawSettlement === undefined) {
    return { transformed: Object.freeze(transformed), settlement: null };
  }
  const parsed = ComposerStagedMediaAdmissionSettlementV1Schema.safeParse(rawSettlement);
  if (!parsed.success) {
    throw new Error('Daemon returned an invalid staged-media admission settlement');
  }
  return {
    transformed: Object.freeze(transformed),
    settlement: parsed.data,
  };
}

export const AgentRuntimeDaemonTurnPayloadV1Schema = z.record(
  z.string(),
  AgentRuntimeJsonValueV1Schema,
);

export const AgentRuntimeDaemonTurnContributionRequestV1Schema =
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('prompt'),
      selectedAsset: z.object({
        pluginId: BoundedIdSchema,
        localId: BoundedIdSchema,
      }).strict().optional(),
      machineId: BoundedIdSchema.optional(),
      featureIds: BoundedFeatureIdsSchema.optional(),
      excludePluginIds: z.array(BoundedIdSchema).max(128).optional(),
    }).strict(),
    z.object({
      kind: z.literal('composition'),
      runtimeFamily: z.enum(['hostSession', 'acpSession']),
      machineId: BoundedIdSchema.optional(),
      featureIds: BoundedFeatureIdsSchema.optional(),
    }).strict(),
    z.object({
      kind: z.literal('composerReference'),
      reference: HostPluginContributionIdentityV1Schema,
      candidateId: ComposerReferenceCandidateV1Schema.shape.id,
    }).strict(),
    z.object({
      kind: z.literal('composerAttachment'),
      attachment: HostPluginContributionIdentityV1Schema,
      request: ComposerAttachmentResolveRequestV1Schema,
    }).strict(),
    z.object({
      kind: z.literal('composerAttachmentAccepted'),
      attachment: HostPluginContributionIdentityV1Schema,
      event: ComposerAttachmentMessageAcceptedV1Schema,
    }).strict(),
    z.object({
      kind: z.literal('settleComposerStagedMedia'),
      outcome: z.enum(['accepted', 'definitiveFailure']),
      settlement: ComposerStagedMediaAdmissionSettlementV1Schema,
    }).strict(),
    z.object({
      kind: z.literal('transformAgentContext'),
      payload: AgentRuntimeDaemonTurnPayloadV1Schema,
    }).strict(),
    z.object({
      kind: z.literal('transformSessionInput'),
      payload: AgentRuntimeDaemonTurnPayloadV1Schema,
    }).strict(),
    z.object({
      kind: z.literal('transformAgentRequest'),
      payload: AgentRuntimeDaemonTurnPayloadV1Schema,
    }).strict(),
  ]);

const AgentRuntimeDaemonPromptBlockV1Schema = z.object({
  id: BoundedIdSchema,
  scope: z.enum([
    'session',
    'first_turn',
    'turn',
    'provider_behavior',
    'tool_delivery',
    'user_prompt',
    'bootstrap',
  ]),
  text: z.string().min(1).max(262_144),
  enabled: z.boolean().optional(),
}).strict();

const AgentRuntimeDaemonToolPromptContributionV1Schema = z.object({
  id: BoundedIdSchema,
  name: z.string().max(4_096).nullable().optional(),
  title: z.string().max(4_096).nullable().optional(),
  promptSnippet: z.string().max(262_144).nullable().optional(),
  promptGuidelines:
    z.array(z.string().max(262_144)).max(256).nullable().optional(),
}).strict();

const AgentRuntimeDaemonCompositionToolPromptContributionV1Schema =
  AgentRuntimeDaemonToolPromptContributionV1Schema.extend({
    pluginId: BoundedIdSchema,
  }).strict();

/**
 * An immutable executable descriptor selected by the daemon for one Agent
 * turn. This is deliberately a turn payload, not a daemon catalog mirror:
 * it carries only the selected tool plus the canonical generation fence that
 * the daemon action owner will revalidate on execution.
 */
const AgentRuntimeDaemonCompositionToolBindingV1Schema = z.object({
  tool: z.object({
    toolId: z.string().trim().min(1).max(1_024),
    actionId: z.string().trim().min(1).max(1_024),
    name: z.string().trim().min(1).max(4_096),
    title: z.string().trim().min(1).max(4_096),
    description: z.string().trim().min(1).max(4_096),
    inputSchema: PluginJsonSchemaV2Schema,
    outputSchema: PluginJsonSchemaV2Schema.optional(),
    inputHints: ActionInputHintsSchema.optional(),
    safety: ActionSafetySchema.optional(),
    examples: PluginActionDefinitionExamplesV1Schema.optional(),
    promptSnippet: z.string().trim().min(1).optional(),
    promptGuidelines: z.array(z.string().trim().min(1)).max(256).optional(),
    availability: PluginActionAvailabilityV2Schema.optional(),
    surfaces: z.array(z.enum(['agent', 'mcp', 'cli'])).min(1).max(3),
  }).strict(),
  expectedContributorImmutableGenerationId: z.string().trim().min(1).max(512),
}).strict();

const AgentRuntimeDaemonCompositionInstructionV1Schema = z.object({
  pluginId: BoundedIdSchema,
  text: z.string().trim().min(1)
    .superRefine((value, context) => {
      if (new TextEncoder().encode(value).byteLength > 8 * 1024) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Agent composition instruction must not exceed 8 KiB UTF-8',
        });
      }
    }),
}).strict();

const AgentRuntimeDaemonCompositionInstructionsV1Schema = z.array(
  AgentRuntimeDaemonCompositionInstructionV1Schema,
).max(128).superRefine((instructions, context) => {
  const bytesByPluginId = new Map<string, number>();
  let aggregateBytes = 0;
  for (const instruction of instructions) {
    const bytes = new TextEncoder().encode(instruction.text).byteLength;
    const pluginBytes = (bytesByPluginId.get(instruction.pluginId) ?? 0) + bytes;
    bytesByPluginId.set(instruction.pluginId, pluginBytes);
    aggregateBytes += bytes;
    if (pluginBytes > 8 * 1024) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Agent composition instructions exceed the per-plugin 8 KiB UTF-8 bound',
      });
    }
  }
  if (aggregateBytes > 32 * 1024) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Agent composition instructions exceed the aggregate 32 KiB UTF-8 bound',
    });
  }
});

export const AgentRuntimeDaemonTurnContributionsResultV1Schema = z.union([
  z.object({
    kind: z.literal('prompt'),
    promptAssetBlocks:
      z.array(AgentRuntimeDaemonPromptBlockV1Schema).max(256),
    toolPromptContributions: z.array(
      AgentRuntimeDaemonToolPromptContributionV1Schema,
    ).max(256),
  }).strict(),
  z.object({
    kind: z.literal('composition'),
    /** Only plugins whose valid composition result is consumed for this turn. */
    managedPluginIds: z.array(BoundedIdSchema).max(128),
    /** Exact executable tools admitted for those composition-managed plugins. */
    selectedTools: z.array(HostPluginContributionIdentityV1Schema).max(128),
    /** Immutable descriptor + generation binding for each selected MCP tool. */
    selectedToolBindings: z.array(AgentRuntimeDaemonCompositionToolBindingV1Schema).max(128),
    promptAssetBlocks:
      z.array(AgentRuntimeDaemonPromptBlockV1Schema).max(128),
    toolPromptContributions: z.array(
      AgentRuntimeDaemonCompositionToolPromptContributionV1Schema,
    ).max(128),
    additionalInstructions: AgentRuntimeDaemonCompositionInstructionsV1Schema,
  }).strict().superRefine((value, context) => {
    const managedPluginIds = new Set(value.managedPluginIds);
    const selectedToolIds = new Set(value.selectedTools.map(
      (tool) => `${tool.pluginId}/${tool.localId}`,
    ));
    const boundToolIds = new Set<string>();
    for (const tool of value.selectedTools) {
      if (!managedPluginIds.has(tool.pluginId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Agent composition selected tool belongs to an unmanaged plugin',
        });
      }
    }
    for (const [index, binding] of value.selectedToolBindings.entries()) {
      const separatorIndex = binding.tool.toolId.indexOf('/');
      const pluginId = separatorIndex > 0 ? binding.tool.toolId.slice(0, separatorIndex) : null;
      if (pluginId === null || !managedPluginIds.has(pluginId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selectedToolBindings', index, 'tool', 'toolId'],
          message: 'Agent composition selected tool binding belongs to an unmanaged plugin',
        });
      }
      if (!selectedToolIds.has(binding.tool.toolId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selectedToolBindings', index, 'tool', 'toolId'],
          message: 'Agent composition selected tool binding is not an admitted selected tool',
        });
      }
      if (!binding.tool.surfaces.includes('agent')) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selectedToolBindings', index, 'tool', 'surfaces'],
          message: 'Agent composition selected tool binding is not available on the Agent surface',
        });
      }
      if (boundToolIds.has(binding.tool.toolId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['selectedToolBindings', index, 'tool', 'toolId'],
          message: 'Agent composition selected tool binding is duplicated',
        });
      }
      boundToolIds.add(binding.tool.toolId);
    }
    for (const toolId of selectedToolIds) {
      if (boundToolIds.has(toolId)) continue;
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectedToolBindings'],
        message: 'Agent composition selected tool is missing its immutable generation binding',
      });
    }
  }),
  z.object({
    kind: z.literal('composerReference'),
    resolution: ComposerReferenceResolutionV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('composerAttachment'),
    result: ComposerAttachmentResolveResultV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('composerAttachmentAccepted'),
  }).strict(),
  z.object({
    kind: z.literal('settleComposerStagedMedia'),
  }).strict(),
  z.object({
    kind: z.literal('transformAgentContext'),
    payload: AgentRuntimeDaemonTurnPayloadV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('transformSessionInput'),
    payload: AgentRuntimeDaemonTurnPayloadV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('transformAgentRequest'),
    payload: AgentRuntimeDaemonTurnPayloadV1Schema,
  }).strict(),
]).superRefine((value, context) => {
  const bytes = new TextEncoder()
    .encode(JSON.stringify(value)).byteLength;
  if (
    bytes
    > AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.p0MeasuredCandidates
      .preWatchReplayBufferMaxJsonBytes
  ) {
    context.addIssue({
      code: 'custom',
      message:
        'Agent turn contribution result exceeds the aggregate byte bound',
    });
  }
});

export type AgentRuntimeDaemonTurnContributionsResultV1 =
  z.infer<typeof AgentRuntimeDaemonTurnContributionsResultV1Schema>;

export const AgentRuntimeDaemonSessionDescriptorV1Schema = z.object({
  v: z.literal(1),
  pluginId: BoundedIdSchema,
  pluginVersion: z.string().trim().min(1).max(256),
  /** Canonical host routing id (`resolveContributedAgentRoutingId`). */
  agentId: AgentIdV1Schema,
  // The runner currently carries the same canonical host routing identity in
  // both fields. Keep the Agent identity's 513-byte envelope here rather than
  // applying the narrower generic backend-local bound to a qualified external
  // Agent id.
  backendId: AgentIdV1Schema,
  generation: BoundedIdSchema,
  immutableGenerationId: z.string().trim().min(1).max(512).optional(),
  /**
   * Exact immutable-generation Agent declaration selected by the daemon. The
   * runner re-verifies this fact against its retained direct binding before
   * runtime construction; the descriptor itself grants no authority.
   */
  agentDeclaration: z.object({
    provenance: z.enum(['first_party', 'external']),
    source: z.object({
      kind: PluginSourceKindV1Schema,
    }).strict(),
    definition: PluginAgentContributionV2Schema,
  }).strict().optional(),
  runtimeAuthority: z.object({
    runtimeCapabilities:
      z.array(PluginRuntimeCapabilityFamilyV1Schema).max(256)
        .refine((values) => new Set(values).size === values.length),
  }).strict().optional(),
}).strict();

export type AgentRuntimeDaemonSessionDescriptorV1 =
  z.infer<typeof AgentRuntimeDaemonSessionDescriptorV1Schema>;

export const AgentRuntimeDaemonProviderConnectionModelRefV1Schema =
  z.object({
    agentTargetKey: ProviderAgentTargetKeySchema,
    providerConnectionId: ProviderConnectionIdSchema,
    modelId: ProviderModelIdSchema,
  }).strict();

export const AgentRuntimeDaemonModelTransitionAuthorizationResultV1Schema =
  z.object({
    selection: AgentRuntimeDaemonProviderConnectionModelRefV1Schema,
    policy: ModelSelectionApplyPolicySchema,
    model: ProviderModelDescriptorV1Schema,
    sessionBindingMetadata: SessionProviderBindingMetadataV1Schema,
    runtimeBindingBasis: ProviderRuntimeBindingBasisV1Schema,
  }).strict();

export type AgentRuntimeDaemonModelTransitionAuthorizationResultV1 =
  z.infer<
    typeof AgentRuntimeDaemonModelTransitionAuthorizationResultV1Schema
  >;

const McpLaunchConfigSchema = z.object({
  command: BoundedPathSchema,
  args: z.array(z.string().max(32_768)).max(1_024).optional(),
  env: z.record(
    z.string().max(256),
    z.string().max(262_144),
  ).optional(),
}).strict();

const ConnectedAccountSchema = z.object({
  purpose: z.string().trim().min(1).max(256),
  account: z.object({
    service: z.object({
      pluginId: BoundedIdSchema,
      localId: BoundedIdSchema,
    }).strict(),
    accountId: BoundedIdSchema,
  }).strict(),
}).strict();

const AgentSessionOpenBaseSchema = z.object({
  sessionId: BoundedIdSchema,
  cwd: BoundedPathSchema,
  launchEnvironment: AgentLaunchEnvironmentV1Schema.optional(),
  runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
  configuration: AgentSessionConfigurationSnapshotV1Schema.optional(),
  connectedAccounts: z.array(ConnectedAccountSchema).max(256).optional(),
  mcpServers:
    z.record(BoundedIdSchema, McpLaunchConfigSchema).optional(),
  providerBinding: AgentSessionProviderBindingV1Schema.optional(),
  stateSharing: ConnectedServicesProviderStateSharingPolicyV1Schema.optional(),
});

export const AgentRuntimeDaemonSessionOpenRequestV1Schema =
  z.discriminatedUnion('kind', [
    AgentSessionOpenBaseSchema.extend({
      kind: z.literal('create'),
      startupInstructions:
        AgentSessionStartupInstructionsV1Schema.optional(),
    }).strict(),
    AgentSessionOpenBaseSchema.extend({
      kind: z.literal('resume'),
      providerSessionId: BoundedIdSchema,
      strictNativeResumeIdentity: z.literal(true).optional(),
      startupInstructions:
        AgentSessionStartupInstructionsV1Schema.optional(),
    }).strict(),
    AgentSessionOpenBaseSchema.extend({
      kind: z.literal('fork'),
      source: z.object({
        sessionId: BoundedIdSchema,
        providerSessionId: BoundedIdSchema,
        cwd: BoundedPathSchema,
        target: z.object({
          turnId: BoundedIdSchema,
          providerCheckpoint: AgentSessionProviderCheckpointV1Schema,
        }).strict().optional(),
      }).strict(),
    }).strict(),
  ]);

/**
 * Durable runner-open evidence deliberately excludes transient startup text
 * and native-resume identity. The marker owns the retained identity; the
 * provider receives those facts only during the one open attempt.
 */
export const AgentRuntimeDaemonSessionOpenAttestationRequestV1Schema =
  z.discriminatedUnion('kind', [
    AgentSessionOpenBaseSchema.extend({
      kind: z.literal('create'),
    }).strict(),
    AgentSessionOpenBaseSchema.extend({
      kind: z.literal('resume'),
      providerSessionId: BoundedIdSchema,
    }).strict(),
    AgentSessionOpenBaseSchema.extend({
      kind: z.literal('fork'),
      source: z.object({
        sessionId: BoundedIdSchema,
        providerSessionId: BoundedIdSchema,
        cwd: BoundedPathSchema,
        target: z.object({
          turnId: BoundedIdSchema,
          providerCheckpoint: AgentSessionProviderCheckpointV1Schema,
        }).strict().optional(),
      }).strict(),
    }).strict(),
  ]);

export type AgentRuntimeDaemonSessionOpenAttestationRequestV1 = z.infer<
  typeof AgentRuntimeDaemonSessionOpenAttestationRequestV1Schema
>;

export function projectAgentRuntimeDaemonSessionOpenAttestationRequestV1(
  request: unknown,
): AgentRuntimeDaemonSessionOpenAttestationRequestV1 {
  const parsed = AgentRuntimeDaemonSessionOpenRequestV1Schema.parse(request);
  if (parsed.kind === 'fork') {
    return AgentRuntimeDaemonSessionOpenAttestationRequestV1Schema.parse(
      parsed,
    );
  }
  if (parsed.kind === 'resume') {
    const {
      startupInstructions: _startupInstructions,
      strictNativeResumeIdentity: _strictNativeResumeIdentity,
      ...attestation
    } = parsed;
    return AgentRuntimeDaemonSessionOpenAttestationRequestV1Schema.parse(
      attestation,
    );
  }
  const { startupInstructions: _startupInstructions, ...attestation } = parsed;
  return AgentRuntimeDaemonSessionOpenAttestationRequestV1Schema.parse(
    attestation,
  );
}
