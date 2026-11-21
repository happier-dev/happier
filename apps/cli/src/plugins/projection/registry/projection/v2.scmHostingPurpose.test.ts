import { expect, it } from 'vitest';

import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { readDeclaredConnectedAccountPurposeV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeSelectionV1';
import { SCM_HOSTING_CONNECTED_ACCOUNT_PURPOSE_ID } from '@happier-dev/protocol/plugins/contributions/scmHostingProviders';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';

import { createResolvedContributionRegistry } from '../createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '../fullProjection';
import { buildPluginConnectedAccountAdmissionProjectionV2 } from './v2';

it('carries the admitted hosting provider purpose through the Machine configuration projection', () => {
    const pluginId = 'com.acme.hosting';
    const ingested = ingestCanonicalPluginManifest({
        schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Acme hosting',
        engines: { happier: '^0.3.0' }, runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        contributes: {
            scmHostingProviders: [{ id: 'forge', title: 'Forge', kind: 'github', capabilities: ['detect', 'push'], authService: 'forge-account' }],
            connectedAccountDescriptors: [{ id: 'forge-account', title: 'Forge account', authentication: {
                defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [] }],
            } }],
        },
    }, { sourceProvenance: 'registryCustodied' });
    if (!ingested.ok) throw new Error(ingested.diagnostics.map(diagnostic => diagnostic.message).join('\n'));
    const registry = {
        ...createResolvedContributionRegistry(projectLoadedPluginContributes({
            provenance: 'external',
            loadResult: {
                diagnosticsByPluginId: {},
                loadedPlugins: [{
                    pluginId, pluginRootPath: '/plugins/acme-hosting', manifest: ingested.manifest,
                    manifestPath: '/plugins/acme-hosting/happier.plugin.json', daemonEntryPath: '/plugins/acme-hosting/daemon.mjs',
                    devDaemonEntryPath: null,
                    sourceSpec: { kind: 'path', locator: '/plugins/acme-hosting', trustPolicy: 'local_trusted', installPolicy: 'link' },
                }],
            },
        })),
        occurrenceIdsByPluginId: { [pluginId]: createPluginRuntimeOccurrenceId(pluginId) },
    };
    const projection = PluginProjectionV2Schema.parse(buildPluginConnectedAccountAdmissionProjectionV2({ registry, generation: 1 }));
    const purpose = { consumer: { pluginId, localId: 'forge' }, purpose: SCM_HOSTING_CONNECTED_ACCOUNT_PURPOSE_ID };
    const fixture = { purpose, projection, machineProvisionersById: {} };
    expect(readDeclaredConnectedAccountPurposeV1(fixture)).toEqual({
        purpose: SCM_HOSTING_CONNECTED_ACCOUNT_PURPOSE_ID, consumerKind: 'scmHostingProvider',
        serviceRefs: [{ pluginId, localId: 'forge-account' }],
    });
    expect(readDeclaredConnectedAccountPurposeV1({
        ...fixture, projection: { ...projection, installedPackagesById: {} },
    })).toBeNull();
});
