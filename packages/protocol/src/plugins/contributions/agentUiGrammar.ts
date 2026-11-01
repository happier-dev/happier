import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

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

const AgentUiIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const AgentUiIdArraySchema = lazyZodSchema(() => z.array(AgentUiIdSchema));
const AgentUiStringRecordSchema = lazyZodSchema(() => z.record(z.string(), z.string()));

/**
 * A setting reference is always qualified by its owner scope. `host` is the
 * incumbent host Account preference namespace; `account` and `daemon` are the
 * declaring plugin's scoped Settings contributions. Bare local IDs are not a
 * supported compatibility form.
 */
const AgentUiSettingReferenceSchema = lazyZodSchema(() => z.strictObject({
  scope: z.enum(['host', 'account', 'daemon']),
  localId: AgentUiIdSchema,
}));
export type AgentUiSettingReferenceV1 = z.infer<typeof AgentUiSettingReferenceSchema>;
const AgentUiMutablePluginSettingReferenceSchema = lazyZodSchema(() => z.strictObject({
  scope: z.enum(['account', 'daemon']),
  localId: AgentUiIdSchema,
}));
/** A translation key resolved by the host's own catalogue. */
const AgentUiTranslationKeySchema = AgentUiIdSchema;

export type AgentUiConditionV1 =
  | { kind: 'experimentsEnabled' }
  | { kind: 'settingEquals'; settingKey: AgentUiSettingReferenceV1; value: string; aliases?: Record<string, string> }
  | { kind: 'settingTrue'; settingKey: AgentUiSettingReferenceV1 }
  | { all: AgentUiConditionV1[] }
  | { any: AgentUiConditionV1[] };

/** When a declared capability applies, evaluated against host account settings. */
export const AgentUiConditionV1Schema: z.ZodMiniType<AgentUiConditionV1, AgentUiConditionV1> = z.lazy(() => z.union([
  z.strictObject({ kind: z.literal('experimentsEnabled') }),
  z.strictObject({
    kind: z.literal('settingEquals'),
    settingKey: AgentUiSettingReferenceSchema,
    value: z.string(),
    aliases: z.optional(AgentUiStringRecordSchema),
  }),
  z.strictObject({ kind: z.literal('settingTrue'), settingKey: AgentUiSettingReferenceSchema }),
  z.strictObject({ all: z.array(AgentUiConditionV1Schema) }),
  z.strictObject({ any: z.array(AgentUiConditionV1Schema) }),
]));

const AgentUiTranscriptStorageModeSchema = lazyZodSchema(() => z.enum(['persisted', 'direct']));

const AgentUiExternalSessionsSourceSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.object({ kind: AgentUiIdSchema })));

/* -------------------------------------------------------------------------- */
/* behavior                                                                    */
/* -------------------------------------------------------------------------- */

const AgentUiPermissionFooterSchema = lazyZodSchema(() => z.strictObject({
  usePermissionUpdates: z.optional(z.boolean()),
  forceReadOnlyAfterStop: z.optional(z.boolean()),
  supportsExecPolicyAmendment: z.optional(z.boolean()),
  stopHandling: z.optional(z.enum(['denyOnly', 'denyAndAbortRun'])),
}));

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

const AgentUiEditableGoalsSchema = lazyZodSchema(() => z.strictObject({
  capabilityDriven: z.optional(z.boolean()),
  activeWhenNoPersistedMode: z.optional(z.boolean()),
  persistedGoalSnapshot: z.optional(z.strictObject({
    path: z.optional(AgentUiIdArraySchema),
    itemKind: z.optional(AgentUiIdSchema),
    providerFields: z.optional(AgentUiIdArraySchema),
  })),
}));

const AgentUiContextWindowSchema = lazyZodSchema(() => z.strictObject({
  defaultTokens: z.optional(z.number().check(z.int(), z.positive())),
  modelRules: z.optional(z.array(z.strictObject({
    idSuffix: z.optional(AgentUiIdSchema),
    descriptionIncludesAny: z.optional(AgentUiIdArraySchema),
    tokens: z.optional(z.number().check(z.int(), z.positive())),
  }))),
  observedUsageBumpTokens: z.optional(z.array(z.number().check(z.int(), z.positive()))),
  trustObservedUsageBeyondKnown: z.optional(z.boolean()),
}));

/**
 * Composer-owned new-session option state an Agent understands. The host owns
 * the option store, the control that edits it, and the spawn envelope; the
 * Agent declares which keys exist and which travel to the daemon as session
 * config options.
 */
const AgentUiNewSessionOptionSchema = lazyZodSchema(() => z.strictObject({
  key: AgentUiIdSchema,
  kind: z.literal('boolean'),
  spawnConfigOption: z.optional(z.boolean()),
}));

const AgentUiNewSessionSchema = lazyZodSchema(() => z.strictObject({
  relevantInstallableDepKeys: z.optional(AgentUiIdArraySchema),
  relevantInstallableDeps: z.optional(z.array(z.strictObject({
    keys: z.optional(AgentUiIdArraySchema),
    when: z.optional(AgentUiConditionV1Schema),
  }))),
  transcriptStorageModes: z.optional(z.array(AgentUiTranscriptStorageModeSchema)),
  transcriptStorageModesByBackendMode: z.optional(z.record(
    z.string(),
    z.array(AgentUiTranscriptStorageModeSchema),
  )),
  canSelectWithoutDetectedCli: z.optional(z.boolean()),
  agentOptions: z.optional(z.array(AgentUiNewSessionOptionSchema)),
}));

const AgentUiEnvironmentVariablesSchema = lazyZodSchema(() => z.strictObject({
  backendMode: z.strictObject({
    envKey: AgentUiIdSchema,
    settingKey: AgentUiSettingReferenceSchema,
    defaultValue: AgentUiIdSchema,
    values: AgentUiIdArraySchema.check(z.minLength(1)),
  }),
  serverBaseUrl: z.optional(z.strictObject({
    envKey: AgentUiIdSchema,
    explicitEnvKey: AgentUiIdSchema,
    settingKey: AgentUiSettingReferenceSchema,
    byServerIdSettingKey: AgentUiSettingReferenceSchema,
    allowedProtocols: z.optional(AgentUiIdArraySchema),
    rejectCredentials: z.optional(z.boolean()),
    originOnly: z.optional(z.boolean()),
  })),
}));

const AgentUiPayloadSchema = lazyZodSchema(() => z.strictObject({
  /**
   * A fixed spawn envelope contribution. The compiled-adapter form
   * (`{ kind: 'adapter' }`) is deliberately not part of the public grammar.
   */
  spawnSessionExtras: z.optional(z.strictObject({
    kind: z.literal('static'),
    value: z.record(z.string(), SpawnConfigOptionValueSchema),
  })),
  /** A configured runtime selection; an output key also contributes a create-time configuration option. */
  sessionExtras: z.optional(z.strictObject({
    outputKey: z.optional(AgentUiIdSchema),
    values: AgentUiIdArraySchema.check(z.minLength(1)),
    settingKey: z.optional(AgentUiSettingReferenceSchema),
    aliases: z.optional(AgentUiStringRecordSchema),
    booleanValues: z.optional(z.strictObject({ true: AgentUiIdSchema, false: AgentUiIdSchema })),
    defaultValue: z.optional(AgentUiIdSchema),
  })),
  environmentVariables: z.optional(AgentUiEnvironmentVariablesSchema),
}));

const AgentUiExternalSessionsBrowseSchema = lazyZodSchema(() => z.strictObject({
  order: z.optional(z.number().check(z.int())),
  sourceOptions: z.optional(z.array(z.strictObject({
    key: AgentUiIdSchema,
    labelKey: AgentUiTranslationKeySchema,
    labelParams: z.optional(AgentUiStringRecordSchema),
    detail: z.optional(AgentUiIdSchema),
    source: AgentUiExternalSessionsSourceSchema,
  }))),
  connectedServiceProfileSources: z.optional(z.array(z.strictObject({
    serviceId: AgentUiIdSchema,
    keyPrefix: AgentUiIdSchema,
    labelKey: AgentUiTranslationKeySchema,
    labelParams: z.optional(AgentUiStringRecordSchema),
    detailSettingsKey: z.optional(AgentUiSettingReferenceSchema),
    source: AgentUiExternalSessionsSourceSchema,
    serviceIdField: AgentUiIdSchema,
    profileIdField: AgentUiIdSchema,
  }))),
  lockedConnectedServiceSource: z.optional(z.strictObject({
    serviceId: AgentUiIdSchema,
    keyPrefix: AgentUiIdSchema,
    source: AgentUiExternalSessionsSourceSchema,
    serviceIdField: AgentUiIdSchema,
    profileIdField: AgentUiIdSchema,
    groupIdField: AgentUiIdSchema,
  })),
  compatibleSource: z.optional(z.strictObject({
    sourceKind: AgentUiIdSchema,
    optionalFields: AgentUiIdArraySchema,
  })),
  linkEnsureRequestExtras: z.optional(z.strictObject({
    sourceFromCandidate: z.optional(z.strictObject({
      sourceKind: AgentUiIdSchema,
      optionalFields: AgentUiIdArraySchema,
    })),
  })),
}));

const AgentUiExternalSessionsSchema = lazyZodSchema(() => z.strictObject({
  browse: z.optional(AgentUiExternalSessionsBrowseSchema),
  sessionHandoff: z.optional(z.strictObject({
    clearMetadataKeys: z.optional(AgentUiIdArraySchema),
  })),
}));

/**
 * One declared AskUserQuestion dialog can opt into a narrowly host-owned
 * setting mutation and/or attached-terminal presentation. The declaration is
 * data only: it never supplies a callback, a route, or a generic action.
 */
const AgentUiAskUserQuestionDialogSchema = lazyZodSchema(() => z.strictObject({
  dialogId: AgentUiIdSchema,
  settingMutation: z.optional(z.strictObject({
    settingId: AgentUiMutablePluginSettingReferenceSchema,
    allowedValues: AgentUiIdArraySchema.check(z.minLength(1)),
  })),
  terminalNotice: z.optional(z.strictObject({
    headerKey: AgentUiTranslationKeySchema,
    questionKey: AgentUiTranslationKeySchema,
  })),
  terminalSecondaryAction: z.optional(z.strictObject({
    kind: z.literal('openAttachedTerminal'),
    labelKey: AgentUiTranslationKeySchema,
    descriptionKey: AgentUiTranslationKeySchema,
  })),
}).check(z.refine((dialog) => dialog.settingMutation !== undefined
    || dialog.terminalNotice !== undefined
    || dialog.terminalSecondaryAction !== undefined, { message: 'AskUserQuestion dialogs require a declared host-owned behavior.' })));

const AgentUiAskUserQuestionSchema = lazyZodSchema(() => z.strictObject({
  dialogs: z.array(AgentUiAskUserQuestionDialogSchema).check(z.minLength(1)),
}).check(z.refine((declaration) => new Set(declaration.dialogs.map((dialog) => dialog.dialogId)).size === declaration.dialogs.length, { message: 'AskUserQuestion dialog ids must be unique.' })));

export const AgentUiBehaviorDeclarationV1Schema = lazyZodSchema(() => z.strictObject({
  /** Author-owned identity for this declaration, surfaced in diagnostics. */
  descriptorId: z.optional(AgentUiIdSchema),
  attachedSessionTerminal: z.optional(z.strictObject({ supported: z.optional(z.boolean()) })),
  pendingDelivery: z.optional(z.strictObject({
    custodyLabelKey: z.optional(AgentUiTranslationKeySchema),
    interruptAndRun: z.optional(z.boolean()),
  })),
  guidance: z.optional(z.strictObject({
    includeInSessionGettingStartedCliExamples: z.optional(z.boolean()),
  })),
  permissions: z.optional(z.strictObject({
    promptProtocol: z.optional(AgentUiPermissionPromptProtocolSchema),
    footer: z.optional(AgentUiPermissionFooterSchema),
  })),
  workState: z.optional(z.strictObject({ editableGoals: z.optional(AgentUiEditableGoalsSchema) })),
  resume: z.optional(z.strictObject({
    experimentSwitches: z.optional(z.array(z.strictObject({
      id: AgentUiIdSchema,
      settingKey: z.optional(AgentUiSettingReferenceSchema),
      when: z.optional(AgentUiConditionV1Schema),
    }))),
  })),
  sessionComposer: z.optional(z.strictObject({
    nonSteerableWhileBusy: z.optional(z.strictObject({
      reason: z.optional(z.literal('provider_config_change_refused')),
      metaKeys: z.optional(AgentUiIdArraySchema),
      sessionConfigOptionIds: z.optional(AgentUiIdArraySchema),
      freshModelOverride: z.optional(z.boolean()),
    })),
  })),
  contextWindow: z.optional(AgentUiContextWindowSchema),
  newSession: z.optional(AgentUiNewSessionSchema),
  payload: z.optional(AgentUiPayloadSchema),
  askUserQuestion: z.optional(AgentUiAskUserQuestionSchema),
  externalSessions: z.optional(AgentUiExternalSessionsSchema),
}));
export type AgentUiBehaviorDeclarationV1 = z.infer<typeof AgentUiBehaviorDeclarationV1Schema>;

/* -------------------------------------------------------------------------- */
/* message                                                                     */
/* -------------------------------------------------------------------------- */

export const AgentUiMessageDeclarationV1Schema = lazyZodSchema(() => z.strictObject({
  /**
   * Outbound message metadata this Agent derives from a session config option
   * the user chose. `metaDescriptorIds` — the compiled-adapter form — is not
   * part of the public grammar.
   */
  metaOverrides: z.optional(z.array(z.strictObject({
    id: AgentUiIdSchema,
    targetKey: AgentUiIdSchema,
    value: z.strictObject({
      kind: z.literal('sessionConfigOptionOverride'),
      key: AgentUiIdSchema,
      aliases: z.optional(AgentUiIdArraySchema),
    }),
    normalize: z.optional(z.literal('trimLowercase')),
  }))),
}));
export type AgentUiMessageDeclarationV1 = z.infer<typeof AgentUiMessageDeclarationV1Schema>;

/* -------------------------------------------------------------------------- */
/* session                                                                     */
/* -------------------------------------------------------------------------- */

const AgentUiAgentTeamBehaviorSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('session.agentTeamBehavior.v1'),
  snapshotKey: AgentUiIdSchema,
  providerLabel: AgentUiIdSchema,
  flavorAliases: AgentUiIdArraySchema.check(z.minLength(1)),
  tools: z.strictObject({
    teamCreate: AgentUiIdArraySchema.check(z.minLength(1)),
    teamDelete: AgentUiIdArraySchema.check(z.minLength(1)),
    teamSendMessage: AgentUiIdArraySchema.check(z.minLength(1)),
    subagentSpawn: AgentUiIdArraySchema.check(z.minLength(1)),
    activeTeamFallbackSubagentSpawn: z.optional(AgentUiIdArraySchema),
    configMutation: z.optional(AgentUiIdArraySchema),
  }),
  configTeamPath: z.optional(z.strictObject({
    rootDirectory: AgentUiIdSchema,
    teamsDirectory: AgentUiIdSchema,
    filename: AgentUiIdSchema,
  })),
  lifecycleEvents: z.optional(z.strictObject({
    ignoreActivityPreview: z.optional(AgentUiIdArraySchema),
    shutdownApproved: z.optional(AgentUiIdSchema),
  })),
}));

const AgentUiSessionProviderBehaviorSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('session.providerBehavior.v1'),
  agentTeam: z.optional(AgentUiAgentTeamBehaviorSchema),
  participants: z.optional(z.strictObject({
    sidechainIds: z.optional(z.strictObject({
      kind: z.literal('toolCallInputString'),
      toolNames: AgentUiIdArraySchema.check(z.minLength(1)),
      inputKey: AgentUiIdSchema,
    })),
  })),
  subagents: z.optional(z.strictObject({
    ignoreActivityPreviewText: z.optional(z.strictObject({
      kind: z.literal('jsonEventType'),
      recipientKinds: AgentUiIdArraySchema.check(z.minLength(1)),
      eventTypes: AgentUiIdArraySchema.check(z.minLength(1)),
    })),
  })),
}));

const AgentUiSessionVisibleMessagesSchema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('session.visibleMessages.v1'),
  subagentKinds: AgentUiIdArraySchema.check(z.minLength(1)),
  fallbackToolNames: z.optional(AgentUiIdArraySchema),
  excludeJsonEventTypes: AgentUiIdArraySchema.check(z.minLength(1)),
}));

/** Data-only Session behavior interpreted by the same host owner for every Agent. */
export const AgentUiSessionDeclarationV1Schema = lazyZodSchema(() => z.strictObject({
  providerBehavior: z.optional(AgentUiSessionProviderBehaviorSchema),
  visibleMessages: z.optional(AgentUiSessionVisibleMessagesSchema),
}).check(z.refine((value) => value.providerBehavior !== undefined || value.visibleMessages !== undefined, 'At least one Agent Session UI declaration is required.')));
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
const AgentUiBooleanOptionComponentSlotSchema = lazyZodSchema(() => z.strictObject({
  id: AgentUiIdSchema,
  slot: AgentUiIdSchema,
  chip: z.strictObject({
    kind: z.literal('booleanOption'),
    optionStateKey: AgentUiIdSchema,
    iconName: AgentUiIdSchema,
    onLabelKey: AgentUiTranslationKeySchema,
    offLabelKey: AgentUiTranslationKeySchema,
  }),
}));

const AgentUiSubagentLaunchComponentSlotSchema = lazyZodSchema(() => z.strictObject({
  id: AgentUiIdSchema,
  slot: z.literal('sessionSubagents.launchCards'),
  surfaceId: AgentUiIdSchema,
  props: z.optional(z.strictObject({
    teamIds: z.optional(z.strictObject({
      kind: z.literal('subagentGroupKeys'),
      subagentKinds: z.optional(AgentUiIdArraySchema),
    })),
  })),
}));

const AgentUiSubagentDetailsComponentSlotSchema = lazyZodSchema(() => z.strictObject({
  id: AgentUiIdSchema,
  slot: z.literal('sessionSubagents.teammateDetailsTab'),
  surfaceId: AgentUiIdSchema,
  resourceKind: AgentUiIdSchema,
  iconName: AgentUiIdSchema,
  tab: z.strictObject({
    keyPrefix: AgentUiIdSchema,
    titleKey: AgentUiTranslationKeySchema,
    subtitleKey: z.optional(AgentUiTranslationKeySchema),
  }),
}));

const AgentUiComponentSlotSchema = lazyZodSchema(() => z.union([
  AgentUiBooleanOptionComponentSlotSchema,
  AgentUiSubagentLaunchComponentSlotSchema,
  AgentUiSubagentDetailsComponentSlotSchema,
]));

export const AgentUiComponentsDeclarationV1Schema = lazyZodSchema(() => z.strictObject({
  slots: z.optional(z.array(AgentUiComponentSlotSchema)),
}));
export type AgentUiComponentsDeclarationV1 = z.infer<typeof AgentUiComponentsDeclarationV1Schema>;

/* -------------------------------------------------------------------------- */
/* projected carrier                                                           */
/* -------------------------------------------------------------------------- */

/** Optional display-only hue; it never identifies or routes an Agent. */
export const AgentUiIdentityColorV1Schema = lazyZodSchema(() => z.strictObject({
  light: z.string().check(z.regex(/^#[0-9a-fA-F]{6}$/)),
  dark: z.string().check(z.regex(/^#[0-9a-fA-F]{6}$/)),
}));

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
export const AgentUiProjectedDeclarationV1Schema = lazyZodSchema(() => z.strictObject({
  identityColor: z.optional(z.record(z.string(), z.unknown())),
  behavior: z.optional(z.record(z.string(), z.unknown())),
  session: z.optional(z.record(z.string(), z.unknown())),
  message: z.optional(z.record(z.string(), z.unknown())),
  components: z.optional(z.record(z.string(), z.unknown())),
}));
export type AgentUiProjectedDeclarationV1 = z.infer<typeof AgentUiProjectedDeclarationV1Schema>;
