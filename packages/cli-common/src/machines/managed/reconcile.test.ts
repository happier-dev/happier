import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@happier-dev/protocol';
import { ManagedMachineV1Schema, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { bindManagedMachineRoleCredentials, captureManagedPendingNativeIdentity, captureManagedSubmittedNativeIdentity, readManagedIssuedNativeFact,
    reconcileManagedMachine, type ManagedMachineReconciliation } from './reconcile.js';
import { SystemTaskExecutionError } from '../../systemTasks/runSystemTask.js';
import { ManagedControllerReportV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineControllerError, ManagedMachineNativeRefusal } from './controllerErrors.js';

const machine = ManagedMachineV1Schema.parse({
    id: 'managed', homeId: 'home', custodianAccountId: 'owner',
    controller: { machineId: 'controller', installationId: 'installation' },
    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
    allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
});
const resource = { contributionRef: machine.launch.provider, schemaVersion: 1, value: { id: 'paid-resource' } };
const provisioner = MachineProvisionerContributionV1Schema.parse({
    id: 'vm', title: 'Compute', icon: 'cloud', resourceKind: 'compute',
    launchSchema: { type: 'object', properties: {}, additionalProperties: false },
    resourceSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    platforms: ['linux'], prerequisites: [], billing: { location: 'cloud', stoppedBilling: 'billed' },
    retention: { supportedIntents: ['start', 'delete'] },
    schemaVersion: 1, actions: { acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy', check: 'check', power: 'power' },
    bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
});

/** Home transport and vendor invocation are the actual external boundaries of this owner. */
function boundary(initial: ManagedMachineV1 = machine) {
    let retained = initial;
    const events: string[] = [];
    const roles: string[] = [];
    const input: ManagedMachineReconciliation = {
        machine: initial, requestId: 'request', action: 'machines.managed.acquire', provisioner,
        home: {
            correlation: row => ({ homeId: row.homeId, managedId: row.id, expectedIntentRevision: row.intentRevision,
                controller: row.controller, requestId: 'request' }),
            row: async (path, body) => {
                events.push(path);
                if (path === 'report') {
                    const report = ManagedControllerReportV1Schema.parse(body);
                    retained = ManagedMachineV1Schema.parse({ ...retained,
                        ...(report.observation ? { observation: report.observation } : {}),
                        ...(report.bootstrapInstalled ? { bootstrapInstalled: true } : {}) });
                }
                return retained;
            },
            submit: async row => { events.push('submit'); retained = { ...row, allocation: 'may-exist' }; return { submitted: true, machine: retained }; },
            reportIssuedAcquireFact: async (row, result) => {
                if (result.kind !== 'bound') throw new Error('Unexpected pending result');
                events.push('report-bound'); retained = { ...row, allocation: 'bound', resource: result.resource }; return retained;
            },
            preparePendingAcquireBoundReport: async () => async result => {
                retained = { ...retained, allocation: 'bound', resource: result.resource }; return retained;
            },
        },
        createNative: () => ({ prepareRoles: async () => { events.push('prepare-roles'); }, invoke: async (role): Promise<JsonValue | null> => {
            roles.push(role);
            if (role === 'acquire') { expect(retained.allocation).toBe('may-exist'); return { kind: 'bound', resource }; }
            if (role === 'bootstrap') { expect(retained.resource).toEqual(resource); return { kind: 'native', transport: {
                contributionRef: resource.contributionRef, schemaVersion: resource.schemaVersion,
            } }; }
            if (role === 'inspect') return { observedAt: 1, availability: 'present', power: 'running' };
            throw new Error(`Unexpected role ${role}`);
        } }),
        bootstrap: {
            preflight: async () => { events.push('preflight'); },
            prepareCredential: async row => ({ machine: row, credentialRevision: 1 }),
            readCredential: async () => ({ revision: 1 }),
            enroll: async ({ machine: row }) => { events.push('enroll'); retained = { ...row, enrolledMachineId: 'guest' }; return retained; },
        },
        waitForObservation: async () => {},
    };
    return { input, events, roles, read: () => retained };
}

describe('portable managed reconciliation', () => {
    // Guest execution and Home transport are external to this portable owner.
    it.each(['remote_command_failed', 'native_boot_unconfirmed', 'background_service_failed',
        'approval_required', 'auth_request_expired', 'auth_enrollment_timeout', 'daemon_service_not_ready'])(
        'persists the guest %s exit before propagating it', async code => {
            const run = boundary({ ...machine, allocation: 'bound', resource });
            const failure = new SystemTaskExecutionError(code, 'private guest output must not reach the row');
            await expect(reconcileManagedMachine({ ...run.input, bootstrap: { ...run.input.bootstrap,
                enroll: async ({ onInstalled }) => {
                    if (code !== 'remote_command_failed') await onInstalled();
                    throw failure;
                },
            } })).rejects.toBe(failure);
            expect(run.read()).toMatchObject({ allocation: 'bound', resource,
                observation: { availability: 'unavailable', reason: `bootstrap.${code}` } });
            expect(run.read().enrolledMachineId).toBeUndefined();
            expect(run.read().bootstrapInstalled).toBe(code === 'remote_command_failed' ? undefined : true);
            expect(JSON.stringify(run.read())).not.toContain(failure.message);
        });

    it('saves an incomplete bootstrap before guest IO, so a lost host operation retains evidence', async () => {
        const run = boundary({ ...machine, allocation: 'bound', resource });
        await reconcileManagedMachine({ ...run.input, bootstrap: { ...run.input.bootstrap,
            enroll: async input => {
                expect(run.read().observation).toMatchObject({ availability: 'unavailable', reason: 'bootstrap.incomplete' });
                return await run.input.bootstrap.enroll(input);
            },
        } });
        expect(run.read().enrolledMachineId).toBe('guest');
        expect(run.read().observation).not.toHaveProperty('reason');
    });

    it.each<import('@happier-dev/protocol/machines/managed/providerFactsV1').ProviderObservationV1>([
        { observedAt: 2, availability: 'present', power: 'running' },
        { observedAt: 2, availability: 'present', power: 'stopped' },
        { observedAt: 2, availability: 'unavailable' },
    ])('retains the closed bootstrap cause after a host restart and $availability/$power observation without replay', async observation => {
        const run = boundary({ ...machine, allocation: 'bound', resource });
        const nativeCause = { httpStatusClass: '5xx' as const, code: 'unavailable' as const };
        const failure = new ManagedMachineControllerError('native_request_failed', undefined, { kind: 'managedNative', nativeCause });
        await expect(reconcileManagedMachine({ ...run.input, bootstrap: { ...run.input.bootstrap,
            enroll: async () => { throw failure; },
        } })).rejects.toBe(failure);
        const afterRestart = boundary(ManagedMachineV1Schema.parse(JSON.parse(JSON.stringify(run.read()))));
        const roles: string[] = [];
        const observed = await reconcileManagedMachine({ ...afterRestart.input, action: 'machines.managed.inspect',
            createNative: () => ({ prepareRoles: async () => {}, invoke: async (role): Promise<JsonValue | null> => { roles.push(role); return observation; } }),
        });
        expect(observed.observation).toMatchObject({ ...observation, reason: 'bootstrap.native_request_failed', nativeCause });
        expect(roles).toEqual(['inspect']);
    });

    it('diagnoses a retained running guest with no bootstrap evidence through Check now', async () => {
        const run = boundary({ ...machine, allocation: 'bound', resource });
        const observed = await reconcileManagedMachine({ ...run.input, action: 'machines.managed.inspect' });
        expect(observed.observation).toMatchObject({ availability: 'present', power: 'running', reason: 'bootstrap.incomplete' });
        expect(run.roles).toEqual(['inspect']);
    });

    it('keeps the exact native absence observed during bootstrap readiness', async () => {
        const run = boundary();
        await expect(reconcileManagedMachine({ ...run.input,
            createNative: (readMachine, readRevision) => {
                const native = run.input.createNative(readMachine, readRevision);
                return { ...native, invoke: async (role, body, io) => {
                    if (role === 'acquire') return { kind: 'bound', resource, startPending: true };
                    if (role === 'inspect') return { observedAt: 2, availability: 'absent', reason: 'managed_not_found' };
                    return await native.invoke(role, body, io);
                } };
            },
        })).rejects.toMatchObject({ code: 'native_resource_unavailable' });
        expect(run.read().observation).toEqual({ observedAt: 2, availability: 'absent', reason: 'managed_not_found' });
    });

    it('does not hide native absence or carry an obsolete bootstrap diagnostic after enrollment', async () => {
        const failed = { ...machine, allocation: 'bound' as const, resource,
            observation: { observedAt: 1, availability: 'unavailable' as const, reason: 'bootstrap.auth_request_expired' } };
        const run = boundary(failed);
        const absent = await reconcileManagedMachine({ ...run.input, action: 'machines.managed.inspect',
            createNative: () => ({ prepareRoles: async () => {}, invoke: async () => ({ observedAt: 2, availability: 'absent' }) }),
        });
        expect(absent.observation).toEqual({ observedAt: 2, availability: 'absent' });
        const enrolled = boundary({ ...failed, enrolledMachineId: 'guest' });
        expect((await reconcileManagedMachine({ ...enrolled.input, action: 'machines.managed.inspect' })).observation)
            .toEqual({ observedAt: 1, availability: 'present', power: 'running' });
    });

});
