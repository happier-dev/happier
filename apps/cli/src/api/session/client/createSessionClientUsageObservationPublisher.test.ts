import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import { createSessionClientUsageObservationPublisher } from './createSessionClientUsageObservationPublisher';

const input = {
    sessionId: 'session-usage', externalKey: 'native-record-1',
    observation: {
        provider: 'claude', source: 'claude-assistant-usage', scope: 'turn_delta' as const,
        key: 'claude-session', modelId: null,
        tokens: { total: 12, input: 7, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        cost: null, contextUsedTokens: null, contextWindowTokens: null,
    },
};

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Session usage transport publisher', () => {
    it('publishes current admitted dimensions without disclosing paths or inventing inference identity', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            features: {}, capabilities: { server: { usageAnalytics: {
                version: 1, eventsIngest: { path: '/v2/usage-events' }, query: { path: '/v2/usage/query' },
                legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' },
            } } },
        }), { headers: { 'content-type': 'application/json' } })));
        const posted: unknown[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
            posted.push(body);
            return { data: { ok: true } };
        });
        let metadata: Record<string, unknown> = {
            machineId: 'machine-1', projectId: 'project-1', workspaceId: 'workspace-1', path: '/private/path',
            providerBindingV1: {
                v: 1, connectionId: 'connection-1', contributionKey: 'happier.provider.openrouter/openrouter',
                connectionRevision: 1, model: { id: 'model-1', name: 'Model' },
                protocol: 'openai_compat', materialization: 'spawnEnv',
                compatibilityFingerprint: 'compatibility', bindingSecurityFingerprint: 'security',
                displaySnapshot: { providerName: 'Provider', connectionName: 'Connection', connectionRole: 'default', connectionDisplayNameMode: 'automatic' },
            },
        };
        const publisher = createSessionClientUsageObservationPublisher({
            token: 'token',
            transport: { serverId: 'home', serverUrl: 'https://usage-dimensions.example.test', createSessionSocketTransport: () => { throw new Error('unused'); } },
            getSessionMetadata: () => metadata,
            getSocket: () => ({ connected: true, emit: vi.fn() }),
        });
        await publisher.publish({ ...input, observation: { ...input.observation, modelId: 'model-1' }, observedAt: 42 });
        expect(posted[0]).toMatchObject({
            machineId: 'machine-1', projectKey: 'project-1', workspaceId: 'workspace-1',
            metadata: {
                usageAccounting: { path: 'runtime', status: 'unknown', asOfMs: 42 },
                providerId: 'happier.provider.openrouter/openrouter', providerConnectionId: 'connection-1',
            },
        });
        expect(JSON.stringify(posted)).not.toContain('/private/path');
        expect(JSON.stringify(posted)).not.toContain('inferenceId');
        expect(JSON.stringify(posted)).not.toContain('historyComplete');
        await publisher.publish({ ...input, observation: { ...input.observation, modelId: 'previous-model' }, observedAt: 43,
            metadata: { providerId: 'forged-provider', providerConnectionId: 'forged-connection' } });
        expect(JSON.stringify(posted[1])).not.toContain('providerConnectionId');
        expect(JSON.stringify(posted[1])).not.toContain('providerId');
        metadata = { sessionModelsV1: { v: 1, agentId: 'claude', updatedAt: 0, currentModelId: 'native-model',
            availableModels: [{ id: 'native-model', name: 'Native' }], activeSelectionV1: { v: 1, source: 'runtime_apply',
                runner: { pid: process.pid, processStartTimeMs: 1 },
                selection: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'native-model' } } } };
        await publisher.publish({ ...input, observation: { ...input.observation, modelId: 'native-model' }, observedAt: 44 });
        // A current native selection is not a response-bound native source witness.
        expect(JSON.stringify(posted[2])).not.toContain('providerConnectionId');
        await publisher.publish({ ...input, observation: { ...input.observation, modelId: 'stale-model' }, observedAt: 45 });
        expect(JSON.stringify(posted[3])).not.toContain('providerConnectionId');
        metadata = { machineId: 'machine-2' };
        await publisher.publish({ ...input, observedAt: 46 });
        expect(posted[4]).toMatchObject({ machineId: 'machine-2', projectKey: null, workspaceId: null });
    });

    it('returns a failure and warns when the advertised HTTP transport fails', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            features: {}, capabilities: { server: { usageAnalytics: {
                version: 1, eventsIngest: { path: '/v2/usage-events' }, query: { path: '/v2/usage/query' },
                legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' },
            } } },
        }), { headers: { 'content-type': 'application/json' } })));
        vi.spyOn(axios, 'post').mockRejectedValue(new Error('usage network failed'));
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const publisher = createSessionClientUsageObservationPublisher({
            token: 'token',
            transport: { serverId: 'home', serverUrl: 'https://usage-failure.example.test', createSessionSocketTransport: () => { throw new Error('unused'); } },
            getSocket: () => ({ connected: true, emit: vi.fn() }),
        });

        await expect(publisher.publish(input)).resolves.toEqual({ status: 'failed' });
        expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: 'usage network failed' }));
    });

    it('reports a disconnected legacy socket as a failure without sending the report', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const emit = vi.fn();
        const publisher = createSessionClientUsageObservationPublisher({
            token: 'token',
            transport: { serverId: 'home', serverUrl: 'https://usage-offline.example.test', createSessionSocketTransport: () => { throw new Error('unused'); } },
            getSocket: () => ({ connected: false, emit }),
        });

        await expect(publisher.publish(input)).resolves.toEqual({ status: 'failed' });
        expect(warn).toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
    });
});
