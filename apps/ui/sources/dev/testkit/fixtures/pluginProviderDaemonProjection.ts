import type { PluginProjectionV2 } from '@happier-dev/protocol';

export const PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE = {
    v: 2,
    generation: 7,
    installedPackagesById: {
        'acme.review': {
            id: 'acme.review',
            displayName: 'Acme Review',
            version: '1.0.0',
            enabled: true,
            source: {
                kind: 'path',
                locator: '/plugins/acme-review',
            },
        },
    },
    agentsById: {
        'acme.review.provider': {
            id: 'acme.review.provider',
            identity: {
                pluginId: 'acme.review',
                localId: 'provider',
            },
            title: 'Acme Review Provider',
            subtitle: 'Plugin provider',
            channel: 'plugin',
            isBuiltIn: false,
            catalogAgentId: 'claude',
            iconAgentId: 'codex',
            providerOwnedEnvironmentKeys: [],
        },
    },
    actionsById: {},
    familiesById: {},


    resourcesById: {},
    settingsById: {},
    diagnostics: [
        {
            version: 1,
            id: 'acme.review:normalization:plugin:0',
            data: {
                severity: 'info',
                code: 'fixture.loaded',
                message: 'Loaded from test fixture',
            },
            plugin: { id: 'acme.review', version: '1.0.0', source: 'localPath' },
            stage: 'normalization',
            occurrenceId: '7',
            host: 'daemon',
            platform: 'darwin',
            occurredAtMs: 1,
            resolution: { state: 'current' },
        },
    ],
} as const satisfies PluginProjectionV2;
