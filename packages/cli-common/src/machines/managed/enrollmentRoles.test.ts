import { expect, it } from 'vitest';
import { ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { applyManagedMachineEnrollmentRoles } from './enrollmentRoles.js';

const machine = ManagedMachineFullV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner',
    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'VM', choices: {} },
    resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'native' } },
    allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, enrolledMachineId: 'guest',
    enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } });

it.each(['applied', 'satisfied', 'unchanged'] as const)('accepts a confirmed sandbox roles seed (%s)', async status => {
    await expect(applyManagedMachineEnrollmentRoles({ machine, dispatch: async input => {
        expect(input).toMatchObject({ machineId: 'guest', serverId: 'home', expectedMetadataVersion: 0,
            policy: { active: ['sessions'] } });
        return { status, policy: input.policy, metadataVersion: 1 };
    } })).resolves.toBeUndefined();
});

it.each(['conflict', 'outcomeUnknown'] as const)('does not claim the sandbox default was applied after %s', async status => {
    await expect(applyManagedMachineEnrollmentRoles({ machine, dispatch: async () => status === 'outcomeUnknown' ? { status } : { status,
        policy: { active: ['deployments'] }, metadataVersion: 2 } })).rejects.toMatchObject({
            code: status === 'conflict' ? 'machine_roles_unconfirmed' : 'action_outcome_unknown',
        });
});
