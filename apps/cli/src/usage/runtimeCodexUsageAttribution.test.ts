import fastify from 'fastify';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord, StrictJsonValueSchema, UsageEventIngestRequestSchema } from '@happier-dev/protocol';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

import { createCodexNativeAppServerSessionRuntime } from '../../../../packages/plugins/codex/src/agent/runtime/appServer/native';
import { withCodexNativeAttachFixture } from '../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime.nativeAttach.test-support';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createSessionClientUsageObservationPublisher } from '@/api/session/client/createSessionClientUsageObservationPublisher';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

vi.mock('node:os', async importOriginal => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: process.env.TMPDIR || actual.userInfo().homedir }) };
});
afterEach(() => { vi.restoreAllMocks(); });

describe('native Codex request scope → host → ingest', () => {
    it('retains the dispatch plan through exact native Usage without certifying cumulative history', async () => {
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' } as const;
        const directory = await createTempDir('usage-attribution-');
        onTestFinished(() => removeTempDir(directory));
        const storage = await readOrCreateDeviceLocalSecretStorage({ path: join(directory, 'device.key') });
        const app = fastify();
        const posted: unknown[] = [];
        app.post('/v2/usage-events', async request => {
            posted.push(request.body);
            return { ok: true };
        });
        const restoreAxios = installAxiosFastifyAdapter({ app, origin: 'https://usage-attribution.test' });
        onTestFinished(async () => {
            restoreAxios();
            await app.close();
        });
        let planType = 'plus';
        await withCodexNativeAttachFixture(async ({ runtime, emitNotification }) => {
            expect(await runtime.runtimeAuth.apply({ serviceId: service.localId, authGeneration: {
                credential: StrictJsonValueSchema.parse(buildConnectedServiceCredentialRecord({
                    now: 1000, serviceId: service.localId, profileId: 'account-A', kind: 'oauth', expiresAt: 2000,
                    oauth: { accessToken: 'synthetic-A', refreshToken: 'synthetic-refresh', idToken: null,
                        scope: null, tokenType: null, providerAccountId: 'native-A', providerEmail: null },
                })), credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', forcedWorkspaceId: 'native-A',
                selection: { kind: 'profile', serviceId: service.localId, profileId: 'account-A' },
            } })).toMatchObject({ ok: true });
            await runtime.updateConfig({ modelId: 'gpt-5.4' });
            const session = createCodexNativeAppServerSessionRuntime(runtime, 'actual-happier-session');
            const publisher = createSessionClientUsageObservationPublisher({ token: 'synthetic-token',
                transport: { serverId: 'home', serverUrl: 'https://usage-attribution.test',
                    createSessionSocketTransport: () => { throw new Error('unused'); } },
                getSessionMetadata: () => ({ machineId: 'machine', projectId: 'accepted-project' }),
                emitUsageEvent: () => null,
            });
            const bridge = createNativeAgentSessionOperations(session, 'actual-happier-session', undefined, undefined, {
                provider: 'codex',
                resolveAccountingWitness: async nativeSessionId => ({
                    nativeSessionId, storage,
                    authority: { serverId: 'home', accountId: 'account', machineId: 'machine' },
                    agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
                }),
                publish: input => publisher.publish({ sessionId: 'actual-happier-session', ...input }),
            }, undefined, undefined, {
                context: {} as AgentSessionRuntimeContext, cwd: '/private/repository',
                connectedAccounts: [{ purpose: 'agent', usageAccountScope: 'personal', account: { service, accountId: 'account-A' } }],
                capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
                cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
            });
            const unsubscribe = bridge.subscribeRuntimeEvents(() => undefined);
            try {
                await bridge.sendTurnPrompt('say ready', { localId: 'input-paid-turn', turnId: 'host-paid-turn' });
                // A later read/default plan cannot rewrite the dispatched request's fact.
                planType = 'team';
                emitNotification('rawResponse/completed', { threadId: 'fresh-thread', turnId: 'provider-turn-1',
                    responseId: 'paid-response', usage: { totalTokens: 3, inputTokens: 2, cachedInputTokens: 1, outputTokens: 1,
                        reasoningOutputTokens: 0, cacheWriteInputTokens: 0 } });
                await vi.waitFor(() => expect(posted).toHaveLength(1));
                expect(UsageEventIngestRequestSchema.parse(posted[0])).toMatchObject({
                    turnId: 'host-paid-turn', scope: 'turn_delta', isCumulative: false,
                    tokens: { input: 2, output: 1, cacheRead: 1, total: 3 },
                    cost: { estimatedUsd: expect.any(Number), breakdown: { cacheSavingsUsd: expect.any(Number) } },
                    attribution: { v: 1, turnId: 'host-paid-turn', source: { kind: 'native', accountScope: 'personal',
                        connectedAccount: { service, accountId: 'account-A' } } },
                });
                // A last-only compatibility snapshot has counters, but no exact
                // upstream response witness and must not inherit the paid proof.
                emitNotification('thread/tokenUsage/updated', { threadId: 'fresh-thread', turnId: 'provider-turn-1',
                    tokenUsage: { last: { totalTokens: 3, inputTokens: 2, outputTokens: 1 } } });
                await vi.waitFor(() => expect(posted).toHaveLength(2));
                expect(UsageEventIngestRequestSchema.parse(posted[1])).not.toHaveProperty('attribution');
                emitNotification('thread/tokenUsage/updated', { threadId: 'fresh-thread', turnId: 'provider-turn-1',
                    tokenUsage: { total: { totalTokens: 9, inputTokens: 6, outputTokens: 3 } } });
                await vi.waitFor(() => expect(posted).toHaveLength(3));
                expect(UsageEventIngestRequestSchema.parse(posted[2])).not.toHaveProperty('attribution');
            } finally { unsubscribe(); await bridge.resetOrDisposeRuntime('runtime_recovery'); }
        }, { connectedAccountService: service, threadStartModel: 'gpt-5.4',
            runtimeAuthHost: { refreshRuntimeAuth: async () => ({ status: 'failed', reason: 'unused' }) },
            accountRead: () => ({ account: { type: 'chatgpt', planType } }),
        });
    });
});
