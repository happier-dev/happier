import {
    mergeExternalSessionEnvironmentVariables,
    type ExternalSessionProviderOps,
} from '@/session/external/providerOps';
import { readOpenCodeSessionRuntimeHandleFromMetadata } from '@happier-dev/agents';

import { getOpenCodeExternalSessionActivity } from './getOpenCodeExternalSessionActivity';
import { getOpenCodeExternalSessionWorkingDirectory } from './getOpenCodeExternalSessionWorkingDirectory';
import { listOpenCodeSessionCandidates } from './listOpenCodeSessionCandidates';
import { pageOpenCodeTranscript } from './pageOpenCodeTranscript';
import { readAfterOpenCodeTranscript } from './readAfterOpenCodeTranscript';
import { resolveOpenCodeExternalSessionLinkIdentity } from './resolveOpenCodeExternalSessionLinkIdentity';
import { validateOpenCodeExternalSessionsSource } from './validateOpenCodeExternalSessionsSource';

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export const openCodeExternalSessionProviderOps: ExternalSessionProviderOps = {
    validateSource: ({ source, env }) => validateOpenCodeExternalSessionsSource({ source, env }),
    listCandidates: async ({ source, cursor, limit, searchTerm }) => {
        const res = await listOpenCodeSessionCandidates({ source, cursor, limit, searchTerm });
        return { candidates: res.candidates, nextCursor: res.nextCursor ?? null };
    },
    getActivity: async ({ source, remoteSessionId }) => {
        const res = await getOpenCodeExternalSessionActivity({ source, remoteSessionId });
        return {
            lastActivityAtMs: typeof res.lastActivityAtMs === 'number' && Number.isFinite(res.lastActivityAtMs) ? res.lastActivityAtMs : null,
            isRunning: res.isBusy === true,
        };
    },
    pageTranscript: async ({ source, remoteSessionId, direction, cursor, maxBytes, maxItems }) => {
        const res = await pageOpenCodeTranscript({ source, remoteSessionId, direction, cursor, maxBytes, maxItems });
        return {
            items: res.items,
            nextCursor: res.nextCursor ?? null,
            tailCursor: res.tailCursor ?? null,
            hasMore: res.hasMore,
            truncated: res.truncated === true,
        };
    },
    readAfterTranscript: async ({ source, remoteSessionId, cursor, maxBytes, maxItems }) => {
        const res = await readAfterOpenCodeTranscript({ source, remoteSessionId, cursor, maxBytes, maxItems });
        return { items: res.items, nextCursor: res.nextCursor ?? null, truncated: res.truncated === true };
    },
    canonicalizeLinkedSession: async ({ metadata, remoteSessionId, source }) => {
        const externalSession = asRecord((metadata as any).externalSessionV1);
        const runtimeHandle = readOpenCodeSessionRuntimeHandleFromMetadata({
            ...metadata,
            runtimeDescriptorV1: externalSession?.runtimeDescriptorV1 ?? (metadata as any).runtimeDescriptorV1,
            agentRuntimeDescriptorV1: externalSession?.agentRuntimeDescriptorV1 ?? (metadata as any).agentRuntimeDescriptorV1,
        });
        const baseUrl =
            runtimeHandle.serverBaseUrl
            ?? (source.kind === 'opencodeServer' && typeof (source as any).baseUrl === 'string' ? String((source as any).baseUrl).trim() : '');
        const directory =
            source.kind === 'opencodeServer' && typeof (source as any).directory === 'string'
                ? String((source as any).directory).trim()
                : '';
        return {
            remoteSessionId: runtimeHandle.vendorSessionId ?? remoteSessionId,
            source: {
                kind: 'opencodeServer',
                ...(baseUrl ? { baseUrl } : {}),
                ...(directory ? { directory } : {}),
            },
        };
    },
    resolveLinkIdentity: async ({ remoteSessionId, source, runtimeDescriptor }) => {
        return resolveOpenCodeExternalSessionLinkIdentity({ remoteSessionId, source, runtimeDescriptor });
    },
    resolveTakeoverSpawnOptions: async ({ linked, sessionId }) => {
        const directory =
            linked.sessionPath
            ?? (await getOpenCodeExternalSessionWorkingDirectory({
                source: linked.source,
                remoteSessionId: linked.remoteSessionId,
            }));
        if (!directory) return null;
        const baseUrl =
            linked.source.kind === 'opencodeServer' && typeof linked.source.baseUrl === 'string'
                ? linked.source.baseUrl.trim()
                : '';
        return {
            directory,
            backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
            existingSessionId: sessionId,
            resume: linked.remoteSessionId,
            approvedNewDirectoryCreation: true,
            transcriptStorage: 'direct',
            environmentVariables: mergeExternalSessionEnvironmentVariables([
                {
                    HAPPIER_OPENCODE_BACKEND_MODE: 'server',
                    ...(baseUrl ? { HAPPIER_OPENCODE_SERVER_URL: baseUrl } : {}),
                    ...(baseUrl ? { HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1' } : {}),
                },
            ]),
        };
    },
};
