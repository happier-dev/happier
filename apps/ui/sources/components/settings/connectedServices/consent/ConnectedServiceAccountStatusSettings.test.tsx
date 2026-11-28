import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import type { Settings } from '@/sync/domains/settings/settings';

import { ConnectedServiceAccountStatusSettings } from './ConnectedServiceAccountStatusSettings';

// The sync singleton pushes account settings to the server (system boundary); apply the delta locally.
vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({
        applySettings: (delta: Partial<Settings>) => {
            storage.setState((state) => ({ ...state, settings: { ...state.settings, ...delta } }));
        },
    }),
}));

const openExternalUrl = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl }));

describe('ConnectedServiceAccountStatusSettings', () => {
    const previousState = storage.getState();
    afterEach(() => {
        storage.setState(previousState, true);
        standardCleanup();
    });

    it('offers an off-by-default toggle that shows the provider notice once when turned on', async () => {
        const screen = await renderScreen(<ConnectedServiceAccountStatusSettings agentId="agy" />);
        const toggleId = 'settings-provider-account-status:agy';
        expect(screen.tree.findByTestId(toggleId)).toBeTruthy();
        expect(screen.tree.findByTestId('connected-services-consent-notice:antigravity')).toBeNull();

        await act(async () => { screen.tree.findByTestId(`${toggleId}:switch`)!.props.onValueChange(true); });
        expect(storage.getState().settings.connectedServicesAccountStatusByAgentIdV1).toEqual({ agy: true });
        expect(screen.tree.findByTestId('connected-services-consent-notice:antigravity')).toBeTruthy();

        await act(async () => { screen.tree.pressByTestId('connected-services-consent-notice:antigravity:learn-more'); });
        expect(openExternalUrl).toHaveBeenCalledWith('https://antigravity.google/docs/faq');

        await act(async () => { screen.tree.pressByTestId('connected-services-consent-notice:antigravity:dismiss'); });
        expect(screen.tree.findByTestId('connected-services-consent-notice:antigravity')).toBeNull();
    });

    it('renders nothing for an agent without consent-gated account reads', async () => {
        const screen = await renderScreen(<ConnectedServiceAccountStatusSettings agentId="codex" />);
        expect(screen.tree.findByTestId('settings-provider-account-status:codex')).toBeNull();
    });
});
