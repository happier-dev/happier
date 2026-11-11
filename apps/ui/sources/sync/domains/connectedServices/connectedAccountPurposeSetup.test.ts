import { expect, it } from 'vitest';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { createPluginAccountBundledSelectionV1, resolvePluginAccountExecutionSelectionV1 } from '@happier-dev/protocol/plugins/availability/accountExecution';
import { resolveConnectedAccountPurposeSetupPlacement } from './connectedAccountPurposeSetup';

const manifest = PluginPortableReleaseManifestV1Schema.parse({
    schemaVersion: 2, id: 'com.acme.purpose-placement', version: '1.0.0', displayName: 'Purpose placement',
    engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
    hostAccess: { required: [{ id: 'cloud', capability: 'connectedAccounts', reason: 'Read cloud',
        scope: { serviceRefs: ['cloud-account'], operations: ['use'] } }], optional: [] },
    contributes: {
        actions: [
            { id: 'account-read', title: 'Read Account', scopes: ['global'], surfaces: ['plugin'], dangerLevel: 'safe',
                execution: { target: 'account', account: { artifactId: 'main', exportName: 'activate' } }, hostAccess: ['cloud'] },
            { id: 'machine-read', title: 'Read Machine', scopes: ['global'], surfaces: ['plugin'], dangerLevel: 'safe',
                execution: { target: 'daemon' }, hostAccess: ['cloud'] },
        ],
        resources: [{ id: 'account-resource', source: 'dynamic', kind: 'config', contentType: 'application/json',
            execution: { target: 'account', account: { artifactId: 'main', exportName: 'activate' } }, hostAccess: ['cloud'] }],
    },
});
const selection = resolvePluginAccountExecutionSelectionV1({ pluginId: manifest.id, intentRead: null,
    bundled: createPluginAccountBundledSelectionV1({ packageName: '@acme/purpose-placement', manifest }) });
const scope = { serverId: 'home', accountId: 'owner' };

it.each(['account-read', 'account-resource'])('places %s in its declared Account despite a selected Machine', consumerId => {
    const purpose = { consumer: { pluginId: manifest.id, localId: consumerId }, purpose: 'cloud' };
    expect(resolveConnectedAccountPurposeSetupPlacement({ scope, machineId: 'selected-machine', purpose }, selection))
        .toEqual({ kind: 'account', request: { scope, purpose } });
});

it.each([undefined, 'selected-machine'])('keeps a declared Machine purpose on its Machine path (%s)', machineId => {
    const request = { scope, machineId,
        purpose: { consumer: { pluginId: manifest.id, localId: 'machine-read' }, purpose: 'cloud' } };
    expect(resolveConnectedAccountPurposeSetupPlacement(request, selection)).toEqual({ kind: 'machine', request });
});
