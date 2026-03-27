import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createRootLayoutFeaturesResponse, renderSettingsView } from '@/dev/testkit';
import {
    installSessionSettingsEntryModuleMocks,
} from './sessionSettingsEntryTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const useServerFeaturesMainSelectionSnapshotMock = vi.fn();
const useEffectiveServerSelectionMock = vi.fn();

vi.mock('@/sync/domains/features/featureDecisionRuntime', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        useServerFeaturesMainSelectionSnapshot: (...args: any[]) => useServerFeaturesMainSelectionSnapshotMock(...args),
    };
});

vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useEffectiveServerSelection: () => useEffectiveServerSelectionMock(),
}));

type MutableHookResult<T> = readonly [T, (next: T) => void];

function createNoopMutable<T>(value: T): MutableHookResult<T> {
    return [value, vi.fn()] as const;
}

function listTitles(screen: Awaited<ReturnType<typeof renderSettingsView>>) {
    return screen.findAll((node) => typeof node.props?.title === 'string').map((node) => node.props.title as string);
}

const useSettingMutableMock = vi.fn();
const useLocalSettingMutableMock = vi.fn();

describe('FeaturesSettingsScreen gating', () => {
    beforeEach(() => {
        vi.resetModules();
        delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW;
        delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        delete process.env.EXPO_PUBLIC_HAPPIER_FEATURE_POLICY_ENV;

        installSessionSettingsEntryModuleMocks({
            reactNative: async () => {
                const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
                return createReactNativeWebMock({
                    View: 'View',
                    Text: 'Text',
                    Platform: {
                        OS: 'ios',
                        select: (spec: Record<string, unknown>) =>
                            spec && Object.prototype.hasOwnProperty.call(spec, 'ios') ? (spec as any).ios : (spec as any).default,
                    },
                });
            },
            textModule: async () => {
                const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
                return createTextModuleMock({ translate: (key) => key });
            },
            modalModule: async () => {
                const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
                return createModalModuleMock({
                    spies: {
                        confirm: vi.fn(async () => false),
                    },
                }).module;
            },
            storageModule: async (importOriginal) => {
                const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
                return createStorageModuleStub({
                    importOriginal,
                    useSettingMutable: (key: string) => useSettingMutableMock(key),
                    useLocalSettingMutable: (key: string) => useLocalSettingMutableMock(key),
                });
            },
        });

        useEffectiveServerSelectionMock.mockReturnValue({ serverIds: [] });
        useServerFeaturesMainSelectionSnapshotMock.mockReturnValue({ status: 'ready', serverIds: [], snapshotsByServerId: {} });

        useSettingMutableMock.mockImplementation((key: string) => {
            if (key === 'experiments') return createNoopMutable(true);
            if (key === 'featureToggles') return createNoopMutable({});
            if (key === 'useProfiles') return createNoopMutable(false);
            if (key === 'agentInputEnterToSend') return createNoopMutable(false);
            if (key === 'agentInputHistoryScope') return createNoopMutable('perSession');
            if (key === 'hideInactiveSessions') return createNoopMutable(false);
            if (key === 'groupInactiveSessionsByProject') return createNoopMutable(false);
            if (key === 'showEnvironmentBadge') return createNoopMutable(false);
            if (key === 'useEnhancedSessionWizard') return createNoopMutable(false);
            if (key === 'useMachinePickerSearch') return createNoopMutable(false);
            if (key === 'usePathPickerSearch') return createNoopMutable(false);
            return createNoopMutable(null);
        });

        useLocalSettingMutableMock.mockImplementation((key: string) => {
            if (key === 'commandPaletteEnabled') return createNoopMutable(false);
            if (key === 'devModeEnabled') return createNoopMutable(false);
            return createNoopMutable(false);
        });
    });

    it('hides build-policy denied feature toggles from the list', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'execution.runs,social.friends,scm.writeOperations';
        vi.resetModules();
        const { getFeatureBuildPolicyDecision } = await import('@/sync/domains/features/featureBuildPolicy');
        expect(getFeatureBuildPolicyDecision('execution.runs')).toBe('deny');

        const { default: FeaturesSettingsScreen } = await import('@/app/(app)/settings/features');

        const screen = await renderSettingsView(React.createElement(FeaturesSettingsScreen));
        const allTitles = listTitles(screen);
        const featureGroup = screen.findGroup('settingsFeatures.experiments');
        const titles = featureGroup ? featureGroup.findAllByType('Item' as any).map((i) => i.props.title) : [];

        expect(allTitles).not.toContain('settingsFeatures.hideInactiveSessions');
        expect(allTitles).not.toContain('settingsFeatures.sessionListActiveGrouping');
        expect(allTitles).not.toContain('settingsFeatures.sessionListInactiveGrouping');
        expect(titles).not.toContain('settingsFeatures.expExecutionRuns');
        expect(titles).not.toContain('settingsFeatures.expFriends');
        expect(titles).not.toContain('settingsFeatures.expScmOperations');
    });

    it('hides server-disabled toggles even when build policy allows them', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_ALLOW = 'social.friends';

        useEffectiveServerSelectionMock.mockReturnValue({ serverIds: ['server-1'] });
        useServerFeaturesMainSelectionSnapshotMock.mockReturnValue({
            status: 'ready',
            serverIds: ['server-1'],
            snapshotsByServerId: {
                'server-1': {
                    status: 'ready',
                    features: createRootLayoutFeaturesResponse({
                        features: {
                            social: { friends: { enabled: false } },
                        },
                    }),
                },
            },
        });

        const { default: FeaturesSettingsScreen } = await import('@/app/(app)/settings/features');

        const screen = await renderSettingsView(React.createElement(FeaturesSettingsScreen));
        const allTitles = listTitles(screen);
        const featureGroup = screen.findGroup('settingsFeatures.experiments');
        const titles = featureGroup ? featureGroup.findAllByType('Item' as any).map((i) => i.props.title) : [];

        expect(allTitles).not.toContain('settingsFeatures.hideInactiveSessions');
        expect(allTitles).not.toContain('settingsFeatures.sessionListActiveGrouping');
        expect(allTitles).not.toContain('settingsFeatures.sessionListInactiveGrouping');
        expect(titles).not.toContain('settingsFeatures.expFriends');
    });

    it('keeps client toggle entries visible when server snapshot lacks their enabled bit', async () => {
        useEffectiveServerSelectionMock.mockReturnValue({ serverIds: ['server-1'] });
        useServerFeaturesMainSelectionSnapshotMock.mockReturnValue({
            status: 'ready',
            serverIds: ['server-1'],
            snapshotsByServerId: {
                'server-1': {
                    status: 'ready',
                    features: createRootLayoutFeaturesResponse({
                        features: {
                            voice: { enabled: true, happierVoice: { enabled: false } },
                        },
                    }),
                },
            },
        });

        const { default: FeaturesSettingsScreen } = await import('@/app/(app)/settings/features');

        const screen = await renderSettingsView(React.createElement(FeaturesSettingsScreen));
        const voiceAgentItem = screen.findRowByTitle('settingsFeatures.expVoiceAgent');
        expect(voiceAgentItem).toBeTruthy();
    });

    it('turning off connectedServices also disables connectedServices.quotas', async () => {
        vi.resetModules();
        const setFeatureToggles = vi.fn();

        useSettingMutableMock.mockImplementation((key: string) => {
            if (key === 'experiments') return createNoopMutable(true);
            if (key === 'featureToggles') return [{ connectedServices: true, 'connectedServices.quotas': true }, setFeatureToggles] as const;
            if (key === 'useProfiles') return createNoopMutable(false);
            if (key === 'agentInputEnterToSend') return createNoopMutable(false);
            if (key === 'agentInputHistoryScope') return createNoopMutable('perSession');
            if (key === 'hideInactiveSessions') return createNoopMutable(false);
            if (key === 'groupInactiveSessionsByProject') return createNoopMutable(false);
            if (key === 'showEnvironmentBadge') return createNoopMutable(false);
            if (key === 'useEnhancedSessionWizard') return createNoopMutable(false);
            if (key === 'useMachinePickerSearch') return createNoopMutable(false);
            if (key === 'usePathPickerSearch') return createNoopMutable(false);
            return createNoopMutable(null);
        });

        const { default: FeaturesSettingsScreen } = await import('@/app/(app)/settings/features');

        const screen = await renderSettingsView(React.createElement(FeaturesSettingsScreen));
        const connectedServicesItem = screen.findRowByTitle('settingsFeatures.expConnectedServices');
        expect(connectedServicesItem).toBeTruthy();

        await act(async () => {
            connectedServicesItem!.props.rightElement.props.onValueChange(false);
        });

        expect(setFeatureToggles).toHaveBeenCalledWith(expect.objectContaining({
            connectedServices: false,
            'connectedServices.quotas': false,
        }));
    });

    it('disables the connectedServices.quotas toggle when connectedServices is disabled', async () => {
        vi.resetModules();
        const setFeatureToggles = vi.fn();

        useSettingMutableMock.mockImplementation((key: string) => {
            if (key === 'experiments') return createNoopMutable(true);
            if (key === 'featureToggles') return [{ connectedServices: false, 'connectedServices.quotas': true }, setFeatureToggles] as const;
            if (key === 'useProfiles') return createNoopMutable(false);
            if (key === 'agentInputEnterToSend') return createNoopMutable(false);
            if (key === 'agentInputHistoryScope') return createNoopMutable('perSession');
            if (key === 'hideInactiveSessions') return createNoopMutable(false);
            if (key === 'groupInactiveSessionsByProject') return createNoopMutable(false);
            if (key === 'showEnvironmentBadge') return createNoopMutable(false);
            if (key === 'useEnhancedSessionWizard') return createNoopMutable(false);
            if (key === 'useMachinePickerSearch') return createNoopMutable(false);
            if (key === 'usePathPickerSearch') return createNoopMutable(false);
            return createNoopMutable(null);
        });

        const { default: FeaturesSettingsScreen } = await import('@/app/(app)/settings/features');

        const screen = await renderSettingsView(React.createElement(FeaturesSettingsScreen));
        const quotasItem = screen.findRowByTitle('settingsFeatures.expConnectedServicesQuotas');
        expect(quotasItem).toBeTruthy();
        expect(quotasItem!.props.rightElement.props.disabled).toBe(true);
        expect(quotasItem!.props.rightElement.props.value).toBe(false);
    });

    it('shows embedded terminal dock location setting when terminal.embeddedPty is enabled', async () => {
        vi.resetModules();

        useSettingMutableMock.mockImplementation((key: string) => {
            if (key === 'experiments') return createNoopMutable(true);
            if (key === 'featureToggles') return createNoopMutable({ 'terminal.embeddedPty': true });
            if (key === 'useProfiles') return createNoopMutable(false);
            if (key === 'agentInputEnterToSend') return createNoopMutable(false);
            if (key === 'agentInputHistoryScope') return createNoopMutable('perSession');
            if (key === 'hideInactiveSessions') return createNoopMutable(false);
            if (key === 'groupInactiveSessionsByProject') return createNoopMutable(false);
            if (key === 'showEnvironmentBadge') return createNoopMutable(false);
            if (key === 'useEnhancedSessionWizard') return createNoopMutable(false);
            if (key === 'useMachinePickerSearch') return createNoopMutable(false);
            if (key === 'usePathPickerSearch') return createNoopMutable(false);
            return createNoopMutable(null);
        });

        useLocalSettingMutableMock.mockImplementation((key: string) => {
            if (key === 'commandPaletteEnabled') return createNoopMutable(false);
            if (key === 'devModeEnabled') return createNoopMutable(false);
            if (key === 'embeddedTerminalDockLocation') return createNoopMutable('sidebar');
            return createNoopMutable(false);
        });

        const { default: FeaturesSettingsScreen } = await import('@/app/(app)/settings/features');

        const screen = await renderSettingsView(React.createElement(FeaturesSettingsScreen));
        const menu = screen.findAll((node) => node.props?.itemTrigger?.title === 'terminalEmbedded.settings.locationTitle')[0] ?? null;
        expect(menu).toBeTruthy();
    });
});
