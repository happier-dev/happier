import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageEventIngestRequestSchema } from '@happier-dev/protocol';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createSdkExecFixture, createEventsFixture, createPluginContextFixture,
    createSessionHooksFixture, createTerminalHostFixture,
} from '../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';
import { createClaudeAgentSdkTurnOperations } from '../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import { createClaudeNativeSessionRuntimeFromOperations } from '../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime';
import { createClaudeUnifiedTerminalTurnOperations } from '../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/turnOperations';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createSessionClientUsageObservationPublisher } from '@/api/session/client/createSessionClientUsageObservationPublisher';
import { withTempDir } from '@/testkit/fs/tempDir';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('runtime usage attribution producer → host → ingest', () => {
    it('retains the terminal foreground turn without assigning its unbound sidechain to that turn', async () => {
        await withTempDir('terminal-usage-attribution-', async directory => {
            const transcriptPath = join(directory, 'native.jsonl');
            await writeFile(transcriptPath, '');
            // Canonical plugin fixture follows the real temporary file. Only OS
            // terminal launch and external host services are boundary fixtures.
            const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service,
                { transcriptFileFollowAllowedPaths: [transcriptPath] });
            const operations = createClaudeUnifiedTerminalTurnOperations({ ctx, directory,
                happierSessionId: 'terminal-usage-session', launchEnv: {}, permissionMode: 'default', hostPreference: 'zellij',
                knownProviderSession: { providerSessionId: 'native-session', transcriptPath } });
            const context = { session: { services: {
                activeInput: { bind: () => ({ dispose() {} }) }, models: { bind: () => ({ dispose() {} }) },
            } } } as unknown as AgentSessionRuntimeContext;
            const session = createClaudeNativeSessionRuntimeFromOperations(operations,
                { kind: 'create', sessionId: 'terminal-usage-session', cwd: directory }, context);
            const events: unknown[] = [];
            session.watch(event => { if (event.kind === 'usage-observed') events.push(AgentSessionRuntimeEventSchema.parse(event)); });
            try {
                await operations.startProviderSession();
                operations.beginProviderTurn('terminal-paid-turn');
                await appendFile(transcriptPath, JSON.stringify({ type: 'assistant', uuid: 'main-record', sessionId: 'native-session',
                    message: { id: 'main-request', model: 'claude-haiku-4-5', usage: { input_tokens: 10, output_tokens: 2 } } }) + '\n');
                await vi.waitFor(() => expect(events).toHaveLength(1));
                expect(events[0]).toMatchObject({ kind: 'usage-observed', turnId: 'terminal-paid-turn', scope: 'turn_delta' });
                await appendFile(transcriptPath, JSON.stringify({ type: 'assistant', uuid: 'sidechain-record', sessionId: 'native-session',
                    isSidechain: true, parent_tool_use_id: 'unbound-task',
                    message: { id: 'sidechain-request', model: 'claude-haiku-4-5', usage: { input_tokens: 5, output_tokens: 1 } } }) + '\n');
                await vi.waitFor(() => expect(events).toHaveLength(2));
                expect(events[1]).not.toHaveProperty('turnId');
            } finally { await session.dispose(); }
        });
    });
    it('keeps the actual Claude request turn and admitted Project on the strict ingest boundary', async () => {
        const exec = createSdkExecFixture();
        const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service,
            { exec: exec.service, sessionHooks: createSessionHooksFixture().service });
        const operations = createClaudeAgentSdkTurnOperations({ ctx, directory: '/private/repository', launchEnv: {},
            permissionMode: 'default', happierSessionId: 'usage-session', initialModelId: 'claude-haiku-4-5' });
        // SDK host services are the external boundary to the Agent leaf. All
        // turn, observation, event and HTTP publication logic beneath it is real.
        const context = { session: { services: {
            activeInput: { bind: () => ({ dispose() {} }) }, models: { bind: () => ({ dispose() {} }) },
        } } } as unknown as AgentSessionRuntimeContext;
        const session = createClaudeNativeSessionRuntimeFromOperations(operations,
            { kind: 'create', sessionId: 'usage-session', cwd: '/private/repository' }, context);
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ features: {}, capabilities: { server: {
            usageAnalytics: { version: 1, eventsIngest: { path: '/v2/usage-events' }, query: { path: '/v2/usage/query' },
                legacy: { usageReportsPath: '/v2/usage-reports', usageQueryPath: '/v1/usage/query' } },
        } } }), { headers: { 'content-type': 'application/json' } })));
        const posted: unknown[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
            posted.push(body); return { data: { ok: true } };
        });
        const publisher = createSessionClientUsageObservationPublisher({ token: 'token',
            transport: { serverId: 'home', serverUrl: 'https://usage-attribution.test',
                createSessionSocketTransport: () => { throw new Error('unused'); } },
            getSessionMetadata: () => ({ machineId: 'machine', projectId: 'accepted-project',
                workspaceId: 'accepted-checkout', path: '/private/repository' }),
            getSocket: () => ({ connected: false, emit() {} }),
        });
        const bridge = createNativeAgentSessionOperations(session, 'usage-session', undefined, undefined, {
            provider: 'claude', publish: input => publisher.publish({ sessionId: 'usage-session', ...input }),
        }, undefined, undefined, {
            context, cwd: '/private/repository', connectedAccounts: [], capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
            cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
        });
        const unsubscribe = bridge.subscribeRuntimeEvents(() => undefined);
        try {
            await bridge.sendTurnPrompt('say ready', { localId: 'input-paid-turn', turnId: 'host-paid-turn' });
            await exec.emit({ type: 'assistant', uuid: 'native-record', session_id: 'native-session',
                message: { id: 'native-inference', role: 'assistant', model: 'claude-haiku-4-5', content: [],
                    usage: { input_tokens: 10, output_tokens: 2 } } });
            await vi.waitFor(() => expect(posted).toHaveLength(1));
            const ingest = UsageEventIngestRequestSchema.parse(posted[0]);
            expect(ingest).toMatchObject({ sessionId: 'usage-session', turnId: 'host-paid-turn',
                projectKey: 'accepted-project', workspaceId: 'accepted-checkout', machineId: 'machine',
                scope: 'turn_delta', tokens: { input: 10, output: 2, total: 12 } });
            expect(JSON.stringify(posted)).not.toContain('/private/repository');
        } finally { unsubscribe(); await bridge.resetOrDisposeRuntime('runtime_recovery'); }
    });
});
