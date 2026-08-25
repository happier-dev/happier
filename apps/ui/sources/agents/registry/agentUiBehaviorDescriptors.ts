import type { ReactNode } from 'react';

import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { resolveSessionModelSelectionDisposition } from '@/sync/domains/models/resolveSessionModelSelectionDisposition';
import type { Settings } from '@/sync/domains/settings/settings';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { tLoose, type TranslationKey } from '@/text';
import {
    LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
    readMetadataAliasValue,
    resolveAgentConfiguredRuntimeKind,
    resolvePersistedProviderSessionBackendMode,
    SESSION_CONFIG_OPTION_OVERRIDES_KEY,
} from '@happier-dev/agents';
import { mergeSpawnConfigOptionAliases } from '@happier-dev/protocol';

import type {
    AgentSessionComposerNonSteerablePayloadContext,
    AgentSessionComposerNonSteerableReason,
    AgentPermissionFooterBehavior,
    AgentResumeExperiments,
    AgentTranscriptStorageMode,
    AgentUiBehavior,
} from './registryUiBehavior';
import type { PermissionPromptProtocol } from './registryCore';
import { createBooleanOptionActionChip } from './agentUiBehavior/booleanOptionActionChip';
import {
    createUiProjectionDiagnostic,
    isRecord,
    readString,
    readStringArray,
    type UiProjectionDiagnostic,
} from './uiDescriptorDiagnostics';
import {
    createDescriptorAdapterBehavior,
    readRuntimeDescriptorAgentPayload,
} from './agentUiBehaviorDescriptorAdapters';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveSessionGoalExecutionCapabilities } from '@/sync/domains/session/control/sessionGoalExecutionCapabilities';

type SettingsKey = Extract<keyof Settings, string>;

export function readOwnerMetadataFromSessionLike(session: unknown): Record<string, unknown> | null {
    if (!isRecord(session)) return null;
    const metadata = readSessionOwnerMetadataView({
        metadataLayoutVersion: typeof session.metadataLayoutVersion === 'number'
            ? session.metadataLayoutVersion
            : undefined,
        metadata: session.metadata,
        ownerMetadataView: session.ownerMetadataView,
    });
    return isRecord(metadata) ? metadata : null;
}

type StaticPayloadDescriptor = Readonly<{
    kind: 'static';
    value: Record<string, unknown>;
}>;

type UnsupportedPayloadAdapterDescriptor = Readonly<{
    kind: 'adapter';
    adapterId: string;
}>;

type PayloadDescriptor = StaticPayloadDescriptor | UnsupportedPayloadAdapterDescriptor;

type DescriptorCondition =
    | Readonly<{ kind: 'experimentsEnabled' }>
    | Readonly<{
        kind: 'settingEquals';
        settingKey: SettingsKey;
        value: string;
        aliases?: Readonly<Record<string, string>>;
    }>
    | Readonly<{
        kind: 'settingTrue';
        settingKey: SettingsKey;
    }>
    | Readonly<{ all: readonly DescriptorCondition[] }>
    | Readonly<{ any: readonly DescriptorCondition[] }>;

type BooleanOptionChipDescriptor = Readonly<{
    kind: 'booleanOption';
    optionStateKey: string;
    iconName: string;
    onLabelKey: string;
    offLabelKey: string;
}>;

type ComponentSlotDescriptor = Readonly<{
    id: string;
    slot: string;
    surfaceId?: string;
    /**
     * The declared half of a composer action chip. The host owns the control,
     * so an Agent declares what it edits and what it is called rather than
     * naming a host component.
     */
    chip?: BooleanOptionChipDescriptor;
    props?: Readonly<{
        teamIds?: Readonly<{
            kind: 'subagentGroupKeys';
            subagentKinds?: readonly string[];
        }>;
        optionStateKey?: string;
    }>;
    resourceKind?: string;
    iconName?: string;
    tab?: Readonly<{
        keyPrefix: string;
        titleKey: string;
        subtitleKey?: string;
    }>;
}>;

type ComponentSlotsDescriptor = Readonly<{
    slots?: readonly ComponentSlotDescriptor[];
}>;

type AgentOptionDescriptor = Readonly<{
    key: string;
    kind: 'boolean';
    /** Travel to the daemon as a session config option under the same id. */
    spawnConfigOption?: boolean;
}>;

type SessionConfigOptionOverrideSource = Readonly<{
    kind: 'sessionConfigOptionOverride';
    key: string;
    aliases?: readonly string[];
}>;

type MessageMetaOverrideDescriptor = Readonly<{
    id: string;
    targetKey: string;
    value: SessionConfigOptionOverrideSource;
    normalize?: 'trimLowercase';
}>;

type ContextWindowModelRuleDescriptor = Readonly<{
    idSuffix?: string;
    descriptionIncludesAny?: readonly string[];
    tokens?: number;
}>;

type ContextWindowDescriptor = Readonly<{
    defaultTokens?: number;
    modelRules?: readonly ContextWindowModelRuleDescriptor[];
    observedUsageBumpTokens?: readonly number[];
    trustObservedUsageBeyondKnown?: boolean;
}>;

type NormalizedContextWindowModelRule = Readonly<{
    tokens: number;
    idSuffix?: string;
    descriptionIncludesAny?: readonly string[];
}>;

export type PluginUiBehaviorDescriptor = Readonly<{
    /**
     * Opt-in to the host's attached-terminal viewer. Serviceability is a host
     * fact the daemon publishes for whichever Agent runs inside a terminal
     * host, so this declares participation, never the decision.
     */
    attachedSessionTerminal?: Readonly<{
        supported?: boolean;
    }>;
    /**
     * Opt-in to the host's pending-input custody presentation, driven by the
     * `pendingInputInterruptAndRunLocalId` capability any Agent can publish
     * through the public SDK runtime context.
     */
    pendingDelivery?: Readonly<{
        custodyLabelKey?: string;
        interruptAndRun?: boolean;
    }>;
    guidance?: Readonly<{
        includeInSessionGettingStartedCliExamples?: boolean;
    }>;
    permissions?: Readonly<{
        /**
         * Which permission-prompt conversation this Agent speaks. It selects the
         * footer's action model, not only its wording.
         */
        promptProtocol?: PermissionPromptProtocol;
        footer?: Partial<AgentPermissionFooterBehavior>;
    }>;
    workState?: Readonly<{
        editableGoals?: Readonly<{
            providerId?: string;
            capabilityDriven?: boolean;
            modeValues?: readonly string[];
            activeModeValues?: readonly string[];
            activeWhenNoPersistedMode?: boolean;
            persistedGoalSnapshot?: Readonly<{
                path?: readonly string[];
                itemKind?: string;
                providerFields?: readonly string[];
            }>;
        }>;
    }>;
    resume?: Readonly<{
        experimentSwitches?: readonly Readonly<{
            id: string;
            settingKey?: SettingsKey;
            when?: DescriptorCondition;
        }>[];
    }>;
    sessionComposer?: Readonly<{
        nonSteerableWhileBusy?: Readonly<{
            reason?: AgentSessionComposerNonSteerableReason;
            metaKeys?: readonly string[];
            sessionConfigOptionIds?: readonly string[];
            freshModelOverride?: boolean;
        }>;
    }>;
    contextWindow?: ContextWindowDescriptor;
    message?: Readonly<{
        metaDescriptorIds?: readonly string[];
        metaOverrides?: readonly MessageMetaOverrideDescriptor[];
    }>;
    newSession?: Readonly<{
        relevantInstallableDepKeys?: readonly string[];
        relevantInstallableDeps?: readonly Readonly<{
            keys?: readonly string[];
            when?: DescriptorCondition;
        }>[];
        transcriptStorageModes?: readonly AgentTranscriptStorageMode[];
        transcriptStorageModesByBackendMode?: Readonly<Record<string, readonly AgentTranscriptStorageMode[]>>;
        canSelectWithoutDetectedCli?: boolean;
        /**
         * Composer-owned new-session option state an Agent understands. The host owns
         * the option-state store, the chip that edits it, and the spawn envelope; the
         * Agent only declares which keys exist and which ones travel to the daemon as
         * session config options.
         */
        agentOptions?: readonly AgentOptionDescriptor[];
    }>;
    payload?: Readonly<{
        spawnSessionExtras?: PayloadDescriptor;
        sessionExtras?: Readonly<{
            providerId?: string;
            outputKey?: string;
            values?: readonly string[];
        }>;
        environmentVariables?: unknown;
        /**
         * The declared half of an Agent's spawn/resume transport: its backend-mode
         * vocabulary and the runtime-handle fields that travel with it. The host owns
         * the canonical `runtimeDescriptorV1` shape and reads incoming descriptors
         * through the protocol-generated canonical reader.
         */
        backendTransport?: unknown;
    }>;
    externalSessions?: unknown;
    sessionHandoff?: unknown;
    components?: ComponentSlotsDescriptor;
}>;

export type PluginUiDescriptor = Readonly<{
    kind: 'plugin.ui.v1';
    pluginId: string;
    agentId: string;
    version: number;
    behavior?: PluginUiBehaviorDescriptor;
    message?: PluginUiBehaviorDescriptor['message'];
    components?: ComponentSlotsDescriptor;
}>;

export type AgentUiBehaviorDescriptorResult = Readonly<{
    behavior: AgentUiBehavior;
    diagnostics: readonly UiProjectionDiagnostic[];
}>;

type AgentExperimentSwitchDescriptor = Readonly<{
    id: string;
    settingKey?: SettingsKey;
    when?: DescriptorCondition;
}>;

type SessionExtrasDescriptor = Readonly<{
    providerId: string;
    outputKey: string;
    values: readonly string[];
    /** Account setting holding this Agent's configured mode. */
    settingKey?: string;
    /** Retired spellings the setting can still hold. */
    aliases?: Readonly<Record<string, string>>;
    /** Mode used when the setting is unset or unreadable. */
    defaultValue?: string;
}>;

type EditableGoalsDescriptor = Readonly<{
    providerId: string;
    // Capability-driven gating (e.g. Claude): edit availability is read from the persisted goal
    // item's `goalCapabilities.canEdit` rather than the session backend mode. When set, the mode
    // fields below are not required (the gate ignores mode and reads the capability instead).
    capabilityDriven?: boolean;
    modeValues: readonly string[];
    activeModeValues: readonly string[];
    activeWhenNoPersistedMode: boolean;
    persistedGoalSnapshot?: Readonly<{
        path: readonly string[];
        itemKind: string;
        providerFields: readonly string[];
    }>;
}>;

function normalizePayloadDescriptor(value: unknown): PayloadDescriptor | null {
    if (!isRecord(value)) return null;
    if (value.kind === 'static' && isRecord(value.value)) {
        return { kind: 'static', value: value.value };
    }
    if (value.kind === 'adapter') {
        const adapterId = readString(value.adapterId);
        return adapterId ? { kind: 'adapter', adapterId } : null;
    }
    return null;
}

function normalizeDescriptorValue(
    value: unknown,
    aliases: Readonly<Record<string, string>> | undefined,
): string | null {
    const raw = readString(value);
    if (!raw) return null;
    return aliases?.[raw] ?? raw;
}

function normalizePositiveInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.trunc(value)
        : null;
}

function normalizeModelId(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeContextWindowModelRules(
    rules: readonly ContextWindowModelRuleDescriptor[] | undefined,
): readonly NormalizedContextWindowModelRule[] {
    if (!Array.isArray(rules)) return [];
    return rules.flatMap((rule) => {
        if (!rule || typeof rule !== 'object') return [];
        const tokens = normalizePositiveInteger(rule.tokens);
        if (!tokens) return [];
        const idSuffix = typeof rule.idSuffix === 'string'
            ? rule.idSuffix.trim().toLowerCase()
            : '';
        const descriptionCandidates: readonly unknown[] = Array.isArray(rule.descriptionIncludesAny)
            ? rule.descriptionIncludesAny
            : [];
        const descriptionIncludesAny = descriptionCandidates
            .map((entry) => typeof entry === 'string' ? entry.trim().toLowerCase() : '')
            .filter((entry) => entry.length > 0);
        if (!idSuffix && descriptionIncludesAny.length === 0) return [];
        return [{
            tokens,
            ...(idSuffix ? { idSuffix } : {}),
            ...(descriptionIncludesAny.length > 0 ? { descriptionIncludesAny } : {}),
        }];
    });
}

function normalizeContextWindowBumpTokens(value: readonly number[] | undefined): readonly number[] {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(
        value
            .map((entry) => normalizePositiveInteger(entry))
            .filter((entry): entry is number => entry !== null),
    )).sort((left, right) => left - right);
}

function evaluateDescriptorCondition(
    condition: DescriptorCondition | undefined,
    ctx: Readonly<{
        settings: Settings;
        experiments?: AgentResumeExperiments;
    }>,
): boolean {
    if (!condition) return true;
    if ('all' in condition) {
        return condition.all.every((entry) => evaluateDescriptorCondition(entry, ctx));
    }
    if ('any' in condition) {
        return condition.any.some((entry) => evaluateDescriptorCondition(entry, ctx));
    }
    if (condition.kind === 'experimentsEnabled') {
        return ctx.experiments?.enabled === true;
    }
    if (condition.kind === 'settingEquals') {
        const actual = normalizeDescriptorValue(ctx.settings[condition.settingKey], condition.aliases);
        const expected = normalizeDescriptorValue(condition.value, condition.aliases);
        return Boolean(actual && expected && actual === expected);
    }
    if (condition.kind === 'settingTrue') {
        return ctx.settings[condition.settingKey] === true;
    }
    return false;
}

function readSessionExtrasDescriptor(
    value: unknown,
    agentId: string,
    diagnostics: UiProjectionDiagnostic[],
): SessionExtrasDescriptor | null {
    if (!isRecord(value)) return null;
    const providerId = agentId;
    const outputKey = readString(value.outputKey);
    const values = readStringArray(value.values);
    if (!providerId || !outputKey || values.length === 0) {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_MALFORMED_DESCRIPTOR',
            'payload.sessionExtras',
            'Session extras descriptors require an output key and allowed values.',
        ));
        return null;
    }

    const settingKey = readString(value.settingKey);
    const aliases = readDescriptorStringRecord(value.aliases);
    const defaultValue = readString(value.defaultValue);
    return {
        providerId,
        outputKey,
        values,
        ...(settingKey ? { settingKey } : {}),
        ...(aliases ? { aliases } : {}),
        ...(defaultValue ? { defaultValue } : {}),
    };
}

function readDescriptorStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
    if (!isRecord(value)) return undefined;
    const entries = Object.entries(value).flatMap(([key, entry]) => {
        const normalizedKey = readString(key);
        const normalizedValue = readString(entry);
        return normalizedKey && normalizedValue ? [[normalizedKey, normalizedValue] as const] : [];
    });
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readValueAtPath(root: unknown, path: readonly string[]): unknown {
    let current = root;
    for (const key of path) {
        if (!isRecord(current)) return undefined;
        current = current[key];
    }
    return current;
}

function normalizeSessionExtraMode(
    descriptor: SessionExtrasDescriptor,
    value: unknown,
): string | null {
    const normalized = normalizeDescriptorValue(value, undefined);
    return normalized && descriptor.values.includes(normalized) ? normalized : null;
}

/**
 * The Agent's mode as ITS OWN declaration describes it.
 *
 * Both readers are keyed by the declaration's Agent id and bounded by its
 * declared value set, so they answer identically for a bundled and an installed
 * Agent. Neither consults a build-time roster: the canonical
 * `runtimeDescriptorV1` envelope already carries the owning `agentId`, and the
 * account setting is named by the declaration.
 */
function readDeclaredSettingsMode(
    descriptor: SessionExtrasDescriptor,
    settings: Readonly<Record<string, unknown>>,
): string | null {
    if (!descriptor.settingKey) return null;
    const declared = normalizeDescriptorValue(settings[descriptor.settingKey], descriptor.aliases);
    return normalizeSessionExtraMode(descriptor, declared)
        ?? normalizeSessionExtraMode(descriptor, descriptor.defaultValue);
}

function readDeclaredPersistedMode(
    providerId: string,
    values: readonly string[],
    metadata: unknown,
): string | null {
    const mode = readString(readRuntimeDescriptorAgentPayload(metadata, providerId)?.backendMode);
    return mode && values.includes(mode) ? mode : null;
}

function createSessionExtrasPayloadBehavior(
    descriptor: SessionExtrasDescriptor,
): NonNullable<AgentUiBehavior['payload']> {
    const buildExtras = (mode: string | null): Record<string, unknown> => (
        mode ? { [descriptor.outputKey]: mode } : {}
    );
    const resolveSettingsMode = (settings: Readonly<Record<string, unknown>>) => (
        readDeclaredSettingsMode(descriptor, settings)
        // Only a BUNDLED Agent has released account-setting shapes older than
        // this declaration; an installed Agent reaches the same outcome above.
        ?? normalizeSessionExtraMode(descriptor, resolveAgentConfiguredRuntimeKind({
            agentId: descriptor.providerId,
            accountSettings: settings as Record<string, unknown>,
        }))
    );
    const resolveSessionMode = (session: { metadata?: Record<string, unknown> | null } | null | undefined) => {
        const metadata = readOwnerMetadataFromSessionLike(session);
        return readDeclaredPersistedMode(descriptor.providerId, descriptor.values, metadata)
            // Same rule for persisted shapes: the canonical envelope above is
            // the one an installed Agent can occupy; the reader below knows a
            // bundled Agent's released pre-envelope metadata and nothing else.
            ?? normalizeSessionExtraMode(descriptor, resolvePersistedProviderSessionBackendMode({
                agentId: descriptor.providerId,
                metadata,
            }));
    };

    return {
        buildSpawnSessionExtras: ({ agentId, settings, sessionConfigOptionOverrides, updatedAt }) => {
            if (agentId !== descriptor.providerId) return {};
            const mode = resolveSettingsMode(settings);
            if (!mode) return {};
            return {
                ...buildExtras(mode),
                sessionConfigOptionOverrides: mergeSpawnConfigOptionAliases({
                    sessionConfigOptionOverrides: sessionConfigOptionOverrides ?? undefined,
                    configOptions: { [descriptor.outputKey]: mode },
                    updatedAt,
                }),
            };
        },
        buildResumeSessionExtras: ({ agentId, settings, session }) => (
            agentId === descriptor.providerId
                ? buildExtras(resolveSessionMode(session) ?? resolveSettingsMode(settings))
                : {}
        ),
        buildWakeResumeExtras: ({ agentId, resumeCapabilityOptions, session }) => (
            agentId === descriptor.providerId
                ? buildExtras(resolveSessionMode(session) ?? resolveSettingsMode(resumeCapabilityOptions.accountSettings ?? ({} as Settings)))
                : {}
        ),
    };
}

function readEditableGoalsDescriptor(
    value: unknown,
    agentId: string,
    diagnostics: UiProjectionDiagnostic[],
): EditableGoalsDescriptor | null {
    if (!isRecord(value)) return null;
    const providerId = agentId;
    const modeValues = readStringArray(value.modeValues);
    const activeModeValues = readStringArray(value.activeModeValues);
    const persistedGoalSnapshot = isRecord(value.persistedGoalSnapshot)
        ? {
            path: readStringArray(value.persistedGoalSnapshot.path),
            itemKind: readString(value.persistedGoalSnapshot.itemKind),
            providerFields: readStringArray(value.persistedGoalSnapshot.providerFields),
        }
        : null;
    const validPersistedGoalSnapshot = persistedGoalSnapshot
        && persistedGoalSnapshot.path.length > 0
        && persistedGoalSnapshot.itemKind
        && persistedGoalSnapshot.providerFields.length > 0
        ? {
            path: persistedGoalSnapshot.path,
            itemKind: persistedGoalSnapshot.itemKind,
            providerFields: persistedGoalSnapshot.providerFields,
        }
        : undefined;

    const capabilityDriven = value.capabilityDriven === true;
    // Capability-driven gating reads the persisted goal item's `goalCapabilities` instead of the
    // session backend mode, so it requires a persisted-goal snapshot but no mode
    // candidates. Mode-driven gating (the original Codex shape) still requires the full mode model.
    if (capabilityDriven) {
        if (!providerId || !validPersistedGoalSnapshot) {
            diagnostics.push(createUiProjectionDiagnostic(
                'A16X1_MALFORMED_DESCRIPTOR',
                'workState.editableGoals',
                'Capability-driven editable-goals descriptors require a persisted-goal snapshot.',
            ));
            return null;
        }
        return {
            providerId,
            capabilityDriven: true,
            modeValues,
            activeModeValues,
            activeWhenNoPersistedMode: value.activeWhenNoPersistedMode === true,
            persistedGoalSnapshot: validPersistedGoalSnapshot,
        };
    }

    if (!providerId || modeValues.length === 0 || activeModeValues.length === 0) {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_MALFORMED_DESCRIPTOR',
            'workState.editableGoals',
            'Editable-goals descriptors require mode values and active mode values.',
        ));
        return null;
    }

    return {
        providerId,
        modeValues,
        activeModeValues,
        activeWhenNoPersistedMode: value.activeWhenNoPersistedMode === true,
        ...(validPersistedGoalSnapshot ? { persistedGoalSnapshot: validPersistedGoalSnapshot } : {}),
    };
}

function hasPersistedGoalWorkState(
    metadata: unknown,
    descriptor: EditableGoalsDescriptor,
): boolean {
    const snapshotDescriptor = descriptor.persistedGoalSnapshot;
    if (!snapshotDescriptor) return false;
    const snapshot = readValueAtPath(metadata, snapshotDescriptor.path);
    if (!isRecord(snapshot) || snapshot.v !== 1 || !Array.isArray(snapshot.items)) return false;
    const providerMatches = snapshotDescriptor.providerFields.some((field) => snapshot[field] === descriptor.providerId);
    if (!providerMatches) return false;
    return snapshot.items.some((item) => isRecord(item) && item.kind === snapshotDescriptor.itemKind);
}

/**
 * Capability-driven goal-edit presence (e.g. Claude): the persisted goal item must carry
 * `goalCapabilities.canEdit === true`, which the provider's work-state source publishes once it has
 * observed native goal support. Provider-agnostic — no provider-name branching; the descriptor
 * supplies the provider id + item kind.
 */
function hasEditableGoalCapability(
    metadata: unknown,
    descriptor: EditableGoalsDescriptor,
): boolean {
    const snapshotDescriptor = descriptor.persistedGoalSnapshot;
    if (!snapshotDescriptor) return false;
    const snapshot = readValueAtPath(metadata, snapshotDescriptor.path);
    if (!isRecord(snapshot) || snapshot.v !== 1 || !Array.isArray(snapshot.items)) return false;
    return snapshot.items.some((item) => {
        if (!isRecord(item) || item.kind !== snapshotDescriptor.itemKind) return false;
        const capabilities = item.goalCapabilities;
        return isRecord(capabilities) && capabilities.canEdit === true;
    });
}

type SessionGoalControlCapabilities = Readonly<{
    sessionGoalSetSupported?: boolean | null;
    sessionGoalClearSupported?: boolean | null;
}>;

type EditableGoalsSession = Readonly<{
    active?: boolean;
    metadata?: unknown;
    agentState?: Readonly<{
        capabilities?: SessionGoalControlCapabilities | null;
    }> | null;
}>;

function readLiveGoalActionCapabilityProfile(
    session: EditableGoalsSession,
): Readonly<{ canEdit: boolean; canStop: false; canClear: boolean; canConfigureBudget: false }> | null {
    const execution = resolveSessionGoalExecutionCapabilities({ session });
    if (!execution.canSet && !execution.canClear) return null;
    return {
        canEdit: execution.canSet,
        canStop: false,
        canClear: execution.canClear,
        canConfigureBudget: false,
    };
}

function createWorkStateBehavior(
    descriptor: PluginUiBehaviorDescriptor,
    agentId: string,
    diagnostics: UiProjectionDiagnostic[],
): AgentUiBehavior['workState'] | undefined {
    const editableGoals = readEditableGoalsDescriptor(descriptor.workState?.editableGoals, agentId, diagnostics);
    if (!editableGoals) return undefined;
    const supportsEditableGoals = (ctx: { agentId: string; session: EditableGoalsSession }): boolean => {
        if (ctx.agentId !== editableGoals.providerId) return false;
        const session = ctx.session;
        const metadata = readOwnerMetadataFromSessionLike(session);
        if (editableGoals.capabilityDriven) {
            // Active sessions trust the live session RPC registry, not a semantic provider signal
            // such as `/goal` discovery or a persisted goal item. Detached sessions retain the
            // persisted item capability so resume-oriented surfaces keep their semantic context.
            if (session.active === true) return readLiveGoalActionCapabilityProfile(session) !== null;
            return hasEditableGoalCapability(metadata, editableGoals);
        }
        const mode = readDeclaredPersistedMode(editableGoals.providerId, editableGoals.modeValues, metadata)
            // The canonical envelope above is what an installed Agent occupies;
            // the reader below knows a bundled Agent's released pre-envelope
            // metadata shapes and answers for nothing else.
            ?? resolvePersistedProviderSessionBackendMode({
                agentId: editableGoals.providerId,
                metadata,
            });
        if (mode) return editableGoals.activeModeValues.includes(mode);
        if (editableGoals.activeWhenNoPersistedMode && session.active === true) return true;
        return hasPersistedGoalWorkState(metadata, editableGoals);
    };

    return {
        supportsEditableGoals,
        // Capability-driven providers (e.g. Claude) restrict the goal-action control surface to
        // edit/clear (no pause/resume/complete, no token budget) — the SAME `{ canEdit, canClear }`
        // capabilities the work-state source attaches to a goal item once one exists. Exposing it at
        // the session level lets the "Set goal" form (no goal item yet) hide the Codex-only budget
        // editor (QA-CHIP-2). Null when not goal-editable so the gate stays the single source of
        // visibility truth and the full legacy surface applies elsewhere. Mode-driven providers
        // (Codex) supply no profile → full control, unchanged.
        ...(editableGoals.capabilityDriven
            ? {
                resolveGoalActionCapabilityProfile: ({ agentId, session }) => {
                    if (agentId !== editableGoals.providerId) return null;
                    const liveProfile = readLiveGoalActionCapabilityProfile(session);
                    if (session.active === true) return liveProfile;
                    if (!supportsEditableGoals({ agentId, session })) return null;
                    return { canEdit: true, canStop: false, canClear: true, canConfigureBudget: false };
                },
            }
            : {}),
    };
}

function mergePayloadBehavior(
    a: AgentUiBehavior['payload'] | undefined,
    b: AgentUiBehavior['payload'] | undefined,
): AgentUiBehavior['payload'] | undefined {
    if (!a && !b) return undefined;
    const merged = { ...(a ?? {}), ...(b ?? {}) };
    // Several declarations can contribute spawn extras (config-option state and
    // backend-mode extras are independent). A shallow merge would silently drop
    // whichever one was declared first, so the spawn envelope is composed here,
    // at the one place payload behaviors meet.
    if (a?.buildSpawnSessionExtras && b?.buildSpawnSessionExtras) {
        merged.buildSpawnSessionExtras = (opts) => {
            const first = a.buildSpawnSessionExtras!(opts);
            const second = b.buildSpawnSessionExtras!({
                ...opts,
                sessionConfigOptionOverrides:
                    first.sessionConfigOptionOverrides ?? opts.sessionConfigOptionOverrides ?? null,
            });
            return { ...first, ...second };
        };
    }
    return merged;
}

function readAgentOptionDescriptors(
    value: unknown,
    diagnostics: UiProjectionDiagnostic[],
): readonly AgentOptionDescriptor[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_MALFORMED_DESCRIPTOR',
            'newSession.agentOptions',
            'Agent option descriptors must be declared as an array.',
        ));
        return [];
    }
    return value.flatMap((entry, index) => {
        const key = isRecord(entry) ? readString(entry.key) : null;
        if (!key || !isRecord(entry) || entry.kind !== 'boolean') {
            diagnostics.push(createUiProjectionDiagnostic(
                'A16X1_MALFORMED_DESCRIPTOR',
                `newSession.agentOptions.${index}`,
                'Agent option descriptors require a non-empty key and a supported kind.',
            ));
            return [];
        }
        return [{
            key,
            kind: 'boolean' as const,
            ...(entry.spawnConfigOption === true ? { spawnConfigOption: true } : {}),
        }];
    });
}

/**
 * Reads the declared new-session option state the composer holds for this Agent.
 * The host normalizes every declared key so a spawn payload never depends on
 * whether the user touched the control.
 */
function createAgentOptionsNewSessionBehavior(
    options: readonly AgentOptionDescriptor[],
): AgentUiBehavior['newSession'] | undefined {
    if (options.length === 0) return undefined;
    return {
        buildNewSessionOptions: ({ agentOptionState }) => Object.fromEntries(
            options.map((option) => [option.key, agentOptionState?.[option.key] === true]),
        ),
    };
}

function createAgentOptionsPayloadBehavior(
    options: readonly AgentOptionDescriptor[],
): AgentUiBehavior['payload'] | undefined {
    const spawnOptions = options.filter((option) => option.spawnConfigOption === true);
    if (spawnOptions.length === 0) return undefined;
    return {
        buildSpawnSessionExtras: ({ newSessionOptions, sessionConfigOptionOverrides, updatedAt }) => {
            const declared = newSessionOptions ?? {};
            const configOptions = Object.fromEntries(
                spawnOptions
                    .filter((option) => Object.prototype.hasOwnProperty.call(declared, option.key))
                    .map((option) => [option.key, declared[option.key] === true] as const),
            );
            if (Object.keys(configOptions).length === 0) return {};
            return {
                sessionConfigOptionOverrides: mergeSpawnConfigOptionAliases({
                    sessionConfigOptionOverrides: sessionConfigOptionOverrides ?? undefined,
                    configOptions,
                    updatedAt,
                }),
            };
        },
    };
}

function createPayloadBehavior(
    descriptor: PluginUiBehaviorDescriptor,
    agentId: string,
    diagnostics: UiProjectionDiagnostic[],
    agentOptions: readonly AgentOptionDescriptor[],
): AgentUiBehavior['payload'] | undefined {
    const spawnSessionExtras = normalizePayloadDescriptor(descriptor.payload?.spawnSessionExtras);
    const staticPayload = (() => {
        if (!spawnSessionExtras) return undefined;

        if (spawnSessionExtras.kind === 'adapter') {
            diagnostics.push(createUiProjectionDiagnostic(
                'A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER',
                'payload.spawnSessionExtras',
                `Unsupported UI behavior payload adapter '${spawnSessionExtras.adapterId}'.`,
            ));
            return undefined;
        }

        return {
            buildSpawnSessionExtras: () => ({ ...spawnSessionExtras.value }),
        } satisfies AgentUiBehavior['payload'];
    })();
    const sessionExtrasDescriptor = readSessionExtrasDescriptor(descriptor.payload?.sessionExtras, agentId, diagnostics);
    const sessionExtrasPayload = sessionExtrasDescriptor
        ? createSessionExtrasPayloadBehavior(sessionExtrasDescriptor)
        : undefined;

    return mergePayloadBehavior(
        mergePayloadBehavior(staticPayload, createAgentOptionsPayloadBehavior(agentOptions)),
        sessionExtrasPayload,
    );
}

function readFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readObjectUpdatedAt(value: unknown): number | null {
    return isRecord(value) ? readFiniteNumber(value.updatedAt) : null;
}

function hasOwnField(value: unknown, key: string): boolean {
    return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function hasListedMetaOverride(
    metaOverrides: Record<string, unknown> | null | undefined,
    metaKeys: readonly string[],
): boolean {
    if (!metaOverrides) return false;
    return metaKeys.some((key) => Object.prototype.hasOwnProperty.call(metaOverrides, key));
}

function isOverrideNewerThanSource(
    override: unknown,
    overrideContainer: unknown,
    source: unknown,
): boolean {
    const overrideUpdatedAt = readObjectUpdatedAt(override) ?? readObjectUpdatedAt(overrideContainer);
    const sourceUpdatedAt = readObjectUpdatedAt(source);
    return overrideUpdatedAt == null || sourceUpdatedAt == null || overrideUpdatedAt > sourceUpdatedAt;
}

function hasFreshConfigOptionOverride(
    metadata: Record<string, unknown>,
    optionIds: readonly string[],
): boolean {
    const candidates = [
        {
            overrides: metadata.sessionConfigOptionOverridesV1,
            source: metadata.sessionConfigOptionsV1,
        },
        {
            overrides: metadata.acpConfigOptionOverridesV1,
            source: metadata.acpConfigOptionsV1,
        },
    ] as const;

    for (const candidate of candidates) {
        if (!isRecord(candidate.overrides) || !isRecord(candidate.overrides.overrides)) continue;
        for (const optionId of optionIds) {
            if (!hasOwnField(candidate.overrides.overrides, optionId)) continue;
            if (isOverrideNewerThanSource(candidate.overrides.overrides[optionId], candidate.overrides, candidate.source)) {
                return true;
            }
        }
    }

    return false;
}

function readSessionField(
    session: AgentSessionComposerNonSteerablePayloadContext['session'],
    key: string,
): unknown {
    return (session as unknown as Record<string, unknown>)[key];
}

function hasFreshModelOverride(ctx: AgentSessionComposerNonSteerablePayloadContext): boolean {
    const metadata = readOwnerMetadataFromSessionLike(ctx.session) ?? {};
    const disposition = resolveSessionModelSelectionDisposition({
        agentId: ctx.agentId,
        agentTargetKey: ctx.agentTargetKey,
        metadata: metadata as Metadata,
        sessionActive: ctx.session.active === true,
        currentRunnerProcessIdentity: ctx.currentRunnerProcessIdentity,
    });
    if (disposition.proposedIntent !== null) {
        return disposition.selectionTransitionPending;
    }

    const localModelId = readString(readSessionField(ctx.session, 'modelMode'));
    if (!localModelId || localModelId === 'default') return false;
    const activeSelection = disposition.activeSelection;
    return activeSelection !== null
        && (activeSelection.providerConnectionId !== null
            || activeSelection.modelId !== localModelId);
}

function createSessionComposerBehavior(
    descriptor: PluginUiBehaviorDescriptor,
): AgentUiBehavior['sessionComposer'] | undefined {
    const nonSteerable = descriptor.sessionComposer?.nonSteerableWhileBusy;
    if (!nonSteerable) return undefined;

    const reason = nonSteerable.reason ?? 'provider_config_change_refused';
    const metaKeys = readStringArray(nonSteerable.metaKeys);
    const sessionConfigOptionIds = readStringArray(nonSteerable.sessionConfigOptionIds);
    const freshModelOverride = nonSteerable.freshModelOverride === true;

    return {
        classifyNonSteerablePayload: (ctx) => {
            const metadata = readOwnerMetadataFromSessionLike(ctx.session) ?? {};
            if (hasListedMetaOverride(ctx.metaOverrides, metaKeys)) {
                return reason;
            }
            if (hasFreshConfigOptionOverride(metadata, sessionConfigOptionIds)) {
                return reason;
            }
            if (freshModelOverride && hasFreshModelOverride(ctx)) {
                return reason;
            }
            return null;
        },
    };
}

function readSessionMetadata(session: unknown): Record<string, unknown> | null {
    return readOwnerMetadataFromSessionLike(session);
}

function readSessionConfigOptionOverrideValue(raw: unknown, key: string): unknown {
    if (!isRecord(raw) || raw.v !== 1) return undefined;
    const overrides = isRecord(raw.overrides) ? raw.overrides : null;
    const override = isRecord(overrides?.[key]) ? overrides[key] : null;
    return override?.value;
}

function normalizeMessageMetaValue(value: unknown, mode: MessageMetaOverrideDescriptor['normalize']): unknown {
    if (mode !== 'trimLowercase') return value;
    const normalized = readString(value)?.toLowerCase() ?? null;
    return normalized ?? undefined;
}

function createMessageBehavior(
    descriptor: PluginUiBehaviorDescriptor,
    diagnostics: UiProjectionDiagnostic[],
): AgentUiBehavior['message'] | undefined {
    for (const [index, descriptorId] of readStringArray(descriptor.message?.metaDescriptorIds).entries()) {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER',
            `message.metaDescriptorIds.${index}`,
            `Unsupported message-meta descriptor id '${descriptorId}'.`,
        ));
    }

    const overrides = (descriptor.message?.metaOverrides ?? []).filter((override, index) => {
        if (!readString(override.id) || !readString(override.targetKey)) {
            diagnostics.push(createUiProjectionDiagnostic(
                'A16X1_MALFORMED_DESCRIPTOR',
                `message.metaOverrides.${index}`,
                'Message-meta override descriptors require id and targetKey.',
            ));
            return false;
        }
        if (override.value.kind !== 'sessionConfigOptionOverride') {
            diagnostics.push(createUiProjectionDiagnostic(
                'A16X1_UNSUPPORTED_DESCRIPTOR_ADAPTER',
                `message.metaOverrides.${index}.value`,
                'Unsupported message-meta source descriptor.',
            ));
            return false;
        }
        return true;
    });

    if (overrides.length === 0) return undefined;

    return {
        buildOverrides: ({ session, metaOverrides }) => {
            const merged = isRecord(metaOverrides) ? { ...metaOverrides } : {};
            const metadata = readSessionMetadata(session);
            for (const override of overrides) {
                if (Object.prototype.hasOwnProperty.call(merged, override.targetKey)) continue;
                const aliases = [
                    SESSION_CONFIG_OPTION_OVERRIDES_KEY,
                    LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
                    ...readStringArray(override.value.aliases),
                ];
                const rawValue = readSessionConfigOptionOverrideValue(
                    readMetadataAliasValue(metadata, ...aliases),
                    override.value.key,
                );
                const normalized = normalizeMessageMetaValue(rawValue, override.normalize);
                if (normalized === undefined) continue;
                merged[override.targetKey] = normalized;
            }
            return Object.keys(merged).length > 0 ? merged : metaOverrides;
        },
    };
}

function createContextWindowBehaviorFromDescriptor(
    descriptor: ContextWindowDescriptor | undefined,
): AgentUiBehavior['contextWindow'] | undefined {
    if (!descriptor) return undefined;
    const defaultTokens = normalizePositiveInteger(descriptor.defaultTokens);
    const modelRules = normalizeContextWindowModelRules(descriptor.modelRules);
    const observedUsageBumpTokens = normalizeContextWindowBumpTokens(descriptor.observedUsageBumpTokens);
    if (defaultTokens === null && modelRules.length === 0 && observedUsageBumpTokens.length === 0) {
        return undefined;
    }

    return {
        ...(defaultTokens !== null
            ? { getDefaultContextWindowTokens: () => defaultTokens }
            : {}),
        ...(modelRules.length > 0
            ? {
                getContextWindowTokensForModel: ({ modelId, description }) => {
                    const normalizedModelId = normalizeModelId(modelId);
                    const normalizedDescription = normalizeModelId(description);
                    for (const rule of modelRules) {
                        const idMatches = rule.idSuffix
                            ? normalizedModelId.endsWith(rule.idSuffix)
                            : false;
                        const descriptionMatches = rule.descriptionIncludesAny?.some((entry) =>
                            normalizedDescription.includes(entry)) === true;
                        if (idMatches || descriptionMatches) return rule.tokens;
                    }
                    return null;
                },
            }
            : {}),
        ...(observedUsageBumpTokens.length > 0
            ? {
                bumpContextWindowTokensForObservedUsage: ({ contextWindowTokens, observedUsedTokens }) => {
                    const observed = normalizePositiveInteger(observedUsedTokens) ?? 0;
                    if (observed <= contextWindowTokens) return contextWindowTokens;
                    for (const known of observedUsageBumpTokens) {
                        if (known >= observed) return known;
                    }
                    return descriptor.trustObservedUsageBeyondKnown === true
                        ? observed
                        : contextWindowTokens;
                },
            }
            : {}),
    };
}

function hasNoExecuteBehaviorFields(value: Readonly<Record<string, unknown>>): boolean {
    const components = isRecord(value.components) ? value.components : null;
    const hasComponentSlots = Array.isArray(components?.slots) && components.slots.length > 0;
    return value.guidance != null
        || value.attachedSessionTerminal != null
        || value.pendingDelivery != null
        || value.permissions != null
        || value.workState != null
        || value.resume != null
        || value.sessionComposer != null
        || value.contextWindow != null
        || value.message != null
        || value.newSession != null
        || value.payload != null
        || value.externalSessions != null
        || value.sessionHandoff != null
        || hasComponentSlots;
}

function mergeDescriptorBehavior(a: AgentUiBehavior, b: AgentUiBehavior): AgentUiBehavior {
    return {
        ...(a.guidance || b.guidance ? { guidance: { ...(a.guidance ?? {}), ...(b.guidance ?? {}) } } : {}),
        ...(a.attachedSessionTerminal || b.attachedSessionTerminal
            ? {
                attachedSessionTerminal: {
                    ...(a.attachedSessionTerminal ?? {}),
                    ...(b.attachedSessionTerminal ?? {}),
                },
            }
            : {}),
        ...(a.pendingDelivery || b.pendingDelivery
            ? { pendingDelivery: { ...(a.pendingDelivery ?? {}), ...(b.pendingDelivery ?? {}) } }
            : {}),
        ...(a.permissions || b.permissions
            ? {
                permissions: {
                    ...(a.permissions ?? {}),
                    ...(b.permissions ?? {}),
                    ...(a.permissions?.footer || b.permissions?.footer
                        ? { footer: { ...(a.permissions?.footer ?? {}), ...(b.permissions?.footer ?? {}) } }
                        : {}),
                },
            }
            : {}),
        ...(a.resume || b.resume ? { resume: { ...(a.resume ?? {}), ...(b.resume ?? {}) } } : {}),
        ...(a.workState || b.workState ? { workState: { ...(a.workState ?? {}), ...(b.workState ?? {}) } } : {}),
        ...(a.sessionComposer || b.sessionComposer
            ? { sessionComposer: { ...(a.sessionComposer ?? {}), ...(b.sessionComposer ?? {}) } }
            : {}),
        ...(a.contextWindow || b.contextWindow
            ? { contextWindow: { ...(a.contextWindow ?? {}), ...(b.contextWindow ?? {}) } }
            : {}),
        ...(a.message || b.message ? { message: { ...(a.message ?? {}), ...(b.message ?? {}) } } : {}),
        ...(a.newSession || b.newSession ? { newSession: { ...(a.newSession ?? {}), ...(b.newSession ?? {}) } } : {}),
        ...(a.externalSessions || b.externalSessions
            ? {
                externalSessions: {
                    ...(a.externalSessions ?? {}),
                    ...(b.externalSessions ?? {}),
                    ...(a.externalSessions?.browse || b.externalSessions?.browse
                        ? { browse: { ...(a.externalSessions?.browse ?? {}), ...(b.externalSessions?.browse ?? {}) } }
                        : {}),
                },
            }
            : {}),
        ...(a.sessionHandoff || b.sessionHandoff ? { sessionHandoff: { ...(a.sessionHandoff ?? {}), ...(b.sessionHandoff ?? {}) } } : {}),
        ...(a.payload || b.payload ? { payload: { ...(a.payload ?? {}), ...(b.payload ?? {}) } } : {}),
        ...(a.sessionSubagents || b.sessionSubagents
            ? { sessionSubagents: { ...(a.sessionSubagents ?? {}), ...(b.sessionSubagents ?? {}) } }
            : {}),
    };
}

function readComponentSlots(components: ComponentSlotsDescriptor | undefined): readonly ComponentSlotDescriptor[] {
    return Array.isArray(components?.slots) ? components.slots : [];
}

function collectSubagentGroupKeys(
    subagents: readonly SessionSubagent[],
    descriptor: ComponentSlotDescriptor,
): readonly string[] {
    const kinds = new Set(readStringArray(descriptor.props?.teamIds?.subagentKinds));
    const ids = new Set<string>();
    for (const subagent of subagents) {
        if (kinds.size > 0 && !kinds.has(subagent.kind)) continue;
        const groupKey = readString(subagent.display.groupKey);
        if (groupKey) ids.add(groupKey);
    }
    return [...ids];
}

function createTeammateLauncherDetailsTab(
    descriptor: ComponentSlotDescriptor,
    teamId: string,
    pluginId: string,
    agentId: string,
    machineId: string | null,
): DetailsTab | null {
    const resourceKind = readString(descriptor.resourceKind);
    const keyPrefix = readString(descriptor.tab?.keyPrefix);
    const titleKey = readString(descriptor.tab?.titleKey);
    if (!resourceKind || !keyPrefix || !titleKey) return null;
    const surfaceId = readString(descriptor.surfaceId);
    if (!surfaceId) return null;

    const normalizedTeamId = readString(teamId);
    return {
        key: normalizedTeamId ? `${keyPrefix}:member:${normalizedTeamId}` : `${keyPrefix}:member`,
        kind: resourceKind,
        title: tLoose(titleKey),
        ...(descriptor.tab?.subtitleKey ? { subtitle: tLoose(descriptor.tab.subtitleKey) } : {}),
        resource: {
            kind: resourceKind,
            mode: 'member',
            pluginInlineSurface: {
                pluginId,
                agentId,
                surfaceId,
                iconName: readString(descriptor.iconName),
                machineId,
            },
            ...(normalizedTeamId ? { initialTeamId: normalizedTeamId } : {}),
        },
    };
}

function createSessionSubagentsBehaviorFromComponents(
    components: ComponentSlotsDescriptor | undefined,
    diagnostics: UiProjectionDiagnostic[],
    pluginId: string,
    agentId: string,
): AgentUiBehavior['sessionSubagents'] | undefined {
    const slots = readComponentSlots(components);
    const launchCardSlots = slots.filter((slot) => slot.slot === 'sessionSubagents.launchCards');
    const detailsTabSlots = slots.filter((slot) => slot.slot === 'sessionSubagents.teammateDetailsTab');
    if (launchCardSlots.length === 0 && detailsTabSlots.length === 0) return undefined;

    return {
        ...(launchCardSlots.length > 0
            ? {
                renderLaunchCards: ({ sessionId, session, subagents, renderInlineSurface }) => {
                    const rendered: ReactNode[] = [];
                    for (const slot of launchCardSlots) {
                        const surfaceId = readString(slot.surfaceId);
                        if (!surfaceId) continue;
                        const metadata = readOwnerMetadataFromSessionLike(session);
                        rendered.push(renderInlineSurface({
                            slotId: slot.id,
                            pluginId,
                            surfaceId,
                            sessionId,
                            machineId: readString(metadata?.machineId),
                            agentId,
                            launchInput: { teamIds: collectSubagentGroupKeys(subagents, slot) },
                        }));
                    }
                    return rendered;
                },
            }
            : {}),
        ...(detailsTabSlots.length > 0
            ? {
                createTeammateLauncherDetailsTab: ({ teamId, session }) => {
                    const metadata = readOwnerMetadataFromSessionLike(session);
                    for (const slot of detailsTabSlots) {
                        const tab = createTeammateLauncherDetailsTab(
                            slot,
                            teamId,
                            pluginId,
                            agentId,
                            readString(metadata?.machineId),
                        );
                        if (tab) return tab;
                    }
                    return null;
                },
            }
            : {}),
    };
}

function readBooleanOptionChipDescriptor(
    slot: ComponentSlotDescriptor,
    diagnostics: UiProjectionDiagnostic[],
): BooleanOptionChipDescriptor | null {
    const chip = slot.chip;
    if (!isRecord(chip) || chip.kind !== 'booleanOption') {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_MALFORMED_DESCRIPTOR',
            'components.slots.chip',
            `Unsupported action chip declaration for slot '${readString(slot.id) ?? ''}'.`,
        ));
        return null;
    }
    const optionStateKey = readString(chip.optionStateKey);
    const iconName = readString(chip.iconName);
    const onLabelKey = readString(chip.onLabelKey);
    const offLabelKey = readString(chip.offLabelKey);
    if (!optionStateKey || !iconName || !onLabelKey || !offLabelKey) {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_MALFORMED_DESCRIPTOR',
            'components.slots.chip',
            'Boolean option chips require an option state key, icon name, and both label keys.',
        ));
        return null;
    }
    return { kind: 'booleanOption', optionStateKey, iconName, onLabelKey, offLabelKey };
}

function createNewSessionActionChipsBehaviorFromComponents(
    components: ComponentSlotsDescriptor | undefined,
    diagnostics: UiProjectionDiagnostic[],
): AgentUiBehavior['newSession'] | undefined {
    const slots = readComponentSlots(components)
        .filter((slot) => slot.slot === 'newSession.agentInputExtraActionChips');
    if (slots.length === 0) return undefined;

    return {
        getAgentInputExtraActionChips: ({ agentOptionState, setAgentOptionState }) => {
            const chips: AgentInputExtraActionChip[] = [];
            for (const slot of slots) {
                const chipDescriptor = readBooleanOptionChipDescriptor(slot, diagnostics);
                if (!chipDescriptor) continue;
                chips.push(createBooleanOptionActionChip({
                    key: readString(slot.id) ?? chipDescriptor.optionStateKey,
                    optionStateKey: chipDescriptor.optionStateKey,
                    iconName: chipDescriptor.iconName,
                    onLabelKey: chipDescriptor.onLabelKey,
                    offLabelKey: chipDescriptor.offLabelKey,
                    value: agentOptionState?.[chipDescriptor.optionStateKey] === true,
                    setValue: (value) => setAgentOptionState(chipDescriptor.optionStateKey, value),
                }));
            }
            return chips;
        },
    };
}

function hasBehaviorFields(value: Readonly<Record<string, unknown>>): boolean {
    return Object.keys(value).length > 0;
}

/**
 * The declared half of pending-input custody presentation. The host owns the
 * decision and the capability it reads; a malformed declaration refuses
 * fail-closed so the author sees the refusal instead of a silent no-op.
 */
function createPendingDeliveryBehavior(
    descriptor: PluginUiBehaviorDescriptor,
    diagnostics: UiProjectionDiagnostic[],
): AgentUiBehavior['pendingDelivery'] | null {
    const declared = descriptor.pendingDelivery;
    if (!declared) return null;
    const custodyLabelKey = readString(declared.custodyLabelKey);
    if (declared.custodyLabelKey !== undefined && !custodyLabelKey) {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_MALFORMED_DESCRIPTOR',
            'pendingDelivery.custodyLabelKey',
            'Pending-delivery custody labels require a non-empty translation key.',
        ));
    }
    const behavior: NonNullable<AgentUiBehavior['pendingDelivery']> = {
        ...(custodyLabelKey ? { custodyLabelKey: custodyLabelKey as TranslationKey } : {}),
        ...(declared.interruptAndRun === true ? { interruptAndRun: true } : {}),
    };
    return Object.keys(behavior).length > 0 ? behavior : null;
}

const PERMISSION_PROMPT_PROTOCOLS = ['claude', 'codexDecision'] as const satisfies readonly PermissionPromptProtocol[];

/**
 * The declared half of permission-prompt handling.
 *
 * `promptProtocol` selects which conversation the footer runs — button set,
 * handlers and terminal-decision reading — so an unreadable value is refused
 * fail-closed and the neutral default applies, rather than an Agent silently
 * impersonating another Agent family's action model.
 */
function createPermissionsBehavior(
    descriptor: PluginUiBehaviorDescriptor,
    diagnostics: UiProjectionDiagnostic[],
): AgentUiBehavior['permissions'] | undefined {
    const declared = descriptor.permissions;
    if (!declared) return undefined;
    const rawProtocol = declared.promptProtocol;
    const promptProtocol = PERMISSION_PROMPT_PROTOCOLS.find((entry) => entry === rawProtocol) ?? null;
    if (rawProtocol !== undefined && !promptProtocol) {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_MALFORMED_DESCRIPTOR',
            'permissions.promptProtocol',
            `Unsupported permission prompt protocol '${String(rawProtocol)}'.`,
        ));
    }
    const { promptProtocol: _declaredProtocol, ...rest } = declared;
    return {
        ...rest,
        ...(promptProtocol ? { promptProtocol } : {}),
    };
}

function createAgentUiBehaviorFromBehaviorDescriptor(
    descriptor: PluginUiBehaviorDescriptor,
    agentId: string,
    pluginId: string,
    diagnostics: UiProjectionDiagnostic[],
): AgentUiBehavior {
    const relevantInstallableDepKeys = readStringArray(descriptor.newSession?.relevantInstallableDepKeys);
    const conditionalRelevantInstallableDeps = (descriptor.newSession?.relevantInstallableDeps ?? [])
        .flatMap((entry) => {
            const keys = readStringArray(entry.keys);
            return keys.length > 0 ? [{ keys, when: entry.when }] : [];
        });
    const transcriptStorageModes = new Set(descriptor.newSession?.transcriptStorageModes ?? []);
    const agentOptions = readAgentOptionDescriptors(descriptor.newSession?.agentOptions, diagnostics);
    const payload = createPayloadBehavior(descriptor, agentId, diagnostics, agentOptions);
    const permissions = createPermissionsBehavior(descriptor, diagnostics);
    const workState = createWorkStateBehavior(descriptor, agentId, diagnostics);
    const sessionSubagents = createSessionSubagentsBehaviorFromComponents(
        descriptor.components,
        diagnostics,
        pluginId,
        agentId,
    );
    const newSessionActionChips = createNewSessionActionChipsBehaviorFromComponents(descriptor.components, diagnostics);
    const sessionComposer = createSessionComposerBehavior(descriptor);
    const contextWindow = createContextWindowBehaviorFromDescriptor(descriptor.contextWindow);
    const message = createMessageBehavior(descriptor, diagnostics);
    const pendingDelivery = createPendingDeliveryBehavior(descriptor, diagnostics);
    const experimentSwitches = (descriptor.resume?.experimentSwitches ?? [])
        .reduce<AgentExperimentSwitchDescriptor[]>((acc, entry, index) => {
            const id = readString(entry.id);
            if (!id) {
                diagnostics.push(createUiProjectionDiagnostic(
                    'A16X1_MALFORMED_DESCRIPTOR',
                    `resume.experimentSwitches.${index}.id`,
                    'Experiment switch descriptors require a non-empty id.',
                ));
                return acc;
            }
            acc.push({
                id,
                settingKey: entry.settingKey,
                when: entry.when,
            });
            return acc;
        }, []);

    const newSessionBehavior: NonNullable<AgentUiBehavior['newSession']> = {
        ...(relevantInstallableDepKeys.length > 0 || conditionalRelevantInstallableDeps.length > 0
            ? {
                getRelevantInstallableDepKeys: (ctx) => {
                    const keys = new Set(relevantInstallableDepKeys);
                    for (const entry of conditionalRelevantInstallableDeps) {
                        if (!evaluateDescriptorCondition(entry.when, ctx)) continue;
                        entry.keys.forEach((key) => keys.add(key));
                    }
                    return [...keys];
                },
            }
            : {}),
        ...(transcriptStorageModes.size > 0
            ? { supportsTranscriptStorageMode: ({ storageMode }) => transcriptStorageModes.has(storageMode) }
            : {}),
        ...(typeof descriptor.newSession?.canSelectWithoutDetectedCli === 'boolean'
            ? { canSelectWithoutDetectedCli: () => descriptor.newSession?.canSelectWithoutDetectedCli === true }
            : {}),
        ...(createAgentOptionsNewSessionBehavior(agentOptions) ?? {}),
        ...(newSessionActionChips ?? {}),
    };

    const baseBehavior: AgentUiBehavior = {
        ...(descriptor.attachedSessionTerminal?.supported === true
            ? { attachedSessionTerminal: { supported: true } }
            : {}),
        ...(pendingDelivery ? { pendingDelivery } : {}),
        ...(descriptor.guidance ? { guidance: { ...descriptor.guidance } } : {}),
        ...(permissions ? { permissions } : {}),
        ...(workState ? { workState } : {}),
        ...(experimentSwitches.length > 0
            ? {
                resume: {
                    experimentSwitches: experimentSwitches.map((entry) => ({
                        id: entry.id,
                        settingKey: entry.settingKey,
                        getValue: entry.when
                            ? (settings) => evaluateDescriptorCondition(entry.when, { settings })
                            : entry.settingKey
                            ? (settings) => settings[entry.settingKey as SettingsKey] === true
                            : undefined,
                    })),
                },
            }
            : {}),
        ...(hasBehaviorFields(newSessionBehavior) ? { newSession: newSessionBehavior } : {}),
        ...(payload ? { payload } : {}),
        ...(sessionComposer ? { sessionComposer } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(message ? { message } : {}),
        ...(sessionSubagents ? { sessionSubagents } : {}),
    };
    const adapterBehavior = createDescriptorAdapterBehavior({
        agentId,
        descriptor: descriptor as Readonly<Record<string, unknown>>,
        diagnostics,
    });

    return mergeDescriptorBehavior(baseBehavior, adapterBehavior);
}

export function createAgentUiBehaviorFromDescriptor(
    value: unknown,
    enclosingAgentId?: string,
): AgentUiBehaviorDescriptorResult {
    const diagnostics: UiProjectionDiagnostic[] = [];
    const normalizedEnclosingAgentId = readString(enclosingAgentId);
    if (isRecord(value) && value.kind == null) {
        if (hasNoExecuteBehaviorFields(value)) {
            return {
                behavior: createAgentUiBehaviorFromBehaviorDescriptor(
                    value as PluginUiBehaviorDescriptor,
                    normalizedEnclosingAgentId ?? '',
                    normalizedEnclosingAgentId ?? '',
                    diagnostics,
                ),
                diagnostics,
            };
        }
    }

    if (!isRecord(value) || value.kind !== 'plugin.ui.v1') {
        return {
            behavior: {},
            diagnostics: [
                createUiProjectionDiagnostic(
                    'A16X1_UNSUPPORTED_DESCRIPTOR_KIND',
                    'kind',
                    'Unsupported agent UI behavior descriptor kind.',
                ),
            ],
        };
    }

    const pluginDescriptor = value as PluginUiDescriptor;
    const agentId = normalizedEnclosingAgentId ?? readString(pluginDescriptor.agentId);
    if (!agentId) {
        return {
            behavior: {},
            diagnostics: [createUiProjectionDiagnostic(
                'A16X1_MALFORMED_DESCRIPTOR',
                'agentId',
                'Plugin UI descriptors require an Agent id.',
            )],
        };
    }
    const descriptor: PluginUiBehaviorDescriptor = {
        ...(pluginDescriptor.behavior ?? {}),
        ...(pluginDescriptor.message ? { message: pluginDescriptor.message } : {}),
        ...(pluginDescriptor.components ? { components: pluginDescriptor.components } : {}),
    };

    return {
        behavior: createAgentUiBehaviorFromBehaviorDescriptor(
            descriptor,
            agentId,
            readString(pluginDescriptor.pluginId) ?? agentId,
            diagnostics,
        ),
        diagnostics,
    };
}
