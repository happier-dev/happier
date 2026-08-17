import type { ReactNode } from 'react';
import {
    buildBackendTargetKeyV2,
    readAcpConfiguredBackendV1FromMetadata,
    readBackendTargetRefV2,
    SessionModelSelectionIntentV1Schema,
    type BackendTargetRefV2,
    type BackendTargetRefV2Input,
    AccountProfile,
    type ExternalSessionsAgentId,
    type AcpConfigOptionOverridesV1,
    type PendingDeliveryDetailV1,
    ExternalSessionLinkEnsureRequest,
    ExternalSessionsSource,
    RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import type { CodexBackendMode } from '@happier-dev/protocol';
import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import type { AgentCoreConfig, AgentId, CanonicalAgentId } from './registryCore';
import {
    CANONICAL_AGENT_IDS,
    getAgentCore,
    resolveAgentIdFromFlavor,
    resolveAgentIdFromSessionMetadata,
} from './registryCore';
import type { CapabilityDetectResult, CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import type { TranslationKey } from '@/text';
import type { Settings } from '@/sync/domains/settings/settings';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { CurrentSessionRunnerProcessIdentity } from '@/sync/domains/models/resolveSessionModelSelectionDisposition';
import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';
import type { GoalActionCapabilities } from '@/components/sessions/workState/goalActionVisibility';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput';
import type { PendingInputServerWireMode } from '@/sync/engine/pending/pendingInputServerWireContract';
import {
    BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS,
    BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_OVERRIDES,
} from './generatedBundledPluginEntries.uiBehaviorOverrides';
import {
    createAgentUiBehaviorFromDescriptor,
} from './agentUiBehaviorDescriptors';
import { LEGACY_COMPAT_PRIMARY_AGENT_ID } from '@/agents/backendCatalog/legacyCompatAgents';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

type CapabilityResults = Partial<Record<CapabilityId, CapabilityDetectResult>>;

export type PendingDeliveryTransientAction = Readonly<{
    id: 'interrupt_and_run';
    localId: string;
    stateAtMs?: number;
}>;

// RU-02: allow legacy compat ids at ingress (never as canonical agents).
export type AgentLookupId = AgentId | typeof LEGACY_COMPAT_PRIMARY_AGENT_ID;

export type AgentExperimentSwitches = Readonly<Record<string, boolean>>;

export type AgentResumeExperiments = Readonly<{
    enabled: boolean;
    switches: AgentExperimentSwitches;
}>;

export type AgentSpawnSessionExtras = Readonly<{
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
}> & Readonly<Record<string, unknown>>;

export type AgentExperimentSwitchDef = Readonly<{
    id: string;
    settingKey?: keyof Settings;
    getValue?: (settings: Settings) => boolean;
}>;

export type AgentTranscriptStorageMode = 'persisted' | 'direct';
export type AgentPermissionFooterStopHandling = 'denyOnly' | 'denyAndAbortRun';
export type AgentPermissionFooterBehavior = Readonly<{
    usePermissionUpdates: boolean;
    forceReadOnlyAfterStop: boolean;
    supportsExecPolicyAmendment: boolean;
    stopHandling: AgentPermissionFooterStopHandling;
}>;

export type ExternalSessionBrowseSourceOption = Readonly<{
    key: string;
    label: string;
    detail?: string;
    source: ExternalSessionsSource;
}>;

export type ExternalSessionBrowseLinkEnsureRequestExtras = Readonly<
    Partial<Omit<ExternalSessionLinkEnsureRequest, 'machineId' | 'providerId' | 'remoteSessionId' | 'titleHint' | 'directoryHint'>>
>;

export type AgentSessionHandoffProviderPatch = Readonly<{
    clearMetadataKeys?: readonly string[];
    metadataPatch?: Record<string, unknown>;
    runtimeDescriptor?: RuntimeDescriptorV1 | null;
    externalSessionRuntimeDescriptor?: RuntimeDescriptorV1 | null;
}>;

export type AgentSessionHandoffSourceRecoveryResumePatch = Readonly<{
    environmentVariables?: Record<string, string>;
}>;

export type AgentSessionComposerNonSteerableReason = 'provider_config_change_refused';

export type AgentSessionComposerNonSteerablePayloadContext = Readonly<{
    agentId: AgentLookupId;
    agentTargetKey: string;
    session: Session;
    metaOverrides?: Record<string, unknown> | null;
    currentRunnerProcessIdentity: CurrentSessionRunnerProcessIdentity | null;
}>;

export type AgentContextWindowBehavior = Readonly<{
    getDefaultContextWindowTokens?: () => number | null;
    getContextWindowTokensForModel?: (ctx: Readonly<{
        modelId: string;
        description?: unknown;
    }>) => number | null;
    bumpContextWindowTokensForObservedUsage?: (ctx: Readonly<{
        contextWindowTokens: number;
        observedUsedTokens: unknown;
    }>) => number;
}>;

export type AgentBackendTransportFields = Readonly<{
    codexBackendMode?: CodexBackendMode;
    runtimeDescriptorV1?: RuntimeDescriptorV1;
}>;

export type AgentBackendTransportContext = Readonly<{
    agentId: AgentLookupId;
    backendTarget: BackendTargetRefV2;
    providerMode?: unknown;
    legacyExperimentalMode?: boolean;
    runtimeDescriptorV1?: RuntimeDescriptorV1;
    providerSessionId?: string;
}>;

export type AgentUiBehavior = Readonly<{
    pendingDelivery?: Readonly<{
        resolveLabelKey?: (ctx: Readonly<{
            agentId: AgentLookupId;
            session: Session;
            localId: string | null;
            detail: PendingDeliveryDetailV1 | undefined;
        }>) => TranslationKey | null;
        resolveTransientAction?: (ctx: Readonly<{
            agentId: AgentLookupId;
            session: Session;
            localId: string;
            wireMode: PendingInputServerWireMode;
        }>) => PendingDeliveryTransientAction | null;
    }>;
    attachedSessionTerminal?: Readonly<{
        isAvailable?: (ctx: Readonly<{
            agentId: AgentLookupId;
            session: Session;
        }>) => boolean;
    }>;
    guidance?: Readonly<{
        includeInSessionGettingStartedCliExamples?: boolean;
    }>;
    mcpServers?: Readonly<{
        supportsDetectedConfigScan?: boolean;
    }>;
    permissions?: Readonly<{
        footer?: Partial<AgentPermissionFooterBehavior>;
    }>;
    resume?: Readonly<{
        experimentSwitches?: readonly AgentExperimentSwitchDef[];
    }>;
    workState?: Readonly<{
        supportsEditableGoals?: (ctx: {
            agentId: AgentLookupId;
            session: Session;
        }) => boolean;
        /**
         * Provider goal-action capability profile applied when no goal item carries its own
         * `goalCapabilities` yet (the "Set goal" form before any native goal is derived). Lets a
         * provider restrict the control surface (e.g. Claude: edit/clear only, no budget) at the
         * session level without the goal-item round-trip. Return null to fall back to the full legacy
         * control surface.
         */
        resolveGoalActionCapabilityProfile?: (ctx: {
            agentId: AgentLookupId;
            session: Session;
        }) => GoalActionCapabilities | null;
    }>;
    sessionComposer?: Readonly<{
        classifyNonSteerablePayload?: (
            ctx: AgentSessionComposerNonSteerablePayloadContext
        ) => AgentSessionComposerNonSteerableReason | null;
    }>;
    workflow?: Readonly<{
        resolveAskUserQuestionPresentation?: (ctx: Readonly<{
            input: unknown;
            translate: (key: string) => string;
        }>) => unknown;
    }>;
    contextWindow?: AgentContextWindowBehavior;
    message?: Readonly<{
        buildOverrides?: (ctx: Readonly<{
            session: unknown;
            settings?: Record<string, unknown>;
            metaOverrides?: Record<string, unknown>;
        }>) => Record<string, unknown> | undefined;
    }>;
    newSession?: Readonly<{
        buildNewSessionOptions?: (ctx: {
            agentId: AgentLookupId;
            agentOptionState?: Record<string, unknown> | null;
        }) => Record<string, unknown> | null;
        canSelectWithoutDetectedCli?: (ctx: NewSessionCliSelectabilityContext) => boolean;
        getAgentInputExtraActionChips?: (ctx: {
            agentId: AgentLookupId;
            agentOptionState?: Record<string, unknown> | null;
            setAgentOptionState: (key: string, value: unknown) => void;
        }) => ReadonlyArray<AgentInputExtraActionChip> | undefined;
        supportsTranscriptStorageMode?: (ctx: {
            agentId: AgentLookupId;
            settings: Settings;
            storageMode: AgentTranscriptStorageMode;
        }) => boolean;
        getPreflightIssues?: (ctx: NewSessionPreflightContext) => readonly NewSessionPreflightIssue[];
        getRelevantInstallableDepKeys?: (ctx: NewSessionRelevantInstallableDepsContext) => readonly string[];
    }>;
    externalSessions?: Readonly<{
        supportsBackgroundFollow?: boolean;
        browse?: Readonly<{
            order?: number;
            getSourceOptions?: (ctx: {
                agentId: ExternalSessionsAgentId;
                profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
                settings: Settings;
            }) => readonly ExternalSessionBrowseSourceOption[];
            resolveLockedSourceOption?: (ctx: {
                agentId: ExternalSessionsAgentId;
                sourceOptions: readonly ExternalSessionBrowseSourceOption[];
                agentOptionState?: Record<string, unknown> | null;
                profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
                settings: Settings;
            }) => ExternalSessionBrowseSourceOption | null;
            buildLinkEnsureRequestExtras?: (ctx: {
                agentId: ExternalSessionsAgentId;
                source: ExternalSessionsSource;
                candidate: Readonly<{ details?: Record<string, unknown> }>;
            }) => ExternalSessionBrowseLinkEnsureRequestExtras;
            resolveCompatibleLinkSource?: (ctx: {
                agentId: ExternalSessionsAgentId;
                selectedSource: ExternalSessionsSource;
                candidateSource: ExternalSessionsSource;
            }) => ExternalSessionsSource | null;
        }>;
    }>;
    sessionHandoff?: Readonly<{
        buildProviderPatch?: (ctx: {
            agentId: AgentId;
            metadata: Record<string, unknown>;
            sourceMetadataForHandoff?: Record<string, unknown>;
            targetRemoteSessionId: string;
            targetDirectSource: ExternalSessionsSource | Record<string, unknown>;
            targetRuntimeDescriptor?: RuntimeDescriptorV1;
        }) => AgentSessionHandoffProviderPatch;
        buildSourceRecoveryResumePatch?: (ctx: {
            agentId: AgentId;
            metadata: Record<string, unknown>;
        }) => AgentSessionHandoffSourceRecoveryResumePatch;
    }>;
    payload?: Readonly<{
        buildSpawnEnvironmentVariables?: (opts: {
            agentId: AgentLookupId;
            settings: Settings;
            environmentVariables: Record<string, string> | undefined;
            newSessionOptions?: Record<string, unknown> | null;
        }) => Record<string, string> | undefined;
        buildSpawnSessionExtras?: (opts: {
            agentId: AgentLookupId;
            settings: Settings;
            experiments: AgentResumeExperiments;
            resumeSessionId: string;
            newSessionOptions?: Record<string, unknown> | null;
            sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
            updatedAt?: number;
        }) => AgentSpawnSessionExtras;
        buildResumeSessionExtras?: (opts: {
            agentId: AgentLookupId;
            experiments: AgentResumeExperiments;
            settings: Settings;
            session?: Session | null;
        }) => Record<string, unknown>;
        buildWakeResumeExtras?: (opts: {
            agentId: AgentLookupId;
            resumeCapabilityOptions: ResumeCapabilityOptions;
            session?: Session | null;
        }) => Record<string, unknown>;
        buildBackendTransportFields?: (opts: AgentBackendTransportContext) => AgentBackendTransportFields;
    }>;
    sessionSubagents?: Readonly<{
        renderLaunchCards?: (ctx: {
            sessionId: string;
            scopeId: string;
            session: Session;
            subagents: readonly SessionSubagent[];
        }) => readonly ReactNode[];
        createTeammateLauncherDetailsTab?: (ctx: {
            session: Session;
            teamId: string;
        }) => DetailsTab | null;
        renderDetailsTab?: (ctx: {
            sessionId: string;
            scopeId: string;
            tab: DetailsTab;
        }) => ReactNode | null;
        getDetailsTabIconName?: (ctx: { tab: DetailsTab }) => string | null;
    }>;
}>;

export type NewSessionPreflightContext = Readonly<{
    agentId: AgentLookupId;
    experiments: AgentResumeExperiments;
    resumeSessionId: string;
    results: CapabilityResults | undefined;
}>;

export type NewSessionCliSelectabilityContext = Readonly<{
    agentId: AgentLookupId;
    settings: Settings;
    agentOptionState?: Record<string, unknown> | null;
}>;

export type NewSessionRelevantInstallableDepsContext = Readonly<{
    agentId: AgentLookupId;
    settings: Settings;
    experiments: AgentResumeExperiments;
    resumeSessionId: string;
}>;

export type NewSessionPreflightIssue = Readonly<{
    id: string;
    titleKey: TranslationKey;
    messageKey: TranslationKey;
    confirmTextKey: TranslationKey;
    action: 'openMachine';
}>;

function mergeMessageBehavior(
    a: AgentUiBehavior['message'] | undefined,
    b: AgentUiBehavior['message'] | undefined,
): AgentUiBehavior['message'] | undefined {
    if (!a && !b) return undefined;
    if (!a?.buildOverrides || !b?.buildOverrides) {
        return { ...(a ?? {}), ...(b ?? {}) };
    }
    return {
        ...a,
        ...b,
        buildOverrides: (ctx) => {
            const first = a.buildOverrides?.(ctx) ?? ctx.metaOverrides;
            return b.buildOverrides?.({
                ...ctx,
                metaOverrides: first,
            }) ?? first;
        },
    };
}

function mergeAgentUiBehavior(a: AgentUiBehavior, b: AgentUiBehavior): AgentUiBehavior {
    const message = mergeMessageBehavior(a.message, b.message);
    return {
        ...(a.pendingDelivery || b.pendingDelivery
            ? { pendingDelivery: { ...(a.pendingDelivery ?? {}), ...(b.pendingDelivery ?? {}) } }
            : {}),
        ...(a.attachedSessionTerminal || b.attachedSessionTerminal
            ? {
                attachedSessionTerminal: {
                    ...(a.attachedSessionTerminal ?? {}),
                    ...(b.attachedSessionTerminal ?? {}),
                },
            }
            : {}),
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
        ...(a.workflow || b.workflow ? { workflow: { ...(a.workflow ?? {}), ...(b.workflow ?? {}) } } : {}),
        ...(a.contextWindow || b.contextWindow
            ? { contextWindow: { ...(a.contextWindow ?? {}), ...(b.contextWindow ?? {}) } }
            : {}),
        ...(message ? { message } : {}),
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
        ...(a.sessionHandoff || b.sessionHandoff
            ? { sessionHandoff: { ...(a.sessionHandoff ?? {}), ...(b.sessionHandoff ?? {}) } }
            : {}),
        ...(a.payload || b.payload ? { payload: { ...(a.payload ?? {}), ...(b.payload ?? {}) } } : {}),
        ...(a.sessionSubagents || b.sessionSubagents
            ? { sessionSubagents: { ...(a.sessionSubagents ?? {}), ...(b.sessionSubagents ?? {}) } }
            : {}),
    };
}

function buildDefaultAgentUiBehaviorFromCore(core: Pick<AgentCoreConfig, 'permissions' | 'sessionStorage'>): AgentUiBehavior {
    const promptProtocol = core.permissions.promptProtocol;

    return {
        permissions: {
            footer: {
                usePermissionUpdates: promptProtocol === 'claude',
                forceReadOnlyAfterStop: promptProtocol !== 'codexDecision',
                supportsExecPolicyAmendment: false,
                stopHandling: 'denyAndAbortRun',
            },
        },
        newSession: {
            supportsTranscriptStorageMode: ({ storageMode }) => core.sessionStorage[storageMode] === true,
        },
    };
}

function buildDefaultAgentUiBehavior(agentId: AgentId): AgentUiBehavior {
    return buildDefaultAgentUiBehaviorFromCore(getAgentCore(agentId));
}

const CANONICAL_AGENTS_UI_BEHAVIOR_OVERRIDES = BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_OVERRIDES;

function resolveGeneratedAgentUiBehavior(agentId: CanonicalAgentId): AgentUiBehavior {
    const generatedDescriptor = BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_DESCRIPTORS[agentId]?.descriptor;
    const generatedBehavior = generatedDescriptor
        ? createAgentUiBehaviorFromDescriptor(generatedDescriptor).behavior
        : {};
    return generatedBehavior;
}

export const CANONICAL_AGENTS_UI_BEHAVIOR: Readonly<Record<CanonicalAgentId, AgentUiBehavior>> = Object.freeze(
    Object.fromEntries(
        CANONICAL_AGENT_IDS.map((id: CanonicalAgentId) => {
            const base = buildDefaultAgentUiBehavior(id);
            const descriptorBehavior = resolveGeneratedAgentUiBehavior(id);
            const generatedOverride = CANONICAL_AGENTS_UI_BEHAVIOR_OVERRIDES[id] ?? {};
            return [
                id,
                mergeAgentUiBehavior(
                    mergeAgentUiBehavior(base, descriptorBehavior),
                    generatedOverride,
                ),
            ] as const;
        }),
    ) as Record<CanonicalAgentId, AgentUiBehavior>,
);

export const AGENTS_UI_BEHAVIOR: Readonly<Record<CanonicalAgentId, AgentUiBehavior>> = Object.freeze({
    ...CANONICAL_AGENTS_UI_BEHAVIOR,
});

const UNKNOWN_AGENT_UI_BEHAVIOR: AgentUiBehavior = Object.freeze({
    permissions: {
        footer: {
            usePermissionUpdates: false,
            forceReadOnlyAfterStop: true,
            supportsExecPolicyAmendment: false,
            stopHandling: 'denyAndAbortRun',
        },
    },
    newSession: {
        supportsTranscriptStorageMode: () => false,
    },
});

function isCanonicalAgentId(value: unknown): value is CanonicalAgentId {
    return typeof value === 'string' && (CANONICAL_AGENT_IDS as readonly string[]).includes(value);
}

function resolveKnownAgentUiBehavior(agentId: string | null | undefined): AgentUiBehavior | null {
    if (isCanonicalAgentId(agentId)) {
        return CANONICAL_AGENTS_UI_BEHAVIOR[agentId];
    }
    return null;
}

export function resolveAgentUiBehavior(agentId: string | null | undefined): AgentUiBehavior {
    const behavior = resolveKnownAgentUiBehavior(agentId);
    if (behavior) {
        return behavior;
    }
    return UNKNOWN_AGENT_UI_BEHAVIOR;
}

export function resolveAgentUiBehaviorFromFlavor(flavor: unknown): AgentUiBehavior | null {
    const agentId = typeof flavor === 'string' ? resolveAgentIdFromFlavor(flavor) : null;
    return agentId ? resolveAgentUiBehavior(agentId) : null;
}

export function resolveAgentUiBehaviorFromSessionMetadata(metadata: unknown): AgentUiBehavior | null {
    const agentId = resolveAgentIdFromSessionMetadata(metadata);
    return agentId ? resolveAgentUiBehavior(agentId) : null;
}

export function resolvePendingDeliveryLabelKeyForSession(ctx: Readonly<{
    session: Session;
    localId: string | null;
    detail: PendingDeliveryDetailV1 | undefined;
}>): TranslationKey | null {
    const agentId = resolveAgentIdFromSessionMetadata(readSessionOwnerMetadataView(ctx.session));
    if (!agentId) return null;
    return resolveAgentUiBehavior(agentId).pendingDelivery?.resolveLabelKey?.({
        agentId,
        session: ctx.session,
        localId: ctx.localId,
        detail: ctx.detail,
    }) ?? null;
}

export function resolvePendingDeliveryTransientActionForSession(ctx: Readonly<{
    session: Session;
    localId: string;
    wireMode: PendingInputServerWireMode;
}>): PendingDeliveryTransientAction | null {
    const agentId = resolveAgentIdFromSessionMetadata(readSessionOwnerMetadataView(ctx.session));
    if (!agentId) return null;
    return resolveAgentUiBehavior(agentId).pendingDelivery?.resolveTransientAction?.({
        agentId,
        session: ctx.session,
        localId: ctx.localId,
        wireMode: ctx.wireMode,
    }) ?? null;
}

export function isAttachedSessionTerminalAvailableForSession(session: Session): boolean {
    const agentId = resolveAgentIdFromSessionMetadata(readSessionOwnerMetadataView(session));
    if (!agentId) return false;
    const isAvailable = resolveAgentUiBehavior(agentId).attachedSessionTerminal?.isAvailable;
    return isAvailable?.({ agentId, session }) === true;
}

export function classifyAgentSessionComposerNonSteerablePayload(opts: {
    session: Session | null;
    agentTargetKey?: string | null;
    metaOverrides?: Record<string, unknown> | null;
    currentRunnerProcessIdentity?: CurrentSessionRunnerProcessIdentity | null;
}): AgentSessionComposerNonSteerableReason | null {
    const agentId = resolveAgentIdFromSessionMetadata(
        opts.session ? readSessionOwnerMetadataView(opts.session) : null,
    );
    if (!opts.session || !agentId) return null;
    const ownerMetadata = readSessionOwnerMetadataView(opts.session);
    const explicitAgentTargetKey = typeof opts.agentTargetKey === 'string'
        ? opts.agentTargetKey.trim()
        : '';
    const canonicalIntent = ownerMetadata
        && typeof ownerMetadata === 'object'
        && !Array.isArray(ownerMetadata)
        ? SessionModelSelectionIntentV1Schema.safeParse(
            (ownerMetadata as Readonly<Record<string, unknown>>).modelSelectionIntentV1,
        )
        : null;
    const configuredBackend = readAcpConfiguredBackendV1FromMetadata(ownerMetadata);
    const agentTargetKey = explicitAgentTargetKey
        || (canonicalIntent?.success
            ? canonicalIntent.data.selection?.agentTargetKey ?? ''
            : '')
        || (configuredBackend
            ? buildBackendTargetKeyV2({
                kind: 'backend',
                backendId: configuredBackend.backendId,
                configuredBackendId: configuredBackend.backendId,
                sourceKind: 'configured',
            })
            : '')
        || buildAgentUniverseBackendTargetKey(agentId);

    return resolveAgentUiBehavior(agentId).sessionComposer?.classifyNonSteerablePayload?.({
        agentId,
        agentTargetKey,
        session: opts.session,
        metaOverrides: opts.metaOverrides ?? null,
        currentRunnerProcessIdentity: opts.currentRunnerProcessIdentity ?? null,
    }) ?? null;
}

export function getAgentResumeExperimentsFromSettings(agentId: AgentLookupId, settings: Settings): AgentResumeExperiments {
    const enabled = true;
    const defs = resolveAgentUiBehavior(agentId).resume?.experimentSwitches ?? [];
    if (defs.length === 0) return { enabled, switches: {} };
    const switches: Record<string, boolean> = {};
    for (const def of defs) {
        if (typeof def.getValue === 'function') {
            switches[def.id] = def.getValue(settings);
            continue;
        }
        const settingKey = def.settingKey as Extract<keyof Settings, string> | undefined;
        switches[def.id] = settingKey ? settings[settingKey] === true : false;
    }
    return { enabled, switches };
}

export function buildResumeCapabilityOptionsFromUiState(opts: {
    settings: Settings;
    results: CapabilityResults | undefined;
}): ResumeCapabilityOptions {
    return {
        accountSettings: opts.settings,
    };
}

export function getNewSessionPreflightIssues(ctx: NewSessionPreflightContext): readonly NewSessionPreflightIssue[] {
    const fn = resolveAgentUiBehavior(ctx.agentId).newSession?.getPreflightIssues;
    return fn ? fn(ctx) : [];
}

export function buildNewSessionOptionsFromUiState(opts: {
    agentId: AgentLookupId;
    agentOptionState?: Record<string, unknown> | null;
}): Record<string, unknown> | null {
    const fn = resolveAgentUiBehavior(opts.agentId).newSession?.buildNewSessionOptions;
    return fn ? fn(opts) : null;
}

export function canSelectAgentWithoutDetectedCli(ctx: NewSessionCliSelectabilityContext): boolean {
    const fn = resolveAgentUiBehavior(ctx.agentId).newSession?.canSelectWithoutDetectedCli;
    return fn ? fn(ctx) : false;
}

export function getNewSessionAgentInputExtraActionChips(opts: {
    agentId: AgentLookupId;
    agentOptionState?: Record<string, unknown> | null;
    setAgentOptionState: (key: string, value: unknown) => void;
}): ReadonlyArray<AgentInputExtraActionChip> | undefined {
    const fn = resolveAgentUiBehavior(opts.agentId).newSession?.getAgentInputExtraActionChips;
    return fn ? fn(opts) : undefined;
}

export function getNewSessionRelevantInstallableDepKeys(
    ctx: NewSessionRelevantInstallableDepsContext,
): readonly string[] {
    const fn = resolveAgentUiBehavior(ctx.agentId).newSession?.getRelevantInstallableDepKeys;
    return fn ? fn(ctx) : [];
}

export function buildSpawnSessionExtrasFromUiState(opts: {
    agentId: AgentLookupId;
    settings: Settings;
    resumeSessionId: string;
    newSessionOptions?: Record<string, unknown> | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
    updatedAt?: number;
}): AgentSpawnSessionExtras {
    const fn = resolveAgentUiBehavior(opts.agentId).payload?.buildSpawnSessionExtras;
    if (!fn) return {};
    const experiments = getAgentResumeExperimentsFromSettings(opts.agentId, opts.settings);
    return fn({
        agentId: opts.agentId,
        settings: opts.settings,
        experiments,
        resumeSessionId: opts.resumeSessionId,
        newSessionOptions: opts.newSessionOptions ?? null,
        sessionConfigOptionOverrides: opts.sessionConfigOptionOverrides ?? null,
        ...(opts.updatedAt === undefined ? {} : { updatedAt: opts.updatedAt }),
    });
}

export function buildSpawnEnvironmentVariablesFromUiState(opts: {
    agentId: AgentLookupId;
    settings: Settings;
    environmentVariables: Record<string, string> | undefined;
    newSessionOptions?: Record<string, unknown> | null;
}): Record<string, string> | undefined {
    const fn = resolveAgentUiBehavior(opts.agentId).payload?.buildSpawnEnvironmentVariables;
    return fn ? fn(opts) : opts.environmentVariables;
}

export function buildResumeSessionExtrasFromUiState(opts: {
    agentId: AgentLookupId;
    settings: Settings;
    session?: Session | null;
}): Record<string, unknown> {
    const fn = resolveAgentUiBehavior(opts.agentId).payload?.buildResumeSessionExtras;
    if (!fn) return {};
    const experiments = getAgentResumeExperimentsFromSettings(opts.agentId, opts.settings);
    return fn({ agentId: opts.agentId, experiments, settings: opts.settings, session: opts.session });
}

export function buildWakeResumeExtras(opts: {
    agentId: AgentLookupId;
    resumeCapabilityOptions: ResumeCapabilityOptions;
    session?: Session | null;
}): Record<string, unknown> {
    const fn = resolveAgentUiBehavior(opts.agentId)?.payload?.buildWakeResumeExtras;
    return fn ? fn(opts) : {};
}

function readCanonicalBackendTarget(input: BackendTargetRefV2Input | undefined): BackendTargetRefV2 | null {
    if (!input) return null;
    try {
        return readBackendTargetRefV2(input);
    } catch {
        return null;
    }
}

function resolveAgentIdFromBackendTarget(input: BackendTargetRefV2Input | undefined): AgentId | null {
    const target = readCanonicalBackendTarget(input);
    if (!target || target.kind !== 'backend' || target.sourceKind === 'configured') return null;
    return isCanonicalAgentId(target.backendId) ? target.backendId : null;
}

export function buildBackendTransportFieldsFromUiState(opts: Readonly<{
    backendTarget?: BackendTargetRefV2Input;
    providerMode?: unknown;
    legacyExperimentalMode?: boolean;
    runtimeDescriptorV1?: RuntimeDescriptorV1;
    providerSessionId?: string;
}>): AgentBackendTransportFields {
    const backendTarget = readCanonicalBackendTarget(opts.backendTarget);
    const agentId = resolveAgentIdFromBackendTarget(opts.backendTarget);
    if (!backendTarget || !agentId) return {};

    const fn = resolveAgentUiBehavior(agentId).payload?.buildBackendTransportFields;
    return fn
        ? fn({
            agentId,
            backendTarget,
            providerMode: opts.providerMode,
            legacyExperimentalMode: opts.legacyExperimentalMode,
            runtimeDescriptorV1: opts.runtimeDescriptorV1,
            providerSessionId: opts.providerSessionId,
        })
        : {};
}

export function buildSessionHandoffSourceRecoveryResumePatch(opts: {
    agentId: AgentId;
    metadata: Record<string, unknown>;
}): AgentSessionHandoffSourceRecoveryResumePatch {
    const fn = resolveAgentUiBehavior(opts.agentId).sessionHandoff?.buildSourceRecoveryResumePatch;
    return fn ? fn(opts) : {};
}

export function supportsDetectedMcpConfigScan(agentId: AgentLookupId): boolean {
    return resolveAgentUiBehavior(agentId).mcpServers?.supportsDetectedConfigScan === true;
}

export function supportsEditableSessionGoals(ctx: {
    agentId: AgentLookupId;
    session: Session;
}): boolean {
    const fn = resolveAgentUiBehavior(ctx.agentId).workState?.supportsEditableGoals;
    return fn ? fn(ctx) : false;
}

/**
 * Provider goal-action capability profile for a session, used as the fallback when no goal item
 * carries its own `goalCapabilities` (the "Set goal" form before any native goal exists). Returns
 * null when the provider declares no profile, in which case the full legacy control surface applies.
 */
export function resolveSessionGoalActionCapabilityProfile(ctx: {
    agentId: AgentLookupId;
    session: Session;
}): GoalActionCapabilities | null {
    const fn = resolveAgentUiBehavior(ctx.agentId).workState?.resolveGoalActionCapabilityProfile;
    return fn ? fn(ctx) : null;
}
