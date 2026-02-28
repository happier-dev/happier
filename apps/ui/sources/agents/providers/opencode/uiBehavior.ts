import type { AgentUiBehavior } from '@/agents/registry/registryUiBehavior';

function normalizeOpenCodeBackendMode(raw: unknown): 'server' | 'acp' {
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (value === 'acp') return 'acp';
    return 'server';
}

function readOpenCodeBackendModeFromSessionMetadata(raw: unknown): 'server' | 'acp' | null {
    const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (value === 'server') return 'server';
    if (value === 'acp') return 'acp';
    return null;
}

export const OPENCODE_UI_BEHAVIOR_OVERRIDE: AgentUiBehavior = {
    payload: {
        buildSpawnEnvironmentVariables: ({ agentId, settings, environmentVariables }) => {
            if (agentId !== 'opencode') return environmentVariables;
            const mode = normalizeOpenCodeBackendMode((settings as any)?.opencodeBackendMode);
            return {
                ...(environmentVariables ?? {}),
                HAPPIER_OPENCODE_BACKEND_MODE: mode,
            };
        },
    },
    forking: {
        supportsForkConversation: ({ session }) => {
            const mode = readOpenCodeBackendModeFromSessionMetadata((session as any)?.metadata?.opencodeBackendMode);
            return mode === 'server' || mode === 'acp';
        },
        supportsForkFromMessage: ({ session }) => {
            const mode = readOpenCodeBackendModeFromSessionMetadata((session as any)?.metadata?.opencodeBackendMode);
            return mode === 'server';
        },
    },
};
