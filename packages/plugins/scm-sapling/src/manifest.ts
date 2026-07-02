import { definePluginManifest, type PluginManifestV2, type ScmBackendContribution } from '@happier-dev/plugin-sdk';

import { SAPLING_INSTALLABLE_DEP_ID, SAPLING_INSTALLABLE_DESCRIPTOR } from './installables/saplingInstallable.js';
import { SAPLING_SCM_BACKEND_CAPABILITIES } from './backend/capabilities.js';
import { SAPLING_SCM_BACKEND_ID } from './backend/registerSaplingScmBackend.js';

export const SAPLING_SCM_BACKEND_CONTRIBUTION = {
    id: SAPLING_SCM_BACKEND_ID,
    displayName: 'Sapling',
    description: 'Sapling local source control backend.',
    repoModes: ['.sl', '.git'],
    detection: {
        rootMarkers: ['.sl'],
    },
    capabilities: SAPLING_SCM_BACKEND_CAPABILITIES,
    installableDependencies: [SAPLING_INSTALLABLE_DEP_ID],
    tooling: {
        commands: [{ installableKey: SAPLING_INSTALLABLE_DEP_ID, command: 'sl' }],
        systemFirst: true,
        managedFallback: false,
    },
    safetyConstraints: {
        mutatesWorkingTree: true,
        requiresUserConfirmationForDestructiveWrites: true,
    },
} satisfies ScmBackendContribution;

export const PLUGIN_MANIFEST = definePluginManifest({
    schemaVersion: 2,
    id: 'happier.scm.backend.sapling',
    version: '0.0.0',
    displayName: 'Sapling SCM backend',
    description: 'Provides the first-party local Sapling SCM backend with audited limited capabilities.',
    source: {
        kind: 'package',
        locator: '@happier-dev/plugins-scm-sapling',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
        resolvedVersion: '0.0.0',
    },
    engines: { happier: '^0.0.0' },
    runtime: { apiVersion: 1, capabilities: ['scmBackends'] },
    targets: {},
    capabilities: {
        permissions: [],
    },
    contributes: {
        installables: [SAPLING_INSTALLABLE_DESCRIPTOR],
        scmBackends: [SAPLING_SCM_BACKEND_CONTRIBUTION],
    },
} satisfies PluginManifestV2);
