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
    it('hides the local provider row on web and treats persisted local web selection as realtime', async () => {
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

        expect(findTestInstanceByTypeWithProps(tree, 'Item' as any, { title: 'settingsVoice.mode.local' })).toBeFalsy();
        expect(
            findTestInstanceByTypeWithProps(tree, 'Item' as any, { title: 'settingsVoice.mode.byo' })?.props?.rightElement,
        ).toBeTruthy();
    });
});
