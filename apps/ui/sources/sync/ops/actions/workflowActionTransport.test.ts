import { describe, expect, it, vi } from 'vitest';
import {
    createWorkflowAccountRunActionOwner,
    TargetedActionRpcRequestV1Schema,
    WorkflowRunStartRequestV1Schema,
    WorkflowRunSummaryV1Schema,
} from '@happier-dev/protocol';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { callSocketRpc } from '@happier-dev/sync-client';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';

import { createUiWorkflowActionTransport, type WorkflowActionTransport } from './workflowActionTransport';

function createHarness() {
    let current = true;
    const transport = vi.fn<WorkflowActionTransport>(async () => ({ definitions: [] }));
    const execute = createUiWorkflowActionTransport({
        account: {
            serverId: 'home-a',
            accountId: 'account-a',
            assertCurrent: () => {
                if (!current) throw new Error('action_account_scope_changed');
            },
        },
        resolveFallbackMachineId: () => 'relay-b',
        transport,
    });
    const context = { surface: 'ui' as const, serverId: 'home-a', runtimeAccountId: 'account-a' };
    return { execute, context, transport, retire: () => { current = false; } };
}

describe('Workflow Action relay and resource target', () => {
    it('retains a late admission refusal instead of losing it to the ordinary RPC deadline', async () => {
        vi.useFakeTimers();
        try {
            const { execute, context, transport } = createHarness();
            const refusal = { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
            // Only the remote socket is substituted; the Account relay and RPC
            // acknowledgement/deadline owners execute their real logic.
            transport.mockImplementation(async (request) => await callSocketRpc({
                socket: {
                    connected: true,
                    emit: () => {},
                    emitWithAck: () => new Promise((resolve) => {
                        setTimeout(() => resolve({ ok: true, result: refusal }), DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 5_000);
                    }),
                },
                target: { kind: 'machine', id: request.machineId },
                method: request.method,
                params: request.payload,
                content: { mode: 'plain' },
                timeoutMs: 'operationTimeoutMs' in request && request.operationTimeoutMs === null
                    ? null : DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS,
                signal: request.signal,
            }));
            const result = execute({ actionId: 'workflow.run.start', input: {
                runId: '00000000-0000-4000-8000-000000000001',
                source: { kind: 'inline', definition: { blocks: ['Wait'] } },
            }, context }).catch((error: unknown) => error);
            await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 5_000);
            await expect(result).resolves.toEqual(refusal);
        } finally {
            vi.useRealTimers();
        }
    });

    it('reads through an available relay without restricting the Account operation to that relay', async () => {
        const { execute, context, transport } = createHarness();
        await expect(execute({ actionId: 'workflow.definition.list', input: {}, context }))
            .resolves.toEqual({ definitions: [] });
        expect(transport.mock.calls[0]?.[0].machineId).toBe('relay-b');
        expect(transport.mock.calls[0]?.[0].payload).toEqual({});
    });

    it('preserves the caller session restriction rather than replacing it with the relay machine', async () => {
        const { execute, context, transport } = createHarness();
        const target = { kind: 'session' as const, sessionId: 'session-a' };
        await execute({ actionId: 'workflow.definition.list', input: {}, context: { ...context, externalActionTarget: target } });
        expect(transport.mock.calls[0]?.[0]).toMatchObject({
            machineId: 'relay-b',
            payload: { v: 1, kind: 'targeted_action_rpc', input: {}, target },
        });
    });

    it('does not supply a relay target when the daemon refuses a missing new-Run target', async () => {
        const { execute, context, transport } = createHarness();
        transport.mockResolvedValue({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' });
        const input = { runId: '00000000-0000-4000-8000-000000000001', source: { kind: 'inline' as const, definition: { blocks: ['Work'] } } };
        await expect(execute({
            actionId: 'workflow.run.start',
            input,
            context,
        })).resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(transport.mock.calls[0]?.[0].payload).toEqual(input);
    });

    it('forwards the exact reviewed machine and project', async () => {
        const { execute, context, transport } = createHarness();
        const target = { kind: 'machine' as const, machineId: 'executor-a', project: { machineId: 'executor-a', directory: '/repo' } };
        const input = { runId: '00000000-0000-4000-8000-000000000001', source: { kind: 'inline' as const, definition: { blocks: ['Work'] } } };
        await execute({ actionId: 'workflow.run.start', input, context: { ...context, externalActionTarget: target } });
        expect(transport.mock.calls[0]?.[0]).toMatchObject({
            machineId: 'executor-a', payload: { v: 1, kind: 'targeted_action_rpc', input, target },
        });
    });

    it("carries the invoking session as the Run origin beside the reviewed target", async () => {
        const { execute, context, transport } = createHarness();
        const target = { kind: 'machine' as const, machineId: 'executor-a', project: { machineId: 'executor-a', directory: '/repo' } };
        const input = { runId: '00000000-0000-4000-8000-000000000001', source: { kind: 'catalog' as const, workflow: 'builtin:review-and-converge' } };
        await execute({ actionId: 'workflow.run.start', input, context: { ...context, defaultSessionId: 'session-a', externalActionTarget: target } });
        expect(transport.mock.calls[0]?.[0]).toMatchObject({
            machineId: 'executor-a', payload: { v: 1, kind: 'targeted_action_rpc', input, target, defaultSessionId: 'session-a' },
        });
    });

    it.each([true, false])('admits catalog Review & converge only with its invoking session: %s', async (withOrigin) => {
        const { execute, context, transport } = createHarness();
        let admittedOrigin: unknown;
        // The remote host and its materializer stay real. Only storage, native
        // availability, workspace preparation and the plugin schema catalog are boundaries.
        const owner = createWorkflowAccountRunActionOwner({
            resolveAccountId: async () => 'account-a',
            definitions: { get: async () => { throw new Error('catalog_does_not_read_artifacts'); } },
            resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
            normalizeAbsolutePath: (directory) => directory.startsWith('/') ? directory : null,
            randomBytes: () => { throw new Error('plain_account_has_no_keys'); },
            prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'executor-a', directory: '/repo', checkoutRootPath: '/repo' } } }),
            resolveMaterializationContext: async () => ({
                roleSelection: { defaultEngine: { agentTargetKey: 'agent:happier.agent.codex/codex' },
                    availableAgentTargetKeys: ['agent:happier.agent.codex/codex'] },
                effects: { resolveTargetAvailability: async () => true,
                    readActionContract: async () => ({ inputSchema: { type: 'object' }, outputSchema: {} }) },
            }),
            storage: { execute: async (operation) => {
                if (operation.operation === 'get') throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
                if (operation.operation !== 'admit') throw new Error('unexpected_storage_operation');
                admittedOrigin = operation.origin;
                return { kind: 'created', run: WorkflowRunSummaryV1Schema.parse({
                    ...createWorkflowRunSummaryFixture({ id: String(operation.runId) }), origin: operation.origin,
                }) };
            } },
        });
        transport.mockImplementation(async ({ payload }) => {
            const request = TargetedActionRpcRequestV1Schema.parse(payload);
            try {
                return await owner.execute({ actionId: 'workflow.run.start', input: WorkflowRunStartRequestV1Schema.parse(request.input),
                    context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'safe-yolo',
                        externalActionTarget: request.target, defaultSessionId: request.defaultSessionId } });
            } catch (error) {
                return { ok: false, errorCode: typeof error === 'object' && error !== null && 'code' in error ? error.code : 'unknown' };
            }
        });
        const response = await execute({ actionId: 'workflow.run.start', input: {
            runId: '00000000-0000-4000-8000-000000000001', source: { kind: 'catalog', workflow: 'builtin:review-and-converge' },
            inputs: { engines: ['agent:happier.agent.codex/codex'] },
        }, context: { ...context, ...(withOrigin ? { defaultSessionId: 'session-a' } : {}),
            externalActionTarget: { kind: 'machine', machineId: 'executor-a', project: { machineId: 'executor-a', directory: '/repo' } } } });
        if (withOrigin) {
            expect(response).toMatchObject({ admission: 'created', run: { origin: { kind: 'direct', originSessionId: 'session-a' } } });
            expect(admittedOrigin).toEqual({ kind: 'direct', originSessionId: 'session-a' });
        } else {
            expect(response).toMatchObject({ ok: false, errorCode: 'invalid_input' });
            expect(admittedOrigin).toBeUndefined();
        }
    });

    it('withdraws a response if the Account lifetime retires while the relay is pending', async () => {
        const { execute, context, transport, retire } = createHarness();
        transport.mockImplementation(async () => {
            retire();
            return { definitions: [{ private: 'must not disclose' }] };
        });
        await expect(execute({ actionId: 'workflow.definition.list', input: {}, context }))
            .resolves.toEqual({ ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' });
    });
});
