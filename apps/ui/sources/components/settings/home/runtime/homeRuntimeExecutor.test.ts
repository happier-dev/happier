import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { parseCapabilitiesDetectResponse } from '@happier-dev/protocol/capabilities';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SystemTaskResult } from '@happier-dev/protocol/system/tasks/spec';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { SystemTaskResultSchema } from '@happier-dev/protocol/system/tasks/spec';
import { standardCleanup } from '@/dev/testkit';
import { t } from '@/text';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

let answerRpc: Parameters<typeof installSessionActionRpcBoundary>[0] = () => { throw new Error('Unexpected daemon request'); };
let refusedMethod: 'start' | 'wait' | null = null;
const requests = installSessionActionRpcBoundary((request, context) => answerRpc(request, context), {
    transformAcknowledgement: (acknowledgement, request) => (request.params as { method?: string })?.method === refusedMethod
        ? { ok: false, error: 'Daemon refused request before execution', errorCode: RPC_ERROR_CODES.FORBIDDEN }
        : acknowledgement,
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { restartHomeRuntime } = await import('./homeRuntimeExecutor');
// Collect the real Action graph before the first lifecycle case starts its operation.
await import('@/sync/ops/actions/defaultActionExecutor');
let context = { serverId: '', secretMaterialAllowed: false, onApprovalPending: vi.fn() };
beforeEach(async () => {
    await harness.reset();
    requests.length = 0;
    refusedMethod = null;
    answerRpc = () => { throw new Error('Unexpected daemon request'); };
    const serverId = await harness.addHome({ name: 'Restart Home', serverUrl: 'https://restart-home.test', accountId: 'account' });
    harness.answer(serverId, '/v2/account/settings', { body: AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {
        actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'home.runtime.restart': ['ui'] } },
    } }, version: 1 }) });
    harness.answer(serverId, '/v1/machines/host-machine', { body: { machine: createPlainMachineRowFixture({ id: 'host-machine', accountId: 'account' }) } });
    context = { serverId, secretMaterialAllowed: false, onApprovalPending: vi.fn() };
});
afterEach(() => standardCleanup());

const executor = { kind: 'connected_machine', machineId: 'host-machine', hostName: 'Home host' } as const;

function installTransport(methods: readonly string[], terminal: Promise<SystemTaskResult>, available = true) {
    requests.length = 0;
    answerRpc = async (input) => {
        if (input.method.endsWith(`:${RPC_METHODS.CAPABILITIES_DETECT}`)) return parseCapabilitiesDetectResponse({ protocolVersion: 1, results: {
            'tool.systemTasks': { ok: true, checkedAt: 1, data: { available, kinds: ['relay.runtime.restart.v1'], methods } },
        } });
        const request = input.params as { method: string; params: { taskId?: string } };
        if (request.method === 'start') return { ok: true, result: { taskId: 'remote-restart' } };
        if (request.method === 'wait' && request.params.taskId === 'remote-restart') return { ok: true, result: SystemTaskResultSchema.parse(await terminal) };
        throw new Error('Unexpected machine request');
    };
}

describe('Home runtime restart task lifecycle', () => {
    it('awaits the connected Machine task and preserves its terminal failure', async () => {
        let complete!: (result: SystemTaskResult) => void;
        installTransport(['start', 'poll', 'respond', 'wait'], new Promise((resolve) => { complete = resolve; }));
        let settled = false;
        const onAdmitted = vi.fn();
        const restart = restartHomeRuntime(executor, { ...context, onAdmitted }).then((outcome) => { settled = true; return outcome; });
        await vi.waitFor(() => expect(requests.some((call) => (call.params as { method?: string }).method === 'wait')).toBe(true));
        expect(settled).toBe(false);
        expect(onAdmitted).toHaveBeenCalledOnce();
        complete({ protocolVersion: 1, taskId: 'remote-restart', ok: false, error: { code: 'restart_failed', message: 'Runtime could not start' } });
        await expect(restart).resolves.toMatchObject({ kind: 'failed', taskId: 'remote-restart', message: 'Runtime could not start' });
    });

    it('does not start a restart when the daemon cannot observe completion', async () => {
        installTransport(['start', 'poll', 'respond'], Promise.resolve({ protocolVersion: 1, taskId: 'remote-restart', ok: true, data: { healthy: true } }));
        await expect(restartHomeRuntime(executor, context)).resolves.toMatchObject({
            kind: 'failed', message: t('homeGovernance.runtime.restartFromHost', { host: executor.hostName }),
        });
        expect(requests.some((call) => (call.params as { method?: string }).method === 'start')).toBe(false);
    });

    it('does not start an advertised but unavailable task service', async () => {
        installTransport(['start', 'wait'], Promise.resolve({ protocolVersion: 1, taskId: 'remote-restart', ok: true, data: { healthy: true } }), false);
        await expect(restartHomeRuntime(executor, context)).resolves.toMatchObject({
            kind: 'failed', message: t('homeGovernance.runtime.restartFromHost', { host: executor.hostName }),
        });
        expect(requests.some((call) => (call.params as { method?: string }).method === 'start')).toBe(false);
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
        const responding = answerRpc;
        if (disposition === 'notSent') refusedMethod = 'wait';
        answerRpc = (input, context) => {
            if (disposition === 'outcomeUnknown' && (input.params as { method?: string }).method === 'wait') throw new Error('Home connection lost after dispatch');
            return responding(input, context);
        };
        await expect(restartHomeRuntime(executor, context)).resolves.toEqual({ kind: 'outcome_unknown', taskId: 'remote-restart' });
    });

    it.each(['notSent', 'outcomeUnknown'] as const)('does not invent a task identity or resubmit when start acknowledgement is %s', async (disposition) => {
        installTransport(['start', 'wait'], Promise.resolve({ protocolVersion: 1, taskId: 'remote-restart', ok: true, data: { healthy: true } }));
        const responding = answerRpc;
        if (disposition === 'notSent') refusedMethod = 'start';
        answerRpc = (input, context) => {
            if (disposition === 'outcomeUnknown' && (input.params as { method?: string }).method === 'start') throw new Error('Home connection lost after dispatch');
            return responding(input, context);
        };
        await expect(restartHomeRuntime(executor, context)).resolves.toEqual(disposition === 'outcomeUnknown'
            ? { kind: 'outcome_unknown' } : { kind: 'failed', message: null });
        expect(requests.filter((call) => (call.params as { method?: string }).method === 'start')).toHaveLength(1);
        expect(requests.some((call) => (call.params as { method?: string }).method === 'wait')).toBe(false);
    });

    it.each([
        { ok: false, error: { code: 'observation_failed', message: 'Cannot read task' } },
        { ok: true, result: { protocolVersion: 1, taskId: 'another-task', ok: false, error: { code: 'restart_failed', message: 'Other task failed' } } },
    ])('does not treat an unavailable or mismatched completion observation as terminal restart failure', async (observation) => {
        installTransport(['start', 'wait'], Promise.resolve({ protocolVersion: 1, taskId: 'remote-restart', ok: true, data: { healthy: true } }));
        const responding = answerRpc;
        answerRpc = (input, context) => (input.params as { method?: string }).method === 'wait' ? observation : responding(input, context);
        await expect(restartHomeRuntime(executor, context)).resolves.toEqual({ kind: 'outcome_unknown', taskId: 'remote-restart' });
    });

    it('does not claim failure or runtime up from successful completion without a health observation', async () => {
        const result = { protocolVersion: 1 as const, taskId: 'remote-restart', ok: true as const };
        installTransport(['start', 'wait'], Promise.resolve(result));
        await expect(restartHomeRuntime(executor, context)).resolves.toEqual({ kind: 'outcome_unknown', taskId: 'remote-restart', result });
    });
});
