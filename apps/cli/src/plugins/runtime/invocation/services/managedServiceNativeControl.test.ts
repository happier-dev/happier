import { expect, it } from 'vitest';
import { machineNativeEffectAdmission, type MachineNativeEffectKey } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { runManagedServiceNativeControl } from './managedServiceNativeControl';

it('restarts an App within its admitted deployment while excluding another native operation', async () => {
    const keys: readonly MachineNativeEffectKey[] = [{ kind: 'composeProject', dockerEndpoint: 'engine', projectName: 'collector' }];
    let restarted = false;
    await machineNativeEffectAdmission.run({ operation: { operationId: 'deploy', kind: 'deploy' }, keys }, async context => {
        await expect(runManagedServiceNativeControl({}, { operation: { operationId: 'different', kind: 'deploy' }, keys,
            admittedContext: context }, async () => {}, () => {})).rejects.toMatchObject({ code: 'admission_unavailable' });
        await expect(runManagedServiceNativeControl({}, { operation: context.operation, keys: [{ kind: 'machineSetup' }],
            admittedContext: context }, async () => {}, () => {})).rejects.toMatchObject({ code: 'admission_unavailable' });
        const child = { operation: context.operation, keys, admittedContext: context };
        await runManagedServiceNativeControl({}, child, async borrowed => {
            expect(borrowed).toBe(context);
            await expect(runManagedServiceNativeControl({}, { operation: { operationId: 'outsider', kind: 'serviceControl' }, keys },
                async () => { throw new Error('Another operation must not restart the container'); }, () => {}))
                .rejects.toMatchObject({ code: 'effect_in_progress' });
            restarted = true;
        }, () => {});
    });
    expect(restarted).toBe(true);
});
