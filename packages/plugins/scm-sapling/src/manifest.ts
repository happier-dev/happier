import { definePlugin } from '@happier-dev/plugin-sdk';
import type { ScmBackendContribution } from '@happier-dev/plugin-sdk/scm/backend';

import { SAPLING_INSTALLABLE_DEP_ID, SAPLING_INSTALLABLE_DESCRIPTOR } from './installables/saplingInstallable.js';
import { createSaplingScmBackendRegistration, SAPLING_SCM_BACKEND_ID } from './backend.js';

export const SAPLING_SCM_BACKEND_CONTRIBUTION = Object.freeze({
    id: SAPLING_SCM_BACKEND_ID,
    title: 'Sapling',
    description: 'Sapling local source control backend.',
    kind: 'sapling',
    capabilities: ['detect', 'fetch', 'status', 'diff', 'commit', 'push'],
} satisfies ScmBackendContribution);

const saplingScmBackendRegistration = createSaplingScmBackendRegistration();

export const SAPLING_PLUGIN = definePlugin({
    id: 'happier.scm.backend.sapling',
    version: '0.0.0',
    displayName: 'Sapling SCM backend',
    description: 'Provides the first-party local Sapling SCM backend with audited limited capabilities.',
    engines: { happier: '^0.0.0' }, runtime: { apiVersion: 1 },
    entrypoints: { daemon: './.happier-plugin/daemon.js' },
    hostAccess: {
        required: [{
            id: 'sapling-process',
            capability: 'process',
            reason: 'Run the declared Sapling executable for local source-control operations.',
            scope: { executables: [{ kind: 'managedDependency', id: SAPLING_INSTALLABLE_DEP_ID }] },
        }],
        optional: [],
    },
    managedDependencies: {
        [SAPLING_INSTALLABLE_DEP_ID]: SAPLING_INSTALLABLE_DESCRIPTOR,
    },
    scmBackends: {
        [SAPLING_SCM_BACKEND_ID]: {
            declaration: SAPLING_SCM_BACKEND_CONTRIBUTION,
            runtime: {
                runtime: saplingScmBackendRegistration.runtime,
                handlers: saplingScmBackendRegistration.handlers,
            },
        },
    },
});

export const PLUGIN_MANIFEST = SAPLING_PLUGIN.manifest;
