import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@happier-dev/protocol';
import { ManagedMachineFullV1Schema, type ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { AcquireResultV1, MachineProvisionerNativeCauseV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/public-types';
import { bindManagedMachineRoleCredentials, captureManagedPendingNativeIdentity, captureManagedSubmittedNativeIdentity, readManagedIssuedNativeFact,
    reconcileManagedMachine, type ManagedMachineReconciliation } from './reconcile.js';
import { executeManagedMachineAcquire } from './acquire.js';
import { executeManagedMachineDeleteIntent, prepareManagedMachineDeleteIntent } from './destroy.js';
import { SystemTaskExecutionError } from '../../systemTasks/runSystemTask.js';
import { ManagedConfigurationFactsV1Schema } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { ManagedControllerReportV1Schema, projectManagedEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineControllerError, ManagedMachineNativeRefusal } from './controllerErrors.js';

const machine = ManagedMachineFullV1Schema.parse({
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
    const correlation = (row: ManagedMachineFullV1) => ({ homeId: row.homeId, managedId: row.id,
        expectedIntentRevision: row.intentRevision, requestId: 'request', ...(row.controller ? { controller: row.controller } : {}) });
    it.each([true, false])('reports only the exact submitted identity (controller present: %s)', withController => {
        const row = ManagedMachineFullV1Schema.parse({ ...machine, ...(withController ? {} : { controller: undefined }), allocation: 'may-exist' });
        const captured = captureManagedSubmittedNativeIdentity({ kind: 'acquire', machine: row, provisioner });
        const report = (candidate: ManagedMachineFullV1, value: NonNullable<ManagedMachineFullV1['resource']>['value'] = resource.value) => readManagedIssuedNativeFact({
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
        const row = ManagedMachineFullV1Schema.parse({ ...machine, allocation: 'may-exist', nativeOperationRef: resource });
        const captured = captureManagedPendingNativeIdentity({ machine: row, current: row, provisioner: recovering });
        const report = (candidate: ManagedMachineFullV1, fact: Parameters<typeof readManagedIssuedNativeFact>[0]['fact']) =>
            readManagedIssuedNativeFact({ machine: candidate, fact, action: 'machines.managed.bootstrap.retry',
                kind: 'pending-acquire', captured, correlation });
        expect(report(row, { kind: 'bound', resource }).result).toEqual({ kind: 'bound', resource });
        const changed = { ...row, nativeOperationRef: { ...resource, value: { id: 'another-paid-handle' } } };
        expect(() => report(changed, { kind: 'bound', resource })).toThrowError(expect.objectContaining({ code: 'resource_mismatch' }));
        expect(() => report(row, { kind: 'pending', nativeOperationRef: resource })).toThrowError(expect.objectContaining({ code: 'resource_mismatch' }));
    });
});

describe('definite acquisition refusals', () => {
    it.each(['throws', 'returns'] as const)('keeps a native refusal the provider %s when Home cannot record it', async kind => {
        const run = boundary();
        const reportFailure = new ManagedMachineControllerError('controller_unavailable');
        const nativeFailure = new ManagedMachineNativeRefusal('credential_unavailable');
        const reportFailures: unknown[] = [];
        const reports: unknown[] = [];
        const reportOutcome = { ...run.input, onReportFailure: (error: unknown) => reportFailures.push(error) };
        await expect(reconcileManagedMachine({
            ...reportOutcome,
            home: { ...run.input.home, row: async (path, body) => {
                if (path !== 'report') return run.input.home.row(path, body);
                reports.push(body);
                throw reportFailure;
            } },
            createNative: () => ({ prepareRoles: async () => {}, invoke: async () => {
                if (kind === 'throws') throw nativeFailure;
                return { kind: 'rejected', code: nativeFailure.code };
            } }),
        })).rejects.toMatchObject({ code: nativeFailure.code });
        expect(reports).toEqual([expect.objectContaining({ result: { kind: 'rejected', code: nativeFailure.code } })]);
        expect(reportFailures).toEqual([reportFailure]);
        expect(run.events).not.toContain('enroll');
    });

    it.each(['provider_unavailable', 'native_trial_auto_stop_required'])('reports %s as no allocation, retaining the real refusal', async code => {
        const run = boundary();
        const reports: unknown[] = [];
        await expect(reconcileManagedMachine({ ...run.input,
            home: { ...run.input.home, row: async (path, body) => {
                if (path === 'report') reports.push(body);
                return run.input.home.row(path, body);
            } },
            createNative: () => ({ prepareRoles: async () => {}, invoke: async () => ({ kind: 'rejected', code }) }),
        })).rejects.toMatchObject({ code });
        expect(reports).toEqual([expect.objectContaining({ result: { kind: 'rejected', code } })]);
        expect(run.events).not.toContain('enroll');
    });

    it('settles a typed pre-effect refusal but keeps an ordinary handler failure uncertain', async () => {
        for (const definite of [true, false]) {
            const run = boundary();
            const reports: unknown[] = [];
            const error = definite ? new ManagedMachineNativeRefusal('credential_unavailable')
                : new ManagedMachineControllerError('credential_unavailable');
            await expect(reconcileManagedMachine({ ...run.input,
                home: { ...run.input.home, row: async (path, body) => {
                    if (path === 'report') reports.push(body);
                    return run.input.home.row(path, body);
                } },
                createNative: () => ({ prepareRoles: async () => {}, invoke: async () => { throw error; } }),
            })).rejects.toBe(error);
            expect(reports).toEqual([expect.objectContaining({ result: definite
                ? { kind: 'rejected', code: 'credential_unavailable' }
                : { kind: 'unknown', recovery: { reference: machine.id, reason: 'native_acquisition_unconfirmed' } } })]);
        }
    });
});

it('binds role authority only to one selected Account in its declared service scope', () => {
    const purpose = { consumer: { pluginId: 'acme.compute', localId: 'acquire' }, purpose: 'cloud' };
    const service = { pluginId: 'acme.accounts', localId: 'cloud' };
    const credential = { purpose: { ...purpose, consumer: machine.launch.provider },
        account: { service, accountId: 'selected-account' }, configurationRevision: null };
    const bind = (credentials: ManagedMachineFullV1['launch']['credentials']) => bindManagedMachineRoleCredentials({
        authorizations: [{ purpose, serviceRefs: [service] }], provider: machine.launch.provider, credentials,
    });
    expect(bind([credential])).toEqual([{ purpose, serviceRefs: [service], credential }]);
    for (const deliveryMode of ['brokered', 'direct'] as const) {
        const teamCredential = { purpose: credential.purpose, teamId: 'team-a', selection: {
            source: 'team_resource' as const, resourceId: 'shared-cloud', deliveryMode,
            ...(deliveryMode === 'direct' ? { disclosedMember: credential.account } : {}),
        } };
        const retained = ManagedMachineFullV1Schema.parse({ ...machine, launch: { ...machine.launch, credentials: [teamCredential] } });
        expect(bind(retained.launch.credentials)).toEqual([{ purpose, serviceRefs: [service], credential: teamCredential }]);
    }
    for (const credentials of [[], [credential, credential], [{ ...credential,
        account: { ...credential.account, service: { ...service, localId: 'undeclared-service' } } }], [{ ...credential,
        purpose: { ...credential.purpose, consumer: { ...machine.launch.provider, pluginId: 'another-provider' } } }], [{ ...credential,
        purpose: { ...credential.purpose, consumer: { ...machine.launch.provider, localId: 'another-provider' } } }]]) {
        expect(() => bind(credentials)).toThrowError(expect.objectContaining({ code: 'credential_unavailable' }));
    }
});

/** Home transport and vendor invocation are the actual external boundaries of this owner. */
function boundary(initial: ManagedMachineFullV1 = machine) {
    let retained = initial;
    const events: string[] = [];
    const roles: string[] = [];
    const input: ManagedMachineReconciliation = {
        machine: initial, requestId: 'request', action: 'machines.managed.acquire', provisioner,
        home: {
            projectEnrollmentCorrelation: projectManagedEnrollmentCorrelationV1,
            correlation: row => ({ homeId: row.homeId, managedId: row.id, expectedIntentRevision: row.intentRevision,
                controller: row.controller, requestId: 'request' }),
            row: async (path, body) => {
                events.push(path);
                if (path === 'report') {
                    const report = ManagedControllerReportV1Schema.parse(body);
                    retained = ManagedMachineFullV1Schema.parse({ ...retained,
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
    it('binds a local Session resource without guest enrollment or enrollment preflight', async () => {
        const run = boundary();
        let prepared = false;
        const result = await reconcileManagedMachine({ ...run.input, acquisitionMode: 'resource-bound', bootstrap: {
            ...run.input.bootstrap, prepareTransport: async input => {
                expect(input.carrier.kind).toBe('native');
                expect(input.machine.resource).toEqual(resource);
                prepared = true;
            },
        } });
        expect(result).toMatchObject({ allocation: 'bound', resource });
        expect(result.enrolledMachineId).toBeUndefined();
        expect(run.events).toEqual(['prepare-roles', 'submit', 'report-bound']);
        expect(run.roles).toEqual(['check', 'acquire', 'bootstrap']);
        expect(prepared).toBe(true);
    });

    it('retries a bound local resource without creating or enrolling another guest', async () => {
        const retained = ManagedMachineFullV1Schema.parse({ ...machine, allocation: 'bound', resource });
        const run = boundary(retained);
        const result = await reconcileManagedMachine({ ...run.input, action: 'machines.managed.bootstrap.retry',
            acquisitionMode: 'resource-bound' });
        expect(result.resource).toEqual(resource);
        expect(run.events).toEqual([]);
        expect(run.roles).toEqual(['bootstrap']);
    });

    it('refuses unsupported or unidentified opaque cleanup at the native owner without IO', async () => {
        const initial = ManagedMachineFullV1Schema.parse({ ...machine, allocation: 'may-exist',
            creationState: 'canceled', desired: 'delete', preset: { id: 'preset', revision: 0, contentEncryptionMode: 'plain' } });
        const run = boundary(initial);
        const invoke = run.input.createNative(() => initial, () => undefined).invoke;
        await expect(prepareManagedMachineDeleteIntent({ machine: initial, requestId: 'cleanup',
            provisioner, home: run.input.home, invoke })).rejects.toMatchObject({ code: 'provider_unavailable' });
        await expect(executeManagedMachineDeleteIntent({ machine: initial, invoke }))
            .rejects.toMatchObject({ code: 'native_resource_unavailable' });
        expect(run.roles).toEqual([]);
        expect(run.events).toEqual([]);
        expect(run.read()).toEqual(initial);
    });

    it.each(['present', 'unavailable'] as const)('observes retained power custody through its original correlation when native availability is %s', async availability => {
        const outstanding = { intent: 'stop' as const, requestId: 'original-power', intentRevision: 2,
            controller: machine.controller };
        const retained = ManagedMachineFullV1Schema.parse({ ...machine, allocation: 'bound', resource, intentRevision: 4,
            submittedNativeEffect: outstanding });
        const run = boundary(retained);
        const reports: Array<{ path: string; body: unknown }> = [];
        const roles: string[] = [];
        const observation = { observedAt: 20, availability, ...(availability === 'present' ? { power: 'stopped' as const } : {}) };
        await reconcileManagedMachine({ ...run.input, action: 'machines.managed.inspect',
            home: { ...run.input.home, row: async (path, body) => { reports.push({ path, body }); return retained; } },
            createNative: () => ({ prepareRoles: async () => {}, invoke: async role => { roles.push(role); return observation; } }),
        });
        expect(reports).toEqual([{ path: 'report-intent', body: { homeId: retained.homeId, managedId: retained.id,
            expectedIntentRevision: outstanding.intentRevision, requestId: outstanding.requestId, controller: outstanding.controller,
            result: { kind: 'unknown' }, observation } }]);
        expect(roles).toEqual(['inspect']);
    });

    it.each(['cold-source', 'prepared-image'] as const)('uses the stored author source authority for %s acquisition', async mode => {
        const authorDigest = 'a'.repeat(64);
        const instanceDigest = 'b'.repeat(64);
        const reviewedFacts = ManagedConfigurationFactsV1Schema.parse({
            launch: machine.launch, controller: machine.controller, optionStatus: 'current',
            billing: provisioner.billing, retentionCapabilities: provisioner.retention, prerequisites: [],
            retention: machine.retention, wakeOnAcceptedMessage: machine.wakeOnAcceptedMessage,
            reviewedEffectDigest: instanceDigest,
        });
        const run = boundary({ ...machine, reviewedFacts });
        const acquired: unknown[] = [];
        await reconcileManagedMachine({ ...run.input,
            createNative: (...args) => {
                const native = run.input.createNative(...args);
                return { ...native,
                    readReviewedEffectDigest: () => mode === 'cold-source' ? authorDigest : undefined,
                    invoke: async (role, body, io) => {
                        if (role !== 'acquire') return native.invoke(role, body, io);
                        acquired.push(body);
                        return { kind: 'bound', resource };
                    },
                };
            },
        });
        expect(acquired).toEqual([{ managedId: machine.id, launch: machine.launch.choices,
            ...(mode === 'cold-source' ? { reviewedEffectDigest: authorDigest } : {}) }]);
    });

    it.each(['initial', 'continued', 'unreviewed'] as const)(
        'passes only the admitted effect digest to native acquisition (%s)', async mode => {
            const digest = 'a'.repeat(64);
            const reviewedFacts = ManagedConfigurationFactsV1Schema.parse({
                launch: machine.launch, controller: machine.controller, optionStatus: 'current',
                billing: provisioner.billing, retentionCapabilities: provisioner.retention, prerequisites: [],
                retention: machine.retention, wakeOnAcceptedMessage: machine.wakeOnAcceptedMessage,
                reviewedEffectDigest: digest,
            });
            const run = boundary({ ...machine, ...(mode === 'unreviewed' ? {} : { reviewedFacts }),
                ...(mode === 'continued' ? { allocation: 'bound', resource } : {}) });
            const acquired: unknown[] = [];
            const result = await reconcileManagedMachine({ ...run.input,
                ...(mode === 'continued' ? { provisioner: { ...provisioner, reconciliation: {
                    action: 'reconcile', nativeOperationSchema: provisioner.resourceSchema, continueAcquire: true,
                } } } : {}),
                createNative: (...args) => {
                    const native = run.input.createNative(...args);
                    return { ...native, invoke: async (role, body, io) => {
                        if (role !== 'acquire') return native.invoke(role, body, io);
                        acquired.push(body);
                        return { kind: 'bound', resource };
                    } };
                },
            });
            expect(result.enrolledMachineId).toBe('guest');
            expect(acquired).toEqual([{ managedId: machine.id, launch: machine.launch.choices,
                ...(mode === 'continued' ? { resource: resource.value } : {}),
                ...(mode === 'unreviewed' ? {} : { reviewedEffectDigest: digest }),
            }]);
        });

    it.each(['machines.managed.acquire', 'machines.managed.bootstrap.retry'] as const)(
        'publishes native power and storage in the first enrolled observation through %s', async action => {
            const run = boundary(action === 'machines.managed.acquire' ? machine : { ...machine, allocation: 'bound', resource });
            const native = run.input.createNative(run.read, () => undefined);
            const observation = { observedAt: 42, availability: 'present', power: 'running', storage: 'retained' } as const;
            const result = await reconcileManagedMachine({ ...run.input, action,
                createNative: () => ({ ...native, invoke: async (role, body, io) => role === 'inspect'
                    ? observation : native.invoke(role, body, io) }),
            });
            expect(result).toMatchObject({ enrolledMachineId: 'guest', observation });
        });

    it('keeps successful enrollment when its final native observation is unavailable', async () => {
        const run = boundary();
        const native = run.input.createNative(run.read, () => undefined);
        const result = await reconcileManagedMachine({ ...run.input,
            createNative: () => ({ ...native, invoke: async (role, body, io) => {
                if (role === 'inspect') throw new ManagedMachineControllerError('native_request_failed');
                return native.invoke(role, body, io);
            } }),
        });
        expect(result).toMatchObject({ enrolledMachineId: 'guest', observation: {
            availability: 'unavailable', reason: 'native_request_failed',
        } });
        expect(result.observation?.power).toBeUndefined();
    });

    it('observes each enrolled resource once across the 200-allocation R101 inventory and does no work on replay', async () => {
        let inspections = 0;
        for (let index = 0; index < 200; index += 1) {
            const run = boundary({ ...machine, id: `managed-${index}` });
            const native = run.input.createNative(run.read, () => undefined);
            const createNative: typeof run.input.createNative = () => ({ ...native, invoke: async (role, body, io) => {
                if (role === 'inspect') inspections += 1;
                return native.invoke(role, body, io);
            } });
            const enrolled = await reconcileManagedMachine({ ...run.input, createNative });
            expect(enrolled.observation?.power).toBe('running');
            await reconcileManagedMachine({ ...run.input, machine: enrolled, createNative });
        }
        expect(inspections).toBe(200);
    });

    it.each(['machines.managed.acquire', 'machines.managed.inspect'] as const)(
        'recovers the same enrolled resource after both final reports return 503 through %s', async action => {
            const run = boundary();
            let rejectFinalReports = true;
            let completed = 0;
            const unavailable = new ManagedMachineControllerError('database_transaction_timeout', undefined, {
                kind: 'managedControllerRequest', path: '/v1/machines/managed/controller/report', category: 'status', status: 503,
            });
            // Home HTTP and guest completion are host transport boundaries; reconciliation stays real.
            const bootstrap = { ...run.input.bootstrap, complete: async (row: ManagedMachineFullV1) => {
                expect(row.enrolledMachineId).toBe('guest');
                completed += 1;
            } };
            const home = { ...run.input.home, row: async (...args: Parameters<typeof run.input.home.row>) => {
                const [path, body] = args;
                if (path === 'report' && run.read().enrolledMachineId
                    && ManagedControllerReportV1Schema.parse(body).observation && rejectFinalReports) throw unavailable;
                return await run.input.home.row(...args);
            } };
            await expect(reconcileManagedMachine({ ...run.input, bootstrap, home })).rejects.toBe(unavailable);
            expect.soft(completed).toBe(1);
            expect(run.read()).toMatchObject({ enrolledMachineId: 'guest', resource,
                observation: { availability: 'unavailable', reason: 'bootstrap.incomplete' } });
            rejectFinalReports = false;
            const result = await reconcileManagedMachine({ ...run.input, machine: run.read(), action, bootstrap, home,
                provisioner: MachineProvisionerContributionV1Schema.parse({ ...provisioner, bootstrapTransport: undefined }) });
            expect.soft(completed).toBe(2);
            expect(result.resource).toEqual(resource);
            expect(result.observation?.availability).toBe('present');
            expect(result.observation?.reason).toBeUndefined();
            expect(run.events.filter(event => event === 'enroll')).toHaveLength(1);
            expect(run.roles.filter(role => role === 'acquire')).toHaveLength(1);
        });

    it.each(['empty', 'command_failed'] as const)('finishes acquisition when pinned SSH trust initially reports %s', async resultClass => {
        const run = boundary();
        let attempts = 0;
        let waits = 0;
        const nativeCause = { localCause: 'ssh_keyscan_failed', resultClass } as const;
        const result = await reconcileManagedMachine({ ...run.input,
            createNative: (...args) => ({ ...run.input.createNative(...args), bootstrapCredentialKind: 'ssh' }),
            bootstrap: { ...run.input.bootstrap, enroll: async enrollment => {
                if (++attempts === 1) throw new ManagedMachineControllerError('native_ssh_host_key_unavailable', undefined,
                    { kind: 'managedNative', nativeCause });
                return run.input.bootstrap.enroll(enrollment);
            } },
            waitForObservation: async () => { waits++; },
        });
        expect(result).toMatchObject({ allocation: 'bound', enrolledMachineId: 'guest', observation: { availability: 'present' } });
        expect(waits).toBe(1);
        expect(run.roles.filter(role => role === 'acquire')).toHaveLength(1);
    });

    it.each([false, true])('settles a failed provider during SSH readiness with a cause and no further wait (native cause: %s)', async providerCause => {
        const run = boundary();
        let waits = 0;
        const scanCause = { localCause: 'ssh_keyscan_failed', resultClass: 'empty' } as const;
        const nativeCause = providerCause ? { httpStatusClass: '5xx', code: 'service_error' } as const : scanCause;
        const work = reconcileManagedMachine({ ...run.input,
            createNative: (...args) => {
                const native = run.input.createNative(...args);
                return { ...native, bootstrapCredentialKind: 'ssh', invoke: async (role, body, io) => role === 'inspect'
                    ? { observedAt: 1, availability: 'unavailable', reason: 'provider_unavailable',
                        ...(providerCause ? { nativeCause } : {}) } : native.invoke(role, body, io) };
            },
            bootstrap: { ...run.input.bootstrap, enroll: async () => {
                throw new ManagedMachineControllerError('native_ssh_host_key_unavailable', undefined, { kind: 'managedNative', nativeCause: scanCause });
            } },
            waitForObservation: async () => { waits++; },
        });
        await expect(work).rejects.toMatchObject({ code: 'native_resource_unavailable', details: { kind: 'managedNative', nativeCause } });
        expect(run.read().observation).toMatchObject({ availability: 'unavailable', nativeCause });
        expect(waits).toBe(0);
    });

    it.each(['invalid', 'spawn_failed'] as const)('does not wait for non-recoverable keyscan %s', async resultClass => {
        const run = boundary();
        const nativeCause = { localCause: 'ssh_keyscan_failed', resultClass } as const;
        let waits = 0;
        await expect(reconcileManagedMachine({ ...run.input,
            createNative: (...args) => ({ ...run.input.createNative(...args), bootstrapCredentialKind: 'ssh' }),
            bootstrap: { ...run.input.bootstrap, enroll: async () => {
                throw new ManagedMachineControllerError('native_ssh_host_key_unavailable', undefined, { kind: 'managedNative', nativeCause });
            } }, waitForObservation: async () => { waits++; },
        })).rejects.toMatchObject({ code: 'native_ssh_host_key_unavailable', details: { kind: 'managedNative', nativeCause } });
        expect(run.read().observation).toMatchObject({ reason: 'bootstrap.native_ssh_host_key_unavailable', nativeCause });
        expect(waits).toBe(0);
    });

    it.each(['authored', 'reviewed', 'options-unavailable', 'empty-options-schema'] as const)('records configuration facts once at issued acquisition (%s)', async mode => {
        const hostPrerequisite = { requirement: { kind: 'systemTool', id: 'docker' }, status: 'available' } as const;
        const configurationPrerequisite = { requirement: { kind: 'systemTool', id: 'devcontainer' }, status: 'available' } as const;
        const launch = { ...machine.launch, choices: { cpu: 4, image: 'ubuntu' } };
        const launchSchema = { type: 'object', properties: { cpu: { type: 'integer' }, image: { type: 'string' } },
            required: ['cpu', 'image'], additionalProperties: false } satisfies PluginJsonSchemaV2;
        const descriptor = MachineProvisionerContributionV1Schema.parse({ ...provisioner, launchSchema,
            actions: { ...provisioner.actions, options: 'options' } });
        const reviewedFacts = { launch, controller: machine.controller, provisioner: descriptor, optionStatus: 'current' as const,
            billing: descriptor.billing, retentionCapabilities: descriptor.retention, prerequisites: [],
            retention: machine.retention, wakeOnAcceptedMessage: machine.wakeOnAcceptedMessage,
            nativeFacts: { image: { id: 'reviewed', title: 'Reviewed image' } } };
        const run = boundary({ ...machine, launch, ...(mode === 'reviewed' ? { reviewedFacts } : {}) });
        let facts: unknown;
        const result = await reconcileManagedMachine({ ...run.input, provisioner: descriptor,
            home: { ...run.input.home, reportIssuedAcquireFact: async (row, result, configurationFacts?: unknown) => {
                facts = configurationFacts;
                return { ...await run.input.home.reportIssuedAcquireFact(row, result),
                    ...(configurationFacts ? { reviewedFacts: ManagedConfigurationFactsV1Schema.parse(configurationFacts) } : {}) };
            } },
            createNative: (...args) => {
                const native = run.input.createNative(...args);
                return { ...native, optionsInputSchema: mode === 'empty-options-schema' ? { type: 'object' as const, properties: {}, additionalProperties: false } : launchSchema, invoke: async (role, body, io): Promise<JsonValue> => {
                    if (role === 'check' || role === 'options') {
                        run.roles.push(role);
                        if (role === 'check') return { available: true, prerequisites: [hostPrerequisite] };
                        if (mode === 'options-unavailable') throw new Error('private provider error');
                        expect(body).toEqual(mode === 'empty-options-schema' ? {} : launch.choices);
                        return { base: { launch: launch.choices, prerequisites: [configurationPrerequisite], nativeFacts: { image: { id: 'ubuntu', title: 'Ubuntu Linux' } } },
                            dimensions: { size: [{ id: 'four', title: 'Four cores', assignments: [],
                                nativeFacts: { size: { id: 'four', title: 'Four cores', cpuCores: 4 } } }], image: [], location: [], network: [], duration: [] } };
                    }
                    return native.invoke(role, body, io);
                } };
            },
        });
        expect(result.allocation).toBe('bound');
        if (mode === 'reviewed') {
            expect(facts).toBeUndefined();
            expect(run.roles).not.toContain('options');
        } else {
            expect(facts).toMatchObject({ launch, provisioner: descriptor, optionStatus: mode === 'options-unavailable' ? 'unavailable' : 'current' });
            expect(facts).toMatchObject({ prerequisites: mode === 'options-unavailable' ? [hostPrerequisite] : [configurationPrerequisite] });
            if (mode !== 'options-unavailable') expect(facts).toMatchObject({ nativeFacts: { size: { cpuCores: 4 }, image: { title: 'Ubuntu Linux' } } });
            expect(run.roles.filter(role => role === 'options')).toHaveLength(1);
            expect(JSON.stringify(facts)).not.toContain('private provider error');
        }
    });

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

    it.each([false, true])('acknowledges a foreground bootstrap failure only after Home retains it (report fails: %s)', async reportFails => {
        const run = boundary({ ...machine, allocation: 'bound', resource });
        const failure = new SystemTaskExecutionError('remote_command_failed', 'private guest output');
        const reportFailure = new ManagedMachineControllerError('action_forbidden', 401, undefined, {
            phase: 'home.authorization.effect_family',
            errorClass: 'HttpStatusError', errorCode: 'action_forbidden', httpStatus: 401,
        });
        const reportFailures: unknown[] = [];
        const work = reconcileManagedMachine({ ...run.input,
            bootstrap: { ...run.input.bootstrap, enroll: async () => { throw failure; } },
            onReportFailure: error => reportFailures.push(error),
            home: { ...run.input.home, row: async (...args: Parameters<typeof run.input.home.row>) => {
                const report = args[0] === 'report' ? ManagedControllerReportV1Schema.parse(args[1]) : null;
                if (reportFails && report?.observation?.availability === 'unavailable' && 'reason' in report.observation
                    && report.observation.reason === 'bootstrap.remote_command_failed') throw reportFailure;
                return run.input.home.row(...args);
            } },
            settleBootstrapFailure: retained => retained,
        });
        if (reportFails) await expect(work).rejects.toBe(reportFailure);
        else expect(await work).toEqual(run.read());
        expect(run.read()).toMatchObject({ allocation: 'bound', resource,
            observation: { reason: reportFails ? 'bootstrap.incomplete' : 'bootstrap.remote_command_failed' } });
        expect(run.read().enrolledMachineId).toBeUndefined();
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
        const afterRestart = boundary(ManagedMachineFullV1Schema.parse(JSON.parse(JSON.stringify(run.read()))));
        const roles: string[] = [];
        const observed = await reconcileManagedMachine({ ...afterRestart.input, action: 'machines.managed.inspect',
            createNative: () => ({ prepareRoles: async () => {}, invoke: async (role): Promise<JsonValue | null> => { roles.push(role); return observation; } }),
        });
        expect(observed.observation).toMatchObject({ ...observation, reason: 'bootstrap.native_request_failed', nativeCause });
        expect(roles).toEqual(['inspect']);
    });

    it('retains guest Home reachability failure through bootstrap reporting and later Check now', async () => {
        const run = boundary({ ...machine, allocation: 'bound', resource });
        const carrierFailure = { attemptedCarrier: 'https', reason: 'home_unreachable',
            irohAttempt: { outcome: 'unavailable', reason: 'unavailable' } } as const;
        const failure = new SystemTaskExecutionError('home_not_guest_reachable', 'private enrollment diagnostic', {
            details: { kind: 'managedGuestHome', homeOrigin: 'https://home.example.test', carrierFailure },
        });
        await expect(reconcileManagedMachine({ ...run.input, bootstrap: { ...run.input.bootstrap,
            enroll: async () => { throw failure; },
        } })).rejects.toBe(failure);
        expect(run.read().observation).toMatchObject({ reason: 'bootstrap.home_not_guest_reachable', carrierFailure });
        const afterRestart = boundary(ManagedMachineFullV1Schema.parse(JSON.parse(JSON.stringify(run.read()))));
        const observed = await reconcileManagedMachine({ ...afterRestart.input, action: 'machines.managed.inspect' });
        expect(observed.observation).toMatchObject({ reason: 'bootstrap.home_not_guest_reachable', carrierFailure });
        expect(JSON.stringify(observed.observation)).not.toContain('private enrollment diagnostic');
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
        const initial = ManagedMachineFullV1Schema.parse({ ...machine, allocation: 'may-exist' });
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
        const initial = ManagedMachineFullV1Schema.parse({ ...machine, allocation: 'may-exist' });
        const run = boundary(initial);
        const reports: unknown[] = [];
        const result = await reconcileManagedMachine({ ...run.input, action: 'machines.managed.inspect',
            provisioner: { ...provisioner, reconciliation: { action: 'reconcile', nativeOperationSchema: provisioner.resourceSchema } },
            home: { ...run.input.home, row: async (_path, body) => {
                reports.push(body);
                const report = body as { result: { kind: string }; observation?: ManagedMachineFullV1['observation'] };
                return ManagedMachineFullV1Schema.parse({ ...initial,
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
        { kind: 'pending' as const, nativeOperationRef: resource, nativeCause: {
            localCause: 'native_command_failed', command: 'up', exitCode: null,
            failureCause: { phase: 'exec.run', errorClass: 'Error', errorCode: 'plugin_exec_termination_incomplete', httpStatus: null },
        } },
    ])('records the latest $kind acquisition check, including an unchanged unknown outcome', async result => {
        const initial = ManagedMachineFullV1Schema.parse({ ...machine, allocation: 'may-exist' });
        const run = boundary(initial);
        let saved = initial;
        const missing = result.kind === 'rejected' && result.code === 'managed_not_found';
        await reconcileManagedMachine({ ...run.input, action: 'machines.managed.inspect',
            provisioner: { ...provisioner, reconciliation: { action: 'reconcile', nativeOperationSchema: provisioner.resourceSchema } },
            home: { ...run.input.home, row: async (_path, body) => {
                const report = body as { result: typeof result; observation?: ManagedMachineFullV1['observation'] };
                saved = ManagedMachineFullV1Schema.parse({ ...saved,
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
            run: (row: ManagedMachineFullV1) => reconcileManagedMachine({ ...run.input, machine: row }),
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
    it.each(['browser', 'native'] as const)('refuses an undeliverable Home payload before paid admission on %s', async host => {
        const run = boundary();
        let admissions = 0;
        const acquire = { host, provisioner: { ...provisioner, browserReachable: true },
            guestCli: { source: 'home-payload' as const }, localPayloadAvailable: false,
            admit: async () => { admissions++; return machine; }, onAccepted: () => {},
            run: (row: ManagedMachineFullV1) => reconcileManagedMachine({ ...run.input, machine: row }),
        };
        await expect(executeManagedMachineAcquire(acquire)).rejects.toMatchObject({ code: 'provider_unavailable' });
        expect(admissions).toBe(0);
        expect(run.roles).toEqual([]);
        expect(run.events).toEqual([]);
        const result = await executeManagedMachineAcquire({ ...acquire, localPayloadAvailable: true });
        expect(result.result.enrolledMachineId).toBe('guest');
        expect(admissions).toBe(1);
        expect(run.roles.filter(role => role === 'acquire')).toHaveLength(1);
    });
    it('retains the submitted and bound identities before allocation and enrollment', async () => {
        const run = boundary();
        expect((await reconcileManagedMachine(run.input)).enrolledMachineId).toBe('guest');
        expect(run.events.filter(event => event !== 'report')).toEqual(['preflight', 'prepare-roles', 'submit', 'report-bound', 'enrollment-context', 'enroll']);
        expect(run.roles).toEqual(['acquire', 'check', 'bootstrap', 'inspect']);
    });
    it('stops at the late bound report when Cancel settled the creation during native allocation', async () => {
        const run = boundary();
        const result = reconcileManagedMachine({ ...run.input, home: { ...run.input.home,
            reportIssuedAcquireFact: async (row, fact) => {
                // Cancel landed while the provider was allocating; Home records the
                // exact late resource for cleanup and returns the canceled row.
                const recorded = await run.input.home.reportIssuedAcquireFact(row, fact);
                return ManagedMachineFullV1Schema.parse({ ...recorded, creationState: 'canceled', desired: 'delete', intentRevision: 1,
                    cleanup: { disposition: 'pending', reason: 'late_allocation' } });
            } } });
        await expect(result).rejects.toMatchObject({ code: 'cancelled' });
        expect(run.events.filter(event => event !== 'report')).toEqual(['preflight', 'prepare-roles', 'submit', 'report-bound']);
        expect(run.roles).not.toContain('bootstrap');
    });
    it('retries installation on the bound resource without another allocation', async () => {
        const run = boundary({ ...machine, allocation: 'bound', resource });
        const result = await reconcileManagedMachine({ ...run.input, action: 'machines.managed.bootstrap.retry' });
        expect(result.resource).toEqual(resource);
        expect(result.enrolledMachineId).toBe('guest');
        expect(run.roles).toEqual(['bootstrap', 'inspect']);
        expect(run.events).not.toContain('submit');
    });
    it('resumes SSH setup on a registered guest whose acquisition failed during bootstrap', async () => {
        const credentialRef = { kind: 'shared_resource' as const, resourceId: '00000000-0000-4000-8000-000000000001' };
        const registered = ManagedMachineFullV1Schema.parse({ ...machine, allocation: 'bound', resource,
            enrolledMachineId: 'guest', bootstrapCredentialRef: credentialRef,
            observation: { observedAt: 1, availability: 'unavailable', reason: 'bootstrap.ssh_command_failed' } });
        const run = boundary(registered);
        const native = run.input.createNative(run.read, () => undefined);
        const sshProvisioner = { ...provisioner, bootstrapTransport: undefined, bootstrapCredential: { kind: 'ssh' as const } };
        const inspected = await reconcileManagedMachine({ ...run.input, action: 'machines.managed.inspect', provisioner: sshProvisioner });
        expect(inspected.observation).toMatchObject({ power: 'running', reason: 'bootstrap.ssh_command_failed' });
        const result = await reconcileManagedMachine({ ...run.input, machine: inspected, action: 'machines.managed.bootstrap.retry',
            provisioner: sshProvisioner,
            createNative: () => ({ ...native, bootstrapCredentialKind: 'ssh', invoke: async (role, body, io) => {
                if (role === 'bootstrap') {
                    run.roles.push(role);
                    return { kind: 'ssh', address: 'guest.example.test', user: 'root', credentialRef };
                }
                return await native.invoke(role, body, io);
            } }),
            bootstrap: { ...run.input.bootstrap, enroll: async enrollment => {
                expect(enrollment.resumeSetup).toBe(true);
                expect(enrollment.machine.enrolledMachineId).toBe('guest');
                expect(run.read().observation?.reason).toBe('bootstrap.ssh_command_failed');
                return await run.input.bootstrap.enroll(enrollment);
            }, complete: async (_row, resumeSetup) => { expect(resumeSetup).toBe(true); run.events.push('complete'); } },
        });
        expect(result).toMatchObject({ resource, enrolledMachineId: 'guest', observation: { availability: 'present', power: 'running' } });
        expect(result.observation?.reason).toBeUndefined();
        expect(run.roles).toEqual(['inspect', 'bootstrap', 'inspect']);
        expect(run.events).toEqual(['report', 'enroll', 'complete', 'report']);
    });
    it('refuses an enrolled guest update without a native bootstrap transport before any provider or Home effect', async () => {
        const enrolled = ManagedMachineFullV1Schema.parse({ ...machine, allocation: 'bound', resource, enrolledMachineId: 'guest' });
        const run = boundary(enrolled);
        await expect(reconcileManagedMachine({ ...run.input, action: 'machines.managed.bootstrap.retry',
            provisioner: { ...provisioner, bootstrapTransport: undefined, bootstrapCredential: { kind: 'ssh' } },
        })).rejects.toMatchObject({ code: 'guest_update_not_supported' });
        expect(run.roles).toEqual([]);
        expect(run.events).toEqual([]);
        expect(run.read()).toEqual(enrolled);
    });
    it('confirms the same enrolled SSH resource through Inspect after a transient final report failure', async () => {
        const run = boundary();
        let failConfirmation = true;
        const home = { ...run.input.home, row: async (path: string, body: unknown) => {
            const report = path === 'report' ? ManagedControllerReportV1Schema.parse(body) : null;
            if (failConfirmation && report?.observation?.availability === 'present') {
                failConfirmation = false;
                throw new ManagedMachineControllerError('database_transaction_timeout', undefined, {
                    kind: 'managedControllerRequest', path: '/v1/machines/managed/controller/report', category: 'status', status: 503,
                });
            }
            return run.input.home.row(path, body);
        } };
        await expect(reconcileManagedMachine({ ...run.input, home })).rejects.toMatchObject({ code: 'database_transaction_timeout' });
        const retained = run.read();
        expect(retained).toMatchObject({ enrolledMachineId: 'guest', resource,
            observation: { availability: 'unavailable', reason: 'bootstrap.database_transaction_timeout' } });
        const recovered = await reconcileManagedMachine({ ...run.input, home, machine: retained,
            provisioner: { ...provisioner, bootstrapTransport: undefined }, action: 'machines.managed.inspect' });
        expect(recovered).toMatchObject({ enrolledMachineId: 'guest', resource, observation: { availability: 'present' } });
        expect(recovered.observation?.reason).toBeUndefined();
        expect(run.roles.filter(role => role === 'acquire')).toHaveLength(1);
        expect(run.events.filter(event => event === 'enroll')).toHaveLength(1);
    });
    it.each(['unsubmitted', 'bound'] as const)('forwards only the retained public SSH keys during %s enrollment', async allocation => {
        const credentialRef = { kind: 'shared_resource' as const, resourceId: '00000000-0000-4000-8000-000000000001' };
        const loginPublicKey = 'ssh-ed25519 client-login-public-key';
        const guestHostPublicKey = 'ssh-ed25519 guest-host-public-key';
        const run = boundary(allocation === 'bound' ? { ...machine, allocation, resource, bootstrapCredentialRef: credentialRef } : machine);
        const calls: Array<Readonly<{ role: string; body: unknown }>> = [];
        let preparations = 0;
        const result = await reconcileManagedMachine({ ...run.input,
            action: allocation === 'bound' ? 'machines.managed.bootstrap.retry' : 'machines.managed.acquire',
            provisioner: MachineProvisionerContributionV1Schema.parse({ ...provisioner,
                bootstrapTransport: undefined, bootstrapCredential: { kind: 'ssh' } }),
            createNative: (readMachine, readRevision) => {
                const native = run.input.createNative(readMachine, readRevision);
                return { ...native, bootstrapCredentialKind: 'ssh', invoke: async (role, body, io) => {
                    calls.push({ role, body });
                    if (role === 'bootstrap') return { kind: 'ssh', address: 'guest.example', user: 'root',
                        credentialRef, hostKeyEvidence: { hostKey: guestHostPublicKey, fingerprint: 'SHA256:retained-public-fingerprint' } };
                    return await native.invoke(role, body, io);
                } };
            },
            bootstrap: { ...run.input.bootstrap,
                enroll: async input => {
                    expect(input).toMatchObject({ guestHostPublicKey, credentialRevision: 7 });
                    return await run.input.bootstrap.enroll(input);
                },
                prepareCredential: async row => {
                    preparations++;
                    return { machine: { ...row, bootstrapCredentialRef: credentialRef }, publicKey: loginPublicKey,
                        guestHostPublicKey, credentialRevision: 7 };
                },
                readCredential: async (row, revision) => {
                    expect(row.bootstrapCredentialRef).toEqual(credentialRef);
                    expect(revision).toBe(allocation === 'unsubmitted' ? 7 : undefined);
                    return { publicKey: loginPublicKey, guestHostPublicKey, revision: 7 };
                },
            },
        });
        expect(result.enrolledMachineId).toBe('guest');
        const allocations = calls.filter(call => call.role === 'acquire');
        expect(allocations).toEqual(allocation === 'unsubmitted' ? [{ role: 'acquire', body: {
            managedId: machine.id, launch: machine.launch.choices, bootstrapPublicKey: loginPublicKey, guestHostPublicKey,
        } }] : []);
        expect(calls.filter(call => call.role === 'bootstrap')).toEqual([{ role: 'bootstrap', body: {
            resource: resource.value, credentialRef, bootstrapPublicKey: loginPublicKey, guestHostPublicKey,
        } }]);
        expect(preparations).toBe(allocation === 'unsubmitted' ? 1 : 0);
    });
});
