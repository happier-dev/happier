import type { ResumeCapabilityOptions } from '@/agents/runtime/resumeCapabilities';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol/installables';
import { resolveCodexSpawnExtrasFromSettings, resolvePersistedCodexRuntimeIdentity } from '@happier-dev/agents';
import { resolveCodexBrowseSourceOptions } from '@/agents/providers/codex/directSessions/resolveCodexBrowseSourceOptions';
import { resolveCodexLinkEnsureRequestExtras } from '@/agents/providers/codex/directSessions/resolveCodexLinkEnsureRequestExtras';
import { resolveCodexLockedBrowseSourceOption } from '@/agents/providers/codex/directSessions/resolveCodexLockedBrowseSourceOption';

import type {
    AgentResumeExperiments,
    AgentUiBehavior,
    NewSessionPreflightContext,
    NewSessionPreflightIssue,
    NewSessionRelevantInstallableDepsContext,
} from '@/agents/registry/registryUiBehavior';

const CODEX_SWITCH_RESUME_ACP = 'resumeAcp';

function getSwitch(experiments: AgentResumeExperiments, id: string): boolean {
    return experiments.switches[id] === true;
}

export type CodexSpawnSessionExtras = Readonly<{
    codexBackendMode: 'mcp' | 'acp' | 'appServer';
}>;

export type CodexResumeSessionExtras = Readonly<{
    codexBackendMode: 'mcp' | 'acp' | 'appServer';
}>;

function resolveCodexResumeExtras(opts: {
    settings: Record<string, unknown>;
    session?: { metadata?: Record<string, unknown> | null } | null;
}): CodexResumeSessionExtras | null {
    const persistedMode = resolvePersistedCodexRuntimeIdentity(opts.session?.metadata ?? null)?.backendMode ?? null;
    const extras = resolveCodexSpawnExtrasFromSettings(
        persistedMode ? { ...opts.settings, codexBackendMode: persistedMode } : opts.settings,
    );
    return extras.codexBackendMode ? {
        codexBackendMode: extras.codexBackendMode,
    } : null;
}

export function computeCodexSpawnSessionExtras(opts: {
    agentId: string;
    settings: Record<string, unknown>;
}): CodexSpawnSessionExtras | null {
    if (opts.agentId !== 'codex') return null;
    const extras = resolveCodexSpawnExtrasFromSettings(opts.settings);
    return extras.codexBackendMode ? {
        codexBackendMode: extras.codexBackendMode,
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
    sessionUsage: {
        supportsExactContextUsageBadge: false,
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
    directSessions: {
        browse: {
            order: 10,
            getSourceOptions: ({ profile, settings }) => resolveCodexBrowseSourceOptions({ profile, settings }),
            resolveLockedSourceOption: ({ sourceOptions, agentOptionState }) => (
                resolveCodexLockedBrowseSourceOption({ sourceOptions, agentOptionState })
            ),
            buildLinkEnsureRequestExtras: ({ candidate, source }) => (
                source.kind === 'codexHome'
                    ? resolveCodexLinkEnsureRequestExtras({ candidate, source })
                    : {}
            ),
        },
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
