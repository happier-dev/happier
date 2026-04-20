import React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { installVoiceSurfaceCommonModuleMocks } from './voiceSurfaceTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createHostComponentMock(type: string) {
    return (props: any) => React.createElement(type, props, props.children);
}

installVoiceSurfaceCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: createHostComponentMock('View'),
            Text: createHostComponentMock('Text'),
            Pressable: createHostComponentMock('Pressable'),
            ScrollView: createHostComponentMock('ScrollView'),
        });
    },
});

describe('VoiceActivityPanel web testID forwarding', () => {
    it('forwards row test ids to web activity entries', async () => {
        const { VoiceActivityPanel } = await import('./VoiceActivityPanel');
        const screen = await renderScreen(
            <VoiceActivityPanel
                count={2}
                emptyLabel="empty"
                expanded
                entries={[
                    { id: 'voice-e2e-assistant-1', createdAt: 2, kind: 'assistant', text: 'second' },
                    { id: 'voice-e2e-user-1', createdAt: 1, kind: 'user', text: 'first' },
                ]}
                eventTextColor="#111"
                entryTestIdPrefix="voice-surface-activity-entry:sidebar:"
                onToggleExpanded={() => {}}
                styles={{
                    feedContainer: {},
                    feedHeader: {},
                    feedHeaderLeft: {},
                    feedTitle: {},
                    feedCount: {},
                    feedScroll: {},
                    feedScrollContent: {},
                    emptyText: {},
                    eventText: {},
                }}
                title="Voice Activity"
                titleColor="#000"
                toggleLabel="Toggle voice activity"
            />,
        );

        const assistantEntry = screen.findByProps({ 'data-testid': 'voice-surface-activity-entry:sidebar:voice-e2e-assistant-1' });
        const userEntry = screen.findByProps({ 'data-testid': 'voice-surface-activity-entry:sidebar:voice-e2e-user-1' });

        expect(assistantEntry).toBeTruthy();
        expect(userEntry).toBeTruthy();
    });
});
