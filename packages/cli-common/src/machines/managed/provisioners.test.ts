import { describe, expect, it } from 'vitest';
import { readMachineProvisionerHostAvailability, prepareManagedPowerProvisionerAdmissionV1 } from './provisioners.js';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

const provisioner = MachineProvisionerContributionV1Schema.parse({ id: 'vm', title: 'Compute', icon: 'cloud', resourceKind: 'compute',
    schemaVersion: 1, launchSchema: { type: 'object', properties: {}, additionalProperties: false },
    resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
    billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['start', 'delete'] },
    actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'observe', destroy: 'destroy', power: 'change-power' } });
const launch = { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} };
const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner', launch,
    allocation: 'unsubmitted', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
        retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });

describe('Account managed power role preparation', () => {
    const selected = [{ contribution: launch.provider, occurrenceId: 'selected', descriptor: provisioner, acquireExecutionTarget: 'account' as const }];
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
        expect(await prepareManagedPowerProvisionerAdmissionV1(machine, async () => selected, 'machines.managed.bootstrap.retry'))
            .toEqual({ children: [
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
    it.each([undefined, false])('refuses browser allocation without a positively reachable recipe (%s)', browserReachable => {
        expect(readMachineProvisionerHostAvailability({ host: 'browser', provisioner: { browserReachable } }))
            .toEqual({ available: false, code: 'provider_unavailable' });
    });
    it('keeps browser-reachable recipes and native host recipes available', () => {
        expect(readMachineProvisionerHostAvailability({ host: 'browser', provisioner: { browserReachable: true } }))
            .toEqual({ available: true });
        expect(readMachineProvisionerHostAvailability({ host: 'native', provisioner: {} }))
            .toEqual({ available: true });
    });
});
