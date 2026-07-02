import { normalizeCodexBackendMode } from '@happier-dev/protocol';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol/installables';
import {
    resolveCodexSpawnExtrasFromSettings,
    resolvePersistedCodexRuntimeIdentity,
} from '@happier-dev/agents';

import type { AgentUiBehavior } from '../registryUiBehavior';

function resolveCodexResumeExtras(opts: Readonly<{
    settings: Record<string, unknown>;
    session?: { metadata?: Record<string, unknown> | null } | null;
}>): Record<string, unknown> {
    const persistedMode = resolvePersistedCodexRuntimeIdentity(opts.session?.metadata ?? null)?.backendMode ?? null;
    const extras = resolveCodexSpawnExtrasFromSettings(
        persistedMode ? { ...opts.settings, codexBackendMode: persistedMode } : opts.settings,
    );
    const codexBackendMode = normalizeCodexBackendMode(extras.codexBackendMode);
    return codexBackendMode ? { codexBackendMode } : {};
}

export function createCodexUiBehavior(): AgentUiBehavior {
    return {
        guidance: {
            includeInSessionGettingStartedCliExamples: true,
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
                { id: 'resumeAcp', getValue: (settings) => settings.codexBackendMode === 'acp' },
            ],
        },
        newSession: {
            getPreflightIssues: () => [],
            getRelevantInstallableDepKeys: (ctx) => {
                if (ctx.agentId !== 'codex' || ctx.experiments.enabled !== true) return [];
                const extras = resolveCodexSpawnExtrasFromSettings(ctx.settings);
                return normalizeCodexBackendMode(extras.codexBackendMode) === 'acp'
                    ? [INSTALLABLE_KEYS.CODEX_ACP]
                    : [];
            },
        },
        payload: {
            buildSpawnSessionExtras: ({ agentId, settings }) => {
                if (agentId !== 'codex') return {};
                const extras = resolveCodexSpawnExtrasFromSettings(settings);
                const codexBackendMode = normalizeCodexBackendMode(extras.codexBackendMode);
                return codexBackendMode ? { codexBackendMode } : {};
            },
            buildResumeSessionExtras: ({ agentId, settings, session }) => (
                agentId === 'codex' ? resolveCodexResumeExtras({ settings, session }) : {}
            ),
            buildWakeResumeExtras: ({ agentId, resumeCapabilityOptions, session }) => (
                agentId === 'codex'
                    ? resolveCodexResumeExtras({
                        settings: resumeCapabilityOptions.accountSettings ?? {},
                        session,
                    })
                    : {}
            ),
        },
    };
}
