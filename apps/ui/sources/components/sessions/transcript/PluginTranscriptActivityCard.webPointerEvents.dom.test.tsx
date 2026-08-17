/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import type { ChatListItem } from '@/components/sessions/chatListItems';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// This must use RNW's real host primitives: a React test-renderer prop bag
// cannot observe the deprecated pointerEvents warning.
vi.mock('react-native', async () => await vi.importActual('react-native-web'));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

type PluginActivityItem = Extract<ChatListItem, { kind: 'plugin-transcript-activity' }>;

const activity: PluginActivityItem = {
    kind: 'plugin-transcript-activity',
    id: 'plugin-transcript-activity:build',
    identityKey: 'build',
    pluginId: 'acme.preview',
    contributionId: 'activity',
    generation: '7',
    sessionId: 'session-a',
    resourceId: 'live-activity',
    localActivityId: 'build',
    phase: 'running',
    title: 'Build complete',
    status: 'Compiling',
    progress: { completed: 3, total: 10 },
    checklist: [],
    dismissible: false,
    actions: [],
    freshness: 'current',
    createdAt: 0,
};

describe('PluginTranscriptActivityCard web pointer-events ownership', () => {
    it('keeps its progress rail and live status non-interactive without RNW deprecated props', async () => {
        const { PluginTranscriptActivityCard } = await import('./PluginTranscriptActivityCard');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root: Root = createRoot(container);
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            await act(async () => {
                root.render(
                    <PluginTranscriptActivityCard
                        activity={activity}
                        onDismiss={() => undefined}
                        onOpenAction={() => undefined}
                    />,
                );
            });

            const progress = container.querySelector<HTMLElement>('[data-testid="plugin-transcript-activity-progress"]');
            const liveStatus = container.querySelector<HTMLElement>('[data-testid="plugin-transcript-activity-a11y-status"]');
            expect(progress).not.toBeNull();
            expect(liveStatus).not.toBeNull();
            expect(getComputedStyle(progress!).pointerEvents).toBe('none');
            expect(getComputedStyle(liveStatus!).pointerEvents).toBe('none');
            expect(warning.mock.calls.filter(([message]) => (
                String(message).includes('props.pointerEvents is deprecated. Use style.pointerEvents')
            ))).toEqual([]);
        } finally {
            await act(async () => {
                root.unmount();
            });
            warning.mockRestore();
            container.remove();
        }
    });
});
