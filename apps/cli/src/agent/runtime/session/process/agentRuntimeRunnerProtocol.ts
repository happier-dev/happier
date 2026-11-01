import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { z } from 'zod/mini';

import { AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1 } from '@happier-dev/protocol/runtime/agentSessionLimitsV1';
import { AgentLaunchEnvironmentV1Schema, AgentRuntimeJsonValueV1Schema, AgentSessionConfigurationSnapshotV1Schema, AgentSessionProviderCheckpointV1Schema, AgentSessionIdleCompactionPreferenceV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { AgentSessionStartupInstructionsV1Schema } from '@happier-dev/protocol/runtime/agentSessionStartupInstructionsV1';
import { AgentSessionSkillDeliveryV1Schema } from '@happier-dev/protocol/prompts/library/skills/resolveSessionSkillPlanV1';
import { McpToolLaunchPoliciesV1Schema } from '@happier-dev/protocol/mcp/servers/tools/resolveMcpToolDecisionV1';
import { AgentSessionProviderBindingV1Schema } from '@happier-dev/protocol/providers/sessions/agentSessionProviderBindingV1';
import { ComposerStagedMediaReleaseIntentV1Schema, MAX_COMPOSER_STAGED_MEDIA_RELEASE_INTENTS_V1 } from '@happier-dev/protocol/sessions/userMessageRpc';
import { AgentIdV1Schema } from '@happier-dev/protocol/agents/agentIdV1';
import { InputHintsSchema as ActionInputHintsSchema } from '@happier-dev/protocol/inputs/inputFields';
import { ActionSafetySchema } from '@happier-dev/protocol/actions/safetyVocabulary';
import { ComposerAttachmentMessageAcceptedV1Schema, ComposerAttachmentResolveRequestV1Schema, ComposerAttachmentResolveResultV1Schema } from '@happier-dev/protocol/plugins/contributions/composerAttachmentRuntimeV1';
import { ComposerReferenceCandidateV1Schema, ComposerReferenceResolutionV1Schema } from '@happier-dev/protocol/plugins/contributions/composer-reference-providers';
import { ConnectedServicesProviderStateSharingPolicyV1Schema } from '@happier-dev/protocol/account/settings/connected-services';
import { ModelSelectionApplyPolicySchema } from '@happier-dev/protocol/providers/compatibility/v1';
import { ProviderRuntimeBindingBasisV1Schema, SessionProviderBindingMetadataV1Schema } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginActionAvailabilityV2Schema, PluginActionDefinitionExamplesV1Schema } from '@happier-dev/protocol/plugins/actions/v2';
import { PluginJsonSchemaV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import { PluginRuntimeCapabilityFamilyV1Schema } from '@happier-dev/protocol/plugins/runtime/api';
import { PluginSourceCustodyV1Schema } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { ProviderAgentTargetKeySchema, ProviderConnectionIdSchema, ProviderModelIdSchema } from '@happier-dev/protocol/providers/ids';
import { ProviderModelDescriptorV1Schema } from '@happier-dev/protocol/models/descriptor';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { PluginSourceKindV1Schema } from '@happier-dev/protocol/plugins/source-spec';
import { SessionIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';
import { HookEventEnvelopeV1Schema } from '@happier-dev/protocol/plugins/hooks/eventEnvelopeV1';
import { BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1 } from '@happier-dev/protocol/hooks/bridgeLifecycleHookCatalog';

/**
 * Private descriptor-only runner bootstrap carrier. It contains no bearer and
 * grants no daemon or Provider operation authority.
 */
export const HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE_ENV_KEY =
  'HAPPIER_AGENT_RUNTIME_RUNNER_BOOTSTRAP_FILE';

const BoundedIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));
const BoundedPathSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(32_768)));
const BoundedFeatureIdsSchema = lazyZodSchema(() => z.array(BoundedIdSchema).check(z.maxLength(256)));
const HostPluginContributionIdentityV1Schema = lazyZodSchema(() => asHostProtocolZod(
  PluginContributionIdentityV1Schema,
));

/**
 * Private runner↔daemon carrier for work that must stay request-local until
 * Session admission reports a known result. It is never transcript metadata.
 */
export const ComposerStagedMediaAdmissionSettlementV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  releaseIntents: z.array(ComposerStagedMediaReleaseIntentV1Schema).check(z.maxLength(MAX_COMPOSER_STAGED_MEDIA_RELEASE_INTENTS_V1)),
  createdWorkspaceRelativePaths: z.array(BoundedPathSchema).check(z.maxLength(64)),
  /**
   * The workspace the finalizer actually wrote `createdWorkspaceRelativePaths` into. It
   * travels with the receipt because the settlement outlives the tracked Session process:
   * a definitive admission failure that lands after teardown still has to delete exactly
   * the media this Message created, and by then no live Session can name its directory.
   */
  workingDirectory: BoundedPathSchema,
}));
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

export const AgentRuntimeDaemonTurnPayloadV1Schema = lazyZodSchema(() => z.record(
  z.string(),
  AgentRuntimeJsonValueV1Schema,
));

export const AgentRuntimeDaemonTurnContributionRequestV1Schema =
  lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('lifecycleHook'),
      event: asHostProtocolZod(HookEventEnvelopeV1Schema).check(z.refine(event =>
        event.category === 'lifecycle'
        && BRIDGE_LIFECYCLE_HOOK_EVENT_IDS_V1.some(id => id === event.eventId))),
    }),
    z.strictObject({
      kind: z.literal('prompt'),
      selectedAsset: z.optional(z.strictObject({
        pluginId: BoundedIdSchema,
        localId: BoundedIdSchema,
      })),
      machineId: z.optional(BoundedIdSchema),
      featureIds: z.optional(BoundedFeatureIdsSchema),
      excludePluginIds: z.optional(z.array(BoundedIdSchema).check(z.maxLength(128))),
    }),
    z.strictObject({
      kind: z.literal('composition'),
      runtimeFamily: z.enum(['hostSession', 'acpSession']),
      machineId: z.optional(BoundedIdSchema),
      featureIds: z.optional(BoundedFeatureIdsSchema),
    }),
    z.strictObject({
      kind: z.literal('composerReference'),
      reference: HostPluginContributionIdentityV1Schema,
      candidateId: ComposerReferenceCandidateV1Schema.shape.id,
    }),
    z.strictObject({
      kind: z.literal('composerAttachment'),
      attachment: HostPluginContributionIdentityV1Schema,
      request: ComposerAttachmentResolveRequestV1Schema,
    }),
    z.strictObject({
      kind: z.literal('composerAttachmentAccepted'),
      attachment: HostPluginContributionIdentityV1Schema,
      event: ComposerAttachmentMessageAcceptedV1Schema,
    }),
    z.strictObject({
      kind: z.literal('settleComposerStagedMedia'),
      outcome: z.enum(['accepted', 'definitiveFailure']),
      settlement: ComposerStagedMediaAdmissionSettlementV1Schema,
    }),
    z.strictObject({
      kind: z.literal('transformAgentContext'),
      payload: AgentRuntimeDaemonTurnPayloadV1Schema,
    }),
    z.strictObject({
      kind: z.literal('transformSessionInput'),
      payload: AgentRuntimeDaemonTurnPayloadV1Schema,
    }),
    z.strictObject({
      kind: z.literal('transformAgentRequest'),
      payload: AgentRuntimeDaemonTurnPayloadV1Schema,
    }),
  ]));

const AgentRuntimeDaemonPromptBlockV1Schema = lazyZodSchema(() => z.strictObject({
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
  text: z.string().check(z.minLength(1), z.maxLength(262_144)),
  enabled: z.optional(z.boolean()),
}));

const AgentRuntimeDaemonToolPromptContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: BoundedIdSchema,
  name: z.optional(z.nullable(z.string().check(z.maxLength(4_096)))),
  title: z.optional(z.nullable(z.string().check(z.maxLength(4_096)))),
  promptSnippet: z.optional(z.nullable(z.string().check(z.maxLength(262_144)))),
  promptGuidelines:
    z.optional(z.nullable(z.array(z.string().check(z.maxLength(262_144))).check(z.maxLength(256)))),
}));

const AgentRuntimeDaemonCompositionToolPromptContributionV1Schema =
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AgentRuntimeDaemonToolPromptContributionV1Schema, {
    pluginId: BoundedIdSchema,
  })));

/**
 * An immutable executable descriptor selected by the daemon for one Agent
 * turn. This is deliberately a turn payload, not a daemon catalog mirror:
 * it carries only the selected tool plus the canonical generation fence that
 * the daemon action owner will revalidate on execution.
 */
const AgentRuntimeDaemonCompositionToolBindingV1Schema = lazyZodSchema(() => z.strictObject({
  tool: z.strictObject({
    toolId: z.string().check(z.trim(), z.minLength(1), z.maxLength(1_024)),
    actionId: z.string().check(z.trim(), z.minLength(1), z.maxLength(1_024)),
    name: z.string().check(z.trim(), z.minLength(1), z.maxLength(4_096)),
    title: z.string().check(z.trim(), z.minLength(1), z.maxLength(4_096)),
    description: z.string().check(z.trim(), z.minLength(1), z.maxLength(4_096)),
    inputSchema: PluginJsonSchemaV2Schema,
    outputSchema: z.optional(PluginJsonSchemaV2Schema),
    inputHints: z.optional(ActionInputHintsSchema),
    safety: z.optional(ActionSafetySchema),
    examples: z.optional(PluginActionDefinitionExamplesV1Schema),
    promptSnippet: z.optional(z.string().check(z.trim(), z.minLength(1))),
    promptGuidelines: z.optional(z.array(z.string().check(z.trim(), z.minLength(1))).check(z.maxLength(256))),
    availability: z.optional(PluginActionAvailabilityV2Schema),
    surfaces: z.array(z.enum(['agent', 'mcp', 'cli'])).check(z.minLength(1), z.maxLength(3)),
  }),
  expectedContributorOccurrenceId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
}));

const AgentRuntimeDaemonCompositionInstructionV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: BoundedIdSchema,
  text: z.string().check(z.trim(), z.minLength(1), z.superRefine((value, context) => {
      if (new TextEncoder().encode(value).byteLength > 8 * 1024) {
        context.addIssue({
          code: "custom",
          message: 'Agent composition instruction must not exceed 8 KiB UTF-8',
        });
      }
    })),
}));

const AgentRuntimeDaemonCompositionInstructionsV1Schema = lazyZodSchema(() => z.array(
  AgentRuntimeDaemonCompositionInstructionV1Schema,
).check(z.maxLength(128), z.superRefine((instructions, context) => {
  const bytesByPluginId = new Map<string, number>();
  let aggregateBytes = 0;
  for (const instruction of instructions) {
    const bytes = new TextEncoder().encode(instruction.text).byteLength;
    const pluginBytes = (bytesByPluginId.get(instruction.pluginId) ?? 0) + bytes;
    bytesByPluginId.set(instruction.pluginId, pluginBytes);
    aggregateBytes += bytes;
    if (pluginBytes > 8 * 1024) {
      context.addIssue({
        code: "custom",
        message: 'Agent composition instructions exceed the per-plugin 8 KiB UTF-8 bound',
      });
    }
  }
  if (aggregateBytes > 32 * 1024) {
    context.addIssue({
      code: "custom",
      message: 'Agent composition instructions exceed the aggregate 32 KiB UTF-8 bound',
    });
  }
})));

export const AgentRuntimeDaemonTurnContributionsResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    kind: z.literal('lifecycleHook'),
    // Preserve the dispatcher's observer outcomes and ordered-list aggregate;
    // lifecycle observers do not carry an interception decision.
    result: z.strictObject({
      eventId: z.nullable(z.string()),
      matchedHandlerCount: z.number().check(z.int(), z.nonnegative()),
      outcomes: z.array(z.strictObject({
        pluginId: z.string(),
        localId: z.optional(z.string()),
        hookId: z.string(),
        status: z.enum(['fulfilled', 'rejected']),
        result: z.optional(z.unknown()),
        error: z.optional(z.string()),
      })),
      validationError: z.optional(z.string()),
      aggregate: z.optional(z.pipe(z.strictObject({ executionKind: z.string(), result: z.unknown() }), z.transform(value => ({ executionKind: value.executionKind, result: value.result })))),
    }),
  }),
  z.strictObject({
    kind: z.literal('prompt'),
    optionalPromptAssetsUnavailable: z.optional(z.boolean()),
    promptAssetBlocks:
      z.array(AgentRuntimeDaemonPromptBlockV1Schema).check(z.maxLength(256)),
    toolPromptContributions: z.array(
      AgentRuntimeDaemonToolPromptContributionV1Schema,
    ).check(z.maxLength(256)),
  }),
  z.strictObject({
    kind: z.literal('composition'),
    /** Only plugins whose valid composition result is consumed for this turn. */
    managedPluginIds: z.array(BoundedIdSchema).check(z.maxLength(128)),
    /** Exact executable tools admitted for those composition-managed plugins. */
    selectedTools: z.array(HostPluginContributionIdentityV1Schema).check(z.maxLength(128)),
    /** Immutable descriptor + generation binding for each selected MCP tool. */
    selectedToolBindings: z.array(AgentRuntimeDaemonCompositionToolBindingV1Schema).check(z.maxLength(128)),
    promptAssetBlocks:
      z.array(AgentRuntimeDaemonPromptBlockV1Schema).check(z.maxLength(128)),
    toolPromptContributions: z.array(
      AgentRuntimeDaemonCompositionToolPromptContributionV1Schema,
    ).check(z.maxLength(128)),
    additionalInstructions: AgentRuntimeDaemonCompositionInstructionsV1Schema,
  }).check(z.superRefine((value, context) => {
    const managedPluginIds = new Set(value.managedPluginIds);
    const selectedToolIds = new Set(value.selectedTools.map(
      (tool) => `${tool.pluginId}/${tool.localId}`,
    ));
    const boundToolIds = new Set<string>();
    for (const tool of value.selectedTools) {
      if (!managedPluginIds.has(tool.pluginId)) {
        context.addIssue({
          code: "custom",
          message: 'Agent composition selected tool belongs to an unmanaged plugin',
        });
      }
    }
    for (const [index, binding] of value.selectedToolBindings.entries()) {
      const separatorIndex = binding.tool.toolId.indexOf('/');
      const pluginId = separatorIndex > 0 ? binding.tool.toolId.slice(0, separatorIndex) : null;
      if (pluginId === null || !managedPluginIds.has(pluginId)) {
        context.addIssue({
          code: "custom",
          path: ['selectedToolBindings', index, 'tool', 'toolId'],
          message: 'Agent composition selected tool binding belongs to an unmanaged plugin',
        });
      }
      if (!selectedToolIds.has(binding.tool.toolId)) {
        context.addIssue({
          code: "custom",
          path: ['selectedToolBindings', index, 'tool', 'toolId'],
          message: 'Agent composition selected tool binding is not an admitted selected tool',
        });
      }
      if (!binding.tool.surfaces.includes('agent')) {
        context.addIssue({
          code: "custom",
          path: ['selectedToolBindings', index, 'tool', 'surfaces'],
          message: 'Agent composition selected tool binding is not available on the Agent surface',
        });
      }
      if (boundToolIds.has(binding.tool.toolId)) {
        context.addIssue({
          code: "custom",
          path: ['selectedToolBindings', index, 'tool', 'toolId'],
          message: 'Agent composition selected tool binding is duplicated',
        });
      }
      boundToolIds.add(binding.tool.toolId);
    }
    for (const toolId of selectedToolIds) {
      if (boundToolIds.has(toolId)) continue;
      context.addIssue({
        code: "custom",
        path: ['selectedToolBindings'],
        message: 'Agent composition selected tool is missing its immutable generation binding',
      });
    }
  })),
  z.strictObject({
    kind: z.literal('composerReference'),
    resolution: ComposerReferenceResolutionV1Schema,
  }),
  z.strictObject({
    kind: z.literal('composerAttachment'),
    result: ComposerAttachmentResolveResultV1Schema,
  }),
  z.strictObject({
    kind: z.literal('composerAttachmentAccepted'),
  }),
  z.strictObject({
    kind: z.literal('settleComposerStagedMedia'),
  }),
  z.strictObject({
    kind: z.literal('transformAgentContext'),
    payload: AgentRuntimeDaemonTurnPayloadV1Schema,
  }),
  z.strictObject({
    kind: z.literal('transformSessionInput'),
    payload: AgentRuntimeDaemonTurnPayloadV1Schema,
  }),
  z.strictObject({
    kind: z.literal('transformAgentRequest'),
    payload: AgentRuntimeDaemonTurnPayloadV1Schema,
  }),
]).check(z.superRefine((value, context) => {
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
})));

export type AgentRuntimeDaemonTurnContributionsResultV1 =
  z.infer<typeof AgentRuntimeDaemonTurnContributionsResultV1Schema>;

export const AgentRuntimeDaemonSessionDescriptorV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  pluginId: BoundedIdSchema,
  pluginVersion: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  /** Canonical host routing id (`resolveContributedAgentRoutingId`). */
  agentId: AgentIdV1Schema,
  // The runner currently carries the same canonical host routing identity in
  // both fields. Keep the Agent identity's 513-byte envelope here rather than
  // applying the narrower generic backend-local bound to a qualified external
  // Agent id.
  backendId: AgentIdV1Schema,
  occurrenceId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  sourceCustody: PluginSourceCustodyV1Schema,
  /**
   * Exact Agent declaration selected by the daemon. The
   * runner re-verifies this fact against its retained direct binding before
   * runtime construction; the descriptor itself grants no authority.
   */
  agentDeclaration: z.optional(z.strictObject({
    provenance: z.enum(['first_party', 'external']),
    source: z.strictObject({
      kind: PluginSourceKindV1Schema,
    }),
    definition: PluginAgentContributionV2Schema,
  })),
  runtimeAuthority: z.optional(z.strictObject({
    runtimeCapabilities:
      z.array(PluginRuntimeCapabilityFamilyV1Schema).check(z.maxLength(256), z.refine((values) => new Set(values).size === values.length)),
  })),
}));

export type AgentRuntimeDaemonSessionDescriptorV1 =
  z.infer<typeof AgentRuntimeDaemonSessionDescriptorV1Schema>;

/** Private launch inputs, separate from Agent identity and daemon operation authority. */
export const AgentRuntimeRunnerBootstrapV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  descriptor: AgentRuntimeDaemonSessionDescriptorV1Schema,
  launch: z.optional(z.strictObject({
    runtimeDescriptorV1: RuntimeDescriptorV1Schema,
    terminalHostOwner: z.optional(z.enum(['startup', 'runtime'])),
    sessionConnectedAccounts: z.optional(AgentSessionConnectedAccountsV1Schema),
  })),
}));

export type AgentRuntimeRunnerBootstrapLaunchV1 =
  NonNullable<z.infer<typeof AgentRuntimeRunnerBootstrapV1Schema>['launch']>;

export const AgentRuntimeDaemonProviderConnectionModelRefV1Schema =
  lazyZodSchema(() => z.strictObject({
    agentTargetKey: ProviderAgentTargetKeySchema,
    providerConnectionId: ProviderConnectionIdSchema,
    modelId: ProviderModelIdSchema,
  }));

export const AgentRuntimeDaemonModelTransitionAuthorizationResultV1Schema =
  lazyZodSchema(() => z.strictObject({
    selection: AgentRuntimeDaemonProviderConnectionModelRefV1Schema,
    policy: ModelSelectionApplyPolicySchema,
    model: ProviderModelDescriptorV1Schema,
    sessionBindingMetadata: SessionProviderBindingMetadataV1Schema,
    runtimeBindingBasis: ProviderRuntimeBindingBasisV1Schema,
  }));

export type AgentRuntimeDaemonModelTransitionAuthorizationResultV1 =
  z.infer<
    typeof AgentRuntimeDaemonModelTransitionAuthorizationResultV1Schema
  >;

const McpLaunchConfigSchema = lazyZodSchema(() => z.strictObject({
  command: BoundedPathSchema,
  enabledTools: z.optional(z.array(z.string())),
  args: z.optional(z.array(z.string().check(z.maxLength(32_768))).check(z.maxLength(1_024))),
  env: z.optional(z.record(
    z.string().check(z.maxLength(256)),
    z.string().check(z.maxLength(262_144)),
  )),
}));

const ConnectedAccountSchema = lazyZodSchema(() => z.strictObject({
  purpose: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  usageAccountScope: z.optional(z.enum(['personal', 'workspace', 'unknown'])),
  account: z.strictObject({
    service: z.strictObject({
      pluginId: BoundedIdSchema,
      localId: BoundedIdSchema,
    }),
    accountId: BoundedIdSchema,
  }),
}));

export const AgentSessionConnectedAccountsV1Schema = lazyZodSchema(() =>
  z.array(ConnectedAccountSchema).check(z.maxLength(256)));

const AgentSessionOpenBaseSchema = lazyZodSchema(() => z.object({
  sessionId: asHostProtocolZod(SessionIdSchema),
  cwd: BoundedPathSchema,
  sessionDirectoryKind: z.optional(z.enum(['path', 'managed'])),
  launchEnvironment: z.optional(AgentLaunchEnvironmentV1Schema),
  runtimeDescriptorV1: z.optional(RuntimeDescriptorV1Schema),
  configuration: z.optional(AgentSessionConfigurationSnapshotV1Schema),
  idleCompaction: z.optional(AgentSessionIdleCompactionPreferenceV1Schema),
  connectedAccounts: z.optional(AgentSessionConnectedAccountsV1Schema),
  mcpServers:
    z.optional(z.record(BoundedIdSchema, McpLaunchConfigSchema)),
  mcpToolPolicy: z.optional(McpToolLaunchPoliciesV1Schema),
  mcpServersStrictMode: z.optional(z.boolean()),
  providerBinding: z.optional(AgentSessionProviderBindingV1Schema),
  stateSharing: z.optional(ConnectedServicesProviderStateSharingPolicyV1Schema),
}));

export const AgentRuntimeDaemonSessionOpenRequestV1Schema =
  lazyZodSchema(() => {
    const requestBase = z.extend(AgentSessionOpenBaseSchema, {
      skills: z.optional(AgentSessionSkillDeliveryV1Schema),
    });
    return z.discriminatedUnion('kind', [
      (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(requestBase, {
        kind: z.literal('create'),
        startupInstructions:
          z.optional(AgentSessionStartupInstructionsV1Schema),
      })),
      (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(requestBase, {
        kind: z.literal('resume'),
        providerSessionId: BoundedIdSchema,
        strictNativeResumeIdentity: z.optional(z.literal(true)),
        startupInstructions:
          z.optional(AgentSessionStartupInstructionsV1Schema),
      })),
      (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(requestBase, {
        kind: z.literal('fork'),
        source: z.strictObject({
          sessionId: asHostProtocolZod(SessionIdSchema),
          providerSessionId: BoundedIdSchema,
          cwd: BoundedPathSchema,
          target: z.optional(z.strictObject({
            turnId: BoundedIdSchema,
            providerCheckpoint: AgentSessionProviderCheckpointV1Schema,
          })),
        }),
      })),
    ]);
  });

/**
 * Durable runner-open evidence deliberately excludes transient skill delivery,
 * startup text and native-resume identity. The marker owns the retained identity; the
 * provider receives those facts only during the one open attempt.
 */
export const AgentRuntimeDaemonSessionOpenAttestationRequestV1Schema =
  lazyZodSchema(() => z.discriminatedUnion('kind', [
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AgentSessionOpenBaseSchema, {
      kind: z.literal('create'),
    })),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AgentSessionOpenBaseSchema, {
      kind: z.literal('resume'),
      providerSessionId: BoundedIdSchema,
    })),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AgentSessionOpenBaseSchema, {
      kind: z.literal('fork'),
      source: z.strictObject({
        sessionId: asHostProtocolZod(SessionIdSchema),
        providerSessionId: BoundedIdSchema,
        cwd: BoundedPathSchema,
        target: z.optional(z.strictObject({
          turnId: BoundedIdSchema,
          providerCheckpoint: AgentSessionProviderCheckpointV1Schema,
        })),
      }),
    })),
  ]));

export type AgentRuntimeDaemonSessionOpenAttestationRequestV1 = z.infer<
  typeof AgentRuntimeDaemonSessionOpenAttestationRequestV1Schema
>;

export function projectAgentRuntimeDaemonSessionOpenAttestationRequestV1(
  request: unknown,
): AgentRuntimeDaemonSessionOpenAttestationRequestV1 {
  const { skills: _skills, ...parsed } =
    AgentRuntimeDaemonSessionOpenRequestV1Schema.parse(request);
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
