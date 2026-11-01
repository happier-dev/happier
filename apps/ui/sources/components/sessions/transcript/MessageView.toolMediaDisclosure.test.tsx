import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { createPartialStorageModuleMock, renderScreen, standardCleanup } from '@/dev/testkit';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { deriveTranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

let chromeMode: 'cards' | 'activity_feed' = 'cards';
let collapsedDetail: 'title' | 'summary' = 'title';

installMessageViewCommonModuleMocks({
    storage: async (importOriginal) => createPartialStorageModuleMock(importOriginal, {
        useSetting: (key: keyof typeof settingsDefaults) => {
            if (key === 'toolViewTimelineChromeMode') return chromeMode;
            if (key === 'toolViewDetailLevelDefault' || key === 'toolViewDetailLevelDefaultLocalControl') return collapsedDetail;
            if (key === 'toolViewTapAction') return 'expand';
            if (key === 'toolViewTimelineFeedDefaultExpanded') return false;
            return settingsDefaults[key];
        },
    }),
});

afterEach(() => standardCleanup());

describe('tool-result media disclosure', () => {
    it.each(['cards', 'activity_feed'] as const)('mounts media only inside expanded %s tool details', async (mode) => {
        chromeMode = mode;
        const { MessageView } = await import('./MessageView');
        const path = '.happier/uploads/artifacts/read-image/comparison.png';
        const message: ToolCallMessage = {
            kind: 'tool-call', id: 'read-image', localId: null, createdAt: 1, children: [],
            tool: { id: 'read-1', name: 'Read', state: 'completed', input: { file_path: 'comparison.png' }, createdAt: 1, startedAt: 1, completedAt: 2, description: null, result: {} },
            meta: { happierMedia: { kind: 'session_media.v1', payload: { media: [{
                id: 'media-1', role: 'output', category: 'tool-artifact', mediaKind: 'image',
                mimeType: 'image/png', name: 'comparison.png', path, sizeBytes: 80,
                origin: { source: 'tool-output', toolCallId: 'read-1' },
            }] } } },
        };
        for (const detail of ['title', 'summary'] as const) {
            collapsedDetail = detail;
            const screen = await renderScreen(<MessageView message={message} metadata={null} sessionId="s1" interaction={deriveTranscriptInteraction({ kind: 'public' })} />);
            expect(screen.findByTestId(`message-session-media-inline-image:${path}`)).toBeNull();
            const header = mode === 'cards' ? 'tool-view-header-primary' : 'tool-timeline-row';
            await act(async () => { screen.pressByTestId(header); });
            expect(screen.findByTestId(`message-session-media-inline-image:${path}`)).not.toBeNull();
            await act(async () => { screen.pressByTestId(header); });
            expect(screen.findByTestId(`message-session-media-inline-image:${path}`)).toBeNull();
            await screen.unmount();
        }
    });
});
