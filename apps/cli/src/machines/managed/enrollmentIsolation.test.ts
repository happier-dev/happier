import { describe, expect, it } from 'vitest';
import { applyManagedMachineEnrollmentIsolation } from '@happier-dev/cli-common/machines/managed';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';

describe('managed enrollment isolation refusal', () => {
    it.each([
        { kind: 'unavailable', status: { kind: 'unavailable', code: 'provisioning_unavailable' } },
        { kind: 'unavailable', status: { kind: 'unavailable', code: 'provisioning_unavailable' },
            setup: { outcome: 'not_applied', reasonCode: 'native_check_unavailable',
                failure: { kind: 'native_check_unavailable', reason: 'required_fact_unavailable' },
                recovery: { kind: 'install_managed_cli', executablePath: '/private-runtime-path' } } },
    ] as const)('preserves preview refusal through terminal operation settlement: %j', async preview => {
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'owner',
            generateOperationId: () => 'isolation-refusal' });
        const details = { kind: 'managedAgentIsolation', phase: 'machines.agentIsolation.preview', status: {
            kind: 'unavailable', code: 'provisioning_unavailable', ...('setup' in preview ? {
                setup: { outcome: 'not_applied', reasonCode: 'native_check_unavailable',
                    failure: { kind: 'native_check_unavailable', reason: 'required_fact_unavailable' } },
            } : {}),
        } };
        await expect(operations.observeExecution({ actionId: 'machines.managed.bootstrap.retry',
            input: { homeId: 'home', managedId: 'managed' }, actionRequestId: 'isolation-refusal', execute: async () => {
                await applyManagedMachineEnrollmentIsolation({ target: { machineId: 'guest' }, policy: { enabled: true },
                    // The enrolled guest's RPC response is the only system boundary replaced here.
                    dispatch: async request => {
                        if (request.actionId !== 'machines.agentIsolation.preview') throw new Error('Unavailable preview must not apply');
                        return preview;
                    } });
                return { ok: true, result: {} };
            } })).rejects.toMatchObject({ code: 'provisioning_unavailable', details });
        const settled = await operations.handlers.getV2({ operationId: 'isolation-refusal', waitForTerminal: true });
        expect(settled)
            .toMatchObject({ kind: 'found', operation: { state: 'failed', error: {
                errorCode: 'provisioning_unavailable', details,
            } } });
        expect(JSON.stringify(settled)).not.toContain('/private-runtime-path');
    });

    it('does not publish mismatched or private preview diagnostics', () => {
        for (const status of [
            { kind: 'unavailable', code: 'sudo_unavailable' },
            { kind: 'unavailable', code: 'provisioning_unavailable',
                setup: { outcome: 'not_applied', reasonCode: 'native_check_unavailable',
                    failure: { kind: 'native_check_unavailable', reason: 'private-native-output' } } },
            { kind: 'unavailable', code: 'provisioning_unavailable',
                setup: { outcome: 'not_applied', reasonCode: 'native_check_unavailable',
                    recovery: { kind: 'install_managed_cli', executablePath: '/private-native-output' } } },
        ]) {
            const failure = normalizeActionExecutorThrownError(Object.assign(new Error('provisioning_unavailable'), {
                code: 'provisioning_unavailable',
                // Simulate malformed boundary data without bypassing the public projector's real schema.
                details: { kind: 'managedAgentIsolation', phase: 'machines.agentIsolation.preview', status } }),
            'machines.managed.bootstrap.retry');
            expect(failure).toMatchObject({ errorCode: 'action_failed', details: { kind: 'actionException' } });
            expect(JSON.stringify(failure)).not.toContain('private-native-output');
        }
    });
});
