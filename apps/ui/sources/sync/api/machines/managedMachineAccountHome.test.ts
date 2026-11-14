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
            presetContent: { content: presetInput.presetContentOverride.content, recipients: [] },
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


it('foreground sandbox completion seeds its admitted roles without an Agent start', async () => {
    const { completeUiManagedAccountGuest } = await import('./managedMachineAccountGuest');
    const requests: unknown[] = [];
    const enrolled = { ...machine, enrollmentIdentity, enrolledMachineId: 'joined' };
    await completeUiManagedAccountGuest({ account: accountResponding({ machine: enrolled, requestId: 'creation' }) as LazyActionAccountContext,
        input: presetInput, machine: enrolled, requestId: 'creation', context: { surface: 'ui', hostReviewedChild: {
            invoke: async request => {
                requests.push(request);
                return { ok: true, result: { status: 'applied', policy: { active: ['sessions'] }, metadataVersion: 1 } };
            },
        } } });
    expect(requests).toMatchObject([{ action: 'machines.roles.set', input: { machineId: 'joined', policy: { active: ['sessions'] } },
        invocationServices: { managedContinuation: { managedId: 'managed', creationRequestId: 'creation', expectedIntentRevision: 0 } } }]);
});

it('adopted completion without an Agent preserves roles without a guest effect', async () => {
    const { completeUiManagedAccountGuest } = await import('./managedMachineAccountGuest');
    const enrolled = { ...machine, enrollmentIdentity: { kind: 'existingUser' as const, role: 'adopted' as const }, enrolledMachineId: 'joined' };
    await expect(completeUiManagedAccountGuest({
        account: accountResponding({ machine: enrolled, requestId: 'creation' }) as LazyActionAccountContext,
        input: {}, machine: enrolled, requestId: 'creation', context: { surface: 'ui' },
    })).resolves.toEqual(enrolled);
});

it('keeps a delegated Account creation successful when Home refuses its optional roles seed', async () => {
    const { completeUiManagedAccountGuest } = await import('./managedMachineAccountGuest');
    const enrolled = { ...machine, enrollmentIdentity, enrolledMachineId: 'joined',
        custodianAccountId: 'company', enrollmentAccountId: 'member' };
    const progress: unknown[] = [];
    await expect(completeUiManagedAccountGuest({
        account: accountResponding({ machine: enrolled, requestId: 'creation' }) as LazyActionAccountContext,
        input: {}, machine: enrolled, requestId: 'creation', context: { surface: 'ui', runtimeAccountId: 'member',
            operationProgress: { update: value => { progress.push(value); } }, hostReviewedChild: {
                invoke: async () => ({ ok: false, errorCode: 'permission_denied', error: 'PRIVATE_REMOTE_MESSAGE' }),
            } },
    })).resolves.toEqual(enrolled);
    expect(progress).toEqual([expect.objectContaining({ phase: 'machines.roles.set', label: expect.stringContaining('permission_denied') })]);
    expect(JSON.stringify(progress)).not.toContain('PRIVATE_REMOTE_MESSAGE');
});
