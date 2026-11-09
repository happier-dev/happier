import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
    createWorkflowAccountRunActionOwner} from '@happier-dev/protocol/actions/executor/workflowRunActions';
import {
    WorkflowRunStartRequestV1Schema} from '@happier-dev/protocol/workflows/actionsV1';
import {
    WorkflowRunSummaryV1Schema,
} from '@happier-dev/protocol/workflows/workflowProgressV1';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { callSocketRpc } from '@happier-dev/sync-client';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';

import { createUiWorkflowActionTransport, type WorkflowActionTransport } from './workflowActionTransport';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);

async function createHarness() {
    const serverId = await homes.addHome({ name: 'Workflow relay', serverUrl: 'https://workflow-relay.test', accountId: 'account-a' });
    const { captureLazyActionAccountContext } = await import('./actionAccountContext');
    const lifetime = new AbortController();
    const account = await captureLazyActionAccountContext(serverId, lifetime.signal);
    onTestFinished(() => account.dispose());
    const transport = vi.fn<WorkflowActionTransport>(async () => ({ definitions: [] }));
    const execute = createUiWorkflowActionTransport({
        account,
        resolveFallbackMachineId: () => 'relay-b',
        transport,
    });
    // This fixture is the admitted UI host producer, not a transport default.
    const context = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
        serverId: account.serverId, runtimeAccountId: account.accountId };
    return { execute, context, transport, retire: () => lifetime.abort() };
}

describe('Workflow Action relay and resource target', () => {
    it('retains a late admission refusal instead of losing it to the ordinary RPC deadline', async () => {
        const { execute, context, transport } = await createHarness();
        vi.useFakeTimers();
        try {
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
        const { execute, context, transport } = await createHarness();
        await expect(execute({ actionId: 'workflow.definition.list', input: {}, context }))
            .resolves.toEqual({ definitions: [] });
        expect(transport.mock.calls[0]?.[0].machineId).toBe('relay-b');
        expect(transport.mock.calls[0]?.[0].payload).toEqual({});
    });

    it('refuses a caller session restriction rather than replacing it with machine authority', async () => {
        const { execute, context, transport } = await createHarness();
        const target = { kind: 'session' as const, sessionId: 'session-a' };
        await expect(execute({ actionId: 'workflow.definition.list', input: {}, context: { ...context, externalActionTarget: target } }))
            .resolves.toMatchObject({ ok: false, errorCode: 'target_not_local' });
        expect(transport).not.toHaveBeenCalled();
    });

    it('does not supply a relay target when the daemon refuses a missing new-Run target', async () => {
        const { execute, context, transport } = await createHarness();
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
        const { execute, context, transport } = await createHarness();
        const target = { kind: 'machine' as const, machineId: 'executor-a', project: { machineId: 'executor-a', directory: '/repo' } };
        const input = { runId: '00000000-0000-4000-8000-000000000001', source: { kind: 'inline' as const, definition: { blocks: ['Work'] } } };
        await execute({ actionId: 'workflow.run.start', input, context: { ...context, externalActionTarget: target } });
        expect(transport.mock.calls[0]?.[0]).toMatchObject({
            machineId: 'executor-a', payload: input, target,
        });
    });

    it("carries the invoking session as the Run origin beside the reviewed target", async () => {
        const { execute, context, transport } = await createHarness();
        const target = { kind: 'machine' as const, machineId: 'executor-a', project: { machineId: 'executor-a', directory: '/repo' } };
        const input = { runId: '00000000-0000-4000-8000-000000000001', source: { kind: 'catalog' as const, workflow: 'builtin:review-and-converge' } };
        await execute({ actionId: 'workflow.run.start', input, context: { ...context, defaultSessionId: 'session-a', externalActionTarget: target } });
        expect(transport.mock.calls[0]?.[0]).toMatchObject({
            machineId: 'executor-a', payload: input, target, invocation: { defaultSessionId: 'session-a' },
        });
    });

    it.each([true, false])('admits catalog Review & converge only with its invoking session: %s', async (withOrigin) => {
        const { execute, context, transport } = await createHarness();
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
                    // The invoking Session is the Run origin; its exact address resolves to its Machine.
                    resolveSessionTarget: async value => typeof value === 'string'
                        ? { address: { serverId: 'home', sessionId: value }, machineId: 'executor-a' }
                        : value && typeof value === 'object' && 'serverId' in value && value.serverId === 'home' && 'sessionId' in value && typeof value.sessionId === 'string'
                            ? { address: { serverId: value.serverId, sessionId: value.sessionId }, machineId: 'executor-a' } : null,
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
        transport.mockImplementation(async ({ payload, target, invocation }) => {
            try {
                return await owner.execute({ actionId: 'workflow.run.start', input: WorkflowRunStartRequestV1Schema.parse(payload),
                    context: { surface: 'ui', authority: 'present_user', callerPermissionMode: 'safe-yolo',
                        externalActionTarget: target, defaultSessionId: invocation.defaultSessionId } });
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
        const { execute, context, transport, retire } = await createHarness();
        transport.mockImplementation(async () => {
            retire();
            return { definitions: [{ private: 'must not disclose' }] };
        });
        await expect(execute({ actionId: 'workflow.definition.list', input: {}, context }))
            .resolves.toEqual({ ok: false, errorCode: 'content_unavailable', error: 'content_unavailable' });
    });
});
