import { expect, it } from 'vitest';

import { PluginPortableReleaseManifestV1Schema } from '../plugins/availability/compatibilityProjectionV1.js';
import { createPluginAccountBundledSelectionV1, resolvePluginAccountExecutionSelectionV1 } from '../plugins/availability/accountExecution.js';
import { SCM_HOSTING_CONNECTED_ACCOUNT_PURPOSE_ID } from '../plugins/contributions/scmHostingProviders.js';
import { resolveConnectedAccountPurposeDefaultTargetV1 } from './connectedAccountPurposeSelectionV1.js';
import { QualifiedConnectedAccountProfileV4Schema } from './qualifiedConnectedAccountsV4.js';

it('allows a hosting provider to select only its declared Connected Account service', () => {
    const manifest = PluginPortableReleaseManifestV1Schema.parse({
        schemaVersion: 2, id: 'com.acme.hosting', version: '1.0.0', displayName: 'Acme hosting',
        engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
        contributes: {
            scmHostingProviders: [{ id: 'forge', title: 'Forge', kind: 'github', capabilities: ['detect', 'push'], authService: 'forge-account' }],
            connectedAccountDescriptors: [{ id: 'forge-account', title: 'Forge account', authentication: {
                defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [] }],
            } }],
        },
    });
    const accountSelection = resolvePluginAccountExecutionSelectionV1({ pluginId: manifest.id, intentRead: null,
        bundled: createPluginAccountBundledSelectionV1({ packageName: '@acme/hosting', manifest }) });
    if (accountSelection.kind !== 'available') throw new Error('Expected the Account hosting plugin');
    const consumer = { pluginId: manifest.id, localId: 'forge' };
    const purpose = { consumer, purpose: SCM_HOSTING_CONNECTED_ACCOUNT_PURPOSE_ID };
    const profile = (pluginId: string) => QualifiedConnectedAccountProfileV4Schema.parse({
        ref: { service: { pluginId, localId: 'forge-account' }, accountId: 'owner' }, status: 'connected',
        authenticationModeId: 'manual', revisionSemantics: 'revisioned', credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        configurationReady: true, configurationRevision: null, scopes: [],
    });
    const own = profile(manifest.id);
    const foreign = profile('com.acme.unrelated');
    const fixture = { declaration: { purpose, accountSelection }, accounts: [own, foreign], groups: [], now: 1 };
    expect(resolveConnectedAccountPurposeDefaultTargetV1({ ...fixture, target: { kind: 'account', account: own.ref } })).toEqual(own);
    expect(resolveConnectedAccountPurposeDefaultTargetV1({ ...fixture, target: { kind: 'account', account: foreign.ref } })).toBeNull();
    expect(resolveConnectedAccountPurposeDefaultTargetV1({ ...fixture,
        declaration: { accountSelection, purpose: { consumer, purpose: 'other' } },
        target: { kind: 'account', account: own.ref },
    })).toBeNull();
});
