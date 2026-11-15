import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import { createSessionClientUsageObservationPublisher } from './createSessionClientUsageObservationPublisher';
import { withTempDir } from '@/testkit/fs/tempDir';
import { join } from 'node:path';
import { getActiveProjectAccountRowsSnapshot, withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { UsageEventIngestRequestSchema } from '@happier-dev/protocol';

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
    withdrawActiveProjectAccountRowsSnapshot();
});

describe('Session usage transport publisher', () => {
    it('resolves the actual execution root through the accepted Account checkout owner when creation has no Project metadata', async () => {
        await withTempDir('session-usage-project-', async directory => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
            vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: {}, capabilities: { server: { usageAnalytics: {
                version: 1, eventsIngest: { path: '/v2/usage-events' }, query: { path: '/v2/usage/query' },
                legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' },
            } } } }), { headers: { 'content-type': 'application/json' } })));
            const key = { kind: 'workspace-ref' as const, serverId: 'home', id: 'accepted-checkout' };
            const row = { key, revision: 0, content: { t: 'plain', v: { key, value: {
                id: 'accepted-checkout', projectKey: 'accepted-project', serverId: 'home', machineId: 'machine',
                rootPath: '/private/repository', createdAtMs: 1,
            } } } };
            // Actual HTTP boundary; Account mode, cipher, Project resolver and ingest mapper run real logic.
            vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
            const posted: unknown[] = [];
            vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
                if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [row] } };
                posted.push(body); return { data: { ok: true } };
            });
            const publisher = createSessionClientUsageObservationPublisher({ token,
                transport: { serverId: 'home', serverUrl: 'https://session-project.test',
                    createSessionSocketTransport: () => { throw new Error('unused'); } },
                getSessionMetadata: () => ({ machineId: 'machine', path: '/agent/repository',
                    sessionWorkspaceLocationV1: { v: 1, machineId: 'machine', agentPath: '/agent/repository', machinePath: '/private/repository' } }),
                emitUsageEvent: () => null,
                projectContext: { machineId: 'machine', signal: new AbortController().signal,
                    deviceLocalSecretKeyFile: join(directory, 'device.key'), readCredentials: async () => ({ token, encryption: null }) },
            });
            await publisher.publish({ ...input, turnId: 'host-paid-turn' });
            expect(posted).toHaveLength(1);
            expect(UsageEventIngestRequestSchema.parse(posted[0])).toMatchObject({ turnId: 'host-paid-turn',
                projectKey: 'accepted-project', workspaceId: 'accepted-checkout', machineId: 'machine' });
            expect(JSON.stringify(posted)).not.toContain('/private/repository');
            expect(JSON.stringify(posted)).not.toContain('/agent/repository');
            expect(getActiveProjectAccountRowsSnapshot()).toBeNull();
        });
    });
    it('publishes the captured request source after metadata switches and removes forged metadata proof', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: {}, capabilities: { server: { usageAnalytics: {
            version: 1, eventsIngest: { path: '/v2/usage-events' }, query: { path: '/v2/usage/query' },
            legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' },
        } } } }), { headers: { 'content-type': 'application/json' } })));
        const posted: unknown[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => { posted.push(body); return { data: { ok: true } }; });
        const publisher = createSessionClientUsageObservationPublisher({ token: 'token',
            transport: { serverId: 'home', serverUrl: 'https://usage-request-proof.example.test', createSessionSocketTransport: () => { throw new Error('unused'); } },
            getSessionMetadata: () => ({ machineId: 'machine', connectedAccount: 'current-account' }),
            emitUsageEvent: () => null,
        });
        const attribution = { v: 1 as const, turnId: 'old-turn', source: { kind: 'native' as const,
            connectedAccount: { service: { pluginId: 'acme.accounts', localId: 'native' }, accountId: 'old-account' } } };
        await publisher.publish({ ...input, turnId: 'old-turn', attribution });
        expect(posted[0]).toMatchObject({ attribution });
        await publisher.publish({ ...input, turnId: 'new-turn', metadata: { usageAttribution: attribution } });
        expect(JSON.stringify(posted[1])).not.toContain('usageAttribution');
        expect(posted[1]).not.toHaveProperty('attribution');
    });
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
            emitUsageEvent: () => null,
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

    it('returns a failure and warns when the HTTP transport fails', async () => {
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
            emitUsageEvent: () => null,
        });

        await expect(publisher.publish(input)).resolves.toEqual({ status: 'failed' });
        expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: 'usage network failed' }));
    });

});
