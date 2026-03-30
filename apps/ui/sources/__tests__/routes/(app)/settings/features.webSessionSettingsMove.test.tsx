import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';
import { installSessionSettingsEntryModuleMocks } from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const shared = vi.hoisted(() => ({
    useServerFeaturesMainSelectionSnapshotMock: vi.fn(),
    useEffectiveServerSelectionMock: vi.fn(),
    useSettingMutableMock: vi.fn(),
    useLocalSettingMutableMock: vi.fn(),
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

type MutableHookResult<T> = readonly [T, (next: T) => void];

function createNoopMutable<T>(value: T): MutableHookResult<T> {
    return [value, vi.fn()] as const;
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
        storageModule: async (importOriginal) => {
            const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
            return createStorageModuleMock({
                importOriginal,
                overrides: {
                    useSettingMutable: (key: string) => shared.useSettingMutableMock(key),
                    useLocalSettingMutable: (key: string) => shared.useLocalSettingMutableMock(key),
                },
            });
        },
    });
    shared.useEffectiveServerSelectionMock.mockReturnValue({ serverIds: [] });
    shared.useServerFeaturesMainSelectionSnapshotMock.mockReturnValue({ status: 'ready', serverIds: [], snapshotsByServerId: {} });

    shared.useSettingMutableMock.mockImplementation((key: string) => {
        if (key === 'experiments') return createNoopMutable(false);
        if (key === 'featureToggles') return createNoopMutable({});
        if (key === 'useProfiles') return createNoopMutable(false);
        if (key === 'agentInputEnterToSend') return createNoopMutable(false);
        if (key === 'agentInputHistoryScope') return createNoopMutable('perSession');
        if (key === 'showEnvironmentBadge') return createNoopMutable(false);
        if (key === 'useEnhancedSessionWizard') return createNoopMutable(false);
        if (key === 'useMachinePickerSearch') return createNoopMutable(false);
        if (key === 'usePathPickerSearch') return createNoopMutable(false);
        return createNoopMutable(null);
    });

    shared.useLocalSettingMutableMock.mockImplementation((key: string) => {
        if (key === 'commandPaletteEnabled') return createNoopMutable(false);
        if (key === 'devModeEnabled') return createNoopMutable(false);
        return createNoopMutable(false);
    });
});

describe('FeaturesSettingsScreen (web settings moved)', () => {
    it('does not show Enter-to-send or Message history (moved to Session settings)', async () => {
        const { default: FeaturesSettingsScreen } = await import('@/app/(app)/settings/features');
        const screen = await renderSettingsView(React.createElement(FeaturesSettingsScreen));
        const titles = screen.findAllByType('Item' as any).map((item) => item.props.title);

        expect(titles).not.toContain('settingsFeatures.enterToSend');
        expect(titles).not.toContain('settingsFeatures.historyScope');
    });
});
