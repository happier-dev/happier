import { afterEach, describe, expect, it } from 'vitest';

import type { ChatListItem } from '@/components/sessions/chatListItems';
import { setPreferredLanguageFromSettings } from '@/text';

import { resolvePluginTranscriptActivityPresentation } from './pluginTranscriptActivityPresentation';

type PluginActivityItem = Extract<ChatListItem, { kind: 'plugin-transcript-activity' }>;

function activity(overrides: Partial<PluginActivityItem> = {}): PluginActivityItem {
    return {
        kind: 'plugin-transcript-activity',
        id: 'plugin-transcript-activity:build',
        identityKey: 'build',
        pluginId: 'acme.preview',
        contributionId: 'activity',
        generation: '7',
        sessionId: 'session-a',
        resourceId: 'live-activity',
        localActivityId: 'build',
        phase: 'cancelled',
        title: 'Build',
        status: null,
        progress: null,
        checklist: [],
        dismissible: true,
        actions: [],
        freshness: 'current',
        createdAt: 0,
        ...overrides,
    } as PluginActivityItem;
}

describe('Plugin transcript Activity presentation', () => {
    afterEach(() => {
        setPreferredLanguageFromSettings(null);
    });

    it('uses real English terminal-state copy for a cancelled Activity, not the imperative action', () => {
        setPreferredLanguageFromSettings('en');

        const presentation = resolvePluginTranscriptActivityPresentation(activity());

        expect(presentation.statusTitle).toBe('Canceled');
        expect(presentation.statusTitle).not.toBe('Cancel');
    });
});
