import type { ReactNode } from 'react';
import type {
    AccountProfile,
    AcpConfigOptionOverridesV1,
    AgentRuntimeDescriptorV1,
    DirectSessionLinkEnsureRequest,
    DirectSessionsSource,
    PendingDeliveryDetailV1,
} from '@happier-dev/protocol';
import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import type { AgentId } from './registryCore';
import { AGENT_IDS, getAgentCore, resolveAgentIdFromFlavor } from './registryCore';
import type { CapabilityDetectResult, CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import type { TranslationKey } from '@/text';
import type { Settings } from '@/sync/domains/settings/settings';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { NonSteerablePayloadReason } from '@/sync/domains/session/control/submitMode';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { GoalActionCapabilities } from '@/components/sessions/workState/goalActionVisibility';
import { CODEX_UI_BEHAVIOR_OVERRIDE } from '@/agents/providers/codex/uiBehavior';
import { CLAUDE_UI_BEHAVIOR_OVERRIDE } from '@/agents/providers/claude/uiBehavior';
import { AUGGIE_UI_BEHAVIOR_OVERRIDE } from '@/agents/providers/auggie/uiBehavior';
import { OPENCODE_UI_BEHAVIOR_OVERRIDE } from '@/agents/providers/opencode/uiBehavior';
import { PI_UI_BEHAVIOR_OVERRIDE } from '@/agents/providers/pi/uiBehavior';
import { CUSTOM_ACP_UI_BEHAVIOR_OVERRIDE } from '@/agents/providers/customAcp/uiBehavior';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { PendingInputServerWireMode } from '@/sync/engine/pending/pendingInputServerWireContract';

export type PendingDeliveryTransientAction = Readonly<{
    id: 'interrupt_and_run';
    localId: string;
    stateAtMs?: number;
}>;

type CapabilityResults = Partial<Record<CapabilityId, CapabilityDetectResult>>;
export type SessionComposerNonSteerablePayloadReason = Extract<NonSteerablePayloadReason, 'provider_config_change_refused'>;

export type AgentExperimentSwitches = Readonly<Record<string, boolean>>;

export type AgentResumeExperiments = Readonly<{
    enabled: boolean;
    switches: AgentExperimentSwitches;
}>;

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

export type DirectBrowseSourceOption = Readonly<{
    key: string;
    label: string;
    detail?: string;
    source: DirectSessionsSource;
}>;

export type DirectBrowseLinkEnsureRequestExtras = Readonly<
    Partial<Omit<DirectSessionLinkEnsureRequest, 'machineId' | 'providerId' | 'remoteSessionId' | 'titleHint' | 'directoryHint'>>
>;

export type AgentSessionHandoffProviderPatch = Readonly<{
    clearMetadataKeys?: readonly string[];
    metadataPatch?: Record<string, unknown>;
    agentRuntimeDescriptor?: AgentRuntimeDescriptorV1 | null;
    directSessionAgentRuntimeDescriptor?: AgentRuntimeDescriptorV1 | null;
}>;

export type AgentUiBehavior = Readonly<{
    pendingDelivery?: Readonly<{
        resolveLabelKey?: (ctx: {
            agentId: AgentId;
            session: Session;
            localId: string | null;
            detail: PendingDeliveryDetailV1 | undefined;
        }) => TranslationKey | null;
        resolveTransientAction?: (ctx: {
            agentId: AgentId;
            session: Session;
            localId: string;
            wireMode: PendingInputServerWireMode;
        }) => PendingDeliveryTransientAction | null;
    }>;
    attachedSessionTerminal?: Readonly<{
        isAvailable?: (ctx: {
            agentId: AgentId;
            session: Session;
        }) => boolean;
    }>;
    guidance?: Readonly<{
        includeInSessionGettingStartedCliExamples?: boolean;
    }>;
    sessionUsage?: Readonly<{
        supportsExactContextUsageBadge?: boolean;
    }>;
    workState?: Readonly<{
        supportsEditableGoals?: (ctx: {
            agentId: AgentId;
            session: Session;
        }) => boolean;
        /**
         * Provider goal-action capability profile applied when no goal item carries its own
         * `goalCapabilities` yet (the "Set goal" form before any native goal is derived). Lets a
         * provider restrict the control surface (e.g. Claude: edit/clear only, no budget) at the
         * session level without the goal-item round-trip. Return null/undefined to fall back to the
         * full legacy control surface.
         */
        resolveGoalActionCapabilityProfile?: (ctx: {
            agentId: AgentId;
            session: Session;
        }) => GoalActionCapabilities | null;
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
    newSession?: Readonly<{
        buildNewSessionOptions?: (ctx: {
            agentId: AgentId;
            agentOptionState?: Record<string, unknown> | null;
        }) => Record<string, unknown> | null;
        canSelectWithoutDetectedCli?: (ctx: NewSessionCliSelectabilityContext) => boolean;
        getAgentInputExtraActionChips?: (ctx: {
            agentId: AgentId;
            agentOptionState?: Record<string, unknown> | null;
            setAgentOptionState: (key: string, value: unknown) => void;
        }) => ReadonlyArray<AgentInputExtraActionChip> | undefined;
        supportsTranscriptStorageMode?: (ctx: {
            agentId: AgentId;
            settings: Settings;
            storageMode: AgentTranscriptStorageMode;
        }) => boolean;
        getPreflightIssues?: (ctx: NewSessionPreflightContext) => readonly NewSessionPreflightIssue[];
        getRelevantInstallableDepKeys?: (ctx: NewSessionRelevantInstallableDepsContext) => readonly string[];
    }>;
    directSessions?: Readonly<{
        browse?: Readonly<{
            order?: number;
            getSourceOptions?: (ctx: {
                agentId: AgentId;
                profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
                settings: Settings;
            }) => readonly DirectBrowseSourceOption[];
            resolveLockedSourceOption?: (ctx: {
                agentId: AgentId;
                sourceOptions: readonly DirectBrowseSourceOption[];
                agentOptionState?: Record<string, unknown> | null;
                profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
                settings: Settings;
            }) => DirectBrowseSourceOption | null;
            buildLinkEnsureRequestExtras?: (ctx: {
                agentId: AgentId;
                source: DirectSessionsSource;
                candidate: Readonly<{ details?: Record<string, unknown> }>;
            }) => DirectBrowseLinkEnsureRequestExtras;
        }>;
    }>;
    sessionHandoff?: Readonly<{
        buildProviderPatch?: (ctx: {
            agentId: AgentId;
            metadata: Record<string, unknown>;
            sourceMetadataForHandoff?: Record<string, unknown>;
            targetRemoteSessionId: string;
            targetDirectSource: DirectSessionsSource | Record<string, unknown>;
            targetRuntimeDescriptor?: AgentRuntimeDescriptorV1;
        }) => AgentSessionHandoffProviderPatch;
    }>;
    payload?: Readonly<{
        buildSpawnEnvironmentVariables?: (opts: {
            agentId: AgentId;
            settings: Settings;
            environmentVariables: Record<string, string> | undefined;
            newSessionOptions?: Record<string, unknown> | null;
        }) => Record<string, string> | undefined;
        buildSpawnSessionExtras?: (opts: {
            agentId: AgentId;
            settings: Settings;
            experiments: AgentResumeExperiments;
            resumeSessionId: string;
        }) => Record<string, unknown>;
        buildResumeSessionExtras?: (opts: {
            agentId: AgentId;
            experiments: AgentResumeExperiments;
            settings: Settings;
            session?: Session | null;
        }) => Record<string, unknown>;
        buildWakeResumeExtras?: (opts: {
            agentId: AgentId;
            resumeCapabilityOptions: ResumeCapabilityOptions;
            session?: Session | null;
        }) => Record<string, unknown>;
    }>;
    sessionComposer?: Readonly<{
        buildNextMessageMetaOverrides?: (opts: {
            agentId: AgentId;
            configOptionOverrides: AcpConfigOptionOverridesV1 | null | undefined;
            metaOverrides?: Record<string, unknown>;
        }) => Record<string, unknown> | undefined;
        getNonSteerablePayloadReason?: (opts: {
            agentId: AgentId;
            session: Session | null | undefined;
            configOptionOverrides: AcpConfigOptionOverridesV1 | null | undefined;
            metaOverrides?: Record<string, unknown>;
        }) => SessionComposerNonSteerablePayloadReason | null;
    }>;
    sessionSubagents?: Readonly<{
        renderLaunchCards?: (ctx: {
            sessionId: string;
            scopeId: string;
            session: Session;
            subagents: readonly SessionSubagent[];
        }) => readonly ReactNode[];
        renderDetailsTab?: (ctx: {
            sessionId: string;
            scopeId: string;
            tab: DetailsTab;
        }) => ReactNode | null;
        getDetailsTabIconName?: (ctx: { tab: DetailsTab }) => string | null;
    }>;
}>;

export type NewSessionPreflightContext = Readonly<{
    agentId: AgentId;
    experiments: AgentResumeExperiments;
    resumeSessionId: string;
    results: CapabilityResults | undefined;
}>;

export type NewSessionCliSelectabilityContext = Readonly<{
    agentId: AgentId;
    settings: Settings;
    agentOptionState?: Record<string, unknown> | null;
}>;

export type NewSessionRelevantInstallableDepsContext = Readonly<{
    agentId: AgentId;
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

function mergeAgentUiBehavior(a: AgentUiBehavior, b: AgentUiBehavior): AgentUiBehavior {
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
        ...(a.sessionUsage || b.sessionUsage ? { sessionUsage: { ...(a.sessionUsage ?? {}), ...(b.sessionUsage ?? {}) } } : {}),
        ...(a.workState || b.workState ? { workState: { ...(a.workState ?? {}), ...(b.workState ?? {}) } } : {}),
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
        ...(a.newSession || b.newSession ? { newSession: { ...(a.newSession ?? {}), ...(b.newSession ?? {}) } } : {}),
        ...(a.directSessions || b.directSessions
            ? {
                directSessions: {
                    ...(a.directSessions ?? {}),
                    ...(b.directSessions ?? {}),
                    ...(a.directSessions?.browse || b.directSessions?.browse
                        ? { browse: { ...(a.directSessions?.browse ?? {}), ...(b.directSessions?.browse ?? {}) } }
                        : {}),
                },
            }
            : {}),
        ...(a.sessionHandoff || b.sessionHandoff ? { sessionHandoff: { ...(a.sessionHandoff ?? {}), ...(b.sessionHandoff ?? {}) } } : {}),
        ...(a.payload || b.payload ? { payload: { ...(a.payload ?? {}), ...(b.payload ?? {}) } } : {}),
        ...(a.sessionComposer || b.sessionComposer ? { sessionComposer: { ...(a.sessionComposer ?? {}), ...(b.sessionComposer ?? {}) } } : {}),
        ...(a.sessionSubagents || b.sessionSubagents
            ? { sessionSubagents: { ...(a.sessionSubagents ?? {}), ...(b.sessionSubagents ?? {}) } }
            : {}),
    };
}

function buildDefaultAgentUiBehavior(agentId: AgentId): AgentUiBehavior {
    const promptProtocol = getAgentCore(agentId).permissions.promptProtocol;

    return {
        sessionUsage: {
            supportsExactContextUsageBadge: true,
        },
        permissions: {
            footer: {
                usePermissionUpdates: promptProtocol === 'claude',
                forceReadOnlyAfterStop: promptProtocol !== 'codexDecision',
                supportsExecPolicyAmendment: false,
                stopHandling: 'denyAndAbortRun',
            },
        },
        newSession: {
            supportsTranscriptStorageMode: ({ storageMode }) => getAgentCore(agentId).sessionStorage[storageMode] === true,
        },
    };
}

const AGENTS_UI_BEHAVIOR_OVERRIDES: Readonly<Partial<Record<AgentId, AgentUiBehavior>>> = Object.freeze({
    claude: CLAUDE_UI_BEHAVIOR_OVERRIDE,
    codex: CODEX_UI_BEHAVIOR_OVERRIDE,
    opencode: OPENCODE_UI_BEHAVIOR_OVERRIDE,
    auggie: AUGGIE_UI_BEHAVIOR_OVERRIDE,
    pi: PI_UI_BEHAVIOR_OVERRIDE,
    customAcp: CUSTOM_ACP_UI_BEHAVIOR_OVERRIDE,
});

export const AGENTS_UI_BEHAVIOR: Readonly<Record<AgentId, AgentUiBehavior>> = Object.freeze(
    Object.fromEntries(
        AGENT_IDS.map((id) => {
            const base = buildDefaultAgentUiBehavior(id);
            const override = AGENTS_UI_BEHAVIOR_OVERRIDES[id] ?? {};
            return [id, mergeAgentUiBehavior(base, override)] as const;
        }),
    ) as Record<AgentId, AgentUiBehavior>,
);

export function resolveAgentUiBehaviorFromFlavor(flavor: unknown): AgentUiBehavior | null {
    const agentId = typeof flavor === 'string' ? resolveAgentIdFromFlavor(flavor) : null;
    return agentId ? AGENTS_UI_BEHAVIOR[agentId] ?? null : null;
}

export function isAttachedSessionTerminalAvailableForSession(session: Session): boolean {
    const agentId = resolveAgentIdFromSessionMetadata(session.metadata);
    if (!agentId) return false;
    const isAvailable = AGENTS_UI_BEHAVIOR[agentId].attachedSessionTerminal?.isAvailable;
    return isAvailable?.({ agentId, session }) === true;
}

export function resolvePendingDeliveryTransientActionForSession(ctx: {
    session: Session;
    localId: string;
    wireMode: PendingInputServerWireMode;
}): PendingDeliveryTransientAction | null {
    const agentId = resolveAgentIdFromSessionMetadata(ctx.session.metadata);
    if (!agentId) return null;
    return AGENTS_UI_BEHAVIOR[agentId].pendingDelivery?.resolveTransientAction?.({
        agentId,
        session: ctx.session,
        localId: ctx.localId,
        wireMode: ctx.wireMode,
    }) ?? null;
}

export function resolvePendingDeliveryLabelKeyForSession(ctx: {
    session: Session;
    localId: string | null;
    detail: PendingDeliveryDetailV1 | undefined;
}): TranslationKey | null {
    const agentId = resolveAgentIdFromSessionMetadata(ctx.session.metadata);
    if (!agentId) return null;
    return AGENTS_UI_BEHAVIOR[agentId].pendingDelivery?.resolveLabelKey?.({
        agentId,
        session: ctx.session,
        localId: ctx.localId,
        detail: ctx.detail,
    }) ?? null;
}

export function getAgentResumeExperimentsFromSettings(agentId: AgentId, settings: Settings): AgentResumeExperiments {
    const enabled = true;
    const defs = AGENTS_UI_BEHAVIOR[agentId].resume?.experimentSwitches ?? [];
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
    const fn = AGENTS_UI_BEHAVIOR[ctx.agentId].newSession?.getPreflightIssues;
    return fn ? fn(ctx) : [];
}

export function buildNewSessionOptionsFromUiState(opts: {
    agentId: AgentId;
    agentOptionState?: Record<string, unknown> | null;
}): Record<string, unknown> | null {
    const fn = AGENTS_UI_BEHAVIOR[opts.agentId].newSession?.buildNewSessionOptions;
    return fn ? fn(opts) : null;
}

export function canSelectAgentWithoutDetectedCli(ctx: NewSessionCliSelectabilityContext): boolean {
    const fn = AGENTS_UI_BEHAVIOR[ctx.agentId].newSession?.canSelectWithoutDetectedCli;
    return fn ? fn(ctx) : false;
}

export function getNewSessionAgentInputExtraActionChips(opts: {
    agentId: AgentId;
    agentOptionState?: Record<string, unknown> | null;
    setAgentOptionState: (key: string, value: unknown) => void;
}): ReadonlyArray<AgentInputExtraActionChip> | undefined {
    const fn = AGENTS_UI_BEHAVIOR[opts.agentId].newSession?.getAgentInputExtraActionChips;
    return fn ? fn(opts) : undefined;
}

export function getNewSessionRelevantInstallableDepKeys(
    ctx: NewSessionRelevantInstallableDepsContext,
): readonly string[] {
    const fn = AGENTS_UI_BEHAVIOR[ctx.agentId].newSession?.getRelevantInstallableDepKeys;
    return fn ? fn(ctx) : [];
}

export function buildSpawnSessionExtrasFromUiState(opts: {
    agentId: AgentId;
    settings: Settings;
    resumeSessionId: string;
}): Record<string, unknown> {
    const fn = AGENTS_UI_BEHAVIOR[opts.agentId].payload?.buildSpawnSessionExtras;
    if (!fn) return {};
    const experiments = getAgentResumeExperimentsFromSettings(opts.agentId, opts.settings);
    return fn({ agentId: opts.agentId, settings: opts.settings, experiments, resumeSessionId: opts.resumeSessionId });
}

export function buildSpawnEnvironmentVariablesFromUiState(opts: {
    agentId: AgentId;
    settings: Settings;
    environmentVariables: Record<string, string> | undefined;
    newSessionOptions?: Record<string, unknown> | null;
}): Record<string, string> | undefined {
    const fn = AGENTS_UI_BEHAVIOR[opts.agentId].payload?.buildSpawnEnvironmentVariables;
    return fn ? fn(opts) : opts.environmentVariables;
}

export function buildResumeSessionExtrasFromUiState(opts: {
    agentId: AgentId;
    settings: Settings;
    session?: Session | null;
}): Record<string, unknown> {
    const fn = AGENTS_UI_BEHAVIOR[opts.agentId].payload?.buildResumeSessionExtras;
    if (!fn) return {};
    const experiments = getAgentResumeExperimentsFromSettings(opts.agentId, opts.settings);
    return fn({ agentId: opts.agentId, experiments, settings: opts.settings, session: opts.session });
}

export function buildWakeResumeExtras(opts: {
    agentId: AgentId;
    resumeCapabilityOptions: ResumeCapabilityOptions;
    session?: Session | null;
}): Record<string, unknown> {
    const fn = AGENTS_UI_BEHAVIOR[opts.agentId]?.payload?.buildWakeResumeExtras;
    return fn ? fn(opts) : {};
}

export function buildSessionComposerNextMessageMetaOverridesFromUiState(opts: {
    agentId: AgentId | null | undefined;
    configOptionOverrides: AcpConfigOptionOverridesV1 | null | undefined;
    metaOverrides?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
    if (!opts.agentId) return opts.metaOverrides;
    const fn = AGENTS_UI_BEHAVIOR[opts.agentId]?.sessionComposer?.buildNextMessageMetaOverrides;
    if (!fn) return opts.metaOverrides;
    return fn({
        agentId: opts.agentId,
        configOptionOverrides: opts.configOptionOverrides,
        metaOverrides: opts.metaOverrides,
    });
}

export function getSessionComposerNonSteerablePayloadReasonFromUiState(opts: {
    agentId: AgentId | null | undefined;
    session: Session | null | undefined;
    configOptionOverrides: AcpConfigOptionOverridesV1 | null | undefined;
    metaOverrides?: Record<string, unknown>;
}): SessionComposerNonSteerablePayloadReason | null {
    if (!opts.agentId) return null;
    const fn = AGENTS_UI_BEHAVIOR[opts.agentId]?.sessionComposer?.getNonSteerablePayloadReason;
    if (!fn) return null;
    return fn({
        agentId: opts.agentId,
        session: opts.session,
        configOptionOverrides: opts.configOptionOverrides,
        metaOverrides: opts.metaOverrides,
    });
}

export function supportsDetectedMcpConfigScan(agentId: AgentId): boolean {
    return AGENTS_UI_BEHAVIOR[agentId]?.mcpServers?.supportsDetectedConfigScan === true;
}

export function supportsEditableSessionGoals(ctx: {
    agentId: AgentId;
    session: Session;
}): boolean {
    const fn = AGENTS_UI_BEHAVIOR[ctx.agentId]?.workState?.supportsEditableGoals;
    return fn ? fn(ctx) : false;
}

/**
 * Provider goal-action capability profile for a session, used as the fallback when no goal item
 * carries its own `goalCapabilities` (the "Set goal" form before any native goal exists). Returns
 * null when the provider declares no profile, in which case the full legacy control surface applies.
 */
export function resolveSessionGoalActionCapabilityProfile(ctx: {
    agentId: AgentId;
    session: Session;
}): GoalActionCapabilities | null {
    const fn = AGENTS_UI_BEHAVIOR[ctx.agentId]?.workState?.resolveGoalActionCapabilityProfile;
    return fn ? fn(ctx) : null;
}
