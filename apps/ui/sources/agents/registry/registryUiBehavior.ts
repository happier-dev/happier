import type { ReactNode } from 'react';
import type {
    AccountProfile,
    DirectSessionLinkEnsureRequest,
    DirectSessionsSource,
    RuntimeDescriptorV1,
} from '@happier-dev/protocol';
import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import type { AgentCoreConfig, AgentId, CanonicalAgentId } from './registryCore';
import { CANONICAL_AGENT_IDS, getAgentCore, resolveAgentIdFromFlavor } from './registryCore';
import type { CapabilityDetectResult, CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import type { TranslationKey } from '@/text';
import type { Settings } from '@/sync/domains/settings/settings';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionSubagent } from '@/sync/domains/session/subagents/types';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput';
import { BUNDLED_CANONICAL_AGENT_UI_BEHAVIOR_OVERRIDES } from './generatedBundledPluginEntries.uiBehaviorOverrides';
import { LEGACY_COMPAT_PRIMARY_AGENT_ID } from '@/agents/backendCatalog/legacyCompatAgents';

type CapabilityResults = Partial<Record<CapabilityId, CapabilityDetectResult>>;

// RU-02: allow legacy compat ids at ingress (never as canonical agents).
type AgentLookupId = AgentId | typeof LEGACY_COMPAT_PRIMARY_AGENT_ID;

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
    runtimeDescriptor?: RuntimeDescriptorV1 | null;
    directSessionRuntimeDescriptor?: RuntimeDescriptorV1 | null;
}>;

export type AgentUiBehavior = Readonly<{
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
    directSessions?: Readonly<{
        supportsBackgroundFollow?: boolean;
        browse?: Readonly<{
            order?: number;
            getSourceOptions?: (ctx: {
                agentId: AgentLookupId;
                profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
                settings: Settings;
            }) => readonly DirectBrowseSourceOption[];
            resolveLockedSourceOption?: (ctx: {
                agentId: AgentLookupId;
                sourceOptions: readonly DirectBrowseSourceOption[];
                agentOptionState?: Record<string, unknown> | null;
                profile: Pick<AccountProfile, 'connectedServicesV2'> | null | undefined;
                settings: Settings;
            }) => DirectBrowseSourceOption | null;
            buildLinkEnsureRequestExtras?: (ctx: {
                agentId: AgentLookupId;
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
            targetRuntimeDescriptor?: RuntimeDescriptorV1;
        }) => AgentSessionHandoffProviderPatch;
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
        }) => Record<string, unknown>;
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

function mergeAgentUiBehavior(a: AgentUiBehavior, b: AgentUiBehavior): AgentUiBehavior {
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

export const CANONICAL_AGENTS_UI_BEHAVIOR: Readonly<Record<CanonicalAgentId, AgentUiBehavior>> = Object.freeze(
    Object.fromEntries(
        CANONICAL_AGENT_IDS.map((id: CanonicalAgentId) => {
            const base = buildDefaultAgentUiBehavior(id);
            const override = CANONICAL_AGENTS_UI_BEHAVIOR_OVERRIDES[id] ?? {};
            return [id, mergeAgentUiBehavior(base, override)] as const;
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
}): Record<string, unknown> {
    const fn = resolveAgentUiBehavior(opts.agentId).payload?.buildSpawnSessionExtras;
    if (!fn) return {};
    const experiments = getAgentResumeExperimentsFromSettings(opts.agentId, opts.settings);
    return fn({ agentId: opts.agentId, settings: opts.settings, experiments, resumeSessionId: opts.resumeSessionId });
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

export function supportsDetectedMcpConfigScan(agentId: AgentLookupId): boolean {
    return resolveAgentUiBehavior(agentId).mcpServers?.supportsDetectedConfigScan === true;
}
