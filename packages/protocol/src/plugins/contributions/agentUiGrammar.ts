import { z } from 'zod';

/**
 * The PUBLIC Agent UI authoring grammar (`contributes.agents[].ui`).
 *
 * One grammar serves first- and third-party Agents. The client owns the single
 * fail-closed interpreter that turns a declaration into behavior; this module
 * owns the declaration LANGUAGE, so an author learns one vocabulary and a
 * malformed literal is refused where it is written instead of silently
 * no-opping at render time.
 *
 * It deliberately admits exactly what an installed Agent can actually reach:
 *
 * - Rich, arbitrary UI is authored through the public TARGETED SURFACES, not
 *   here. This block is declarative facts and host-owned controls only.
 * - `components.slots[]` admits host-owned controls and exact semantic inline
 *   surface roles. `componentId` remains absent: it names code compiled into
 *   the app, while `surfaceId` names the declaring plugin's ordinary
 *   daemon-admitted UI view and therefore works identically for installed and
 *   bundled Agents.
 * - `payload.spawnSessionExtras` admits only the `static` form, and
 *   `message.metaDescriptorIds` is absent, for the same reason: the interpreter
 *   answers both compiled-adapter forms with a refusal diagnostic, so a loose
 *   grammar that accepts them only teaches authors a shape that cannot work.
 *
 * Host-owned identifiers an Agent may reference — account setting keys,
 * translation keys, icon names — stay strings here. They are validated by the
 * owner that knows them (the client interpreter), and restating their closed
 * sets in the wire schema would create a second decision-maker for them.
 */

const AgentUiIdSchema = z.string().trim().min(1);
const AgentUiIdArraySchema = z.array(AgentUiIdSchema);
const AgentUiStringRecordSchema = z.record(z.string(), z.string());

/** A host account-setting key the Agent's declaration reads. */
const AgentUiSettingKeySchema = AgentUiIdSchema;
/** A translation key resolved by the host's own catalogue. */
const AgentUiTranslationKeySchema = AgentUiIdSchema;

export type AgentUiConditionV1 =
  | { kind: 'experimentsEnabled' }
  | { kind: 'settingEquals'; settingKey: string; value: string; aliases?: Record<string, string> }
  | { kind: 'settingTrue'; settingKey: string }
  | { all: AgentUiConditionV1[] }
  | { any: AgentUiConditionV1[] };

/** When a declared capability applies, evaluated against host account settings. */
export const AgentUiConditionV1Schema: z.ZodType<AgentUiConditionV1, AgentUiConditionV1> = z.lazy(() => z.union([
  z.object({ kind: z.literal('experimentsEnabled') }).strict(),
  z.object({
    kind: z.literal('settingEquals'),
    settingKey: AgentUiSettingKeySchema,
    value: z.string(),
    aliases: AgentUiStringRecordSchema.optional(),
  }).strict(),
  z.object({ kind: z.literal('settingTrue'), settingKey: AgentUiSettingKeySchema }).strict(),
  z.object({ all: z.array(AgentUiConditionV1Schema) }).strict(),
  z.object({ any: z.array(AgentUiConditionV1Schema) }).strict(),
]));

const AgentUiTranscriptStorageModeSchema = z.enum(['persisted', 'direct']);

/**
 * The schema identity of an Agent's `runtimeDescriptorV1.agentExtra` block.
 *
 * `payload.backendTransport` declares the runtime-handle fields once, on the
 * transport itself, and the interpreter reuses them for the extra — so there
 * the extra is the identity alone. The environment-variable and link-extras
 * descriptors have no such sibling and read the fields off the extra, so they
 * extend this with the required list below.
 */
const AgentUiRuntimeDescriptorAgentExtraIdentityShape = {
  owner: AgentUiIdSchema,
  schemaId: AgentUiIdSchema,
  v: z.number().int(),
} as const;

const AgentUiRuntimeDescriptorAgentExtraIdentitySchema = z.object(
  AgentUiRuntimeDescriptorAgentExtraIdentityShape,
).strict();

const AgentUiRuntimeDescriptorAgentExtraSchema = z.object({
  ...AgentUiRuntimeDescriptorAgentExtraIdentityShape,
  runtimeHandleFields: AgentUiIdArraySchema,
}).strict();

const AgentUiExternalSessionsSourceSchema = z.object({ kind: AgentUiIdSchema })
  .catchall(z.unknown());

/* -------------------------------------------------------------------------- */
/* behavior                                                                    */
/* -------------------------------------------------------------------------- */

const AgentUiPermissionFooterSchema = z.object({
  usePermissionUpdates: z.boolean().optional(),
  forceReadOnlyAfterStop: z.boolean().optional(),
  supportsExecPolicyAmendment: z.boolean().optional(),
  stopHandling: z.enum(['denyOnly', 'denyAndAbortRun']).optional(),
}).strict();

/**
 * Which permission-prompt conversation this Agent speaks.
 *
 * It selects the footer's whole semantic action model — button set, handlers
 * and terminal-decision reading — not just its wording, so an Agent that
 * answers Codex-style decisions cannot reach the right controls without
 * declaring it. Absent means the neutral Claude-shaped default, which is what
 * an Agent that declares nothing has always received.
 */
const AgentUiPermissionPromptProtocolSchema = z.enum(['claude', 'codexDecision']);

const AgentUiEditableGoalsSchema = z.object({
  capabilityDriven: z.boolean().optional(),
  modeValues: AgentUiIdArraySchema.optional(),
  activeModeValues: AgentUiIdArraySchema.optional(),
  activeWhenNoPersistedMode: z.boolean().optional(),
  persistedGoalSnapshot: z.object({
    path: AgentUiIdArraySchema.optional(),
    itemKind: AgentUiIdSchema.optional(),
    providerFields: AgentUiIdArraySchema.optional(),
  }).strict().optional(),
}).strict();

const AgentUiContextWindowSchema = z.object({
  defaultTokens: z.number().int().positive().optional(),
  modelRules: z.array(z.object({
    idSuffix: AgentUiIdSchema.optional(),
    descriptionIncludesAny: AgentUiIdArraySchema.optional(),
    tokens: z.number().int().positive().optional(),
  }).strict()).optional(),
  observedUsageBumpTokens: z.array(z.number().int().positive()).optional(),
  trustObservedUsageBeyondKnown: z.boolean().optional(),
}).strict();

/**
 * Composer-owned new-session option state an Agent understands. The host owns
 * the option store, the control that edits it, and the spawn envelope; the
 * Agent declares which keys exist and which travel to the daemon as session
 * config options.
 */
const AgentUiNewSessionOptionSchema = z.object({
  key: AgentUiIdSchema,
  kind: z.literal('boolean'),
  spawnConfigOption: z.boolean().optional(),
}).strict();

const AgentUiNewSessionSchema = z.object({
  relevantInstallableDepKeys: AgentUiIdArraySchema.optional(),
  relevantInstallableDeps: z.array(z.object({
    keys: AgentUiIdArraySchema.optional(),
    when: AgentUiConditionV1Schema.optional(),
  }).strict()).optional(),
  transcriptStorageModes: z.array(AgentUiTranscriptStorageModeSchema).optional(),
  transcriptStorageModesByBackendMode: z.record(
    z.string(),
    z.array(AgentUiTranscriptStorageModeSchema),
  ).optional(),
  canSelectWithoutDetectedCli: z.boolean().optional(),
  agentOptions: z.array(AgentUiNewSessionOptionSchema).optional(),
}).strict();

const AgentUiEnvironmentVariablesSchema = z.object({
  backendMode: z.object({
    envKey: AgentUiIdSchema,
    settingKey: AgentUiSettingKeySchema,
    legacyMetadataKey: AgentUiIdSchema,
    runtimeDescriptorField: AgentUiIdSchema,
    defaultValue: AgentUiIdSchema,
    values: AgentUiIdArraySchema.min(1),
  }).strict(),
  serverBaseUrl: z.object({
    envKey: AgentUiIdSchema,
    explicitEnvKey: AgentUiIdSchema,
    settingKey: AgentUiSettingKeySchema,
    byServerIdSettingKey: AgentUiSettingKeySchema,
    legacyMetadataKey: AgentUiIdSchema,
    legacyExplicitMetadataKey: AgentUiIdSchema,
    runtimeDescriptorField: AgentUiIdSchema,
    runtimeDescriptorExplicitField: AgentUiIdSchema,
    allowedProtocols: AgentUiIdArraySchema.optional(),
    rejectCredentials: z.boolean().optional(),
    originOnly: z.boolean().optional(),
  }).strict().optional(),
  agentExtra: AgentUiRuntimeDescriptorAgentExtraSchema.optional(),
}).strict();

const AgentUiBackendTransportSchema = z.object({
  runtimeDescriptorOutputKey: AgentUiIdSchema.optional(),
  legacyModeOutputKey: AgentUiIdSchema.optional(),
  backendMode: z.object({
    values: AgentUiIdArraySchema.min(1),
    aliases: AgentUiStringRecordSchema.optional(),
    legacyExperimentalValue: AgentUiIdSchema.optional(),
  }).strict(),
  runtimeHandleFields: AgentUiIdArraySchema.min(1),
  agentExtra: AgentUiRuntimeDescriptorAgentExtraIdentitySchema.optional(),
}).strict();

const AgentUiPayloadSchema = z.object({
  /**
   * A fixed spawn envelope contribution. The compiled-adapter form
   * (`{ kind: 'adapter' }`) is deliberately not part of the public grammar.
   */
  spawnSessionExtras: z.object({
    kind: z.literal('static'),
    value: z.record(z.string(), z.unknown()),
  }).strict().optional(),
  /**
   * A backend-mode fact this Agent contributes to the spawn/resume envelope.
   *
   * The mode is read from the account setting named here and, for an existing
   * Session, from the canonical `runtimeDescriptorV1` envelope carrying this
   * Agent's id — both facts an installed Agent can occupy, so the block is not
   * a bundled-only capability.
   */
  sessionExtras: z.object({
    outputKey: AgentUiIdSchema,
    values: AgentUiIdArraySchema.min(1),
    settingKey: AgentUiSettingKeySchema.optional(),
    aliases: AgentUiStringRecordSchema.optional(),
    defaultValue: AgentUiIdSchema.optional(),
  }).strict().optional(),
  environmentVariables: AgentUiEnvironmentVariablesSchema.optional(),
  backendTransport: AgentUiBackendTransportSchema.optional(),
}).strict();

const AgentUiRuntimeDescriptorLinkExtrasSchema = z.object({
  runtimeDescriptorOutputKey: AgentUiIdSchema.optional(),
  legacyModeOutputKey: AgentUiIdSchema.optional(),
  backendMode: z.object({ values: AgentUiIdArraySchema.min(1) }).strict(),
  sourceFields: AgentUiIdArraySchema,
  agentExtra: AgentUiRuntimeDescriptorAgentExtraSchema.optional(),
}).strict();

const AgentUiExternalSessionsBrowseSchema = z.object({
  order: z.number().int().optional(),
  sourceOptions: z.array(z.object({
    key: AgentUiIdSchema,
    labelKey: AgentUiTranslationKeySchema,
    labelParams: AgentUiStringRecordSchema.optional(),
    detail: AgentUiIdSchema.optional(),
    source: AgentUiExternalSessionsSourceSchema,
  }).strict()).optional(),
  connectedServiceProfileSources: z.array(z.object({
    serviceId: AgentUiIdSchema,
    keyPrefix: AgentUiIdSchema,
    labelKey: AgentUiTranslationKeySchema,
    labelParams: AgentUiStringRecordSchema.optional(),
    detailSettingsKey: AgentUiSettingKeySchema.optional(),
    source: AgentUiExternalSessionsSourceSchema,
    serviceIdField: AgentUiIdSchema,
    profileIdField: AgentUiIdSchema,
  }).strict()).optional(),
  lockedConnectedServiceSource: z.object({
    serviceId: AgentUiIdSchema,
    keyPrefix: AgentUiIdSchema,
    source: AgentUiExternalSessionsSourceSchema,
    serviceIdField: AgentUiIdSchema,
    profileIdField: AgentUiIdSchema,
    groupIdField: AgentUiIdSchema,
  }).strict().optional(),
  compatibleSource: z.object({
    sourceKind: AgentUiIdSchema,
    optionalFields: AgentUiIdArraySchema,
  }).strict().optional(),
  linkEnsureRequestExtras: z.object({
    sourceFromCandidate: z.object({
      sourceKind: AgentUiIdSchema,
      optionalFields: AgentUiIdArraySchema,
    }).strict().optional(),
    runtimeDescriptorFromCandidate: AgentUiRuntimeDescriptorLinkExtrasSchema.optional(),
  }).strict().optional(),
}).strict();

const AgentUiExternalSessionsSchema = z.object({
  browse: AgentUiExternalSessionsBrowseSchema.optional(),
  sessionHandoff: z.object({
    clearMetadataKeys: AgentUiIdArraySchema.optional(),
  }).strict().optional(),
}).strict();

export const AgentUiBehaviorDeclarationV1Schema = z.object({
  /** Author-owned identity for this declaration, surfaced in diagnostics. */
  descriptorId: AgentUiIdSchema.optional(),
  attachedSessionTerminal: z.object({ supported: z.boolean().optional() }).strict().optional(),
  pendingDelivery: z.object({
    custodyLabelKey: AgentUiTranslationKeySchema.optional(),
    interruptAndRun: z.boolean().optional(),
  }).strict().optional(),
  guidance: z.object({
    includeInSessionGettingStartedCliExamples: z.boolean().optional(),
  }).strict().optional(),
  permissions: z.object({
    promptProtocol: AgentUiPermissionPromptProtocolSchema.optional(),
    footer: AgentUiPermissionFooterSchema.optional(),
  }).strict().optional(),
  workState: z.object({ editableGoals: AgentUiEditableGoalsSchema.optional() }).strict().optional(),
  resume: z.object({
    experimentSwitches: z.array(z.object({
      id: AgentUiIdSchema,
      settingKey: AgentUiSettingKeySchema.optional(),
      when: AgentUiConditionV1Schema.optional(),
    }).strict()).optional(),
  }).strict().optional(),
  sessionComposer: z.object({
    nonSteerableWhileBusy: z.object({
      reason: z.literal('provider_config_change_refused').optional(),
      metaKeys: AgentUiIdArraySchema.optional(),
      sessionConfigOptionIds: AgentUiIdArraySchema.optional(),
      freshModelOverride: z.boolean().optional(),
    }).strict().optional(),
  }).strict().optional(),
  contextWindow: AgentUiContextWindowSchema.optional(),
  newSession: AgentUiNewSessionSchema.optional(),
  payload: AgentUiPayloadSchema.optional(),
  externalSessions: AgentUiExternalSessionsSchema.optional(),
}).strict();
export type AgentUiBehaviorDeclarationV1 = z.infer<typeof AgentUiBehaviorDeclarationV1Schema>;

/* -------------------------------------------------------------------------- */
/* message                                                                     */
/* -------------------------------------------------------------------------- */

export const AgentUiMessageDeclarationV1Schema = z.object({
  /**
   * Outbound message metadata this Agent derives from a session config option
   * the user chose. `metaDescriptorIds` — the compiled-adapter form — is not
   * part of the public grammar.
   */
  metaOverrides: z.array(z.object({
    id: AgentUiIdSchema,
    targetKey: AgentUiIdSchema,
    value: z.object({
      kind: z.literal('sessionConfigOptionOverride'),
      key: AgentUiIdSchema,
      aliases: AgentUiIdArraySchema.optional(),
    }).strict(),
    normalize: z.literal('trimLowercase').optional(),
  }).strict()).optional(),
}).strict();
export type AgentUiMessageDeclarationV1 = z.infer<typeof AgentUiMessageDeclarationV1Schema>;

/* -------------------------------------------------------------------------- */
/* components                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Host-owned controls and public inline surfaces an Agent may place in a named
 * slot.
 *
 * The Agent declares what the control edits and what it is called; the host
 * owns the control itself. That is what keeps the slot language the same for a
 * bundled and an installed Agent.
 *
 * A boolean-option `chip` selects the host-owned control. Session-subagent
 * slots instead name a `surfaceId` from the same plugin and provide only the
 * host-owned placement/resource metadata needed to mount that ordinary public
 * UI view. `componentId` remains absent because it names code compiled into the
 * app rather than a public plugin contribution.
 */
const AgentUiBooleanOptionComponentSlotSchema = z.object({
  id: AgentUiIdSchema,
  slot: AgentUiIdSchema,
  chip: z.object({
    kind: z.literal('booleanOption'),
    optionStateKey: AgentUiIdSchema,
    iconName: AgentUiIdSchema,
    onLabelKey: AgentUiTranslationKeySchema,
    offLabelKey: AgentUiTranslationKeySchema,
  }).strict(),
}).strict();

const AgentUiSubagentLaunchComponentSlotSchema = z.object({
  id: AgentUiIdSchema,
  slot: z.literal('sessionSubagents.launchCards'),
  surfaceId: AgentUiIdSchema,
  props: z.object({
    teamIds: z.object({
      kind: z.literal('subagentGroupKeys'),
      subagentKinds: AgentUiIdArraySchema.optional(),
    }).strict().optional(),
  }).strict().optional(),
}).strict();

const AgentUiSubagentDetailsComponentSlotSchema = z.object({
  id: AgentUiIdSchema,
  slot: z.literal('sessionSubagents.teammateDetailsTab'),
  surfaceId: AgentUiIdSchema,
  resourceKind: AgentUiIdSchema,
  iconName: AgentUiIdSchema,
  tab: z.object({
    keyPrefix: AgentUiIdSchema,
    titleKey: AgentUiTranslationKeySchema,
    subtitleKey: AgentUiTranslationKeySchema.optional(),
  }).strict(),
}).strict();

const AgentUiComponentSlotSchema = z.union([
  AgentUiBooleanOptionComponentSlotSchema,
  AgentUiSubagentLaunchComponentSlotSchema,
  AgentUiSubagentDetailsComponentSlotSchema,
]);

export const AgentUiComponentsDeclarationV1Schema = z.object({
  slots: z.array(AgentUiComponentSlotSchema).optional(),
}).strict();
export type AgentUiComponentsDeclarationV1 = z.infer<typeof AgentUiComponentsDeclarationV1Schema>;

/* -------------------------------------------------------------------------- */
/* projected carrier                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The SAME three declaration slots as they travel in the daemon contribution
 * registry projection, carried structurally rather than re-validated.
 *
 * The strict grammar above is the AUTHORING contract: it refuses a malformed
 * declaration where the author writes it, which is the only place a refusal can
 * teach anyone anything. Re-applying it here would make an unrecognised field —
 * a newer plugin's declaration reaching an older client, or one typo in a
 * trusted plugin — reject the whole projected Agent and remove it from the
 * catalog. The client's single fail-closed interpreter already answers an
 * unreadable field with a per-field diagnostic and the neutral default, which
 * is the correct blast radius. This is transport, not a second grammar owner.
 */
export const AgentUiProjectedDeclarationV1Schema = z.object({
  behavior: z.record(z.string(), z.unknown()).optional(),
  message: z.record(z.string(), z.unknown()).optional(),
  components: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type AgentUiProjectedDeclarationV1 = z.infer<typeof AgentUiProjectedDeclarationV1Schema>;
