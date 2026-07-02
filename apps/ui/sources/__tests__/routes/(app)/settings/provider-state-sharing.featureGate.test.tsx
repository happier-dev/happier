import * as React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/settings/connectedServices/ConnectedServicesProviderStateSharingSettings', () => ({
    ConnectedServicesProviderStateSharingSettingsView: () =>
        React.createElement('ConnectedServicesProviderStateSharingSettingsView'),
}));

installSessionSettingsEntryModuleMocks({
    featureEnabled: (featureId: string) => sessionSettingsEntryState.options.featureEnabled?.(featureId) ?? false,
});

describe('Connected services provider-state-sharing route (feature gate)', () => {
    afterEach(() => {
        standardCleanup();
        resetSessionSettingsEntryState();
    });

    it('returns null when connectedServices is disabled', async () => {
        const useFeatureEnabledMock = vi.fn((featureId: string) => featureId !== 'connectedServices');
        sessionSettingsEntryState.options.featureEnabled = useFeatureEnabledMock;

        const mod = await import('@/app/(app)/settings/connected-services/provider-state-sharing');
        const ProviderStateSharingRoute = mod.default;

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(ProviderStateSharingRoute))).tree;

        expect(tree.toJSON()).toBeNull();
        expect(useFeatureEnabledMock).toHaveBeenCalledWith('connectedServices');
    });

    it('renders the provider-state-sharing settings view when connectedServices is enabled', async () => {
        const useFeatureEnabledMock = vi.fn((featureId: string) => featureId === 'connectedServices');
        sessionSettingsEntryState.options.featureEnabled = useFeatureEnabledMock;

        const mod = await import('@/app/(app)/settings/connected-services/provider-state-sharing');
        const ProviderStateSharingRoute = mod.default;

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(ProviderStateSharingRoute))).tree;

        expect(tree.toJSON()).not.toBeNull();
        expect(useFeatureEnabledMock).toHaveBeenCalledWith('connectedServices');
        expect(tree.findByType('ConnectedServicesProviderStateSharingSettingsView' as any)).toBeTruthy();
    });
});
