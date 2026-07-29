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

describe('Connected services provider-state-sharing route', () => {
    afterEach(() => {
        standardCleanup();
        resetSessionSettingsEntryState();
    });

    it('renders without consulting the retired connectedServices master feature', async () => {
        const useFeatureEnabledMock = vi.fn(() => false);
        sessionSettingsEntryState.options.featureEnabled = useFeatureEnabledMock;

        const mod = await import('@/app/(app)/settings/connected-services/provider-state-sharing');
        const ProviderStateSharingRoute = mod.default;

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(ProviderStateSharingRoute))).tree;

        expect(tree.toJSON()).not.toBeNull();
        expect(useFeatureEnabledMock).not.toHaveBeenCalled();
        expect(tree.findByType('ConnectedServicesProviderStateSharingSettingsView' as any)).toBeTruthy();
    });
});
