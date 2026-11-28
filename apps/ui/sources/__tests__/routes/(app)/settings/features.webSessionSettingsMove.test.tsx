import * as React from 'react';
import { Item } from '@/components/ui/lists/Item';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    renderSettingsView as renderBaseSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import { installSessionSettingsEntryModuleMocks } from './sessionSettingsEntryTestHelpers';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsParse } from '@/sync/domains/settings/settings';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;
const initialStorage = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(initialStorage, true); });

const shared = vi.hoisted(() => ({
    useServerFeaturesMainSelectionSnapshotMock: vi.fn(),
    useEffectiveServerSelectionMock: vi.fn(),
}));

vi.mock('@/components/settings/features/FeatureDiagnosticsPanel', () => ({
    FeatureDiagnosticsPanel: () => null,
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        useServerFeaturesMainSelectionSnapshot: (...args: any[]) => shared.useServerFeaturesMainSelectionSnapshotMock(...args),
    };
});

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useEffectiveServerSelection: () => shared.useEffectiveServerSelectionMock(),
}));

async function renderSettingsView(element: React.ReactElement) {
    storage.setState({ settings: settingsParse({ experiments: false, agentInputEnterToSend: false }),
        localSettings: localSettingsParse({ commandPaletteEnabled: false, devModeEnabled: false }) });
    return renderBaseSettingsView(element);
}

beforeEach(() => {
    standardCleanup();
    installSessionSettingsEntryModuleMocks({
        reactNative: async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock(
                {
                    Text: 'Text',
                    Platform: {
                        OS: 'web',
                        select: (spec: Record<string, unknown>) => (
                            spec && Object.prototype.hasOwnProperty.call(spec, 'ios')
                                ? (spec as { ios?: unknown }).ios
                                : (spec as { default?: unknown }).default
                        ),
                    },
                }
            );
        },
    });
    shared.useEffectiveServerSelectionMock.mockReturnValue({ serverIds: [] });
    shared.useServerFeaturesMainSelectionSnapshotMock.mockReturnValue({ status: 'ready', serverIds: [], snapshotsByServerId: {} });

});

describe('FeaturesSettingsScreen (web settings moved)', () => {
    it('does not show Enter-to-send or Message history (moved to Session settings)', async () => {
        const { default: FeaturesSettingsScreen } = await import('@/app/(app)/settings/features');
        const screen = await renderSettingsView(React.createElement(FeaturesSettingsScreen));
        const titles = screen.findAllByType(Item).map((item) => item.props.title);

        expect(titles).not.toContain('settingsFeatures.enterToSend');
        expect(titles).not.toContain('settingsFeatures.historyScope');
        expect(titles).not.toContain('settingsFeatures.enhancedSessionWizard');
        expect(titles).not.toContain('settingsFeatures.commandPalette');
    });
});
