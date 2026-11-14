import { expect, it } from 'vitest';
import { ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { applyManagedMachineEnrollmentRoles } from './enrollmentRoles.js';
import { ManagedMachineControllerError } from './controllerErrors.js';

const machine = ManagedMachineFullV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner',
    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'VM', choices: {} },
    resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'native' } },
    allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, enrolledMachineId: 'guest',
    enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } });

it.each(['applied', 'satisfied', 'unchanged'] as const)('accepts a confirmed sandbox roles seed (%s)', async status => {
    const warnings: string[] = [];
    await expect(applyManagedMachineEnrollmentRoles({ machine, warn: code => warnings.push(code), dispatch: async input => {
        expect(input).toMatchObject({ machineId: 'guest', serverId: 'home', expectedMetadataVersion: 0,
            policy: { active: ['sessions'] } });
        return { status, policy: input.policy, metadataVersion: 1 };
    } })).resolves.toBeUndefined();
    expect(warnings).toEqual([]);
});

it.each(['conflict', 'outcomeUnknown'] as const)('keeps enrollment successful but reports an unconfirmed roles seed after %s', async status => {
    const warnings: string[] = [];
    await expect(applyManagedMachineEnrollmentRoles({ machine, warn: code => warnings.push(code),
        dispatch: async () => status === 'outcomeUnknown' ? { status } : { status,
            policy: { active: ['deployments'] }, metadataVersion: 2 } })).resolves.toBeUndefined();
    expect(warnings).toEqual([status === 'conflict' ? 'machine_roles_unconfirmed' : 'action_outcome_unknown']);
});

it.each([new ManagedMachineControllerError('permission_denied'), new Error('PRIVATE_REMOTE_MESSAGE')])(
    'preserves enrollment after a refused seed and reports only a public code (%s)', async error => {
        const warnings: string[] = [];
        await expect(applyManagedMachineEnrollmentRoles({ machine, warn: code => warnings.push(code),
            dispatch: async () => { throw error; } })).resolves.toBeUndefined();
        expect(warnings).toEqual([error instanceof ManagedMachineControllerError ? 'permission_denied' : 'internal_error']);
    });

it('keeps cancellation observable instead of treating it as an optional seed warning', async () => {
    const controller = new AbortController();
    const cancelled = new Error('cancelled');
    const warnings: string[] = [];
    await expect(applyManagedMachineEnrollmentRoles({ machine, signal: controller.signal, warn: code => warnings.push(code),
        dispatch: async () => { controller.abort(cancelled); throw cancelled; } })).rejects.toBe(cancelled);
    expect(warnings).toEqual([]);
});
