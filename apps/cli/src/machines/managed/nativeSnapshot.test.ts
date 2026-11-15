import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedMachineAcquisitionDriver } from './acquire';
import { createNativeCredentialComposerFixture } from './nativeCredentialComposer.testkit';
import { PluginConnectedAccountAuthenticationV2Schema } from '@happier-dev/protocol';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { PluginError } from '@happier-dev/plugin-sdk';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('admitted restore native snapshot', () => {
    it.each([true, false])('retains only the closed native snapshot cause (typed=%s)', async typed => {
        const nativeCause = { grpcStatusCode: 14 };
        const fixture = await createNativeCredentialComposerFixture({ nativeOptions: { snapshot: true,
            onNativeRole: role => {
                if (role !== 'snapshot') return;
                if (typed) throw new PluginError({ code: 'native_snapshot_refused',
                    details: { nativeCause, privateOutput: 'PRIVATE_SNAPSHOT_OUTPUT' } });
                throw new Error('PRIVATE_SNAPSHOT_OUTPUT');
            },
        } });
        try {
            const driver = createManagedMachineAcquisitionDriver(fixture.driverInput);
            const result = await driver.snapshotAdmitted({ machine: fixture.input.machine, label: 'Before restore', reason: 'Database restore',
                options: { requestId: 'restore-operation', context: {
                    operationAcceptance: { operationId: 'restore-operation', actionId: 'deployments.backups.restore', accept() {} },
                } } });
            expect(result).toMatchObject({ kind: 'unknown' });
            if (typed) expect(result).toEqual({ kind: 'unknown', code: 'native_snapshot_refused', nativeCause });
            else expect(result).not.toHaveProperty('nativeCause');
            expect(JSON.stringify(result)).not.toContain('PRIVATE_SNAPSHOT_OUTPUT');
        } finally { await fixture.cleanup(); }
    });
    it('reports an absent optional role without native effects', async () => {
        const fixture = await createNativeCredentialComposerFixture();
        try {
            const driver = createManagedMachineAcquisitionDriver(fixture.driverInput);
            expect(await driver.snapshotAdmitted({ machine: fixture.input.machine, label: 'Before restore', reason: 'Database restore',
                options: { requestId: 'restore-operation', context: {
                    operationAcceptance: { operationId: 'restore-operation', actionId: 'deployments.backups.restore', accept() {} },
                } } })).toEqual({ kind: 'unsupported', code: 'native_snapshot_unsupported' });
            expect(fixture.native.effects()).toBe(0);
        } finally { await fixture.cleanup(); }
    });
    it('runs the exact resource through the installed managed custody and returns the provider receipt', async () => {
        const observed: unknown[] = [];
        const unavailable = async (): Promise<never> => { throw new Error('A retained snapshot must not select mutable credentials'); };
        const service = { pluginId: 'acme.accounts', localId: 'cloud' };
        const provider = { pluginId: 'acme.compute', localId: 'vm' };
        const owner = createConnectedAccountPurposeBindingOwner({ credentialOwnerAccountId: 'controller-account',
            store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
            selectTarget: unavailable,
            resolveTarget: async target => target.kind === 'account' ? { displayName: 'Cloud account', account: target.account } : null,
            materializeAccount: async ({ account }) => ({ kind: 'environment', env: { TOKEN: account.accountId } }),
            resolveCredentialConfigurationRevision: async () => 'cloud-configuration',
            projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable });
        const reference = normalizePluginManifestV2({ schemaVersion: 2, id: service.pluginId, version: '1.0.0',
            displayName: 'Native fixture accounts', runtime: { apiVersion: 1 }, contributes: {
                connectedAccountDescriptors: [{ id: service.localId, title: 'Cloud',
                    authentication: PluginConnectedAccountAuthenticationV2Schema.parse({ defaultModeId: 'token', modes: [{
                        id: 'token', kind: 'manual', outcomeReconciliation: 'none', fields: [{ id: 'token', title: 'Token',
                            schema: { type: 'string', minLength: 1 }, secret: true }] }] }) }] } });
        const fixture = await createNativeCredentialComposerFixture({ purposeBindingOwner: owner,
            machine: { launch: { provider, schemaVersion: 1, name: 'guest', choices: {}, credentials: [{
                purpose: { consumer: provider, purpose: 'cloud' }, account: { service, accountId: 'retained-cloud' },
                configurationRevision: 'cloud-configuration' }] } }, nativeOptions: {
            snapshot: true,
            credentialOwner: owner, credentialPurposes: [{ purpose: 'cloud', service }], referenceManifests: [reference],
            onNativeRole: async (role, input) => { if (role === 'snapshot') observed.push(input); },
        } });
        try {
            const machine = fixture.input.machine;
            const driver = createManagedMachineAcquisitionDriver(fixture.driverInput);
            const result = await driver.snapshotAdmitted({ machine, label: 'Before restore', reason: 'Database restore',
                options: { requestId: 'restore-operation', context: {
                    operationAcceptance: { operationId: 'restore-operation', actionId: 'deployments.backups.restore', accept() {} },
                } } });
            expect(result).toMatchObject({ kind: 'confirmed', snapshotId: 'snapshot-1',
                coverage: { rootDisk: true, attachedVolumes: false }, consistency: 'running',
                cost: { kind: 'billed' } });
            expect(observed).toEqual([{ resource: machine.resource?.value, expectedMachineRevision: machine.intentRevision,
                label: 'Before restore', reason: 'Database restore' }]);
            expect(fixture.native.materializedAccounts).toEqual(['retained-cloud']);
            expect(axios.post).not.toHaveBeenCalled();
        } finally { await fixture.cleanup(); }
    });
});
