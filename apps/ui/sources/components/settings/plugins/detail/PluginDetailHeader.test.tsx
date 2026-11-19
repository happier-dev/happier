import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

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
                    'common.enabled': 'Enabled',
                    'common.unavailable': 'Unavailable',
                    'settingsPlugins.trustPolicy.localTrusted': 'Locally trusted',
                    'settingsPlugins.trustPolicy.trusted': 'Trusted',
                    'settingsPlugins.trustPolicy.prompt': 'Approval required',
                    'settingsPlugins.sourceKind.marketplace': 'Marketplace',
                    'settingsPlugins.sourceKind.path': 'Local path',
                    'settingsPlugins.gitInstall.mode': 'Git repository',
                    'settingsPlugins.gitInstall.notImported': 'Not imported',
                    'settingsPlugins.gitInstall.omittedHooks': '1 hook',
                };
                if (key === 'settingsPlugins.unknownValue') {
                    return `Other: ${String(params?.value ?? '')}`;
                }
                return translations[key] ?? key;
            },
        });
    },
});

function installed(source: InstalledPluginEntry['source'], overrides: Partial<InstalledPluginEntry> = {}): InstalledPluginEntry {
    return {
        pluginId: 'acme.tools',
        title: 'Acme tools',
        description: null,
        version: '1.0.0',
        enabled: true,
        source,
        install: { mode: 'linked', manifestVersion: '1' },
        compatibility: { status: 'compatible', diagnostics: [] },
        diagnostics: [],
        ...overrides,
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

async function renderHeader(props: Readonly<{
    installed: InstalledPluginEntry;
    projection?: PluginProjectionEntry | null;
    enabled?: Parameters<typeof import('./PluginDetailHeader')['PluginDetailHeader']>[0]['enabled'];
    menuActions?: Parameters<typeof import('./PluginDetailHeader')['PluginDetailHeader']>[0]['menuActions'];
}>) {
    const { PluginDetailHeader } = await import('./PluginDetailHeader');
    return renderScreen(
        <PluginDetailHeader
            pluginId={props.installed.pluginId}
            installed={props.installed}
            projection={props.projection ?? null}
            enabled={props.enabled}
            menuActions={props.menuActions}
        />,
    );
}

describe('PluginDetailHeader', () => {
    it('exposes the plugin identity as one navigable heading with its id among the facts', async () => {
        const screen = await renderHeader({
            installed: installed({ kind: 'localPath', locator: '/plugins/acme.tools', trustPolicy: 'trusted' }, { description: 'Example plugin' }),
        });

        expect(screen.findAll((node) => (node.type as unknown) === 'Text' && node.props.accessibilityRole === 'header'))
            .toHaveLength(1);
        expect(screen.getTextContent()).toContain('acme.tools');
        expect(screen.getTextContent()).toContain('Example plugin');
    });

    it('renders known trust and source identifiers as translated facts', async () => {
        const screen = await renderHeader({
            installed: installed({ kind: 'path', locator: '/plugins/acme.tools', trustPolicy: 'local_trusted' }),
            projection: projection({ sourceKind: 'path', sourceLabel: null, trustPolicy: 'local_trusted' }),
        });

        const content = screen.getTextContent();
        expect(content).toContain('Locally trusted');
        expect(content).toContain('Local path');
        expect(content).not.toContain('local_trusted');
    });

    it('shows the resolved Git commit and omitted content on the installed plugin', async () => {
        const commit = 'a'.repeat(40);
        const screen = await renderHeader({ installed: installed({ kind: 'git', locator: 'https://github.com/acme/tools',
            resolvedCommit: commit, notImported: { hooks: 1, commands: 0, agents: 0, mcpServers: 0 } }) });

        const content = screen.getTextContent();
        expect(content).toContain('Git repository');
        expect(content).toContain(commit);
        expect(content).toContain('Not imported · 1 hook');
    });

    it('labels novel projection identifiers as other while preserving their diagnostic value', async () => {
        const screen = await renderHeader({
            installed: installed({ kind: 'custom_repo', locator: 'acme://tools', trustPolicy: 'vendor_attested' }),
            projection: projection({ sourceKind: 'custom_repo', sourceLabel: null, trustPolicy: 'vendor_attested' }),
        });

        const content = screen.getTextContent();
        expect(content).toContain('Other: vendor_attested');
        expect(content).toContain('Other: custom_repo');
    });

    it('does not expose the host generation as a user fact', async () => {
        const screen = await renderHeader({
            installed: installed({ kind: 'path', locator: '/plugins/acme.tools', trustPolicy: 'local_trusted' }),
            projection: {
                ...projection({ sourceKind: 'path', sourceLabel: null, trustPolicy: 'local_trusted' }),
                generation: 27,
                generationLabel: 'internal-generation-27',
            },
        });

        expect(screen.getTextContent()).not.toContain('internal-generation-27');
    });

    it('presents the installed trust grant instead of the source future-admission policy', async () => {
        const entry = installed({ kind: 'marketplace', locator: '@acme/tools', trustPolicy: 'prompt' });
        const screen = await renderHeader({
            installed: {
                ...entry,
                install: {
                    ...entry.install,
                    trust: {
                        pluginId: entry.pluginId,
                        distribution: { kind: 'npm', registryOrigin: 'https://registry.npmjs.org', packageName: '@acme/tools' },
                        state: 'trusted',
                        approvedAtMs: 1,
                    },
                },
            },
            projection: projection({ sourceKind: 'marketplace', sourceLabel: 'Community npm', trustPolicy: 'prompt' }),
        });

        expect(screen.getTextContent()).toContain('Trusted');
        expect(screen.getTextContent()).toContain('Community npm');
        expect(screen.getTextContent()).not.toContain('Approval required');
    });

    it('turns the plugin off from the header switch and keeps rare operations behind the menu', async () => {
        const onToggle = vi.fn();
        const onUpdate = vi.fn();
        const screen = await renderHeader({
            installed: installed({ kind: 'npm', locator: '@acme/tools', trustPolicy: 'trusted' }),
            enabled: { value: true, disabled: false, testID: 'settings.plugins.detail.acme.tools.action.disable', onChange: onToggle },
            menuActions: [{ id: 'update', title: 'Update', onSelect: onUpdate }],
        });

        const toggle = screen.findByTestId('settings.plugins.detail.acme.tools.action.disable');
        expect(toggle?.props.value).toBe(true);
        (toggle?.props.onValueChange as (next: boolean) => void)(false);
        expect(onToggle).toHaveBeenCalledTimes(1);

        const menu = screen.findAll((node) => node.props?.testID === 'settings.plugins.detail.acme.tools.menu'
            && Array.isArray(node.props.items))[0];
        expect(menu?.props.items.map((item: { id: string }) => item.id)).toEqual(['update']);
        await (menu?.props.onSelect as (id: string) => unknown)('update');
        expect(onUpdate).toHaveBeenCalledTimes(1);
    });
    it('shows the runtime status the plugin reports together with its detail', async () => {
        const screen = await renderHeader({
            installed: installed({ kind: 'npm', locator: '@acme/tools', trustPolicy: 'trusted' }),
            projection: {
                ...projection({ sourceKind: 'package', sourceLabel: null, trustPolicy: 'trusted' }),
                status: { label: 'Degraded', detail: 'Sync paused: token expired', tone: 'warning' },
            },
        });
        expect(screen.getTextContent()).toContain('Degraded');
        expect(screen.getTextContent()).toContain('Sync paused: token expired');
    });
});
