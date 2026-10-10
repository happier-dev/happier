import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SystemTaskResult } from '@happier-dev/protocol';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';
import { standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const rpc = vi.hoisted(() => vi.fn<(input: { method: string; payload: unknown }) => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { restartHomeRuntime } = await import('./homeRuntimeExecutor');
let context = { serverId: '', secretMaterialAllowed: false, onApprovalPending: vi.fn() };
beforeEach(async () => {
    await harness.reset();
    const serverId = await harness.addHome({ name: 'Restart Home', serverUrl: 'https://restart-home.test', accountId: 'account' });
    harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
        actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'home.runtime.restart': ['ui'] } },
    } }, version: 1 } });
    context = { serverId, secretMaterialAllowed: false, onApprovalPending: vi.fn() };
});
afterEach(() => standardCleanup());

const executor = { kind: 'connected_machine', machineId: 'host-machine', hostName: 'Home host' } as const;

function installTransport(methods: readonly string[], terminal: Promise<SystemTaskResult>, available = true) {
    rpc.mockClear();
    rpc.mockImplementation(async (input) => {
        if (input.method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
            'tool.systemTasks': { ok: true, checkedAt: 1, data: { available, kinds: ['relay.runtime.restart.v1'], methods } },
        } };
        const request = input.payload as { method: string; params: { taskId?: string } };
        if (request.method === 'start') return { ok: true, result: { taskId: 'remote-restart' } };
        if (request.method === 'wait' && request.params.taskId === 'remote-restart') return { ok: true, result: await terminal };
        throw new Error('Unexpected machine request');
    });
}

describe('Home runtime restart task lifecycle', () => {
    it('awaits the connected Machine task and preserves its terminal failure', async () => {
        let complete!: (result: SystemTaskResult) => void;
        installTransport(['start', 'poll', 'respond', 'wait'], new Promise((resolve) => { complete = resolve; }));
        let settled = false;
        const onAdmitted = vi.fn();
        const restart = restartHomeRuntime(executor, { ...context, onAdmitted }).then((outcome) => { settled = true; return outcome; });
        await vi.waitFor(() => expect(rpc.mock.calls.some(([call]) => (call.payload as { method?: string }).method === 'wait')).toBe(true));
        expect(settled).toBe(false);
        expect(onAdmitted).toHaveBeenCalledOnce();
        complete({ protocolVersion: 1, taskId: 'remote-restart', ok: false, error: { code: 'restart_failed', message: 'Runtime could not start' } });
        await expect(restart).resolves.toMatchObject({ kind: 'failed', taskId: 'remote-restart', message: 'Runtime could not start' });
    });

    it('does not start a restart when the daemon cannot observe completion', async () => {
        installTransport(['start', 'poll', 'respond'], Promise.resolve({ protocolVersion: 1, taskId: 'remote-restart', ok: true, data: { healthy: true } }));
        await expect(restartHomeRuntime(executor, context)).resolves.toMatchObject({ kind: 'failed' });
        expect(rpc.mock.calls.some(([call]) => (call.payload as { method?: string }).method === 'start')).toBe(false);
    });

    it('does not start an advertised but unavailable task service', async () => {
        installTransport(['start', 'wait'], Promise.resolve({ protocolVersion: 1, taskId: 'remote-restart', ok: true, data: { healthy: true } }), false);
        await expect(restartHomeRuntime(executor, context)).resolves.toMatchObject({ kind: 'failed' });
        expect(rpc.mock.calls.some(([call]) => (call.payload as { method?: string }).method === 'start')).toBe(false);
    });

    it.each([true, false])('requires the connected runtime health fact (%s) after completion', async (healthy) => {
        const result = { protocolVersion: 1 as const, taskId: 'remote-restart', ok: true as const, data: { healthy } };
        installTransport(['start', 'wait'], Promise.resolve(result));
        await expect(restartHomeRuntime(executor, context)).resolves.toMatchObject({
            kind: healthy ? 'restarted' : 'failed', taskId: result.taskId, result,
        });
    });

    it.each(['notSent', 'outcomeUnknown'] as const)('retains the admitted task with an unknown restart outcome when observation is %s', async (disposition) => {
        installTransport(['start', 'wait'], Promise.resolve({ protocolVersion: 1, taskId: 'remote-restart', ok: true, data: { healthy: true } }));
        const responding = rpc.getMockImplementation()!;
        rpc.mockImplementation(async (input) => {
            if ((input.payload as { method?: string }).method === 'wait') throw markRpcRequestDisposition(new Error('Home connection lost'), disposition);
            return responding(input);
        });
        await expect(restartHomeRuntime(executor, context)).resolves.toEqual({ kind: 'outcome_unknown', taskId: 'remote-restart' });
    });

    it.each(['notSent', 'outcomeUnknown'] as const)('does not invent a task identity or resubmit when start acknowledgement is %s', async (disposition) => {
        installTransport(['start', 'wait'], Promise.resolve({ protocolVersion: 1, taskId: 'remote-restart', ok: true, data: { healthy: true } }));
        const responding = rpc.getMockImplementation()!;
        rpc.mockImplementation(async (input) => {
            if ((input.payload as { method?: string }).method === 'start') throw markRpcRequestDisposition(new Error('Home connection lost'), disposition);
            return responding(input);
        });
        await expect(restartHomeRuntime(executor, context)).resolves.toEqual(disposition === 'outcomeUnknown'
            ? { kind: 'outcome_unknown' } : { kind: 'failed', message: null });
        expect(rpc.mock.calls.filter(([call]) => (call.payload as { method?: string }).method === 'start')).toHaveLength(1);
        expect(rpc.mock.calls.some(([call]) => (call.payload as { method?: string }).method === 'wait')).toBe(false);
    });

    it.each([
        { ok: false, error: { code: 'observation_failed', message: 'Cannot read task' } },
        { ok: true, result: { protocolVersion: 1, taskId: 'another-task', ok: false, error: { code: 'restart_failed', message: 'Other task failed' } } },
    ])('does not treat an unavailable or mismatched completion observation as terminal restart failure', async (observation) => {
        installTransport(['start', 'wait'], Promise.resolve({ protocolVersion: 1, taskId: 'remote-restart', ok: true, data: { healthy: true } }));
        const responding = rpc.getMockImplementation()!;
        rpc.mockImplementation(async (input) => (input.payload as { method?: string }).method === 'wait' ? observation : responding(input));
        await expect(restartHomeRuntime(executor, context)).resolves.toEqual({ kind: 'outcome_unknown', taskId: 'remote-restart' });
    });

    it('does not claim failure or runtime up from successful completion without a health observation', async () => {
        const result = { protocolVersion: 1 as const, taskId: 'remote-restart', ok: true as const };
        installTransport(['start', 'wait'], Promise.resolve(result));
        await expect(restartHomeRuntime(executor, context)).resolves.toEqual({ kind: 'outcome_unknown', taskId: 'remote-restart', result });
    });
});
