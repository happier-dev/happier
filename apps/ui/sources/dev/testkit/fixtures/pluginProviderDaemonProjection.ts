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
            digest: 'sha256:test-fixture',
        },
    },
    providersById: {
        'acme.review.provider': {
            id: 'acme.review.provider',
            title: 'Acme Review Provider',
            subtitle: 'Plugin provider',
            channel: 'plugin',
            isBuiltIn: false,
            providerAgentId: 'claude',
            iconAgentId: 'codex',
        },
    },
    backendsById: {
        'acme.review.backend': {
            id: 'acme.review.backend',
            providerId: 'acme.review.provider',
            title: 'Acme Review Backend',
            subtitle: 'Plugin-backed review engine',
            providerAgentId: 'claude',
            iconAgentId: 'codex',
        },
    },
    actionsById: {},
    familiesById: {},
    hooksById: {},
    toolsById: {},
    commandsById: {},
    resourcesById: {},
    uiDescriptorsById: {
        'acme.review.setup': {
            id: 'acme.review.setup',
            pluginId: 'acme.review',
            surface: 'settings',
            title: 'Setup',
            fields: [
                {
                    id: 'reviewHooks',
                    type: 'boolean',
                    title: 'Review hooks',
                    options: [],
                },
            ],
        },
        'acme.review.runtime': {
            id: 'acme.review.runtime',
            pluginId: 'acme.review',
            surface: 'status',
            title: 'Runtime',
            fields: [
                {
                    id: 'generation',
                    type: 'text',
                    title: 'Registry generation',
                    options: [],
                },
            ],
        },
    },
    diagnostics: [
        {
            severity: 'info',
            code: 'fixture.loaded',
            message: 'Loaded from test fixture',
            pluginId: 'acme.review',
        },
    ],
} as const satisfies PluginProjectionV2;
