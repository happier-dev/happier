import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol/installables';
import { normalizeCodexBackendMode, type CodexBackendMode } from '@happier-dev/protocol';
import { resolveCodexSpawnExtrasFromSettings, resolvePersistedCodexRuntimeIdentity } from '@happier-dev/agents';
import { resolveCodexBrowseSourceOptions } from '@/agents/providers/codex/externalSessions/resolveCodexBrowseSourceOptions';
import { resolveCodexLinkEnsureRequestExtras } from '@/agents/providers/codex/externalSessions/resolveCodexLinkEnsureRequestExtras';
import { resolveCodexLockedBrowseSourceOption } from '@/agents/providers/codex/externalSessions/resolveCodexLockedBrowseSourceOption';
import { buildCodexSessionHandoffProviderPatch } from '@/agents/providers/codex/buildCodexSessionHandoffProviderPatch';

import type {
    AgentResumeExperiments,
    AgentUiBehavior,
    NewSessionPreflightContext,
    NewSessionPreflightIssue,
    NewSessionRelevantInstallableDepsContext,
} from '@/agents/registry/registryUiBehavior';

const CODEX_SWITCH_RESUME_ACP = 'resumeAcp';

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

type CodexHomeSource = Readonly<{
    kind: 'codexHome';
    home: 'user' | 'connectedService';
    connectedServiceId?: string;
    connectedServiceProfileId?: string;
    homePath?: string;
}>;

function isCodexHomeSource(value: unknown): value is CodexHomeSource {
    const record = asRecord(value);
    return record?.kind === 'codexHome'
        && (record.home === 'user' || record.home === 'connectedService');
}

function hasCodexGoalWorkState(metadata: unknown): boolean {
    const metadataRecord = asRecord(metadata);
    const snapshot = asRecord(metadataRecord?.sessionWorkStateV1);
    if (!snapshot || snapshot.v !== 1) return false;

    const backendId = typeof snapshot.backendId === 'string' ? snapshot.backendId.trim() : '';
    const agentId = typeof snapshot.agentId === 'string' ? snapshot.agentId.trim() : '';
    if (backendId !== 'codex' && agentId !== 'codex') return false;
    if (!Array.isArray(snapshot.items)) return false;

    return snapshot.items.some((item) => asRecord(item)?.kind === 'goal');
}

function getSwitch(experiments: AgentResumeExperiments, id: string): boolean {
    return experiments.switches[id] === true;
}

function normalizeCodexUiBackendMode(value: unknown): CodexSpawnSessionExtras['codexBackendMode'] | null {
    return normalizeCodexBackendMode(value);
}

export type CodexSpawnSessionExtras = Readonly<{
    codexBackendMode: CodexBackendMode;
}>;

export type CodexResumeSessionExtras = Readonly<{
    codexBackendMode: CodexBackendMode;
}>;

function resolveCodexResumeExtras(opts: {
    settings: Record<string, unknown>;
    session?: { metadata?: Record<string, unknown> | null } | null;
}): CodexResumeSessionExtras | null {
    const persistedMode = resolvePersistedCodexRuntimeIdentity(opts.session?.metadata ?? null)?.backendMode ?? null;
    const extras = resolveCodexSpawnExtrasFromSettings(
        persistedMode ? { ...opts.settings, codexBackendMode: persistedMode } : opts.settings,
    );
    const codexBackendMode = normalizeCodexUiBackendMode(extras.codexBackendMode);
    return codexBackendMode ? {
        codexBackendMode,
    } : null;
}

export function computeCodexSpawnSessionExtras(opts: {
    agentId: string;
    settings: Record<string, unknown>;
}): CodexSpawnSessionExtras | null {
    if (opts.agentId !== 'codex') return null;
    const extras = resolveCodexSpawnExtrasFromSettings(opts.settings);
    const codexBackendMode = normalizeCodexUiBackendMode(extras.codexBackendMode);
    return codexBackendMode ? {
        codexBackendMode,
    } : null;
}

export function computeCodexResumeSessionExtras(opts: {
    agentId: string;
    settings: Record<string, unknown>;
    session?: { metadata?: Record<string, unknown> | null } | null;
}): CodexResumeSessionExtras | null {
    if (opts.agentId !== 'codex') return null;
    return resolveCodexResumeExtras({ settings: opts.settings, session: opts.session });
}

export function getCodexNewSessionPreflightIssues(ctx: NewSessionPreflightContext): readonly NewSessionPreflightIssue[] {
    if (ctx.agentId !== 'codex') return [];
    // New Codex sessions can background-install Codex ACP and daemon-side fresh-session spawns can
    // still fall back to MCP, so missing ACP should not hard-block the wizard here.
    return [];
}

export function getCodexNewSessionRelevantInstallableDepKeys(ctx: NewSessionRelevantInstallableDepsContext): readonly string[] {
    if (ctx.agentId !== 'codex') return [];
    if (ctx.experiments.enabled !== true) return [];

    const extras = computeCodexSpawnSessionExtras({
        agentId: 'codex',
        settings: ctx.settings,
    });

    const keys: string[] = [];
    if (extras?.codexBackendMode === 'acp') keys.push(INSTALLABLE_KEYS.CODEX_ACP);
    return keys;
}

export const CODEX_UI_BEHAVIOR_OVERRIDE: AgentUiBehavior = {
    guidance: {
        includeInSessionGettingStartedCliExamples: true,
    },
    workState: {
        supportsEditableGoals: ({ agentId, session }) => {
            if (agentId !== 'codex') return false;
            const persistedIdentity = resolvePersistedCodexRuntimeIdentity(session.metadata ?? null);
            if (persistedIdentity) return persistedIdentity.backendMode === 'appServer';
            return session.active === true || hasCodexGoalWorkState(session.metadata ?? null);
        },
    },
    mcpServers: {
        supportsDetectedConfigScan: true,
    },
    permissions: {
        footer: {
            usePermissionUpdates: false,
            forceReadOnlyAfterStop: false,
            supportsExecPolicyAmendment: true,
            stopHandling: 'denyOnly',
        },
    },
    resume: {
        experimentSwitches: [
            { id: CODEX_SWITCH_RESUME_ACP, getValue: (settings) => settings.codexBackendMode === 'acp' },
        ],
    },
    newSession: {
        getPreflightIssues: getCodexNewSessionPreflightIssues,
        getRelevantInstallableDepKeys: getCodexNewSessionRelevantInstallableDepKeys,
    },
    externalSessions: {
        supportsBackgroundFollow: true,
        browse: {
            order: 10,
            getSourceOptions: ({ profile, settings }) => resolveCodexBrowseSourceOptions({ profile, settings }),
            resolveLockedSourceOption: ({ sourceOptions, agentOptionState }) => (
                resolveCodexLockedBrowseSourceOption({ sourceOptions, agentOptionState })
            ),
            buildLinkEnsureRequestExtras: ({ candidate, source }) => (
                isCodexHomeSource(source)
                    ? resolveCodexLinkEnsureRequestExtras({ candidate, source })
                    : {}
            ),
        },
    },
    sessionHandoff: {
        buildProviderPatch: ({ metadata, targetRemoteSessionId, targetDirectSource, targetRuntimeDescriptor }) => (
            buildCodexSessionHandoffProviderPatch({
                metadata,
                targetRemoteSessionId,
                targetDirectSource,
                targetRuntimeDescriptor,
            })
        ),
    },
    payload: {
        buildSpawnSessionExtras: ({ agentId, settings }) => {
            const extras = computeCodexSpawnSessionExtras({
                agentId,
                settings,
            });
            return extras ?? {};
        },
        buildResumeSessionExtras: ({ agentId, settings, session }) => {
            const extras = computeCodexResumeSessionExtras({
                agentId,
                settings,
                session,
            });
            return extras ?? {};
        },
        buildWakeResumeExtras: ({ resumeCapabilityOptions, session }: { resumeCapabilityOptions: ResumeCapabilityOptions; session?: { metadata?: Record<string, unknown> | null } | null }) => {
            const settings = resumeCapabilityOptions.accountSettings ?? {};
            const extras = resolveCodexResumeExtras({ settings, session });
            return extras ?? {};
        },
    },
};
