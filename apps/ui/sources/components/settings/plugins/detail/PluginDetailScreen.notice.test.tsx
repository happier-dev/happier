import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import type { PluginSettingsScreenState } from '../model/usePluginSettingsScreenState';

installSettingsViewCommonModuleMocks();
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
afterEach(standardCleanup);

describe('plugin detail unavailable presentation', () => {
    it('defers the adjacent pane cause to its page while a standalone page keeps Retry', async () => {
        const { PluginDetailView } = await import('./PluginDetailScreen');
        const retry = vi.fn(async () => {});
        const missing = {
            installedPluginById: new Map(),
            installedPlugins: [],
            pluginProjectionById: {},
            readOnlySnapshotNotice: { reason: 'projectionUnavailable' },
            pluginTruthSettled: true,
            refreshPluginTruth: retry,
        } satisfies Pick<PluginSettingsScreenState, 'installedPluginById' | 'installedPlugins' | 'pluginProjectionById' | 'readOnlySnapshotNotice' | 'pluginTruthSettled' | 'refreshPluginTruth'>;
        // Boundary fixture: this cold unavailable arm reads only the typed fields above.
        const state = missing as unknown as PluginSettingsScreenState;
        const view = (pageNoticeActive: boolean) => (
            <ListPresentationProvider value="page" pageNoticeActive={pageNoticeActive}>
                <PluginDetailView pluginId="example.tools" state={state} presentation={pageNoticeActive ? 'pane' : 'page'} />
            </ListPresentationProvider>
        );
        const screen = await renderScreen(view(true));
        expect(screen.findByTestId('settings.plugins.detail.readOnlySnapshot')).toBeNull();
        expect(screen.findByTestId('settings.plugins.detail.noSnapshot')).not.toBeNull();
        await screen.update(view(false));
        expect(screen.findByTestId('settings.plugins.detail.noSnapshot')).toBeNull();
        await screen.pressByTestIdAsync('settings.plugins.detail.readOnlySnapshot-retry');
        expect(retry).toHaveBeenCalledOnce();
    });
});
