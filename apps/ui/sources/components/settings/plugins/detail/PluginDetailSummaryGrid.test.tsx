import * as React from 'react';
import { describe, expect, it } from 'vitest';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { renderScreen } from '@/dev/testkit';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
import type { InstalledPluginEntry } from '../model/pluginMarketplaceModel';

installSettingsViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key, params) => {
                const translations: Readonly<Record<string, string>> = {
                    'common.details': 'Details',
                    'common.enabled': 'Enabled',
                    'common.version': 'Version',
                    'common.unavailable': 'Unavailable',
                    'settingsPlugins.trustPolicy.localTrusted': 'Locally trusted',
                    'settingsPlugins.sourceKind.path': 'Local path',
                };
                if (key === 'settingsPlugins.unknownValue') {
                    return `Other: ${String(params?.value ?? '')}`;
                }
                return translations[key] ?? key;
            },
        });
    },
});

function installed(source: InstalledPluginEntry['source']): InstalledPluginEntry {
    return {
        pluginId: 'acme.tools',
        title: 'Acme tools',
        description: null,
        version: '1.0.0',
        enabled: true,
        source,
        install: {
            mode: 'linked',
            manifestVersion: '1',
        },
        compatibility: {
            status: 'compatible',
            diagnostics: [],
        },
        diagnostics: [],
    };
}

function projection(provenance: NonNullable<PluginProjectionEntry['provenance']>): PluginProjectionEntry {
    return {
        pluginId: 'acme.tools',
        title: 'Acme tools',
        description: null,
        version: '1.0.0',
        enabled: true,
        generation: 1,
        generationLabel: null,
        status: null,
        provenance,
        diagnostics: [],
        actions: [],
        resources: [],
        editableSettingsGroups: [],
    };
}

describe('PluginDetailSummaryGrid', () => {
    it('renders known trust and source identifiers as translated user-facing statuses', async () => {
        const { PluginDetailSummaryGrid } = await import('./PluginDetailSummaryGrid');
        const screen = await renderScreen(
            <PluginDetailSummaryGrid
                installed={installed({
                    kind: 'path',
                    locator: '/plugins/acme.tools',
                    trustPolicy: 'local_trusted',
                })}
                projection={projection({
                    sourceKind: 'path',
                    sourceLabel: null,
                    trustPolicy: 'local_trusted',
                    manifestDigest: null,
                })}
            />,
        );

        const content = screen.getTextContent();
        expect(content).toContain('Locally trusted');
        expect(content).toContain('Local path');
        expect(content).not.toContain('local_trusted');
    });

    it('labels novel projection identifiers as other while preserving their diagnostic value', async () => {
        const { PluginDetailSummaryGrid } = await import('./PluginDetailSummaryGrid');
        const screen = await renderScreen(
            <PluginDetailSummaryGrid
                installed={installed({
                    kind: 'custom_repo',
                    locator: 'acme://tools',
                    trustPolicy: 'vendor_attested',
                })}
                projection={projection({
                    sourceKind: 'custom_repo',
                    sourceLabel: null,
                    trustPolicy: 'vendor_attested',
                    manifestDigest: null,
                })}
            />,
        );

        const content = screen.getTextContent();
        expect(content).toContain('Other: vendor_attested');
        expect(content).toContain('Other: custom_repo');
    });

    it('does not expose the host generation as a user workflow concept', async () => {
        const { PluginDetailSummaryGrid } = await import('./PluginDetailSummaryGrid');
        const currentProjection = {
            ...projection({
                sourceKind: 'path',
                sourceLabel: null,
                trustPolicy: 'local_trusted',
                manifestDigest: null,
            }),
            generation: 27,
            generationLabel: 'internal-generation-27',
        };
        const screen = await renderScreen(
            <PluginDetailSummaryGrid
                installed={installed({
                    kind: 'path',
                    locator: '/plugins/acme.tools',
                    trustPolicy: 'local_trusted',
                })}
                projection={currentProjection}
            />,
        );

        expect(screen.getTextContent()).not.toContain('internal-generation-27');
        expect(screen.getTextContent()).not.toContain('settingsPlugins.generationLabel');
    });
});
