import { expect, it } from 'vitest';
import { ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { applyManagedMachineEnrollmentRoles } from './enrollmentRoles.js';
import { ManagedMachineControllerError } from './controllerErrors.js';
import { CORE_MACHINE_ROLE_IDS_V1, mutateMachineRolesV1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';

const machine = ManagedMachineFullV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner',
    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'VM', choices: {} },
    resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'native' } },
    allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, enrolledMachineId: 'guest',
    enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } });

it.each([
    { kind: 'sandbox', expectedRoles: ['sessions'], contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, provisionerId: 'happier.devcontainer/devcontainer' },
    { kind: 'personal', expectedRoles: CORE_MACHINE_ROLE_IDS_V1.filter(id => id !== 'broker'),
        contributionRef: { pluginId: 'happier.machine.lume', localId: 'lume' }, provisionerId: 'happier.machine.lume/lume' },
    { kind: 'server', expectedRoles: ['sessions', 'workspaces', 'relay'],
        contributionRef: { pluginId: 'happier.machine.lima', localId: 'lima' }, provisionerId: 'happier.machine.lima/lima' },
] as const)('seeds created $kind isolation with the broker off and preserves later role choices', async ({ kind, expectedRoles, contributionRef, provisionerId }) => {
    let metadata: Record<string, unknown> = { host: 'guest' };
    let metadataVersion = 0;
    const writes: Record<string, unknown>[] = [];
    const port = {
        read: async () => ({ status: 'ready' as const, metadata, metadataVersion }),
        compareAndSwap: async (input: { metadata: Record<string, unknown>; expectedMetadataVersion: number }) => {
            expect(input.expectedMetadataVersion).toBe(metadataVersion);
            metadata = input.metadata;
            writes.push(metadata);
            return { status: 'applied' as const, metadata, metadataVersion: ++metadataVersion };
        },
    };
    const enrolled = ManagedMachineFullV1Schema.parse({ ...machine, launch: { ...machine.launch, provider: contributionRef },
        resource: { ...machine.resource!, contributionRef, origin: 'created' },
        enrollmentIdentity: kind === 'sandbox' ? machine.enrollmentIdentity
            : kind === 'server' ? { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user',
                role: 'server', adminAccessAtCreation: 'none' }
                : { kind: 'existingUser', role: 'personal' } });
    const warnings: string[] = [];
    const seed = () => applyManagedMachineEnrollmentRoles({ machine: enrolled, warn: code => warnings.push(code),
        // The daemon RPC owner consumes routing before invoking the metadata mutation.
        dispatch: ({ serverId: _serverId, machineId: _machineId, ...mutation }) => mutateMachineRolesV1(mutation, port) });
    await seed();
    expect(metadata.isolationV1).toEqual({ environment: 'managed-guest', provisionerId });
    expect(writes).toHaveLength(1);
    expect(metadata.rolesV1).toEqual({ active: expectedRoles });
    await seed();
    expect(writes).toHaveLength(1);
    metadata = { ...metadata, isolationV1: { environment: 'managed-guest', provisionerId: 'other/guest' } };
    await seed();
    expect(metadata.isolationV1).toEqual({ environment: 'managed-guest', provisionerId: 'other/guest' });
    expect(writes).toHaveLength(1);
    expect(warnings).toEqual([]);

    const enabled = { active: [...CORE_MACHINE_ROLE_IDS_V1] };
    await mutateMachineRolesV1({ expectedPolicy: { active: expectedRoles }, expectedMetadataVersion: metadataVersion, policy: enabled }, port);
    await seed();
    expect(metadata.rolesV1).toEqual(enabled);
    expect(writes).toHaveLength(2);
});

it.each(['personal', 'adopted'] as const)('does not label existing %s hosts isolated without created provenance', async role => {
    const writes: unknown[] = [];
    await applyManagedMachineEnrollmentRoles({ machine: { ...machine, enrollmentIdentity: { kind: 'existingUser', role } },
        warn: code => { throw new Error(code); }, dispatch: async input => { writes.push(input); return { status: 'unavailable' }; } });
    expect(writes).toEqual([]);
});

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
