import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createSessionHooksService } from './service';
import type { AgentState } from '@/api/types';
import { AgentStateRequestStore } from '@/agent/permissions/agentStateRequestStore';
import { createPermissionRequestCoordinator } from '@/agent/permissions/permissionRequestCoordinator';
import { logger } from '@/ui/logger';
import { createClaudePermissionHookHandler } from '../../../../../../../packages/plugins/claude/src/agent/runtime/shared/permissionHookHandler';
import { createClaudeAgentSdkTurnOperations } from '../../../../../../../packages/plugins/claude/src/agent/runtime/remote/sdk/session';
import { createEventsFixture, createPluginContextFixture, createSdkExecFixture, createTerminalHostFixture } from '../../../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit';

describe('Claude hook lifecycle composition', () => {
    it.each(['admitted', 'failed', 'disconnected'] as const)('withdraws approval when the native hook expires or disconnects while retirement admission is %s', async (outcome) => {
        const home = await mkdtemp(join(tmpdir(), 'happier-claude-hook-expiry-'));
        const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        const admissionFailure = new Error('journal unavailable');
        admissionFailure.name = 'SettlementAdmissionFailure';
        let admitRetirement!: () => void;
        const retirementAdmission = new Promise<void>((resolve) => { admitRetirement = resolve; });
        let markPublished!: () => void;
        const publication = new Promise<void>((resolve) => { markPublished = resolve; });
        // Session persistence is the external boundary; hook, plugin engine, store and coordinator stay real.
        let agentState: AgentState = { requests: {}, completedRequests: {} };
        const session = {
            sessionId: 'hook-expiry',
            getAgentStateSnapshot: () => agentState,
            updateAgentState: (updater: (state: AgentState) => AgentState) => { agentState = updater(agentState); markPublished(); },
            updateAgentStateRequestSettlement: async (updater: (state: AgentState) => AgentState) => {
                const updated = updater(agentState);
                await retirementAdmission;
                if (outcome === 'failed') throw admissionFailure;
                agentState = updated;
            },
        };
        const store = new AgentStateRequestStore({ session, logPrefix: '[HookExpiryTest]' });
        const coordinator = createPermissionRequestCoordinator<{ decision: 'approved' }>({ store });
        const hooks = createSessionHooksService({ happyHomeDir: home, hasCapability: capability => capability === 'sessionHooks' });
        const handler = createClaudePermissionHookHandler({
            agentRuntime: { toolExecution: { before: async (request) => ({ status: 'continue', input: request.input }) } },
            sessions: { current: { permissions: {
                requestDecision: async (request, options) => await coordinator.requestDecision({
                    requestId: request.requestId!, toolName: request.toolName, toolInput: request.input,
                }, options),
            } } },
        });
        const server = await hooks.startServer({ providerId: 'claude', sessionId: session.sessionId,
            onPermissionHook: handler, permissionRequestTimeoutMs: outcome === 'disconnected' ? null : 20 });
        try {
            const disconnect = new AbortController();
            const request = fetch(`http://127.0.0.1:${server.port}/hook/permission-request`, {
                // As the installed forwarder: present the host-generated permission secret.
                method: 'POST', headers: { 'Content-Type': 'application/json',
                    'x-happier-hook-secret': await readFile(server.permissionHookSecretFile!, 'utf8') },
                signal: disconnect.signal,
                body: JSON.stringify({ hook_event_name: 'PermissionRequest', tool_use_id: 'expired-call',
                    tool_name: 'Bash', tool_input: { command: 'pwd' } }),
            });
            if (outcome === 'disconnected') {
                await publication;
                disconnect.abort();
                await expect(request).rejects.toMatchObject({ name: 'AbortError' });
                await vi.waitFor(() => expect(coordinator.getResponseContext('expired-call')).toBeNull());
            } else {
                const response = await request;
                expect(response.status).toBe(408);
                await response.text();
            }
            expect(agentState.requests?.['expired-call']).toBeDefined();
            expect(coordinator.getResponseContext('expired-call')).toBeNull();
            expect(await coordinator.handleResponse({ requestId: 'expired-call', buildCompletion: () => ({
                result: { decision: 'approved' }, completedRequest: { status: 'approved' },
            }) })).toBe(false);
            admitRetirement();
            if (outcome !== 'failed') {
                await vi.waitFor(() => expect(agentState.completedRequests?.['expired-call']).toMatchObject({ status: 'canceled' }));
                expect(agentState.requests?.['expired-call']).toBeUndefined();
            } else {
                await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
                    event: 'permission_request_cancellation_persistence_failed', errorName: admissionFailure.name,
                })));
                expect(agentState.requests?.['expired-call']).toBeDefined();
                expect(agentState.completedRequests?.['expired-call']).toBeUndefined();
                expect(coordinator.getResponseContext('expired-call')).toBeNull();
                expect(await coordinator.handleResponse({ requestId: 'expired-call', buildCompletion: () => ({
                    result: { decision: 'approved' }, completedRequest: { status: 'approved' },
                }) })).toBe(false);
            }
        } finally {
            admitRetirement();
            // A failed admission retains the same exact context for an ordinary lifecycle retry.
            session.updateAgentStateRequestSettlement = async (updater) => { agentState = updater(agentState); };
            await coordinator.dispose();
            await server.dispose();
            await rm(home, { recursive: true, force: true });
            log.mockRestore();
        }
    });

    it('retires a prepared terminal before the first remote turn with real hook ownership', async () => {
        const home = await mkdtemp(join(tmpdir(), 'happier-claude-hook-composed-'));
        const disposables: Array<{ dispose(): Promise<void> | void }> = [];
        const hooks = createSessionHooksService({ happyHomeDir: home, hasCapability: capability => capability === 'sessionHooks',
            addDisposable: disposable => { disposables.push(disposable); } });
        const exec = createSdkExecFixture();
        const ctx = createPluginContextFixture(createTerminalHostFixture().service, createEventsFixture().service, {
            exec: exec.service, sessionHooks: hooks,
        });
        const operations = createClaudeAgentSdkTurnOperations({ ctx, directory: home, launchEnv: {},
            permissionMode: 'default', happierSessionId: 'hook-composed' });
        try {
            const terminal = await operations.prepareTerminalPresentation();
            if (terminal.kind !== 'terminal_launch') throw new Error('Expected terminal launch');
            await Promise.all([
                operations.observeTerminalExecution({ kind: 'launch_failed', plan: terminal.plan }),
                ...disposables.splice(0).map(disposable => disposable.dispose()),
            ]);
            operations.beginProviderTurn('first-turn');
            await operations.sendProviderTurnPrompt('Reply ready');
            await exec.emit({ type: 'system', subtype: 'init', session_id: 'native-hook-composed' });
            await exec.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-hook-composed',
                result: 'ready', queued_turn_count: 0, usage: {}, modelUsage: {} });
            await operations.waitForProviderTurnCompletion();
        } finally {
            await operations.disposeProviderSession();
            await Promise.all(disposables.map(disposable => disposable.dispose()));
            await rm(home, { recursive: true, force: true });
        }
    });
});
