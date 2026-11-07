import { describe, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { buildActivityOverviewFromCandidates } from '@/activity/attention/buildActivityOverviewSnapshot';
import { buildInboxSessionPresentation } from './buildInboxSessionPresentation';
import { selectHomeCompletedBots } from './selectHomeCompletedBots';
import { storage } from '@/sync/domains/state/storage';
import { readSessionRecordingVisibility } from '@/sync/store/sessionRecordingVisibility';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { setScreenSharingPrivacyActive } from '@/desktop/capture/useNativeRecordingActive';

function ready(id: string, serverId: string, bot = true) {
    return buildSessionActivityAttention({ session: createSessionFixture({ id, serverId,
        metadata: { path: '/same', host: 'host', ...(bot ? { bot: { kind: 'bot' } } : {}) },
        latestTurnId: 'done', latestTurnStatus: 'completed', latestReadyEventSeq: 5, latestReadyEventAt: 500,
        viewer: { latestFailureSeq: null, readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: 5 },
            relevance: { relevant: true, reasons: ['owned_by_me'] }, follow: { follows: false, notificationLevel: null },
            notification: { level: 'important', source: 'owner' },
            attention: { needsAttention: true, reasons: ['ready_after_read'], primary: 'ready_after_read', presentation: 'full' } },
    }), nowMs: 1_000 });
}

describe('selectHomeCompletedBots', () => {
    it('omits private Bot previews and their bulk-read targets while retaining the same id in another Home', () => {
        const previous = storage.getState();
        storage.setState({ settings: { ...previous.settings, sessionListHiddenTagIdsWhileRecording: { 'home-a': ['secret'] } },
            sessionOrganizationTagAssignmentsBySessionKey: { [buildSessionOrganizationSessionKey('home-a', 'same')]: { sessionId: 'same', tagIds: ['secret'] } } });
        try {
            const privateBot = ready('same', 'home-a');
            const publicBot = ready('same', 'home-b');
            const presentation = buildInboxSessionPresentation({ overview: buildActivityOverviewFromCandidates([privateBot, publicBot]) });
            setScreenSharingPrivacyActive(true);
            const result = selectHomeCompletedBots(presentation, readSessionRecordingVisibility());
            expect(result.readySessions).toEqual([publicBot]);
            expect(result.markAllReadTargets.map(target => target.serverId)).toEqual(['home-b']);
            setScreenSharingPrivacyActive(false);
            expect(selectHomeCompletedBots(presentation, readSessionRecordingVisibility()).readySessions).toEqual([privateBot, publicBot]);
        } finally { setScreenSharingPrivacyActive(false); storage.setState(previous, true); }
    });
    it('selects only admitted ready Bots and their exact Home targets without reads', () => {
        const fetch = vi.spyOn(globalThis, 'fetch');
        try {
            const bot = ready('same', 'home-a');
            const ordinary = ready('same', 'home-b', false);
            const otherBot = ready('other', 'home-b');
            const presentation = buildInboxSessionPresentation({ overview: buildActivityOverviewFromCandidates([bot, ordinary, otherBot]) });
            const result = selectHomeCompletedBots(presentation);
            expect(result.readySessions).toEqual([bot, otherBot]);
            expect(result.markAllReadTargets).toEqual(presentation.markAllReadTargets.filter(target => target.serverId === 'home-a' || target.sessionId === 'other'));
            expect(result.readySessions[0]).toBe(bot);
            expect(result.markAllReadTargets[0]).toBe(presentation.markAllReadTargets[0]);
            expect(fetch).not.toHaveBeenCalled();

            const noLongerReady = buildInboxSessionPresentation({ overview: buildActivityOverviewFromCandidates([
                { ...bot, hasAttention: false },
                { ...otherBot, attentionState: 'thinking', awareness: { ...otherBot.awareness,
                    operational: { ...otherBot.awareness.operational, reasons: ['working'] } } }, ordinary,
            ]) });
            expect(selectHomeCompletedBots(noLongerReady).readySessions).toEqual([]);
            expect(selectHomeCompletedBots(noLongerReady).markAllReadTargets).toEqual([]);
        } finally { fetch.mockRestore(); }
    });
});
