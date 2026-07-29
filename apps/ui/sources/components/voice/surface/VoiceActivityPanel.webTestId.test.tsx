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
    it('uses a real 44pt activity toggle without overlapping hit slop', async () => {
        const { VoiceActivityPanel } = await import('./VoiceActivityPanel');
        const screen = await renderScreen(
            <VoiceActivityPanel
                count={0}
                emptyLabel="empty"
                expanded={false}
                entries={[]}
                eventTextColor="#111"
                onToggleExpanded={() => {}}
                styles={{ feedContainer: {}, feedHeader: {}, feedHeaderLeft: {}, feedTitle: {}, feedCount: {} }}
                title="Voice Activity"
                titleColor="#000"
                toggleLabel="Toggle voice activity"
                expandEntryLabel="Show full content"
                collapseEntryLabel="Show less"
                partialLabel="Live"
                correctedLabel="Updated"
                interruptedLabel="Interrupted"
            />,
        );
        const toggle = screen.findByProps({ accessibilityLabel: 'Toggle voice activity' });
        expect(toggle.props.hitSlop).toBeUndefined();
        expect(toggle.props.style({ pressed: false })).toEqual(expect.arrayContaining([
            expect.objectContaining({ minWidth: 44, minHeight: 44 }),
        ]));
    });

    it('forwards row test ids to web activity entries', async () => {
        const { VoiceActivityPanel } = await import('./VoiceActivityPanel');
        const screen = await renderScreen(
            <VoiceActivityPanel
                count={2}
                emptyLabel="empty"
                expanded
                entries={[
                    { id: 'voice-e2e-assistant-1', createdAt: 2, kind: 'assistant', text: 'second', transcriptState: 'final', announce: false, announcementId: 'assistant:1' },
                    { id: 'voice-e2e-user-1', createdAt: 1, kind: 'user', text: 'first', transcriptState: 'final', announce: false, announcementId: 'user:1' },
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
                expandEntryLabel="Show full content"
                collapseEntryLabel="Show less"
                partialLabel="Live"
                correctedLabel="Updated"
                interruptedLabel="Interrupted"
            />,
        );

        const assistantEntry = screen.findByProps({ 'data-testid': 'voice-surface-activity-entry:sidebar:voice-e2e-assistant-1' });
        const userEntry = screen.findByProps({ 'data-testid': 'voice-surface-activity-entry:sidebar:voice-e2e-user-1' });

        expect(assistantEntry).toBeTruthy();
        expect(userEntry).toBeTruthy();
    });

    it('lets each activity entry reveal its full accessible text', async () => {
        const { VoiceActivityPanel } = await import('./VoiceActivityPanel');
        const longText = 'A long activity entry that needs an explicit per-entry reveal.';
        const screen = await renderScreen(
            <VoiceActivityPanel
                count={1}
                emptyLabel="empty"
                expanded
                entries={[
                    { id: 'long-entry', createdAt: 1, kind: 'assistant', text: longText, transcriptState: 'final', announce: false, announcementId: 'long-entry:1' },
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
                    eventRow: {},
                    eventText: {},
                    eventRevealAction: {},
                    eventRevealText: {},
                }}
                title="Voice Activity"
                titleColor="#000"
                toggleLabel="Toggle voice activity"
                expandEntryLabel="Show full content"
                collapseEntryLabel="Show less"
                partialLabel="Live"
                correctedLabel="Updated"
                interruptedLabel="Interrupted"
            />,
        );

        const text = screen.findByProps({ children: longText });
        expect(text.props.numberOfLines).toBe(3);
        expect(text.props.accessibilityLabel).toBe(longText);

        const revealTestID = 'voice-surface-activity-entry:sidebar:long-entry:reveal';
        const reveal = screen.findByProps({ testID: revealTestID });
        expect(reveal.props.accessibilityRole).toBe('button');
        expect(reveal.props.accessibilityState).toEqual({ expanded: false });

        await screen.pressByTestIdAsync(revealTestID);

        expect(screen.findByProps({ children: longText }).props.numberOfLines).toBeUndefined();
        expect(screen.findByProps({ testID: revealTestID }).props.accessibilityState).toEqual({ expanded: true });
        expect(screen.findByProps({ accessibilityLabel: 'Show less' })).toBeTruthy();
    });
});
