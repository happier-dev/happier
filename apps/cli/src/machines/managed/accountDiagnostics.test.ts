import { expect, it } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineProvisionerContributionV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { readCliManagedAccountGuestDiagnostics } from './accountDiagnostics';

it('retains missing Account diagnostic admission instead of reporting provider absence', async () => {
    const provisioner = MachineProvisionerContributionV1Schema.parse({
        id: 'vm', title: 'Compute', icon: 'cloud', resourceKind: 'compute', schemaVersion: 1,
        launchSchema: { type: 'object', properties: {}, additionalProperties: false },
        resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
        billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['start', 'delete'] },
        actions: { acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy', check: 'check', power: 'power' },
        bootstrapTransport: { kind: 'native', exec: 'exec', putFile: 'put-file' },
    });
    const launch = { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} };
    const retention = { kind: 'until-delete' };
    const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'home', custodianAccountId: 'owner',
        enrolledMachineId: 'guest', launch, resource: { contributionRef: launch.provider, schemaVersion: 1, value: {} },
        allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
        retention, wakeOnAcceptedMessage: false,
        reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
            retentionCapabilities: provisioner.retention, retention, wakeOnAcceptedMessage: false },
    });
    expect(await readCliManagedAccountGuestDiagnostics({ machine, context: { runtimeAccountId: 'owner' },
        credentials: { token: 'unused', encryption: null }, serverUrl: 'https://unused.invalid' }))
        .toEqual({ status: 'unavailable', code: 'admission_unavailable', phase: 'guest_collection' });
});
