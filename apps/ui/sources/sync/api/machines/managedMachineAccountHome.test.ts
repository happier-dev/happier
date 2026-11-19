import { describe, expect, it } from 'vitest';
import { ManagedAcquireInputV1Schema, ManagedAdmissionOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema, ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { admitUiManagedAccountHome, createUiManagedAccountHome } from './managedMachineAccountHome';

const launch = {
    provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1,
    name: 'private preset launch', choices: { image: 'linux' },
};
const enrollmentIdentity = { kind: 'guestProcess' as const, role: 'sandbox' as const };
const machine = ManagedMachineFullV1Schema.parse({
    id: 'managed', homeId: 'home', custodianAccountId: 'account', enrollmentAccountId: 'account', launch,
    allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
});
const provisioner = MachineProvisionerContributionV1Schema.parse({
    id: 'lima', title: 'Lima', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
    enrollmentRole: 'sandbox', launchSchema: { type: 'object', properties: {}, additionalProperties: false },
    resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
    billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['delete'] },
    actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
});
const presetInput = ManagedAcquireInputV1Schema.parse({
    selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 7 },
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    presetContentOverride: { content: { t: 'plain', v: { v: 1, name: 'private override', launch, enrollmentIdentity } } },
});
if (presetInput.selection.kind !== 'preset' || !('presetContentOverride' in presetInput)
    || presetInput.presetContentOverride === undefined) throw new Error('Expected a preset acquire input with its override');
const presetContentOverride = presetInput.presetContentOverride;

function accountResponding(body: unknown): Pick<LazyActionAccountContext, 'request'> {
    return { request: async () => Response.json(body) };
}

describe('Account managed admission boundary', () => {
    it('refuses a schema-valid one-off downgrade for a signed preset selection', async () => {
        const fullWire = {
            machine: {
                id: 'managed', homeId: 'home', custodianAccountId: 'account', enrollmentAccountId: 'account',
                launch,
                allocation: 'unsubmitted' as const, creationState: 'active' as const,
                desired: 'start' as const, desiredWhen: 'now' as const, intentRevision: 0,
                retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
            },
            replayed: false,
        };
        // A Home cannot replace the signed preset with a schema-valid one-off
        // row: the Account client must only accept the opaque exact snapshot.
        expect(ManagedAdmissionOutputV1Schema.parse(fullWire)).toEqual(fullWire);

        await expect(admitUiManagedAccountHome({
            account: accountResponding(fullWire), requestId: 'request',
        }, presetInput, 'a'.repeat(43))).rejects.toMatchObject({ code: 'managed_response_invalid' });
    });

    it('refuses an opaque snapshot whose revision differs from the signed selection', async () => {
        const wrongRevision = {
            machine: {
                id: 'managed', homeId: 'home', custodianAccountId: 'account', enrollmentAccountId: 'account',
                preset: { id: 'preset', revision: 8, contentEncryptionMode: 'plain' as const },
                allocation: 'unsubmitted' as const, creationState: 'active' as const,
                desired: 'start' as const, desiredWhen: 'now' as const, intentRevision: 0,
                retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
            },
            presetContent: { content: presetContentOverride.content, recipients: [] },
            replayed: false,
        };
        expect(ManagedAdmissionOutputV1Schema.parse(wrongRevision)).toEqual(wrongRevision);

        await expect(admitUiManagedAccountHome({
            account: accountResponding(wrongRevision), requestId: 'request',
        }, presetInput, 'a'.repeat(43))).rejects.toMatchObject({ code: 'managed_response_invalid' });
    });

    it('refuses a submitted opaque row when its local opener is absent', async () => {
        const { launch: _launch, ...structural } = machine;
        const opaque = ManagedMachineV1Schema.parse({ ...structural,
            preset: { id: 'preset', revision: 7, contentEncryptionMode: 'plain' } });
        const { home } = createUiManagedAccountHome({
            account: accountResponding({ machine: opaque, submitted: false }) as LazyActionAccountContext,
            requestId: 'request', provisioner,
        });

        await expect(home.submit(machine)).rejects.toMatchObject({ code: 'content_unavailable' });
    });

    it('fails closed when the local opaque normalizer refuses a submitted or structural row', async () => {
        const normalizer = { normalize: () => null, structural: () => null };
        const { home, structural } = createUiManagedAccountHome({
            account: accountResponding({ machine, submitted: false }) as LazyActionAccountContext,
            requestId: 'request', provisioner, normalizer,
        });

        await expect(home.submit(machine)).rejects.toMatchObject({ code: 'content_unavailable' });
        expect(() => structural(machine)).toThrow(expect.objectContaining({ code: 'content_unavailable' }));
    });
});


it.each([enrollmentIdentity, { kind: 'existingUser' as const, role: 'adopted' as const }])('returns an enrolled guest without a follow-up effect when there is no Agent start', async identity => {
    const { completeUiManagedAccountGuest } = await import('./managedMachineAccountGuest');
    const enrolled = { ...machine, enrollmentIdentity: identity, enrolledMachineId: 'joined' };
    await expect(completeUiManagedAccountGuest({
        account: accountResponding({ machine: enrolled, requestId: 'creation' }) as LazyActionAccountContext,
        input: {}, machine: enrolled, requestId: 'creation', context: { surface: 'ui' },
    })).resolves.toEqual(enrolled);
});
