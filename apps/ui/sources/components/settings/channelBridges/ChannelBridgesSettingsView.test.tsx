import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FeatureAxis, FeatureBlockerCode, FeatureDecision, FeatureId, FeatureState } from '@happier-dev/protocol';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useFeatureDecisionMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: FeatureId) => useFeatureDecisionMock(featureId),
}));

installSettingsViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key) => key,
        });
    },
});

function createDecision(params: Readonly<{
    featureId: FeatureId;
    state: FeatureState;
    blockedBy: FeatureAxis | null;
    blockerCode: FeatureBlockerCode;
}>): FeatureDecision {
    return {
        featureId: params.featureId,
        state: params.state,
        blockedBy: params.blockedBy,
        blockerCode: params.blockerCode,
        diagnostics: [],
        evaluatedAt: 0,
        scope: { scopeKind: 'runtime' },
    };
}

afterEach(() => {
    standardCleanup();
    useFeatureDecisionMock.mockReset();
});

describe('ChannelBridgesSettingsView', () => {
    it('shows a loading state before decisions resolve', async () => {
        useFeatureDecisionMock.mockReturnValue(null);
        const { ChannelBridgesSettingsView } = await import('./ChannelBridgesSettingsView');
        const screen = await renderScreen(React.createElement(ChannelBridgesSettingsView));

        expect(screen.findByTestId('settings-channel-bridges-loading')).toBeTruthy();
        expect(screen.findByTestId('settings-channel-bridges-telegram-config')).toBeNull();
        expect(screen.findByTestId('settings-channel-bridges-enable-in-features')).toBeNull();
    });

    it('shows unsupported state when server does not support channel bridges', async () => {
        useFeatureDecisionMock.mockImplementation((featureId: FeatureId) => {
            if (featureId === 'channelBridges') {
                return createDecision({
                    featureId,
                    state: 'unsupported',
                    blockedBy: 'server',
                    blockerCode: 'not_implemented',
                });
            }
            if (featureId === 'channelBridges.telegram') {
                return createDecision({
                    featureId,
                    state: 'unsupported',
                    blockedBy: 'server',
                    blockerCode: 'not_implemented',
                });
            }
            return null;
        });
        const { ChannelBridgesSettingsView } = await import('./ChannelBridgesSettingsView');
        const screen = await renderScreen(React.createElement(ChannelBridgesSettingsView));

        expect(screen.findByTestId('settings-channel-bridges-unsupported')).toBeTruthy();
        expect(screen.findByTestId('settings-channel-bridges-telegram-config')).toBeNull();
        expect(screen.findByTestId('settings-channel-bridges-enable-in-features')).toBeNull();
    });

    it('shows enablement call-to-action when blocked by local policy', async () => {
        useFeatureDecisionMock.mockImplementation((featureId: FeatureId) => {
            if (featureId === 'channelBridges') {
                return createDecision({
                    featureId,
                    state: 'disabled',
                    blockedBy: 'local_policy',
                    blockerCode: 'flag_disabled',
                });
            }
            if (featureId === 'channelBridges.telegram') {
                return createDecision({
                    featureId,
                    state: 'disabled',
                    blockedBy: 'dependency',
                    blockerCode: 'dependency_disabled',
                });
            }
            return null;
        });
        const { ChannelBridgesSettingsView } = await import('./ChannelBridgesSettingsView');
        const screen = await renderScreen(React.createElement(ChannelBridgesSettingsView));

        expect(screen.findByTestId('settings-channel-bridges-enable-in-features')).toBeTruthy();
        expect(screen.findByTestId('settings-channel-bridges-telegram-config')).toBeNull();
    });

    it('does not render provider configuration when telegram is disabled', async () => {
        useFeatureDecisionMock.mockImplementation((featureId: FeatureId) => {
            if (featureId === 'channelBridges') {
                return createDecision({
                    featureId,
                    state: 'enabled',
                    blockedBy: null,
                    blockerCode: 'none',
                });
            }
            if (featureId === 'channelBridges.telegram') {
                return createDecision({
                    featureId,
                    state: 'disabled',
                    blockedBy: 'server',
                    blockerCode: 'feature_disabled',
                });
            }
            return null;
        });
        const { ChannelBridgesSettingsView } = await import('./ChannelBridgesSettingsView');
        const screen = await renderScreen(React.createElement(ChannelBridgesSettingsView));

        expect(screen.findByTestId('settings-channel-bridges-telegram-config')).toBeNull();
    });

    it('renders provider configuration when channel bridges and Telegram are enabled', async () => {
        useFeatureDecisionMock.mockImplementation((featureId: FeatureId) => {
            if (featureId === 'channelBridges') {
                return createDecision({
                    featureId,
                    state: 'enabled',
                    blockedBy: null,
                    blockerCode: 'none',
                });
            }
            if (featureId === 'channelBridges.telegram') {
                return createDecision({
                    featureId,
                    state: 'enabled',
                    blockedBy: null,
                    blockerCode: 'none',
                });
            }
            return null;
        });
        const { ChannelBridgesSettingsView } = await import('./ChannelBridgesSettingsView');
        const screen = await renderScreen(React.createElement(ChannelBridgesSettingsView));

        expect(screen.findByTestId('settings-channel-bridges-telegram-config')).toBeTruthy();
    });
});
