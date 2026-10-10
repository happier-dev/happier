import * as React from 'react';
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { measureMountedCollections, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import type { InstalledPluginEntry } from './model/pluginMarketplaceModel';
import type { PluginsCollectionState } from './model/pluginsCollectionState';

installSettingsViewCommonModuleMocks();
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());

function installed(pluginId: string, overrides: Partial<InstalledPluginEntry> = {}): InstalledPluginEntry {
    return {
        pluginId, title: pluginId, description: 'Does a thing', version: '1.0.0', enabled: true,
        source: { kind: 'npm', locator: `@acme/${pluginId}` }, install: { mode: 'copy', manifestVersion: '1.0.0' },
        compatibility: { status: 'compatible', diagnostics: [] }, diagnostics: [],
        ...overrides,
    };
}

async function renderInstalled(params: Readonly<{
    collectionState: PluginsCollectionState;
    plugins?: readonly InstalledPluginEntry[];
    presentation?: 'grid' | 'list';
    searchText?: string;
    filtering?: boolean;
    onClearSearch?: () => void;
    onRetry?: () => void;
    onNavigateToPlugin?: (pluginId: string) => void;
    onRunAction?: (action: 'enable' | 'disable', pluginId: string) => void;
    machineCoverageByPluginId?: Readonly<Record<string, string>>;
    projectionByPluginId?: Readonly<Record<string, Readonly<{ iconAgentId?: string | null; contributionKinds?: readonly string[] }>>>;
}>) {
    const { InstalledPluginsSection } = await import('./PluginMarketplaceSections');
    const { ListPresentationProvider } = await import('@/components/ui/lists/listPresentation');
    // The Installed collection always renders inside the Plugins page, where sections carry their actions. It is
    // one Collection, which lays its grid out at the width it measured, as the page does on its first layout.
    const screen = await renderScreen(<ListPresentationProvider value="page"><InstalledPluginsSection
        collectionState={params.collectionState}
        installedPlugins={params.plugins ?? []}
        presentation={params.presentation ?? 'grid'}
        searchText={params.searchText ?? ''}
        filtering={params.filtering ?? false}
        machineCoverageByPluginId={params.machineCoverageByPluginId}
        projectionByPluginId={params.projectionByPluginId as never}
        onClearSearch={params.onClearSearch ?? (() => {})}
        onRetry={params.onRetry ?? (() => {})}
        onDiscover={() => {}}
        canRunActions
        isPluginActionInFlight={() => false}
        onNavigateToPlugin={params.onNavigateToPlugin ?? (() => {})}
        onRunAction={(action, pluginId) => params.onRunAction?.(action as 'enable' | 'disable', pluginId)}
    /></ListPresentationProvider>);
    await measureMountedCollections(screen);
    return screen;
}

describe('Installed plugins collection', () => {
    afterEach(standardCleanup);

    it('keeps the switch in the card footer and opens the plugin from the card body', async () => {
        const onNavigateToPlugin = vi.fn();
        const onRunAction = vi.fn();
        const screen = await renderInstalled({ collectionState: 'ready', plugins: [installed('alpha')], onNavigateToPlugin, onRunAction });
        await screen.pressByTestIdAsync('settings.plugins.marketplace.installed.alpha');
        expect(onNavigateToPlugin).toHaveBeenCalledWith('alpha');
        const toggle = screen.findByTestId('settings.plugins.marketplace.installed.alpha.action.disable');
        expect(toggle?.props.disabled).toBe(false);
        // The grid has one footer control, not a second copy in the body accessory slot.
        const { Switch } = await import('@/components/ui/forms/Switch');
        expect(screen.root.findAll((node) => node.type === Switch
            && node.props.testID === 'settings.plugins.marketplace.installed.alpha.action.disable')).toHaveLength(1);
        expect(onRunAction).not.toHaveBeenCalled();
    });

    it('puts Review where the switch was for a plugin that needs a decision', async () => {
        const screen = await renderInstalled({
            collectionState: 'ready',
            plugins: [installed('broken', { diagnostics: [{ code: 'x', message: 'Needs a repository to watch' }] })],
        });
        expect(screen.findByTestId('settings.plugins.marketplace.installed.broken.fix')).not.toBeNull();
        expect(screen.findByTestId('settings.plugins.marketplace.installed.broken.action.disable')).toBeNull();
        expect(screen.getTextContent()).toContain('Needs a repository to watch');
    });

    it('keeps last-known plugins while the machine is offline, with every control off', async () => {
        const screen = await renderInstalled({ collectionState: 'offline', plugins: [installed('alpha')] });
        expect(screen.getTextContent()).toContain('settingsPlugins.surfaces.lastKnown');
        expect(screen.findByTestId('settings.plugins.marketplace.installed.alpha.action.disable')?.props.disabled).toBe(true);
    });

    it('says the read failed and offers Retry instead of loading forever', async () => {
        const onRetry = vi.fn();
        const screen = await renderInstalled({ collectionState: 'readFailed', onRetry });
        expect(screen.findByTestId('settings.plugins.marketplace.installed.loading')).toBeNull();
        await screen.pressByTestIdAsync('settings.plugins.marketplace.installed.readFailed-action');
        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('names the absence of retained details when an offline machine has no snapshot', async () => {
        const screen = await renderInstalled({ collectionState: 'offline', presentation: 'list' });
        expect(screen.findByTestId('settings.plugins.marketplace.installed.noSnapshot')).not.toBeNull();
        expect(screen.findByTestId('settings.plugins.marketplace.installed.empty')).toBeNull();
        expect(screen.findByTestId('settings.plugins.marketplace.installed.loading')).toBeNull();
        const retained = await renderInstalled({ collectionState: 'offline', presentation: 'list', plugins: [installed('alpha')] });
        expect(retained.findByTestId('settings.plugins.marketplace.installed.noSnapshot')).toBeNull();
    });

    it('answers a search that hid every plugin inline, naming it, with Clear', async () => {
        const onClearSearch = vi.fn();
        const screen = await renderInstalled({ collectionState: 'noMatch', searchText: 'jira', onClearSearch });
        expect(screen.getTextContent()).toContain('settingsPlugins.surfaces.noMatch');
        expect(screen.getTextContent()).not.toContain('settingsPlugins.surfaces.emptyTitle');
        await screen.pressByTestIdAsync('settings.plugins.marketplace.installed.clearSearch');
        expect(onClearSearch).toHaveBeenCalledTimes(1);
    });

    it('lists the same plugins as rows with the same targets', async () => {
        const onNavigateToPlugin = vi.fn();
        const screen = await renderInstalled({ collectionState: 'ready', presentation: 'list', plugins: [installed('alpha')], onNavigateToPlugin });
        await screen.pressByTestIdAsync('settings.plugins.marketplace.installed.alpha');
        expect(onNavigateToPlugin).toHaveBeenCalledWith('alpha');
        expect(screen.findByTestId('settings.plugins.marketplace.installed.alpha.action.disable')).not.toBeNull();
    });

    it('lists what ships with Happier as its own section below the plugins the user added', async () => {
        const bundled = (pluginId: string) => installed(pluginId, { version: '0.0.0', source: { kind: 'bundled', locator: pluginId } });
        const screen = await renderInstalled({ collectionState: 'ready', plugins: [installed('mine'), bundled('claude'), bundled('codex')] });
        expect(screen.findByTestId('settings.plugins.marketplace.installed.mine')).not.toBeNull();
        expect(screen.findByTestId('settings.plugins.marketplace.installed.claude')).not.toBeNull();
        expect(screen.findByTestId('settings.plugins.marketplace.installed.codex')).not.toBeNull();
        expect(screen.findByTestId('settings.plugins.marketplace.installed.included.toggle')).toBeNull();
        expect(screen.getTextContent()).not.toContain('0.0.0');
    });

    it('shows included plugins as cards in the grid, each with where it runs unless it needs attention', async () => {
        const bundled = (pluginId: string, overrides: Partial<InstalledPluginEntry> = {}) => installed(pluginId, {
            source: { kind: 'bundled', locator: pluginId }, ...overrides,
        });
        const screen = await renderInstalled({
            collectionState: 'ready',
            presentation: 'grid',
            plugins: [bundled('claude'), bundled('codex', { enabled: false })],
            machineCoverageByPluginId: { claude: 'On 3 machines', codex: 'On 2 machines' },
        });
        const cards = [...new Set(screen.root.findAll((node) => typeof node.props.testID === 'string'
            && node.props.testID.endsWith(':card')).map((card) => card.props.testID as string))];
        expect(cards).toEqual([
            'settings.plugins.marketplace.installed.claude:card',
            'settings.plugins.marketplace.installed.codex:card',
        ]);
        const text = screen.getTextContent();
        expect(text).toContain('On 3 machines');
        // A plugin switched off on this machine says so rather than where else it runs.
        expect(text).not.toContain('On 2 machines');
    });

    it('gives every grid card its status footer without repeating its source or inventing a purpose', async () => {
        const bundled = (pluginId: string, overrides: Partial<InstalledPluginEntry> = {}) => installed(pluginId, {
            source: { kind: 'bundled', locator: pluginId }, ...overrides,
        });
        const screen = await renderInstalled({
            collectionState: 'ready',
            presentation: 'grid',
            plugins: [installed('mine'), bundled('claude', { description: null }), bundled('codex', { enabled: false })],
            machineCoverageByPluginId: { mine: 'On 3 machines' },
        });
        const { t } = await import('@/text');
        const text = screen.getTextContent();
        // The section header names the source once; its cards do not repeat it.
        expect(text.split(t('settingsPlugins.rowSource.bundled'))).toHaveLength(2);
        expect(text).toContain(t('settingsPlugins.rowStatus.enabled'));
        expect(text).toContain(t('settingsPlugins.rowStatus.disabled'));
        expect(text).toContain('On 3 machines');
        // The empty description declares the two-line slot, not invented copy.
        expect(screen.findByTestId('settings.plugins.marketplace.installed.claude:description')?.props.children).toBe('');
        expect(screen.findByTestId('settings.plugins.marketplace.installed.mine:description')).not.toBeNull();
    });

    it('keeps the card anatomy when none has a purpose yet, while healthy list rows stay quiet', async () => {
        const bundled = installed('quiet', { description: null, source: { kind: 'bundled', locator: 'quiet' } });
        const described = await renderInstalled({ collectionState: 'ready', plugins: [{ ...bundled, description: 'Does a thing' }] });
        const undescribed = await renderInstalled({ collectionState: 'ready', plugins: [bundled] });
        const height = (screen: Awaited<ReturnType<typeof renderInstalled>>) => StyleSheet.flatten(
            screen.findByTestId('settings.plugins.marketplace.installed.quiet:card')?.props.style,
        ).height;
        expect(height(undescribed)).toBe(height(described));
        expect(undescribed.findByTestId('settings.plugins.marketplace.installed.quiet:description')?.props.children).toBe('');
        const { t } = await import('@/text');
        expect(undescribed.getTextContent()).toContain(t('settingsPlugins.rowStatus.enabled'));
        const list = await renderInstalled({ collectionState: 'ready', presentation: 'list', plugins: [bundled] });
        expect(list.getTextContent()).not.toContain(t('settingsPlugins.rowStatus.enabled'));
    });

    it('gives a card with no description the kind of thing the plugin adds as its second line', async () => {
        const bundled = (pluginId: string) => installed(pluginId, { description: null, source: { kind: 'bundled', locator: pluginId } });
        const screen = await renderInstalled({
            collectionState: 'ready',
            presentation: 'grid',
            plugins: [bundled('auggie'), bundled('github'), bundled('quiet')],
            projectionByPluginId: {
                auggie: { contributionKinds: ['agent'] },
                github: { contributionKinds: ['scmHostingProviders'] },
                quiet: { contributionKinds: [] },
            },
        });
        const { t } = await import('@/text');
        const description = (pluginId: string) => screen.findByTestId(`settings.plugins.marketplace.installed.${pluginId}:description`);
        expect(description('auggie')?.props.children).toBe(t('settingsPlugins.surfaces.kinds.agent'));
        expect(description('github')?.props.children).toBe(t('settingsPlugins.surfaces.kinds.scmHostingProviders'));
        // Nothing projected, nothing invented.
        expect(description('quiet')?.props.children).toBe('');
    });

    it('shows the included plugins, not an empty page, when only those are installed', async () => {
        const screen = await renderInstalled({
            collectionState: 'ready',
            plugins: [installed('claude', { source: { kind: 'bundled', locator: 'claude' } })],
        });
        expect(screen.findByTestId('settings.plugins.marketplace.installed.empty')).toBeNull();
        expect(screen.findByTestId('settings.plugins.marketplace.installed.claude')).not.toBeNull();
    });

    it('opens the included group while a search or filter is on, so a match is never hidden', async () => {
        const screen = await renderInstalled({
            collectionState: 'ready',
            filtering: true,
            searchText: 'cla',
            plugins: [installed('claude', { source: { kind: 'bundled', locator: 'claude' } })],
        });
        expect(screen.findByTestId('settings.plugins.marketplace.installed.claude')).not.toBeNull();
        expect(screen.findByTestId('settings.plugins.marketplace.installed.empty')).toBeNull();
    });
});
