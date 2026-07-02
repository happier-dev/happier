import type { ExternalSessionTranscriptStoreAdapter } from '@/session/external/transcripts/store';

import {
    acquireCodexRolloutSessionStore,
    withCodexRolloutSessionStore,
} from './codexRolloutSessionStoreRegistry';
import { resolveCodexRolloutExternalTranscriptSnapshot } from './transcriptHistory';
import { homeEntries } from '@happier-dev/plugins-codex/agent/rollout/discovery/homeEntries';
import { resolveCodexExternalSessionFallbackHome } from '@happier-dev/plugins-codex/agent/surfaces/sessions/external/providerOps';

function hasExactConnectedServiceHome(source: Parameters<typeof homeEntries>[0]['source']): boolean {
    return source.kind === 'codexHome'
        && source.home === 'connectedService'
        && (
            (typeof source.connectedServiceProfileId === 'string' && source.connectedServiceProfileId.trim().length > 0)
            || (typeof source.connectedServiceGroupId === 'string' && source.connectedServiceGroupId.trim().length > 0)
            || (typeof source.homePath === 'string' && source.homePath.trim().length > 0)
        );
}

export function createCodexExternalSessionTranscriptStoreAdapter(params: Readonly<{
    activeServerDir: string;
    env?: NodeJS.ProcessEnv;
}>): ExternalSessionTranscriptStoreAdapter {
    return {
        providerId: 'codex',
        withStore: async (input, handler) => await withCodexRolloutSessionStore(
            {
                activeServerDir: params.activeServerDir,
                env: params.env ?? process.env,
                key: {
                    providerId: 'codex',
                    source: input.source,
                    remoteSessionId: input.providerSessionId,
                },
            },
            handler,
        ),
        acquireStore: async (input) => await acquireCodexRolloutSessionStore({
            activeServerDir: params.activeServerDir,
            env: params.env ?? process.env,
            key: {
                providerId: 'codex',
                source: input.source,
                remoteSessionId: input.providerSessionId,
            },
        }),
        resolveFollowTranscriptPath: async (input) => {
            const snapshot = await resolveCodexRolloutExternalTranscriptSnapshot({
                source: input.source,
                activeServerDir: params.activeServerDir,
                remoteSessionId: input.providerSessionId,
                env: params.env ?? process.env,
                options: {
                    allowRolloutCwdAppServerFallback: false,
                    resolveTitle: false,
                },
            });
            return snapshot.primaryRolloutFilePath
                ? {
                    path: snapshot.primaryRolloutFilePath,
                    sourceId: input.providerSessionId,
                }
                : null;
        },
        getProviderHome: async (input) => {
            const entries = await homeEntries({
                source: input.source,
                activeServerDir: params.activeServerDir,
                env: params.env ?? process.env,
            });
            const fallbackHome = resolveCodexExternalSessionFallbackHome(entries);
            if (input.source.kind === 'codexHome' && input.source.home === 'user') {
                return fallbackHome;
            }
            if (hasExactConnectedServiceHome(input.source)) {
                return fallbackHome;
            }
            const snapshot = await resolveCodexRolloutExternalTranscriptSnapshot({
                source: input.source,
                activeServerDir: params.activeServerDir,
                remoteSessionId: input.providerSessionId,
                env: params.env ?? process.env,
                options: {
                    allowRolloutCwdAppServerFallback: false,
                    resolveTitle: false,
                },
            });
            return snapshot.rolloutHome;
        },
    };
}
