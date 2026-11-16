import { describe, expect, it } from 'vitest';
import { qualifyManagedOpaquePresetProvisionerV1, readMachineProvisionerHostAvailability,
    prepareManagedPowerProvisionerAdmissionV1 } from './provisioners.js';
import { ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

const provisioner = MachineProvisionerContributionV1Schema.parse({ id: 'vm', title: 'Compute', icon: 'cloud', resourceKind: 'compute',
    schemaVersion: 1, launchSchema: { type: 'object', properties: {}, additionalProperties: false },
    resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
    billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['start', 'delete'] },
    actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'observe', destroy: 'destroy', power: 'change-power' } });
const launch = { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} };
const machine = ManagedMachineFullV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner', launch,
    allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
        retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });

describe('Account managed power role preparation', () => {
    const selected = [{ contribution: launch.provider, occurrenceId: 'selected', descriptor: provisioner, acquireExecutionTarget: 'account' as const }];
    it('reviews resize from the current declaration even when creation facts predate resize', async () => {
        const descriptor = { ...provisioner, actions: { ...provisioner.actions, resize: 'resize' } };
        expect(await prepareManagedPowerProvisionerAdmissionV1(machine,
            async () => [{ ...selected[0]!, descriptor }], 'machines.managed.resize')).toEqual({ children: [
                { action: { pluginId: 'acme.compute', localId: 'observe' }, role: 'inspect' },
                { action: { pluginId: 'acme.compute', localId: 'change-power' }, role: 'power' },
                { action: { pluginId: 'acme.compute', localId: 'resize' }, role: 'resize' },
            ] });
    });
    it('reviews native diagnostics roles only for an explicit inspection read', async () => {
        const nativeProvisioner = { ...provisioner, bootstrapTransport: { kind: 'native' as const, exec: 'exec', putFile: 'put-file' } };
        const nativeMachine = { ...machine, reviewedFacts: { ...machine.reviewedFacts!, provisioner: nativeProvisioner } };
        const readSelected = async () => [{ ...selected[0]!, descriptor: nativeProvisioner }];
        expect(await prepareManagedPowerProvisionerAdmissionV1(nativeMachine, readSelected, 'machines.managed.inspect'))
            .toEqual({ children: [{ action: { pluginId: 'acme.compute', localId: 'observe' }, role: 'inspect' }] });
        expect(await prepareManagedPowerProvisionerAdmissionV1(nativeMachine, readSelected, 'machines.managed.inspect',
            { includeGuestDiagnostics: true })).toEqual({ children: [
                { action: { pluginId: 'acme.compute', localId: 'observe' }, role: 'inspect' },
                { action: { pluginId: 'acme.compute', localId: 'exec' }, role: 'exec' },
            ] });
    });
    it('reviews retained native guest startup with power, excluding installer file delivery', async () => {
        const nativeProvisioner = { ...provisioner, bootstrapTransport: { kind: 'native' as const, exec: 'exec', putFile: 'put-file' } };
        const nativeMachine = { ...machine, enrolledMachineId: 'same-machine',
            reviewedFacts: { ...machine.reviewedFacts!, provisioner: nativeProvisioner } };
        const prepared = await prepareManagedPowerProvisionerAdmissionV1(nativeMachine,
            async () => [{ ...selected[0]!, descriptor: nativeProvisioner }]);
        expect(prepared).toEqual({ children: [
            { action: { pluginId: 'acme.compute', localId: 'bootstrap' }, role: 'bootstrap' },
            { action: { pluginId: 'acme.compute', localId: 'observe' }, role: 'inspect' },
            { action: { pluginId: 'acme.compute', localId: 'change-power' }, role: 'power' },
            { action: { pluginId: 'acme.compute', localId: 'exec' }, role: 'exec' },
        ] });
    });
    it.each(['permission_denied', 'server_unreachable', 'managed_response_invalid', 'cancelled'] as const)(
        'prepares no roles from a failed snapshot read without hiding control admission (%s)', async errorCode => {
        const failure = { ok: false as const, errorCode, error: errorCode };
        expect(await prepareManagedPowerProvisionerAdmissionV1(failure, async () => {
            throw new Error('A failed row read cannot select provider roles');
        })).toEqual(errorCode === 'permission_denied' ? { children: [] } : failure);
    });
    it('prepares only retained power and inspect roles without native operands or effects', async () => {
        expect(await prepareManagedPowerProvisionerAdmissionV1(machine, async () => selected)).toEqual({ children: [
            { action: { pluginId: 'acme.compute', localId: 'observe' }, role: 'inspect' },
            { action: { pluginId: 'acme.compute', localId: 'change-power' }, role: 'power' },
        ] });
        expect(await prepareManagedPowerProvisionerAdmissionV1({ ...machine,
            controller: { machineId: 'controller', installationId: 'installation' } }, async () => {
            throw new Error('Native controller owns its own declaration');
        })).toBeNull();
    });
    it('refuses an unavailable or changed selected Account declaration before preparing roles', async () => {
        expect(await prepareManagedPowerProvisionerAdmissionV1(machine, async () => null))
            .toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
        expect(await prepareManagedPowerProvisionerAdmissionV1(machine, async () => [{ ...selected[0]!,
            descriptor: { ...provisioner, actions: { ...provisioner.actions, power: 'foreign-power' } } }]))
            .toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
    });
    it('reviews inspection without mutation roles and installation retry without power or destroy roles', async () => {
        expect(await prepareManagedPowerProvisionerAdmissionV1(machine, async () => selected, 'machines.managed.inspect'))
            .toEqual({ children: [{ action: { pluginId: 'acme.compute', localId: 'observe' }, role: 'inspect' }] });
        expect(await prepareManagedPowerProvisionerAdmissionV1({ ...machine,
            enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } }, async () => selected, 'machines.managed.bootstrap.retry'))
            .toEqual({ children: [
                { action: { pluginId: 'acme.compute', localId: 'acquire' }, role: 'acquire' },
                { action: { pluginId: 'acme.compute', localId: 'bootstrap' }, role: 'bootstrap' },
                { action: { pluginId: 'acme.compute', localId: 'observe' }, role: 'inspect' },
                { action: 'machines.roles.set', role: 'machines.roles.set' },
            ] });
    });
    it('does not demand a roles seed when retrying an adopted Machine', async () => {
        const prepared = await prepareManagedPowerProvisionerAdmissionV1({ ...machine,
            enrollmentIdentity: { kind: 'existingUser', role: 'adopted' } }, async () => selected, 'machines.managed.bootstrap.retry');
        expect(prepared).toEqual({ children: [
            { action: { pluginId: 'acme.compute', localId: 'acquire' }, role: 'acquire' },
            { action: { pluginId: 'acme.compute', localId: 'bootstrap' }, role: 'bootstrap' },
            { action: { pluginId: 'acme.compute', localId: 'observe' }, role: 'inspect' },
        ] });
    });
    it.each(['machines.managed.delete', 'machines.managed.cancel'] as const)('reviews cleanup roles for %s without acquisition or bootstrap', async actionId => {
        expect(await prepareManagedPowerProvisionerAdmissionV1(machine, async () => selected, actionId)).toEqual({ children: [
            { action: { pluginId: 'acme.compute', localId: 'observe' }, role: 'inspect' },
            { action: { pluginId: 'acme.compute', localId: 'destroy' }, role: 'destroy' },
        ] });
    });
});

describe('provisioner host availability before acquisition', () => {
    it('awaits a computer for a daemon role with cloud billing and keeps an Account role with local billing usable', () => {
        const cloudProvisioner = MachineProvisionerContributionV1Schema.parse({ ...provisioner,
            billing: { location: 'cloud', stoppedBilling: 'billed' } });
        const localProvisioner = MachineProvisionerContributionV1Schema.parse({ ...provisioner,
            billing: { location: 'local', stoppedBilling: 'not-billed' } });
        expect(readMachineProvisionerHostAvailability({ host: 'native',
            provisioner: cloudProvisioner,
            acquireExecutionTarget: 'daemon' })).toMatchObject({ executionTarget: 'daemon', requiresController: true });
        expect(readMachineProvisionerHostAvailability({ host: 'native',
            provisioner: localProvisioner,
            acquireExecutionTarget: 'account' })).toMatchObject({ available: true, executionTarget: 'account', requiresController: false });
    });
    it.each([
        { host: 'browser', browserReachable: false, selected: true, declared: 'account', target: 'daemon', available: true },
        { host: 'browser', browserReachable: false, selected: false, declared: 'account', target: 'account', available: false },
        { host: 'browser', browserReachable: true, selected: true, declared: 'account', target: 'account', available: true },
        { host: 'native', browserReachable: false, selected: true, declared: 'account', target: 'account', available: true },
        { host: 'browser', browserReachable: false, selected: true, declared: 'daemon', target: 'daemon', available: true },
        { host: 'browser', browserReachable: false, selected: false, declared: 'daemon', target: 'daemon', available: false },
    ] as const)('places $declared on $target with $host, reachable=$browserReachable, selected=$selected', value => {
        const controller = { machineId: 'selected', installationId: 'installation' };
        const input = { host: value.host, provisioner: { browserReachable: value.browserReachable },
            acquireExecutionTarget: value.declared, ...(value.selected ? { controller } : {}) };
        const result = readMachineProvisionerHostAvailability(input);
        expect(result).toMatchObject({ available: value.available, executionTarget: value.target });
        expect(result.controller).toEqual(value.target === 'daemon' && value.selected ? controller : undefined);
    });
    it('qualifies CLI delivery without opening an opaque preset and preserves explicit browser qualification', () => {
        expect(readMachineProvisionerHostAvailability({ host: 'browser' })).toMatchObject({ available: false,
            code: 'guest_cli_identity_unavailable' });
        expect(readMachineProvisionerHostAvailability({ host: 'browser', guestCli: { source: 'public-release' } }))
            .toMatchObject({ available: true, executionTarget: 'account' });
        expect(readMachineProvisionerHostAvailability({ host: 'browser', provisioner: {}, guestCli: { source: 'public-release' } }))
            .toMatchObject({ available: false, code: 'provider_unavailable' });
    });
    it.each(['browser', 'native'] as const)('requires a controller for Home payloads without local delivery on %s', host => {
        const request = { host, provisioner: { browserReachable: true }, acquireExecutionTarget: 'account' as const,
            guestCli: { source: 'home-payload' as const }, localPayloadAvailable: false };
        expect(readMachineProvisionerHostAvailability(request)).toMatchObject({ available: false,
            executionTarget: 'daemon', requiresController: true });
        const controller = { machineId: 'reviewed', installationId: 'reviewed-installation' };
        expect(readMachineProvisionerHostAvailability({ ...request, controller })).toMatchObject({ available: true,
            executionTarget: 'daemon', requiresController: false, controller });
        expect(readMachineProvisionerHostAvailability({ ...request, localPayloadAvailable: true })).toMatchObject({ available: true,
            executionTarget: 'account', requiresController: false });
        expect(readMachineProvisionerHostAvailability({ ...request, guestCli: { source: 'public-release' as const } })).toMatchObject({ available: true,
            executionTarget: 'account', requiresController: false });
    });
    it.each([undefined, false])('refuses browser allocation without a positively reachable recipe (%s)', browserReachable => {
        expect(readMachineProvisionerHostAvailability({ host: 'browser', provisioner: { browserReachable } }))
            .toEqual({ available: false, code: 'provider_unavailable', executionTarget: 'account', requiresController: false });
    });
    it('keeps browser-reachable recipes and native host recipes available', () => {
        expect(readMachineProvisionerHostAvailability({ host: 'browser', provisioner: { browserReachable: true } }))
            .toEqual({ available: true, executionTarget: 'account', requiresController: false });
        expect(readMachineProvisionerHostAvailability({ host: 'native', provisioner: {} }))
            .toEqual({ available: true, executionTarget: 'account', requiresController: false });
    });
});

describe('opaque preset launch qualification', () => {
    const selected = [{ contribution: launch.provider, occurrenceId: 'selected', descriptor: provisioner,
        acquireExecutionTarget: 'account' as const }];

    it('selects and validates the exact opened declaration once for every keyholding host', () => {
        expect(qualifyManagedOpaquePresetProvisionerV1({ launch, provisioners: selected })).toBe(provisioner);
    });

    it('rejects schema drift or an absent acquire role before any host can issue a private child', () => {
        expect(qualifyManagedOpaquePresetProvisionerV1({ launch: { ...launch, choices: { stale: true } }, provisioners: selected }))
            .toBeNull();
        expect(qualifyManagedOpaquePresetProvisionerV1({ launch, provisioners: [{ ...selected[0]!,
            // @ts-expect-error -- Simulates a malformed declaration at the external plugin boundary.
            descriptor: { ...provisioner, actions: { ...provisioner.actions, acquire: undefined } } }], })).toBeNull();
    });
});
