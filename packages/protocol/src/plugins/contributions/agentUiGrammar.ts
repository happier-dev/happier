import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { SpawnConfigOptionValueSchema } from '../../actions/sessionSpawnConfigOptions.js';

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
 * - `session` admits the two inline data descriptors the shared client really
 *   interprets. Compiled descriptor/callback ids are absent; bundled and
 *   installed Agents author the same portable facts.
 *
 * Host-owned identifiers an Agent may reference — host setting keys,
 * translation keys, icon names — stay strings here. They are validated by the
 * owner that knows them (the client interpreter), and restating their closed
 * sets in the wire schema would create a second decision-maker for them.
 */

const AgentUiIdSchema = lazyZodSchema(() => z.string().trim().min(1));
const AgentUiIdArraySchema = lazyZodSchema(() => z.array(AgentUiIdSchema));
const AgentUiStringRecordSchema = lazyZodSchema(() => z.record(z.string(), z.string()));

/**
 * A setting reference is always qualified by its owner scope. `host` is the
 * incumbent host Account preference namespace; `account` and `daemon` are the
 * declaring plugin's scoped Settings contributions. Bare local IDs are not a
 * supported compatibility form.
 */
const AgentUiSettingReferenceSchema = lazyZodSchema(() => z.object({
  scope: z.enum(['host', 'account', 'daemon']),
  localId: AgentUiIdSchema,
}).strict());
export type AgentUiSettingReferenceV1 = z.infer<typeof AgentUiSettingReferenceSchema>;
const AgentUiMutablePluginSettingReferenceSchema = lazyZodSchema(() => z.object({
  scope: z.enum(['account', 'daemon']),
  localId: AgentUiIdSchema,
}).strict());
/** A translation key resolved by the host's own catalogue. */
const AgentUiTranslationKeySchema = AgentUiIdSchema;

export type AgentUiConditionV1 =
  | { kind: 'experimentsEnabled' }
  | { kind: 'settingEquals'; settingKey: AgentUiSettingReferenceV1; value: string; aliases?: Record<string, string> }
  | { kind: 'settingTrue'; settingKey: AgentUiSettingReferenceV1 }
  | { all: AgentUiConditionV1[] }
  | { any: AgentUiConditionV1[] };

/** When a declared capability applies, evaluated against host account settings. */
export const AgentUiConditionV1Schema: z.ZodType<AgentUiConditionV1, AgentUiConditionV1> = z.lazy(() => z.union([
  z.object({ kind: z.literal('experimentsEnabled') }).strict(),
  z.object({
    kind: z.literal('settingEquals'),
    settingKey: AgentUiSettingReferenceSchema,
    value: z.string(),
    aliases: AgentUiStringRecordSchema.optional(),
  }).strict(),
  z.object({ kind: z.literal('settingTrue'), settingKey: AgentUiSettingReferenceSchema }).strict(),
  z.object({ all: z.array(AgentUiConditionV1Schema) }).strict(),
  z.object({ any: z.array(AgentUiConditionV1Schema) }).strict(),
]));

const AgentUiTranscriptStorageModeSchema = lazyZodSchema(() => z.enum(['persisted', 'direct']));

const AgentUiExternalSessionsSourceSchema = lazyZodSchema(() => z.object({ kind: AgentUiIdSchema })
  .catchall(z.unknown()));

/* -------------------------------------------------------------------------- */
/* behavior                                                                    */
/* -------------------------------------------------------------------------- */

const AgentUiPermissionFooterSchema = lazyZodSchema(() => z.object({
  usePermissionUpdates: z.boolean().optional(),
  forceReadOnlyAfterStop: z.boolean().optional(),
  supportsExecPolicyAmendment: z.boolean().optional(),
  stopHandling: z.enum(['denyOnly', 'denyAndAbortRun']).optional(),
}).strict());

/**
 * Which permission-prompt conversation this Agent speaks.
 *
 * It selects the footer's whole semantic action model — button set, handlers
 * and terminal-decision reading — not just its wording, so an Agent that
 * answers Codex-style decisions cannot reach the right controls without
 * declaring it. Absent means the neutral Claude-shaped default, which is what
 * an Agent that declares nothing has always received.
 */
const AgentUiPermissionPromptProtocolSchema = lazyZodSchema(() => z.enum(['claude', 'codexDecision']));

const AgentUiEditableGoalsSchema = lazyZodSchema(() => z.object({
  capabilityDriven: z.boolean().optional(),
  activeWhenNoPersistedMode: z.boolean().optional(),
  persistedGoalSnapshot: z.object({
    path: AgentUiIdArraySchema.optional(),
    itemKind: AgentUiIdSchema.optional(),
    providerFields: AgentUiIdArraySchema.optional(),
  }).strict().optional(),
}).strict());

const AgentUiContextWindowSchema = lazyZodSchema(() => z.object({
  defaultTokens: z.number().int().positive().optional(),
  modelRules: z.array(z.object({
    idSuffix: AgentUiIdSchema.optional(),
    descriptionIncludesAny: AgentUiIdArraySchema.optional(),
    tokens: z.number().int().positive().optional(),
  }).strict()).optional(),
  observedUsageBumpTokens: z.array(z.number().int().positive()).optional(),
  trustObservedUsageBeyondKnown: z.boolean().optional(),
}).strict());

/**
 * Composer-owned new-session option state an Agent understands. The host owns
 * the option store, the control that edits it, and the spawn envelope; the
 * Agent declares which keys exist and which travel to the daemon as session
 * config options.
 */
const AgentUiNewSessionOptionSchema = lazyZodSchema(() => z.object({
  key: AgentUiIdSchema,
  kind: z.literal('boolean'),
  spawnConfigOption: z.boolean().optional(),
}).strict());

const AgentUiNewSessionSchema = lazyZodSchema(() => z.object({
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
}).strict());

const AgentUiEnvironmentVariablesSchema = lazyZodSchema(() => z.object({
  backendMode: z.object({
    envKey: AgentUiIdSchema,
    settingKey: AgentUiSettingReferenceSchema,
    defaultValue: AgentUiIdSchema,
    values: AgentUiIdArraySchema.min(1),
  }).strict(),
  serverBaseUrl: z.object({
    envKey: AgentUiIdSchema,
    explicitEnvKey: AgentUiIdSchema,
    settingKey: AgentUiSettingReferenceSchema,
    byServerIdSettingKey: AgentUiSettingReferenceSchema,
    allowedProtocols: AgentUiIdArraySchema.optional(),
    rejectCredentials: z.boolean().optional(),
    originOnly: z.boolean().optional(),
  }).strict().optional(),
}).strict());

const AgentUiPayloadSchema = lazyZodSchema(() => z.object({
  /**
   * A fixed spawn envelope contribution. The compiled-adapter form
   * (`{ kind: 'adapter' }`) is deliberately not part of the public grammar.
   */
  spawnSessionExtras: z.object({
    kind: z.literal('static'),
    value: z.record(z.string(), SpawnConfigOptionValueSchema),
  }).strict().optional(),
  /** A setting-backed session configuration option contributed on create. */
  sessionExtras: z.object({
    outputKey: AgentUiIdSchema,
    values: AgentUiIdArraySchema.min(1),
    settingKey: AgentUiSettingReferenceSchema.optional(),
    aliases: AgentUiStringRecordSchema.optional(),
    defaultValue: AgentUiIdSchema.optional(),
  }).strict().optional(),
  environmentVariables: AgentUiEnvironmentVariablesSchema.optional(),
}).strict());

const AgentUiExternalSessionsBrowseSchema = lazyZodSchema(() => z.object({
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
    detailSettingsKey: AgentUiSettingReferenceSchema.optional(),
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
  }).strict().optional(),
}).strict());

const AgentUiExternalSessionsSchema = lazyZodSchema(() => z.object({
  browse: AgentUiExternalSessionsBrowseSchema.optional(),
  sessionHandoff: z.object({
    clearMetadataKeys: AgentUiIdArraySchema.optional(),
  }).strict().optional(),
}).strict());

/**
 * One declared AskUserQuestion dialog can opt into a narrowly host-owned
 * setting mutation and/or attached-terminal presentation. The declaration is
 * data only: it never supplies a callback, a route, or a generic action.
 */
const AgentUiAskUserQuestionDialogSchema = lazyZodSchema(() => z.object({
  dialogId: AgentUiIdSchema,
  settingMutation: z.object({
    settingId: AgentUiMutablePluginSettingReferenceSchema,
    allowedValues: AgentUiIdArraySchema.min(1),
  }).strict().optional(),
  terminalNotice: z.object({
    headerKey: AgentUiTranslationKeySchema,
    questionKey: AgentUiTranslationKeySchema,
  }).strict().optional(),
  terminalSecondaryAction: z.object({
    kind: z.literal('openAttachedTerminal'),
    labelKey: AgentUiTranslationKeySchema,
    descriptionKey: AgentUiTranslationKeySchema,
  }).strict().optional(),
}).strict().refine(
  (dialog) => dialog.settingMutation !== undefined
    || dialog.terminalNotice !== undefined
    || dialog.terminalSecondaryAction !== undefined,
  { message: 'AskUserQuestion dialogs require a declared host-owned behavior.' },
));

const AgentUiAskUserQuestionSchema = lazyZodSchema(() => z.object({
  dialogs: z.array(AgentUiAskUserQuestionDialogSchema).min(1),
}).strict().refine(
  (declaration) => new Set(declaration.dialogs.map((dialog) => dialog.dialogId)).size === declaration.dialogs.length,
  { message: 'AskUserQuestion dialog ids must be unique.' },
));

export const AgentUiBehaviorDeclarationV1Schema = lazyZodSchema(() => z.object({
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
      settingKey: AgentUiSettingReferenceSchema.optional(),
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
  askUserQuestion: AgentUiAskUserQuestionSchema.optional(),
  externalSessions: AgentUiExternalSessionsSchema.optional(),
}).strict());
export type AgentUiBehaviorDeclarationV1 = z.infer<typeof AgentUiBehaviorDeclarationV1Schema>;

/* -------------------------------------------------------------------------- */
/* message                                                                     */
/* -------------------------------------------------------------------------- */

export const AgentUiMessageDeclarationV1Schema = lazyZodSchema(() => z.object({
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
}).strict());
export type AgentUiMessageDeclarationV1 = z.infer<typeof AgentUiMessageDeclarationV1Schema>;

/* -------------------------------------------------------------------------- */
/* session                                                                     */
/* -------------------------------------------------------------------------- */

const AgentUiAgentTeamBehaviorSchema = lazyZodSchema(() => z.object({
  kind: z.literal('session.agentTeamBehavior.v1'),
  snapshotKey: AgentUiIdSchema,
  providerLabel: AgentUiIdSchema,
  flavorAliases: AgentUiIdArraySchema.min(1),
  tools: z.object({
    teamCreate: AgentUiIdArraySchema.min(1),
    teamDelete: AgentUiIdArraySchema.min(1),
    teamSendMessage: AgentUiIdArraySchema.min(1),
    subagentSpawn: AgentUiIdArraySchema.min(1),
    activeTeamFallbackSubagentSpawn: AgentUiIdArraySchema.optional(),
    configMutation: AgentUiIdArraySchema.optional(),
  }).strict(),
  configTeamPath: z.object({
    rootDirectory: AgentUiIdSchema,
    teamsDirectory: AgentUiIdSchema,
    filename: AgentUiIdSchema,
  }).strict().optional(),
  lifecycleEvents: z.object({
    ignoreActivityPreview: AgentUiIdArraySchema.optional(),
    shutdownApproved: AgentUiIdSchema.optional(),
  }).strict().optional(),
}).strict());

const AgentUiSessionProviderBehaviorSchema = lazyZodSchema(() => z.object({
  kind: z.literal('session.providerBehavior.v1'),
  agentTeam: AgentUiAgentTeamBehaviorSchema.optional(),
  participants: z.object({
    sidechainIds: z.object({
      kind: z.literal('toolCallInputString'),
      toolNames: AgentUiIdArraySchema.min(1),
      inputKey: AgentUiIdSchema,
    }).strict().optional(),
  }).strict().optional(),
  subagents: z.object({
    ignoreActivityPreviewText: z.object({
      kind: z.literal('jsonEventType'),
      recipientKinds: AgentUiIdArraySchema.min(1),
      eventTypes: AgentUiIdArraySchema.min(1),
    }).strict().optional(),
  }).strict().optional(),
}).strict());

const AgentUiSessionVisibleMessagesSchema = lazyZodSchema(() => z.object({
  kind: z.literal('session.visibleMessages.v1'),
  subagentKinds: AgentUiIdArraySchema.min(1),
  fallbackToolNames: AgentUiIdArraySchema.optional(),
  excludeJsonEventTypes: AgentUiIdArraySchema.min(1),
}).strict());

/** Data-only Session behavior interpreted by the same host owner for every Agent. */
export const AgentUiSessionDeclarationV1Schema = lazyZodSchema(() => z.object({
  providerBehavior: AgentUiSessionProviderBehaviorSchema.optional(),
  visibleMessages: AgentUiSessionVisibleMessagesSchema.optional(),
}).strict().refine(
  (value) => value.providerBehavior !== undefined || value.visibleMessages !== undefined,
  'At least one Agent Session UI declaration is required.',
));
export type AgentUiSessionDeclarationV1 = z.infer<typeof AgentUiSessionDeclarationV1Schema>;

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
const AgentUiBooleanOptionComponentSlotSchema = lazyZodSchema(() => z.object({
  id: AgentUiIdSchema,
  slot: AgentUiIdSchema,
  chip: z.object({
    kind: z.literal('booleanOption'),
    optionStateKey: AgentUiIdSchema,
    iconName: AgentUiIdSchema,
    onLabelKey: AgentUiTranslationKeySchema,
    offLabelKey: AgentUiTranslationKeySchema,
  }).strict(),
}).strict());

const AgentUiSubagentLaunchComponentSlotSchema = lazyZodSchema(() => z.object({
  id: AgentUiIdSchema,
  slot: z.literal('sessionSubagents.launchCards'),
  surfaceId: AgentUiIdSchema,
  props: z.object({
    teamIds: z.object({
      kind: z.literal('subagentGroupKeys'),
      subagentKinds: AgentUiIdArraySchema.optional(),
    }).strict().optional(),
  }).strict().optional(),
}).strict());

const AgentUiSubagentDetailsComponentSlotSchema = lazyZodSchema(() => z.object({
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
}).strict());

const AgentUiComponentSlotSchema = lazyZodSchema(() => z.union([
  AgentUiBooleanOptionComponentSlotSchema,
  AgentUiSubagentLaunchComponentSlotSchema,
  AgentUiSubagentDetailsComponentSlotSchema,
]));

export const AgentUiComponentsDeclarationV1Schema = lazyZodSchema(() => z.object({
  slots: z.array(AgentUiComponentSlotSchema).optional(),
}).strict());
export type AgentUiComponentsDeclarationV1 = z.infer<typeof AgentUiComponentsDeclarationV1Schema>;

/* -------------------------------------------------------------------------- */
/* projected carrier                                                           */
/* -------------------------------------------------------------------------- */

/** Optional display-only hue; it never identifies or routes an Agent. */
export const AgentUiIdentityColorV1Schema = lazyZodSchema(() => z.object({
  light: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  dark: z.string().regex(/^#[0-9a-fA-F]{6}$/),
}).strict());

/**
 * The SAME declaration slots as they travel in the daemon contribution
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
export const AgentUiProjectedDeclarationV1Schema = lazyZodSchema(() => z.object({
  identityColor: z.record(z.string(), z.unknown()).optional(),
  behavior: z.record(z.string(), z.unknown()).optional(),
  session: z.record(z.string(), z.unknown()).optional(),
  message: z.record(z.string(), z.unknown()).optional(),
  components: z.record(z.string(), z.unknown()).optional(),
}).strict());
export type AgentUiProjectedDeclarationV1 = z.infer<typeof AgentUiProjectedDeclarationV1Schema>;
