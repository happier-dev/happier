import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@happier-dev/protocol';
import { ManagedMachineV1Schema, type ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { AcquireResultV1, MachineProvisionerNativeCauseV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { bindManagedMachineRoleCredentials, captureManagedPendingNativeIdentity, captureManagedSubmittedNativeIdentity, readManagedIssuedNativeFact,
    reconcileManagedMachine, type ManagedMachineReconciliation } from './reconcile.js';
import { executeManagedMachineAcquire } from './acquire.js';
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

describe('portable issued native identity', () => {
    const correlation = (row: ManagedMachineV1) => ({ homeId: row.homeId, managedId: row.id,
        expectedIntentRevision: row.intentRevision, requestId: 'request', ...(row.controller ? { controller: row.controller } : {}) });
    it.each([true, false])('reports only the exact submitted identity (controller present: %s)', withController => {
        const row = ManagedMachineV1Schema.parse({ ...machine, ...(withController ? {} : { controller: undefined }), allocation: 'may-exist' });
        const captured = captureManagedSubmittedNativeIdentity({ kind: 'acquire', machine: row, provisioner });
        const report = (candidate: ManagedMachineV1, value: NonNullable<ManagedMachineV1['resource']>['value'] = resource.value) => readManagedIssuedNativeFact({
            machine: candidate, fact: { kind: 'bound', resource: { ...resource, value } },
            action: 'machines.managed.acquire', kind: 'acquire', captured, correlation });
        expect(report(row).result).toEqual({ kind: 'bound', resource });
        expect(() => report({ ...row, id: 'another-row' })).toThrowError(expect.objectContaining({ code: 'resource_mismatch' }));
        expect(() => report({ ...row, launch: { ...row.launch, name: 'another-guest' } })).toThrowError(expect.objectContaining({ code: 'resource_mismatch' }));
        expect(() => report(row, { different: 'not-an-identity' })).toThrowError(expect.objectContaining({ code: 'resource_mismatch' }));
    });
    it('retains the paid pending handle without authorizing another handle or pending report', () => {
        const recovering = MachineProvisionerContributionV1Schema.parse({ ...provisioner, reconciliation: {
            action: 'reconcile', nativeOperationSchema: provisioner.resourceSchema,
        } });
        const row = ManagedMachineV1Schema.parse({ ...machine, allocation: 'may-exist', nativeOperationRef: resource });
        const captured = captureManagedPendingNativeIdentity({ machine: row, current: row, provisioner: recovering });
        const report = (candidate: ManagedMachineV1, fact: Parameters<typeof readManagedIssuedNativeFact>[0]['fact']) =>
            readManagedIssuedNativeFact({ machine: candidate, fact, action: 'machines.managed.bootstrap.retry',
                kind: 'pending-acquire', captured, correlation });
        expect(report(row, { kind: 'bound', resource }).result).toEqual({ kind: 'bound', resource });
        const changed = { ...row, nativeOperationRef: { ...resource, value: { id: 'another-paid-handle' } } };
        expect(() => report(changed, { kind: 'bound', resource })).toThrowError(expect.objectContaining({ code: 'resource_mismatch' }));
        expect(() => report(row, { kind: 'pending', nativeOperationRef: resource })).toThrowError(expect.objectContaining({ code: 'resource_mismatch' }));
    });
});

it('binds role authority only to one selected Account in its declared service scope', () => {
    const purpose = { consumer: { pluginId: 'acme.compute', localId: 'acquire' }, purpose: 'cloud' };
    const service = { pluginId: 'acme.accounts', localId: 'cloud' };
    const credential = { purpose: { ...purpose, consumer: machine.launch.provider },
        account: { service, accountId: 'selected-account' }, configurationRevision: null };
    const bind = (credentials: ManagedMachineV1['launch']['credentials']) => bindManagedMachineRoleCredentials({
        authorizations: [{ purpose, serviceRefs: [service] }], providerPluginId: 'acme.compute', credentials,
    });
    expect(bind([credential])).toEqual([{ purpose, serviceRefs: [service], credential }]);
    for (const credentials of [[], [credential, credential], [{ ...credential,
        account: { ...credential.account, service: { ...service, localId: 'undeclared-service' } } }], [{ ...credential,
        purpose: { ...credential.purpose, consumer: { ...machine.launch.provider, pluginId: 'another-provider' } } }]]) {
        expect(() => bind(credentials)).toThrowError(expect.objectContaining({ code: 'credential_unavailable' }));
    }
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
        'approval_required', 'auth_request_expired', 'auth_enrollment_timeout', 'daemon_service_not_ready', 'github_rate_limited'])(
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

    it('records a failed native reconciliation read without losing its typed cause or claiming absence', async () => {
        const initial = ManagedMachineV1Schema.parse({ ...machine, allocation: 'may-exist' });
        const run = boundary(initial);
        const reports: unknown[] = [];
        await reconcileManagedMachine({ ...run.input, action: 'machines.managed.inspect',
            provisioner: { ...provisioner, reconciliation: { action: 'reconcile', nativeOperationSchema: provisioner.resourceSchema } },
            home: { ...run.input.home, row: async (_path, body) => { reports.push(body); return initial; } },
            createNative: () => ({ prepareRoles: async () => {}, invoke: async () => {
                throw new ManagedMachineNativeRefusal('provider_unavailable', undefined,
                    { kind: 'managedNative', nativeCause: { httpStatusClass: '5xx' } });
            } }),
        });
        expect(reports).toEqual([expect.objectContaining({ result: { kind: 'unknown',
            recovery: { reference: initial.id, reason: 'provider_unavailable' }, nativeCause: { httpStatusClass: '5xx' } },
            observation: { observedAt: expect.any(Number), availability: 'unavailable', reason: 'provider_unavailable',
                nativeCause: { httpStatusClass: '5xx' } } })]);
    });

    it.each(['absent', 'present', 'unavailable'] as const)('settles a recovered identity from its exact %s inspection in one Home report', async availability => {
        const initial = ManagedMachineV1Schema.parse({ ...machine, allocation: 'may-exist' });
        const run = boundary(initial);
        const reports: unknown[] = [];
        const result = await reconcileManagedMachine({ ...run.input, action: 'machines.managed.inspect',
            provisioner: { ...provisioner, reconciliation: { action: 'reconcile', nativeOperationSchema: provisioner.resourceSchema } },
            home: { ...run.input.home, row: async (_path, body) => {
                reports.push(body);
                const report = body as { result: { kind: string }; observation?: ManagedMachineV1['observation'] };
                return ManagedMachineV1Schema.parse({ ...initial,
                    ...(report.result.kind === 'bound' ? { allocation: 'bound', resource } : { allocation: 'confirmed-absent' }),
                    observation: report.observation });
            } },
            createNative: () => ({ prepareRoles: async () => {}, invoke: async (role): Promise<JsonValue> => role === 'reconcile'
                ? { kind: 'bound', resource } : { observedAt: 20, availability,
                    ...(availability === 'unavailable' ? { reason: 'provider_unavailable' } : {}) } }),
        });
        expect(result.allocation).toBe(availability === 'absent' ? 'confirmed-absent' : 'bound');
        expect(result.observation).toMatchObject({ availability,
            ...(availability === 'absent' ? { reason: 'managed_not_found' } : {}) });
        expect(reports).toHaveLength(1); // One exact read decides the recovered fact before persistence.
    });

    it.each<AcquireResultV1>([
        { kind: 'rejected' as const, code: 'managed_not_found' as const },
        { kind: 'rejected' as const, code: 'provider_unavailable' as const },
        { kind: 'unknown' as const, recovery: { reference: 'native-instance', reason: 'native_command_failed' },
            nativeCause: { httpStatusClass: '5xx' as const } },
        { kind: 'pending' as const, nativeOperationRef: resource },
    ])('records the latest $kind acquisition check, including an unchanged unknown outcome', async result => {
        const initial = ManagedMachineV1Schema.parse({ ...machine, allocation: 'may-exist' });
        const run = boundary(initial);
        let saved = initial;
        const missing = result.kind === 'rejected' && result.code === 'managed_not_found';
        await reconcileManagedMachine({ ...run.input, action: 'machines.managed.inspect',
            provisioner: { ...provisioner, reconciliation: { action: 'reconcile', nativeOperationSchema: provisioner.resourceSchema } },
            home: { ...run.input.home, row: async (_path, body) => {
                const report = body as { result: typeof result; observation?: ManagedMachineV1['observation'] };
                saved = ManagedMachineV1Schema.parse({ ...saved,
                    allocation: report.result.kind === 'rejected' ? 'confirmed-absent' : 'may-exist', observation: report.observation });
                return saved;
            } },
            createNative: () => ({ prepareRoles: async () => {}, invoke: async () => result }),
        });
        expect(saved.allocation).toBe(missing ? 'confirmed-absent' : 'may-exist');
        expect(saved.observation).toMatchObject({ availability: missing ? 'absent' : 'unavailable', observedAt: expect.any(Number),
            reason: result.kind === 'rejected' ? result.code : result.kind === 'unknown' ? result.recovery.reason : 'native_acquisition_pending' });
        if ('nativeCause' in result) expect(saved.observation?.nativeCause).toEqual(result.nativeCause);
    });

    it.each<MachineProvisionerNativeCauseV1>([
        { httpStatusClass: '5xx' as const }, { grpcStatusCode: 14 as const },
        { localCause: 'native_command_failed' as const, command: 'run' as const, exitCode: 1 },
    ])('preserves any admitted leaf native cause through unknown acquisition', async nativeCause => {
        const run = boundary();
        const result = { kind: 'unknown' as const, recovery: { reference: 'native-instance', reason: 'native_acquisition_unconfirmed' }, nativeCause };
        await expect(reconcileManagedMachine({ ...run.input, createNative: () => ({
            prepareRoles: async () => {}, invoke: async () => result,
        }) })).rejects.toMatchObject({ code: 'native_acquisition_unconfirmed', details: { kind: 'managedNative', nativeCause } });
        expect(run.events).not.toContain('enroll');
    });
    it('refuses browser-ineligible compute before Home admission and admits native work once', async () => {
        const run = boundary();
        let admissions = 0;
        const acquire = { provisioner,
            admit: async () => { admissions++; return machine; },
            onAccepted: () => { run.events.push('accepted'); },
            run: (row: ManagedMachineV1) => reconcileManagedMachine({ ...run.input, machine: row }),
        };
        await expect(executeManagedMachineAcquire({ ...acquire, host: 'browser' })).rejects.toMatchObject({ code: 'provider_unavailable' });
        expect(admissions).toBe(0);
        expect(run.roles).toEqual([]);
        const result = await executeManagedMachineAcquire({ ...acquire, host: 'native' });
        expect(admissions).toBe(1);
        expect(result.result.enrolledMachineId).toBe('guest');
        expect(run.events[0]).toBe('accepted');
        expect(run.roles.filter(role => role === 'acquire')).toHaveLength(1);
    });
    it('retries installation on the bound resource without another allocation', async () => {
        const run = boundary({ ...machine, allocation: 'bound', resource });
        const result = await reconcileManagedMachine({ ...run.input, action: 'machines.managed.bootstrap.retry' });
        expect(result.resource).toEqual(resource);
        expect(result.enrolledMachineId).toBe('guest');
        expect(run.roles).toEqual(['bootstrap']);
        expect(run.events).not.toContain('submit');
    });
});
