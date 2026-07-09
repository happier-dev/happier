import React from 'react';
import { vi } from 'vitest';
import { describe, expect, it } from 'vitest';

import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';

import { installVoiceSettingsPanelCommonModuleMocks } from './voiceSettingsPanelTestHelpers';

installVoiceSettingsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        });
    },
    icons: async () => ({
        Ionicons: (props: any) => React.createElement('Ionicons', props),
    }),
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

describe('VoiceProviderSection', () => {
    it('shows the local provider row on web and preserves persisted local selection', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');

        const voice: any = {
            providerId: 'local_conversation',
            adapters: {
                realtime_elevenlabs: {
                    billingMode: 'byo',
                },
            },
        };

        const { tree } = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                setVoice: () => {},
                happierVoiceSupported: true,
            }),
        );

        expect(
            findTestInstanceByTypeWithProps(tree, 'Item' as any, { title: 'settingsVoice.mode.local' })?.props?.rightElement,
        ).toBeTruthy();
        expect(
            findTestInstanceByTypeWithProps(tree, 'Item' as any, { title: 'settingsVoice.mode.byo' })?.props?.rightElement,
        ).toBeFalsy();
    });

    it('keeps hosted Happier Voice visible but disabled when the server does not support it', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const setVoice = vi.fn();

        const voice: any = {
            providerId: 'off',
            adapters: {
                realtime_elevenlabs: {
                    billingMode: 'byo',
                },
            },
        };

        const { tree } = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                setVoice,
                happierVoiceSupported: false,
            }),
        );
        const hostedRow = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            title: 'settingsVoice.mode.happier',
        });

        expect(hostedRow?.props?.disabled).toBe(true);
        expect(hostedRow?.props?.onPress).toBeUndefined();
        expect(
            findTestInstanceByTypeWithProps(tree, 'Item' as any, { title: 'settingsVoice.mode.local' }),
        ).toBeTruthy();
        expect(setVoice).not.toHaveBeenCalled();
    });

    it('uses the runtime platform when no platform override is supplied', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');

        const voice: any = {
            providerId: 'off',
            adapters: {
                realtime_elevenlabs: {
                    billingMode: 'byo',
                },
            },
        };

        const { tree } = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                setVoice: () => {},
                happierVoiceSupported: true,
                localAvailability: {
                    browserSpeech: { support: 'unavailable' },
                    daemon: { featureEnabled: true, route: 'relay_disabled', modelState: 'ready' },
                    nativeDevice: { requested: true },
                },
            }),
        );

        const localRow = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            title: 'settingsVoice.mode.local',
        });

        expect(localRow?.props?.disabled).toBe(true);
        expect(localRow?.props?.onPress).toBeUndefined();
    });

    it('keeps Local visible but fail-closed on web while detailed browser and daemon availability are still loading', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const setVoice = vi.fn();

        const voice: any = {
            providerId: 'off',
            adapters: {
                realtime_elevenlabs: {
                    billingMode: 'byo',
                },
            },
        };

        const { tree } = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                setVoice,
                happierVoiceSupported: true,
            }),
        );

        const localRow = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            title: 'settingsVoice.mode.local',
        });

        expect(localRow).toBeTruthy();
        expect(localRow?.props?.disabled).toBe(true);
        expect(localRow?.props?.onPress).toBeUndefined();
        localRow?.props?.onPress?.();
        expect(setVoice).not.toHaveBeenCalled();
    });

    it('disables Local when browser, daemon, and native execution paths are unavailable', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');

        const voice: any = {
            providerId: 'off',
            adapters: {
                realtime_elevenlabs: {
                    billingMode: 'byo',
                },
            },
        };

        const { tree } = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                setVoice: () => {},
                happierVoiceSupported: true,
                platformOs: 'web',
                localAvailability: {
                    browserSpeech: { support: 'unavailable' },
                    daemon: { featureEnabled: true, route: 'relay_disabled', modelState: 'ready' },
                    nativeDevice: { requested: true },
                },
            }),
        );

        const localRow = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            title: 'settingsVoice.mode.local',
        });

        expect(localRow?.props?.disabled).toBe(true);
        expect(localRow?.props?.onPress).toBeUndefined();
    });

    it('keeps Local selectable on web when browser speech is available', async () => {
        const { VoiceProviderSection } = await import('./VoiceProviderSection');
        const setVoice = vi.fn();

        const voice: any = {
            providerId: 'off',
            adapters: {
                realtime_elevenlabs: {
                    billingMode: 'byo',
                },
            },
        };

        const { tree } = await renderScreen(
            React.createElement(VoiceProviderSection, {
                voice,
                setVoice,
                happierVoiceSupported: true,
                platformOs: 'web',
                localAvailability: {
                    browserSpeech: { support: 'cloud_only' },
                    daemon: { featureEnabled: false, route: 'unavailable', modelState: 'unknown' },
                    nativeDevice: { requested: true },
                },
            }),
        );

        const localRow = findTestInstanceByTypeWithProps(tree, 'Item' as any, {
            title: 'settingsVoice.mode.local',
        });

        expect(localRow?.props?.disabled).not.toBe(true);
        localRow?.props?.onPress?.();
        expect(setVoice).toHaveBeenCalledWith({ ...voice, providerId: 'local_conversation' });
    });
});
