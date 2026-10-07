import type { AgentRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginAgentSessionCapabilitiesV2Schema, readSessionWorkStateV1FromMetadata } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { Metadata } from '@/api/types';
import { OPENCODE_PLUGIN } from '../../../../../../../packages/plugins/opencode/src/manifest';
import { createOpenCodeRuntimeContext } from '../../../../../../../packages/plugins/opencode/src/agent/runtime/server/runtimeContext';
import { createOpenCodeServerRuntime } from '../../../../../../../packages/plugins/opencode/src/agent/runtime/server/runtime';
import type { OpenCodeServerClient } from '../../../../../../../packages/plugins/opencode/src/agent/runtime/server/openCodeServerClient';

import { createNativeAgentSessionWorkStateService } from './nativeAgentSessionWorkState';

describe('OpenCode native todo host composition', () => {
    it('merges a native todo event into Session work-state using the OpenCode declaration', async () => {
        let metadata: Metadata = {
            path: '/repo', host: 'test', homeDir: '/tmp', happyHomeDir: '/tmp/.happier',
            happyLibDir: '/tmp/.happier/lib', happyToolsDir: '/tmp/.happier/tools',
        };
        const declaration = OPENCODE_PLUGIN.manifest.contributes?.agents?.find((agent) => agent.id === 'opencode');
        const workState = createNativeAgentSessionWorkStateService({
            session: {
                sessionId: 'happy-session-1',
                async updateMetadata(updater) { metadata = updater(metadata); },
            },
            pluginId: OPENCODE_PLUGIN.manifest.id,
            contributionId: 'opencode',
            agentId: 'opencode',
            occurrenceId: 'opencode-occurrence',
            declarations: PluginAgentSessionCapabilitiesV2Schema.parse(Reflect.get(declaration?.capabilities ?? {}, 'sessions')).workStateSources ?? [],
            isCurrent: () => true,
        });
        const sessionStorage = new Map<string, unknown>();
        // Only the logger, storage and unused process/interaction boundaries are fixture ports.
        // The native event handler, OpenCode bridge and host work-state merge stay real.
        const context = {
            signal: new AbortController().signal,
            services: {
                logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
                exec: { systemTools: { resolve: vi.fn() } },
                managedServices: {},
                interactions: { askQuestions: vi.fn(), requestApproval: vi.fn() },
                storage: { daemonSession: {
                    get: async (key: string) => sessionStorage.get(key),
                    set: async (key: string, value: unknown) => { sessionStorage.set(key, value); },
                } },
            },
        } as unknown as AgentRuntimeContext;
        const ctx = createOpenCodeRuntimeContext({ kind: 'create', sessionId: 'happy-session-1', cwd: '/repo' }, context, workState);
        // The OpenCode HTTP/SSE client is the genuine external system boundary.
        const client = {
            sessionCreate: vi.fn(async () => ({ id: 'ses-1' })),
            sessionUpdatePermissions: vi.fn(async () => undefined),
            sessionSetAgent: vi.fn(async () => undefined),
            sessionReadAgent: vi.fn(async () => null),
            agentsList: vi.fn(async () => []),
            sessionSetModel: vi.fn(async () => undefined),
            sessionFork: vi.fn(async () => ({ id: 'ses-forked' })),
            sessionPromptAsync: vi.fn(async () => undefined),
            sessionCommand: vi.fn(async () => undefined),
            sessionAbort: vi.fn(async () => undefined),
            sessionSummarize: vi.fn(async () => undefined),
            sessionStatus: vi.fn(async () => ({ type: 'idle' })),
            sessionChildInventory: vi.fn(async () => null),
            sessionMessages: vi.fn(async () => []),
            sessionTodo: vi.fn(async () => [{ id: 'todo-1', content: 'Ship OpenCode runtime', status: 'in_progress', priority: 'high' }]),
            permissionList: vi.fn(async () => []),
            questionList: vi.fn(async () => []),
            permissionReply: vi.fn(async () => undefined),
            questionReply: vi.fn(async () => undefined),
            questionReject: vi.fn(async () => undefined),
            appSkills: vi.fn(async () => []),
            appCommands: vi.fn(async () => []),
            globalConfigGet: vi.fn(async () => ({})),
            subscribeGlobalEvents: vi.fn(async () => undefined),
            providersList: vi.fn(async () => []),
            mcpAdd: vi.fn(async () => ({ status: 'connected' as const })),
            mcpRemove: vi.fn(async () => undefined),
        } satisfies OpenCodeServerClient;
        const runtime = createOpenCodeServerRuntime({
            ctx, directory: '/repo', happierSessionId: 'happy-session-1', client,
            mcpRegistration: Promise.resolve({ requiredHappier: { status: 'ready' }, registeredServers: [] }),
            mcpProjection: { registrations: [], requiredHappierServerName: null, requiredHappierConfigurationPresent: false },
        });
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
        try {
            await runtime.openSession({ kind: 'create' });
            await runtime.handleProviderEvent({ payload: { type: 'todo.updated', properties: { sessionID: 'ses-1' } } });

            const snapshot = readSessionWorkStateV1FromMetadata(metadata);
            expect(snapshot?.items).toEqual([
                expect.objectContaining({ kind: 'todo', status: 'active', title: 'Ship OpenCode runtime', agentId: 'opencode', vendorRef: 'todo-1' }),
            ]);
            expect(snapshot?.primaryItemId).toBe(snapshot?.items[0]?.id);

            now.mockReturnValue(1_001);
            client.sessionTodo.mockResolvedValue([]);
            await runtime.handleProviderEvent({ payload: { type: 'todo.updated', properties: { sessionID: 'ses-1' } } });
            expect(readSessionWorkStateV1FromMetadata(metadata)?.items).toEqual([]);
        } finally {
            now.mockRestore();
            await runtime.resetOrDisposeRuntime();
        }
    });
});
