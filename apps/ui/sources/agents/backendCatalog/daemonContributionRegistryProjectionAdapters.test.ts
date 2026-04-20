import { describe, expect, it } from 'vitest';

import type { ExtensionProjectionV2 } from '@happier-dev/protocol';

import {
    adaptDaemonContributionRegistryProjectionToMergedProjectionInputs,
    type DaemonContributionRegistryProjectionV1Like,
} from './daemonContributionRegistryProjectionAdapters';

describe('daemon contribution registry projection adapters', () => {
    it('adapts daemon projection v1 into merged backend/provider projection maps', () => {
        const projection: DaemonContributionRegistryProjectionV1Like = {
            v: 1,
            generationId: 'registry:plugin-provider|ui:p1.settings',
            providersById: {
                p1: {
                    id: 'p1',
                    title: 'P1',
                    subtitle: 'sub',
                    channel: 'plugin',
                    settingsBackendId: 'b1',
                    providerAgentId: 'claude',
                    iconAgentId: 'codex',
                },
            },
            backendsById: {
                b1: { id: 'b1', providerId: 'p1', providerAgentId: 'claude', iconAgentId: 'codex' },
            },
            actionsById: {
                'p1.refresh': {
                    id: 'p1.refresh',
                    pluginId: 'p1',
                    title: 'Refresh P1',
                    description: 'Refresh P1 resources',
                    safety: 'safe',
                    surfaces: {
                        settings: true,
                    },
                },
            },
            resourcesById: {
                'p1.prompt': {
                    id: 'p1.prompt',
                    pluginId: 'p1',
                    type: 'prompt',
                    path: 'resources/prompt.md',
                    digest: 'sha256:prompt',
                    contentType: 'text/markdown',
                },
            },
            uiDescriptorsById: {
                'p1.settings': {
                    id: 'p1.settings',
                    pluginId: 'p1',
                    surface: 'settings',
                    title: 'Setup',
                    description: 'Configure P1',
                    fields: [
                        {
                            id: 'enabled',
                            kind: 'boolean',
                            title: 'Enabled',
                            options: [],
                        },
                    ],
                },
            },
        };

        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);
        expect(adapted.mergedProviderProjectionById?.p1).toEqual(expect.objectContaining({
            providerId: 'p1',
            title: 'P1',
            subtitle: 'sub',
            channel: 'plugin',
            settingsBackendId: 'b1',
            providerAgentId: 'claude',
            iconAgentId: 'codex',
        }));
        expect(adapted.mergedBackendProjectionById?.b1).toEqual(expect.objectContaining({
            backendId: 'b1',
            providerId: 'p1',
            providerAgentId: 'claude',
            iconAgentId: 'codex',
        }));
        expect(adapted.pluginProjectionById?.p1).toEqual(expect.objectContaining({
            pluginId: 'p1',
            generation: null,
            generationLabel: 'registry:plugin-provider|ui:p1.settings',
            actions: [
                expect.objectContaining({
                    id: 'p1.refresh',
                    title: 'Refresh P1',
                    surfaces: ['settings'],
                }),
            ],
            resources: [
                expect.objectContaining({
                    id: 'p1.prompt',
                    resourceKind: 'prompt',
                    path: 'resources/prompt.md',
                }),
            ],
            settingsSections: [
                expect.objectContaining({
                    id: 'p1.settings',
                    fields: [
                        expect.objectContaining({
                            key: 'enabled',
                            kind: 'boolean',
                        }),
                    ],
                }),
            ],
        }));
    });

    it('adapts extension projection v2 plugin descriptors and registry metadata', () => {
        const projection: ExtensionProjectionV2 = {
            v: 2,
            generation: 42,
            installedPackagesById: {
                'acme.review': {
                    id: 'acme.review',
                    displayName: 'Acme Review',
                    version: '1.2.3',
                    enabled: true,
                    source: {
                        kind: 'path',
                        locator: '/plugins/acme-review',
                    },
                    digest: 'sha256:manifest',
                },
            },
            providersById: {},
            backendsById: {},
            actionsById: {
                'acme.review.refresh': {
                    id: 'acme.review.refresh',
                    pluginId: 'acme.review',
                    title: 'Refresh Acme',
                    description: 'Refresh Acme resources',
                    scopes: ['settings'],
                    surfaces: ['settings'],
                    placement: 'detailsPanel',
                    dangerLevel: 'safe',
                    available: true,
                },
            },
            hooksById: {},
            toolsById: {},
            commandsById: {},
            resourcesById: {
                'acme.review.prompt': {
                    id: 'acme.review.prompt',
                    pluginId: 'acme.review',
                    resourceKind: 'prompt',
                    path: 'resources/review.md',
                    digest: 'sha256:prompt',
                    contentType: 'text/markdown',
                },
            },
            uiDescriptorsById: {
                'acme.review.settings': {
                    id: 'acme.review.settings',
                    pluginId: 'acme.review',
                    surface: 'settings',
                    title: 'Setup',
                    description: 'Configure review hooks',
                    fields: [
                        {
                            id: 'enabled',
                            type: 'boolean',
                            title: 'Enable review hooks',
                            options: [],
                        },
                        {
                            id: 'mode',
                            type: 'select',
                            title: 'Mode',
                            options: [
                                { value: 'safe', label: 'Safe' },
                            ],
                        },
                    ],
                },
                'acme.review.setup': {
                    id: 'acme.review.setup',
                    pluginId: 'acme.review',
                    surface: 'setup',
                    title: 'Setup Flow',
                    description: 'Initial setup',
                    fields: [
                        {
                            id: 'connect',
                            type: 'action',
                            title: 'Connect account',
                            options: [],
                        },
                    ],
                },
                'acme.review.provider-settings': {
                    id: 'acme.review.provider-settings',
                    pluginId: 'acme.review',
                    surface: 'providerSettings',
                    title: 'Provider Settings',
                    fields: [
                        {
                            id: 'providerSecret',
                            type: 'secret',
                            title: 'Provider token',
                            options: [],
                        },
                    ],
                },
                'acme.review.backend-settings': {
                    id: 'acme.review.backend-settings',
                    pluginId: 'acme.review',
                    surface: 'backendSettings',
                    title: 'Backend Settings',
                    fields: [
                        {
                            id: 'parallelism',
                            type: 'number',
                            title: 'Parallelism',
                            options: [],
                        },
                    ],
                },
                'acme.review.status': {
                    id: 'acme.review.status',
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
                    severity: 'warning',
                    code: 'registry.warning',
                    message: 'Registry rebuilt with warnings',
                },
                {
                    severity: 'info',
                    code: 'plugin.activated',
                    message: 'Activation completed',
                    pluginId: 'acme.review',
                },
            ],
        };

        const adapted = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);

        expect(adapted.pluginProjectionById?.['acme.review']).toEqual(expect.objectContaining({
            pluginId: 'acme.review',
            title: 'Acme Review',
            version: '1.2.3',
            enabled: true,
            generation: 42,
            generationLabel: '42',
            provenance: expect.objectContaining({
                sourceKind: 'path',
                sourceLabel: '/plugins/acme-review',
                manifestDigest: 'sha256:manifest',
            }),
            diagnostics: [
                { code: 'plugin.activated', message: 'Activation completed', severity: 'info' },
            ],
            actions: [
                expect.objectContaining({
                    id: 'acme.review.refresh',
                    title: 'Refresh Acme',
                }),
            ],
            resources: [
                expect.objectContaining({
                    id: 'acme.review.prompt',
                    resourceKind: 'prompt',
                    path: 'resources/review.md',
                }),
            ],
        }));
        expect(adapted.pluginProjectionById?.['acme.review']?.settingsSections).toEqual([
            expect.objectContaining({
                id: 'acme.review.settings',
                title: 'Setup',
                fields: [
                    expect.objectContaining({ key: 'enabled', kind: 'boolean' }),
                    expect.objectContaining({
                        key: 'mode',
                        kind: 'enum',
                        enumOptions: [{ id: 'safe', title: 'Safe' }],
                    }),
                ],
            }),
        ]);
        expect(adapted.pluginProjectionById?.['acme.review']?.setupSections).toEqual([
            expect.objectContaining({
                id: 'acme.review.setup',
                fields: [
                    expect.objectContaining({ key: 'connect', kind: 'action' }),
                ],
            }),
        ]);
        expect(adapted.pluginProjectionById?.['acme.review']?.providerSettingsSections).toEqual([
            expect.objectContaining({
                id: 'acme.review.provider-settings',
                fields: [
                    expect.objectContaining({ key: 'providerSecret', kind: 'secret' }),
                ],
            }),
        ]);
        expect(adapted.pluginProjectionById?.['acme.review']?.backendSettingsSections).toEqual([
            expect.objectContaining({
                id: 'acme.review.backend-settings',
                fields: [
                    expect.objectContaining({ key: 'parallelism', kind: 'number' }),
                ],
            }),
        ]);
        expect(adapted.pluginProjectionById?.['acme.review']?.statusSections).toHaveLength(1);
        expect(adapted.registryDiagnostics).toEqual([
            { code: 'registry.warning', message: 'Registry rebuilt with warnings', severity: 'warning' },
        ]);
    });

});
