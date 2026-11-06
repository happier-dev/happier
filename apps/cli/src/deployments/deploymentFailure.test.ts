import { describe, expect, it } from 'vitest';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createMachineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { projectDeploymentFailure } from './deploymentFailure';

describe('deployment failure diagnostics', () => {
    it('retains the incumbent native operation through the published failure envelope', async () => {
        const admission = createMachineNativeEffectAdmission();
        const keys = [{ kind: 'dockerEngine' as const, dockerEndpoint: 'engine' }];
        await admission.run({ operation: { operationId: 'incumbent-remove', kind: 'machine_setup' }, keys }, async () => {
            let failure: unknown;
            try {
                await admission.run({ operation: { operationId: 'next-build', kind: 'deployment_build' }, keys }, async () => {
                    throw new Error('Conflicting build must not run');
                });
            } catch (error) { failure = projectDeploymentFailure('effect_in_progress', error); }
            expect(ActionExecuteFailureSchema.parse(JSON.parse(JSON.stringify(failure)))).toMatchObject({
                ok: false, errorCode: 'effect_in_progress', details: { actionOperationId: 'incumbent-remove' },
            });
        });
    });
});
