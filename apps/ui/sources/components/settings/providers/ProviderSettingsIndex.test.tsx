import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderInCollectionLayout, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const route = vi.hoisted(() => ({ params: {} as Record<string, string> }));

installSettingsViewCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ pathname: '/settings/providers', params: () => route.params }).module;
    },
    storage: () => vi.importActual<typeof import('@/sync/domains/state/storage')>('@/sync/domains/state/storage'),
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

describe('ProviderSettingsIndex', () => {
    afterEach(() => {
        standardCleanup();
        route.params = {};
    });

    it('keeps a searched collection control on screen instead of landing on a detail in split layout', async () => {
        route.params = { setting: 'providers.custom' };
        const { ProviderSettingsIndex } = await import('./ProviderSettingsIndex');
        const screen = await renderInCollectionLayout(<ProviderSettingsIndex />, 'split');
        expect(screen.findByTestId('settings-providers-screen')).not.toBeNull();
    });

    it('keeps the normal landing for a setting outside the Providers collection', async () => {
        route.params = { setting: 'appearance.density' };
        const { ProviderSettingsIndex } = await import('./ProviderSettingsIndex');
        const screen = await renderInCollectionLayout(<ProviderSettingsIndex />, 'split');
        expect(screen.findByTestId('settings-providers-screen')).toBeNull();
    });
});
