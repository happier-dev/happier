import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FeatureDecision, FeatureId } from '@happier-dev/protocol';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useFeatureDecisionMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: FeatureId) => useFeatureDecisionMock(featureId),
}));

installSettingsViewCommonModuleMocks();

function createEnabledDecision(featureId: FeatureId): FeatureDecision {
    return {
        featureId,
        state: 'enabled',
        blockedBy: null,
        blockerCode: 'none',
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
    it('does not render provider configuration before decisions resolve', async () => {
        useFeatureDecisionMock.mockReturnValue(null);
        const { ChannelBridgesSettingsView } = await import('./ChannelBridgesSettingsView');
        const screen = await renderScreen(React.createElement(ChannelBridgesSettingsView));

        expect(screen.getTextContent()).not.toContain('happier bridge telegram set');
    });

    it('renders provider configuration when channel bridges and Telegram are enabled', async () => {
        useFeatureDecisionMock.mockImplementation((featureId: FeatureId) => {
            if (featureId === 'channelBridges') return createEnabledDecision(featureId);
            if (featureId === 'channelBridges.telegram') return createEnabledDecision(featureId);
            return null;
        });
        const { ChannelBridgesSettingsView } = await import('./ChannelBridgesSettingsView');
        const screen = await renderScreen(React.createElement(ChannelBridgesSettingsView));

        expect(screen.getTextContent()).toContain('happier bridge telegram set');
    });
});
