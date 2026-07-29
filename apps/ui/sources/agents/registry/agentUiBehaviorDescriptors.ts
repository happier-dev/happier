import type { ReactNode } from 'react';

import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { Settings } from '@/sync/domains/settings/settings';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import { tLoose } from '@/text';
import {
    LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
    readMetadataAliasValue,
    SESSION_CONFIG_OPTION_OVERRIDES_KEY,
} from '@happier-dev/agents';
import { isSlashCommandSupported } from '@happier-dev/protocol';

import type {
    AgentSessionComposerNonSteerablePayloadContext,
    AgentSessionComposerNonSteerableReason,
    AgentPermissionFooterBehavior,
    AgentResumeExperiments,
    AgentTranscriptStorageMode,
    AgentUiBehavior,
} from './registryUiBehavior';
import { resolveFirstPartyUiActionChip, resolveFirstPartyUiComponent } from './componentAllowlist';
import {
    createUiProjectionDiagnostic,
    isRecord,
    readString,
    readStringArray,
    type UiProjectionDiagnostic,
} from './uiDescriptorDiagnostics';
import { createDescriptorAdapterBehavior } from './agentUiBehaviorDescriptorAdapters';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

type SettingsKey = Extract<keyof Settings, string>;

function readOwnerMetadataFromSessionLike(session: unknown): Record<string, unknown> | null {
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

type ComponentSlotDescriptor = Readonly<{
    id: string;
    slot: string;
    componentId: string;
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
    guidance?: Readonly<{
        includeInSessionGettingStartedCliExamples?: boolean;
    }>;
    mcpServers?: Readonly<{
        supportsDetectedConfigScan?: boolean;
    }>;
    permissions?: Readonly<{
        footer?: Partial<AgentPermissionFooterBehavior>;
    }>;
    workState?: Readonly<{
        editableGoals?: Readonly<{
            providerId?: string;
            capabilityDriven?: boolean;
            modeValues?: readonly string[];
            activeModeValues?: readonly string[];
            activeWhenNoPersistedMode?: boolean;
            aliases?: Readonly<Record<string, string>>;
            modeCandidates?: readonly ModeCandidatePathDescriptor[];
            sessionCapability?: Readonly<{
                path?: readonly string[];
                includesValue?: string;
            }>;
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
    }>;
    payload?: Readonly<{
        spawnSessionExtras?: PayloadDescriptor;
        sessionExtras?: Readonly<{
            providerId?: string;
            outputKey?: string;
            values?: readonly string[];
            aliases?: Readonly<Record<string, string>>;
            settingsCandidates?: readonly ModeCandidatePathDescriptor[];
            metadataCandidates?: readonly ModeCandidatePathDescriptor[];
        }>;
        environmentVariables?: unknown;
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

type ModeCandidatePathDescriptor = Readonly<{
    path?: readonly string[];
    valueWhenTrue?: string;
    required?: Readonly<{
        path?: readonly string[];
        equals?: string;
    }>;
}>;

type SessionExtrasDescriptor = Readonly<{
    providerId: string;
    outputKey: string;
    values: readonly string[];
    aliases?: Readonly<Record<string, string>>;
    settingsCandidates: readonly ModeCandidatePathDescriptor[];
    metadataCandidates: readonly ModeCandidatePathDescriptor[];
}>;

type EditableGoalsSessionCapabilityDescriptor = Readonly<{
    path: readonly string[];
    includesValue: string;
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
    aliases?: Readonly<Record<string, string>>;
    modeCandidates: readonly ModeCandidatePathDescriptor[];
    // Session-level capability signal (e.g. Claude `/goal`): when an ACTIVE session's metadata at
    // `path` is an array that includes `includesValue`, the session is goal-editable BEFORE any goal
    // item exists — so the chip can be the first-goal entry point (resolves the chicken-and-egg).
    sessionCapability?: EditableGoalsSessionCapabilityDescriptor;
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

function readModeCandidatePath(value: unknown): ModeCandidatePathDescriptor | null {
    if (!isRecord(value)) return null;
    const path = readStringArray(value.path);
    const valueWhenTrue = readString(value.valueWhenTrue);
    const required = isRecord(value.required) ? value.required : null;
    const requiredPath = readStringArray(required?.path);
    const requiredEquals = readString(required?.equals);
    if (path.length === 0) return null;
    return {
        path,
        ...(valueWhenTrue ? { valueWhenTrue } : {}),
        ...(requiredPath.length > 0 && requiredEquals ? { required: { path: requiredPath, equals: requiredEquals } } : {}),
    };
}

function readSessionExtrasDescriptor(
    value: unknown,
    diagnostics: UiProjectionDiagnostic[],
): SessionExtrasDescriptor | null {
    if (!isRecord(value)) return null;
    const providerId = readString(value.providerId);
    const outputKey = readString(value.outputKey);
    const values = readStringArray(value.values);
    const aliases = isRecord(value.aliases) ? Object.fromEntries(
        Object.entries(value.aliases).flatMap(([key, aliasValue]) => {
            const normalizedKey = readString(key);
            const normalizedValue = readString(aliasValue);
            return normalizedKey && normalizedValue ? [[normalizedKey, normalizedValue] as const] : [];
        }),
    ) : undefined;
    const settingsCandidates = Array.isArray(value.settingsCandidates)
        ? value.settingsCandidates.flatMap((entry) => {
            const candidate = readModeCandidatePath(entry);
            return candidate ? [candidate] : [];
        })
        : [];
    const metadataCandidates = Array.isArray(value.metadataCandidates)
        ? value.metadataCandidates.flatMap((entry) => {
            const candidate = readModeCandidatePath(entry);
            return candidate ? [candidate] : [];
        })
        : [];

    if (!providerId || !outputKey || values.length === 0 || settingsCandidates.length === 0) {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_MALFORMED_DESCRIPTOR',
            'payload.sessionExtras',
            'Session extras descriptors require provider id, output key, allowed values, and settings candidates.',
        ));
        return null;
    }

    return {
        providerId,
        outputKey,
        values,
        aliases,
        settingsCandidates,
        metadataCandidates,
    };
}

function readValueAtPath(root: unknown, path: readonly string[]): unknown {
    let current = root;
    for (const key of path) {
        if (!isRecord(current)) return undefined;
        current = current[key];
    }
    return current;
}

function pathRequirementMatches(root: unknown, candidate: ModeCandidatePathDescriptor): boolean {
    const required = candidate.required;
    if (!required) return true;
    return readString(readValueAtPath(root, required.path ?? [])) === required.equals;
}

function normalizeSessionExtraMode(
    descriptor: SessionExtrasDescriptor,
    value: unknown,
): string | null {
    const normalized = normalizeDescriptorValue(value, descriptor.aliases);
    return normalized && descriptor.values.includes(normalized) ? normalized : null;
}

function readModeCandidate(
    root: unknown,
    candidate: ModeCandidatePathDescriptor,
    descriptor: SessionExtrasDescriptor,
): string | null {
    if (!pathRequirementMatches(root, candidate)) return null;
    const rawValue = readValueAtPath(root, candidate.path ?? []);
    if (candidate.valueWhenTrue && rawValue === true) {
        return normalizeSessionExtraMode(descriptor, candidate.valueWhenTrue);
    }
    return normalizeSessionExtraMode(descriptor, rawValue);
}

function resolveSessionExtraModeFromCandidates(
    root: unknown,
    candidates: readonly ModeCandidatePathDescriptor[],
    descriptor: SessionExtrasDescriptor,
): string | null {
    for (const candidate of candidates) {
        const value = readModeCandidate(root, candidate, descriptor);
        if (value) return value;
    }
    return null;
}

function createSessionExtrasPayloadBehavior(
    descriptor: SessionExtrasDescriptor,
): NonNullable<AgentUiBehavior['payload']> {
    const buildExtras = (mode: string | null): Record<string, unknown> => (
        mode ? { [descriptor.outputKey]: mode } : {}
    );
    const resolveSettingsMode = (settings: Readonly<Record<string, unknown>>) => resolveSessionExtraModeFromCandidates(
        settings,
        descriptor.settingsCandidates,
        descriptor,
    );
    const resolveSessionMode = (session: { metadata?: Record<string, unknown> | null } | null | undefined) => (
        resolveSessionExtraModeFromCandidates(readOwnerMetadataFromSessionLike(session), descriptor.metadataCandidates, descriptor)
    );

    return {
        buildSpawnSessionExtras: ({ agentId, settings }) => (
            agentId === descriptor.providerId ? buildExtras(resolveSettingsMode(settings)) : {}
        ),
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
    diagnostics: UiProjectionDiagnostic[],
): EditableGoalsDescriptor | null {
    if (!isRecord(value)) return null;
    const providerId = readString(value.providerId);
    const modeValues = readStringArray(value.modeValues);
    const activeModeValues = readStringArray(value.activeModeValues);
    const aliases = isRecord(value.aliases) ? Object.fromEntries(
        Object.entries(value.aliases).flatMap(([key, aliasValue]) => {
            const normalizedKey = readString(key);
            const normalizedValue = readString(aliasValue);
            return normalizedKey && normalizedValue ? [[normalizedKey, normalizedValue] as const] : [];
        }),
    ) : undefined;
    const modeCandidates = Array.isArray(value.modeCandidates)
        ? value.modeCandidates.flatMap((entry) => {
            const candidate = readModeCandidatePath(entry);
            return candidate ? [candidate] : [];
        })
        : [];
    const sessionCapabilityRaw = isRecord(value.sessionCapability) ? value.sessionCapability : null;
    const sessionCapabilityPath = readStringArray(sessionCapabilityRaw?.path);
    const sessionCapabilityIncludesValue = readString(sessionCapabilityRaw?.includesValue);
    const sessionCapability: EditableGoalsSessionCapabilityDescriptor | undefined =
        sessionCapabilityPath.length > 0 && sessionCapabilityIncludesValue
            ? { path: sessionCapabilityPath, includesValue: sessionCapabilityIncludesValue }
            : undefined;
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
    // session backend mode, so it requires a provider id + a persisted-goal snapshot but no mode
    // candidates. Mode-driven gating (the original Codex shape) still requires the full mode model.
    if (capabilityDriven) {
        if (!providerId || !validPersistedGoalSnapshot) {
            diagnostics.push(createUiProjectionDiagnostic(
                'A16X1_MALFORMED_DESCRIPTOR',
                'workState.editableGoals',
                'Capability-driven editable-goals descriptors require provider id and a persisted-goal snapshot.',
            ));
            return null;
        }
        return {
            providerId,
            capabilityDriven: true,
            modeValues,
            activeModeValues,
            activeWhenNoPersistedMode: value.activeWhenNoPersistedMode === true,
            aliases,
            modeCandidates,
            ...(sessionCapability ? { sessionCapability } : {}),
            persistedGoalSnapshot: validPersistedGoalSnapshot,
        };
    }

    if (!providerId || modeValues.length === 0 || activeModeValues.length === 0 || modeCandidates.length === 0) {
        diagnostics.push(createUiProjectionDiagnostic(
            'A16X1_MALFORMED_DESCRIPTOR',
            'workState.editableGoals',
            'Editable-goals descriptors require provider id, mode values, active mode values, and mode candidates.',
        ));
        return null;
    }

    return {
        providerId,
        modeValues,
        activeModeValues,
        activeWhenNoPersistedMode: value.activeWhenNoPersistedMode === true,
        aliases,
        modeCandidates,
        ...(sessionCapability ? { sessionCapability } : {}),
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

/**
 * Session-level goal capability (e.g. Claude `/goal`): the metadata value at the descriptor path is
 * an array that includes the configured value (e.g. `metadata.slashCommands` includes `'goal'`).
 * Published on every Claude launcher path, so it is present BEFORE any goal item is derived — which
 * is what lets the goal chip be the first-goal entry point on a fresh session. Provider-agnostic:
 * the descriptor supplies the metadata path and the required value. Fail-closed: absent/non-array.
 */
function hasSessionGoalCapability(
    metadata: unknown,
    descriptor: EditableGoalsDescriptor,
): boolean {
    const capability = descriptor.sessionCapability;
    if (!capability) return false;
    const value = readValueAtPath(metadata, capability.path);
    // Normalize the slash-command shape so `goal` and `/goal` both satisfy a `goal` capability (D2):
    // the runtime `slash_commands` list is inconsistent about the leading slash. Shared with the CLI
    // goal source through the same protocol helper, so the parity is defined once and cannot drift.
    return isSlashCommandSupported(value, capability.includesValue);
}

function createWorkStateBehavior(
    descriptor: PluginUiBehaviorDescriptor,
    diagnostics: UiProjectionDiagnostic[],
): AgentUiBehavior['workState'] | undefined {
    const editableGoals = readEditableGoalsDescriptor(descriptor.workState?.editableGoals, diagnostics);
    if (!editableGoals) return undefined;
    const modeReaderDescriptor: SessionExtrasDescriptor = {
        providerId: editableGoals.providerId,
        outputKey: 'mode',
        values: editableGoals.modeValues,
        aliases: editableGoals.aliases,
        settingsCandidates: editableGoals.modeCandidates,
        metadataCandidates: editableGoals.modeCandidates,
    };

    const supportsEditableGoals = (ctx: { agentId: string; session: { active?: boolean; metadata?: unknown } }): boolean => {
        if (ctx.agentId !== editableGoals.providerId) return false;
        const session = ctx.session;
        const metadata = readOwnerMetadataFromSessionLike(session);
        if (editableGoals.capabilityDriven) {
            // Two provider-derived signals (no provider-name branching beyond the descriptor's
            // own providerId), mirroring remote-dev's capability-driven Claude gate:
            //  1. Session-level `/goal` capability (e.g. `metadata.slashCommands` includes `goal`)
            //     — present BEFORE any goal item, so the chip is the first-goal entry point.
            //     Requires an ACTIVE session because `/goal` is injected live; inactive sessions
            //     seed through the goal-item path below. (QA-CHIP-1: resolves the chicken-and-egg.)
            if (session.active === true && hasSessionGoalCapability(metadata, editableGoals)) {
                return true;
            }
            //  2. A goal item already advertising `goalCapabilities.canEdit` — covers a resumable
            //     (detached) session restored from metadata that carries a prior goal, even while
            //     `slashCommands` is not re-published.
            return hasEditableGoalCapability(metadata, editableGoals);
        }
        const mode = resolveSessionExtraModeFromCandidates(
            metadata,
            editableGoals.modeCandidates,
            modeReaderDescriptor,
        );
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
    return a || b ? { ...(a ?? {}), ...(b ?? {}) } : undefined;
}

function createPayloadBehavior(
    descriptor: PluginUiBehaviorDescriptor,
    diagnostics: UiProjectionDiagnostic[],
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
    const sessionExtrasDescriptor = readSessionExtrasDescriptor(descriptor.payload?.sessionExtras, diagnostics);
    const sessionExtrasPayload = sessionExtrasDescriptor
        ? createSessionExtrasPayloadBehavior(sessionExtrasDescriptor)
        : undefined;

    return mergePayloadBehavior(staticPayload, sessionExtrasPayload);
}

function readFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readObjectUpdatedAt(value: unknown): number | null {
    return isRecord(value) ? readFiniteNumber(value.updatedAt) : null;
}

function readMaxUpdatedAt(values: readonly unknown[]): number | null {
    let max: number | null = null;
    for (const value of values) {
        const updatedAt = readObjectUpdatedAt(value);
        if (updatedAt == null) continue;
        max = max == null ? updatedAt : Math.max(max, updatedAt);
    }
    return max;
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

function isNonDefaultValue(value: unknown): boolean {
    const normalized = readString(value);
    return Boolean(normalized && normalized !== 'default');
}

function hasFreshModelOverride(ctx: AgentSessionComposerNonSteerablePayloadContext): boolean {
    const metadata = readOwnerMetadataFromSessionLike(ctx.session) ?? {};
    const modelSourceUpdatedAt = readMaxUpdatedAt([
        metadata.sessionModelsV1,
        metadata.acpSessionModelsV1,
    ]);
    const canonicalModelIntent = isRecord(metadata.modelSelectionIntentV1) ? metadata.modelSelectionIntentV1 : null;
    if (
        canonicalModelIntent
        && canonicalModelIntent.selection !== null
        && isOverrideNewerThanSource(canonicalModelIntent, canonicalModelIntent, { updatedAt: modelSourceUpdatedAt })
    ) {
        return true;
    }
    const metadataModelOverride = isRecord(metadata.modelOverrideV1) ? metadata.modelOverrideV1 : null;
    if (
        metadataModelOverride
        && isNonDefaultValue(metadataModelOverride.modelId)
        && isOverrideNewerThanSource(metadataModelOverride, metadataModelOverride, { updatedAt: modelSourceUpdatedAt })
    ) {
        return true;
    }

    if (!isNonDefaultValue(readSessionField(ctx.session, 'modelMode'))) return false;
    const localUpdatedAt = readFiniteNumber(readSessionField(ctx.session, 'modelModeUpdatedAt'));
    return localUpdatedAt != null && (modelSourceUpdatedAt == null || localUpdatedAt > modelSourceUpdatedAt);
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
        || value.mcpServers != null
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
        ...(a.mcpServers || b.mcpServers ? { mcpServers: { ...(a.mcpServers ?? {}), ...(b.mcpServers ?? {}) } } : {}),
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
): DetailsTab | null {
    const resourceKind = readString(descriptor.resourceKind);
    const keyPrefix = readString(descriptor.tab?.keyPrefix);
    const titleKey = readString(descriptor.tab?.titleKey);
    if (!resourceKind || !keyPrefix || !titleKey) return null;

    const normalizedTeamId = readString(teamId);
    return {
        key: normalizedTeamId ? `${keyPrefix}:member:${normalizedTeamId}` : `${keyPrefix}:member`,
        kind: resourceKind,
        title: tLoose(titleKey),
        ...(descriptor.tab?.subtitleKey ? { subtitle: tLoose(descriptor.tab.subtitleKey) } : {}),
        resource: {
            kind: resourceKind,
            mode: 'member',
            ...(normalizedTeamId ? { initialTeamId: normalizedTeamId } : {}),
        },
    };
}

function isDetailsTabResourceForSlot(tab: DetailsTab, descriptor: ComponentSlotDescriptor): boolean {
    const resourceKind = readString(descriptor.resourceKind);
    return Boolean(
        resourceKind
        && isRecord(tab.resource)
        && tab.resource.kind === resourceKind,
    );
}

function createSessionSubagentsBehaviorFromComponents(
    components: ComponentSlotsDescriptor | undefined,
    diagnostics: UiProjectionDiagnostic[],
): AgentUiBehavior['sessionSubagents'] | undefined {
    const slots = readComponentSlots(components);
    const launchCardSlots = slots.filter((slot) => slot.slot === 'sessionSubagents.launchCards');
    const detailsTabSlots = slots.filter((slot) => slot.slot === 'sessionSubagents.teammateDetailsTab');
    if (launchCardSlots.length === 0 && detailsTabSlots.length === 0) return undefined;

    return {
        ...(launchCardSlots.length > 0
            ? {
                renderLaunchCards: ({ sessionId, scopeId, subagents }) => {
                    const rendered: ReactNode[] = [];
                    for (const slot of launchCardSlots) {
                        const resolution = resolveFirstPartyUiComponent(slot.componentId);
                        if (resolution.diagnostic) diagnostics.push(resolution.diagnostic);
                        if (!resolution.render) continue;
                        rendered.push(resolution.render({
                            sessionId,
                            scopeId,
                            teamIds: collectSubagentGroupKeys(subagents, slot),
                        }));
                    }
                    return rendered;
                },
            }
            : {}),
        ...(detailsTabSlots.length > 0
            ? {
                createTeammateLauncherDetailsTab: ({ teamId }) => {
                    for (const slot of detailsTabSlots) {
                        const tab = createTeammateLauncherDetailsTab(slot, teamId);
                        if (tab) return tab;
                    }
                    return null;
                },
                renderDetailsTab: ({ sessionId, scopeId, tab }) => {
                    for (const slot of detailsTabSlots) {
                        if (!isDetailsTabResourceForSlot(tab, slot)) continue;
                        const resolution = resolveFirstPartyUiComponent(slot.componentId);
                        if (resolution.diagnostic) diagnostics.push(resolution.diagnostic);
                        if (!resolution.render || !isRecord(tab.resource)) continue;
                        return resolution.render({
                            sessionId,
                            scopeId,
                            mode: readString(tab.resource.mode),
                            initialTeamId: readString(tab.resource.initialTeamId),
                        });
                    }
                    return null;
                },
                getDetailsTabIconName: ({ tab }) => {
                    for (const slot of detailsTabSlots) {
                        if (!isDetailsTabResourceForSlot(tab, slot)) continue;
                        return readString(slot.iconName);
                    }
                    return null;
                },
            }
            : {}),
    };
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
                const resolution = resolveFirstPartyUiActionChip(slot.componentId);
                if (resolution.diagnostic) diagnostics.push(resolution.diagnostic);
                if (!resolution.render) continue;
                const chip = resolution.render({
                    agentOptionState,
                    setAgentOptionState,
                    optionStateKey: readString(slot.props?.optionStateKey),
                });
                if (chip) chips.push(chip);
            }
            return chips;
        },
    };
}

function hasBehaviorFields(value: Readonly<Record<string, unknown>>): boolean {
    return Object.keys(value).length > 0;
}

function createAgentUiBehaviorFromBehaviorDescriptor(
    descriptor: PluginUiBehaviorDescriptor,
    diagnostics: UiProjectionDiagnostic[],
): AgentUiBehavior {
    const relevantInstallableDepKeys = readStringArray(descriptor.newSession?.relevantInstallableDepKeys);
    const conditionalRelevantInstallableDeps = (descriptor.newSession?.relevantInstallableDeps ?? [])
        .flatMap((entry) => {
            const keys = readStringArray(entry.keys);
            return keys.length > 0 ? [{ keys, when: entry.when }] : [];
        });
    const transcriptStorageModes = new Set(descriptor.newSession?.transcriptStorageModes ?? []);
    const payload = createPayloadBehavior(descriptor, diagnostics);
    const workState = createWorkStateBehavior(descriptor, diagnostics);
    const sessionSubagents = createSessionSubagentsBehaviorFromComponents(descriptor.components, diagnostics);
    const newSessionActionChips = createNewSessionActionChipsBehaviorFromComponents(descriptor.components, diagnostics);
    const sessionComposer = createSessionComposerBehavior(descriptor);
    const contextWindow = createContextWindowBehaviorFromDescriptor(descriptor.contextWindow);
    const message = createMessageBehavior(descriptor, diagnostics);
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
        ...(newSessionActionChips ?? {}),
    };

    const baseBehavior: AgentUiBehavior = {
        ...(descriptor.guidance ? { guidance: { ...descriptor.guidance } } : {}),
        ...(descriptor.mcpServers ? { mcpServers: { ...descriptor.mcpServers } } : {}),
        ...(descriptor.permissions ? { permissions: { ...descriptor.permissions } } : {}),
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
        descriptor: descriptor as Readonly<Record<string, unknown>>,
        diagnostics,
    });

    return mergeDescriptorBehavior(baseBehavior, adapterBehavior);
}

export function createAgentUiBehaviorFromDescriptor(value: unknown): AgentUiBehaviorDescriptorResult {
    const diagnostics: UiProjectionDiagnostic[] = [];
    if (isRecord(value) && value.kind == null) {
        if (hasNoExecuteBehaviorFields(value)) {
            return {
                behavior: createAgentUiBehaviorFromBehaviorDescriptor(value as PluginUiBehaviorDescriptor, diagnostics),
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
    const descriptor: PluginUiBehaviorDescriptor = {
        ...(pluginDescriptor.behavior ?? {}),
        ...(pluginDescriptor.message ? { message: pluginDescriptor.message } : {}),
        ...(pluginDescriptor.components ? { components: pluginDescriptor.components } : {}),
    };

    return {
        behavior: createAgentUiBehaviorFromBehaviorDescriptor(descriptor, diagnostics),
        diagnostics,
    };
}
