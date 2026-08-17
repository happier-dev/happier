import type { PluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { ScmBackendContribution } from '@happier-dev/plugin-sdk/scm/backend';

import { SAPLING_INSTALLABLE_DEP_ID, SAPLING_INSTALLABLE_DESCRIPTOR } from './installables/saplingInstallable.js';
import { SAPLING_SCM_BACKEND_ID } from './backend.js';

export const SAPLING_SCM_BACKEND_CONTRIBUTION = Object.freeze({
    id: SAPLING_SCM_BACKEND_ID,
    title: 'Sapling',
    description: 'Sapling local source control backend.',
    kind: 'sapling',
    capabilities: ['detect', 'fetch', 'status', 'diff', 'commit', 'push'],
} satisfies ScmBackendContribution);

export const PLUGIN_MANIFEST = {
    schemaVersion: 2,
    id: 'happier.scm.backend.sapling',
    version: '0.0.0',
    displayName: 'Sapling SCM backend',
    description: 'Provides the first-party local Sapling SCM backend with audited limited capabilities.',
    engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
    entrypoints: { daemon: './dist/index.js' },
    hostAccess: {
        required: [{
            id: 'sapling-process',
            capability: 'process',
            reason: 'Run the declared Sapling executable for local source-control operations.',
            scope: { executables: [{ kind: 'managedDependency', id: SAPLING_INSTALLABLE_DEP_ID }] },
        }],
        optional: [],
    },
    contributes: {
        managedDependencies: [SAPLING_INSTALLABLE_DESCRIPTOR],
        scmBackends: [SAPLING_SCM_BACKEND_CONTRIBUTION],
    },
} satisfies PluginManifest;
