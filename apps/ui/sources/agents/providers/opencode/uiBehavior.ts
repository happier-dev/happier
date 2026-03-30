import type { AgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import { resolveEffectiveConfiguredRuntimeControlSurface } from '@/sync/domains/session/control/effectiveRuntimeControlSurface';
import {
    normalizeOpenCodeServerBaseUrl,
    readOpenCodeSessionAffinityFromMetadata,
    normalizeOpenCodeBackendMode,
} from '@happier-dev/agents';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveOpenCodeBrowseSourceOptions } from '@/agents/providers/opencode/directSessions/resolveOpenCodeBrowseSourceOptions';
import { resolveOpenCodeLinkEnsureRequestExtras } from '@/agents/providers/opencode/directSessions/resolveOpenCodeLinkEnsureRequestExtras';

function readOpenCodeScopedServerBaseUrlFromSettings(opts: {
    settings: Record<string, unknown> | null | undefined;
    targetServerId?: string | null;
    allowActiveServerFallback?: boolean;
}): string | null {
    const explicitTargetServerId = typeof opts.targetServerId === 'string' ? opts.targetServerId.trim() : '';
    const snapshot = explicitTargetServerId || opts.allowActiveServerFallback === false ? null : getActiveServerSnapshot();
    const serverId = explicitTargetServerId || (typeof snapshot?.serverId === 'string' ? snapshot.serverId.trim() : '');
    if (!serverId) return null;

    const byServerIdRaw = opts.settings?.opencodeServerBaseUrlByServerIdV1;
    if (!byServerIdRaw || typeof byServerIdRaw !== 'object' || Array.isArray(byServerIdRaw)) return null;

    const rawUrl = (byServerIdRaw as Record<string, unknown>)[serverId];
    return normalizeOpenCodeServerBaseUrl(rawUrl);
}

function buildOpenCodeEnvironmentVariables(opts: {
    settings?: Record<string, unknown> | null;
    session?: { metadata?: Record<string, unknown> | null } | null;
    environmentVariables?: Record<string, string> | undefined;
    newSessionOptions?: Record<string, unknown> | null;
    allowLegacySettingsServerBaseUrl?: boolean;
    allowActiveServerFallback?: boolean;
}): Record<string, string> {
    const base = { ...(opts.environmentVariables ?? {}) };
    const metadata = opts.session?.metadata ?? null;
    const sessionAffinity = readOpenCodeSessionAffinityFromMetadata(metadata);
    const backendMode = sessionAffinity.backendMode
        ?? normalizeOpenCodeBackendMode(opts.settings?.opencodeBackendMode);
    base.HAPPIER_OPENCODE_BACKEND_MODE = backendMode;

    const sessionServerBaseUrl = sessionAffinity.serverBaseUrlExplicit ? sessionAffinity.serverBaseUrl : null;
    const targetServerId = typeof opts.newSessionOptions?.targetServerId === 'string'
        ? opts.newSessionOptions.targetServerId
        : null;
    const activeServerOverride = readOpenCodeScopedServerBaseUrlFromSettings({
        settings: opts.settings,
        targetServerId,
        allowActiveServerFallback: opts.allowActiveServerFallback,
    });
    const legacyServerBaseUrl = opts.allowLegacySettingsServerBaseUrl === true
        ? normalizeOpenCodeServerBaseUrl(opts.settings?.opencodeServerBaseUrl)
        : null;
    const settingsServerBaseUrl = activeServerOverride ?? legacyServerBaseUrl;
    const serverBaseUrl = sessionServerBaseUrl ?? settingsServerBaseUrl;
    if (serverBaseUrl) {
        base.HAPPIER_OPENCODE_SERVER_URL = serverBaseUrl;
        base.HAPPIER_OPENCODE_SERVER_URL_EXPLICIT = '1';
    }

    return base;
}

export const OPENCODE_UI_BEHAVIOR_OVERRIDE: AgentUiBehavior = {
    guidance: {
        includeInSessionGettingStartedCliExamples: true,
    },
    mcpServers: {
        supportsDetectedConfigScan: true,
    },
    newSession: {
        supportsTranscriptStorageMode: ({ settings, storageMode }) => {
            if (storageMode !== 'direct') return true;
            return resolveEffectiveConfiguredRuntimeControlSurface({
                agentId: 'opencode',
                accountSettings: settings as Record<string, unknown>,
            }).sessionStorage.direct === true;
        },
    },
    directSessions: {
        browse: {
            order: 30,
            getSourceOptions: () => resolveOpenCodeBrowseSourceOptions(),
            buildLinkEnsureRequestExtras: ({ candidate }) => resolveOpenCodeLinkEnsureRequestExtras({ candidate }),
        },
    },
    payload: {
        buildSpawnEnvironmentVariables: ({ agentId, settings, environmentVariables, newSessionOptions }) => {
            if (agentId !== 'opencode') return environmentVariables;
            return buildOpenCodeEnvironmentVariables({
                settings,
                environmentVariables,
                newSessionOptions,
                allowLegacySettingsServerBaseUrl: false,
                allowActiveServerFallback: true,
            });
        },
        buildResumeSessionExtras: ({ agentId, settings, session }) => {
            if (agentId !== 'opencode') return {};
            return {
                environmentVariables: buildOpenCodeEnvironmentVariables({
                    settings: settings as any,
                    session: session as any,
                    allowLegacySettingsServerBaseUrl: true,
                    allowActiveServerFallback: false,
                }),
            };
        },
        buildWakeResumeExtras: ({ agentId, resumeCapabilityOptions, session }) => {
            if (agentId !== 'opencode') return {};
            return {
                environmentVariables: buildOpenCodeEnvironmentVariables({
                    settings: (resumeCapabilityOptions.accountSettings ?? {}) as any,
                    session: session as any,
                    allowLegacySettingsServerBaseUrl: true,
                    allowActiveServerFallback: false,
                }),
            };
        },
    },
};
