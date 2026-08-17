import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { VoiceSurfaceTranscriptEntry } from './mergeVoiceSurfaceTranscriptEntries';

/**
 * §5.4a — the single app-shell Voice announcer.
 *
 * These are the guarantees `VoiceActivityPanel.transcriptState.test.tsx` used to
 * hold, moved onto their new owner: the panel is a superseded presentation of
 * "show the voice activity" (Horizon's `TranscriptStream` owns that now), but the
 * two dedupe layers it carried are load-bearing accessibility behaviour and
 * belong to the announcer.
 *
 * The platform cases exist because a one-for-one port of the panel would have
 * shipped **silence on iOS** while every other case here passed:
 * `accessibilityLiveRegion` is Android + web only (absent from
 * `BaseViewConfig.ios.js`, present at `BaseViewConfig.android.js:227`).
 */

const platform = vi.hoisted(() => ({ os: 'web' as 'web' | 'ios' | 'android' }));
const announceForAccessibilityMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const base = await createReactNativeWebMock();
    return {
        ...base,
        AccessibilityInfo: {
            ...base.AccessibilityInfo,
            announceForAccessibility: announceForAccessibilityMock,
        },
        Platform: {
            ...base.Platform,
            get OS() {
                return platform.os;
            },
        },
    };
});

import { VoiceAnnouncerSurface, VOICE_ANNOUNCER_TEST_ID } from './VoiceAnnouncer';

function entry(
    overrides: Partial<VoiceSurfaceTranscriptEntry> & Readonly<{ id: string; text: string }>,
): VoiceSurfaceTranscriptEntry {
    return {
        createdAt: 1,
        kind: 'assistant',
        interrupted: false,
        transcriptState: 'final',
        announce: true,
        announcementId: `${overrides.id}:1`,
        ...overrides,
    } as VoiceSurfaceTranscriptEntry;
}

function readAnnouncement(screen: Awaited<ReturnType<typeof renderScreen>>): string | null {
    const region = screen.findByTestId(VOICE_ANNOUNCER_TEST_ID);
    if (!region) return null;
    const label = region.props?.accessibilityLabel;
    return typeof label === 'string' ? label : null;
}

/**
 * The claim owner is scoped by canonical server/account/session identity (§5.4a).
 * Every case that is not specifically about scoping runs inside one scope, so the
 * dedupe guarantees below are the same-scope guarantees.
 */
const SCOPE = 'scope:server-a|account-a|session-a';
const IDLE = {
    statusAnnouncement: 'Voice assistant',
    statusTransitionKey: 'voice-status:idle',
    announcementScopeKey: SCOPE,
} as const;
const LISTENING = {
    statusAnnouncement: 'Listening',
    statusTransitionKey: 'voice-status:listening',
    announcementScopeKey: SCOPE,
} as const;

beforeEach(() => {
    platform.os = 'web';
    announceForAccessibilityMock.mockClear();
});

describe('VoiceAnnouncer transcript announcements', () => {
    it('stays silent on mount and announces the first new final entry', async () => {
        const seeded = [entry({ id: 'mount-seeded', text: 'Seeded on mount' })];
        const screen = await renderScreen(
            <VoiceAnnouncerSurface {...IDLE} transcriptEntries={seeded} />,
        );

        // The per-instance cursor: what was already on screen when the announcer
        // mounted is state, not an event.
        expect(readAnnouncement(screen)).toBe('');

        await screen.update(
            <VoiceAnnouncerSurface
                {...IDLE}
                transcriptEntries={[entry({ id: 'mount-new', text: 'Arrived after mount' }), ...seeded]}
            />,
        );

        expect(readAnnouncement(screen)).toBe('Arrived after mount');
        await screen.unmount();
    });

    it('announces a newly finalized correction once and does not replay it', async () => {
        const screen = await renderScreen(
            <VoiceAnnouncerSurface
                {...LISTENING}
                transcriptEntries={[entry({
                    id: 'correction',
                    text: 'Hello',
                    transcriptState: 'partial',
                    announce: false,
                    announcementId: 'correction:1',
                })]}
            />,
        );
        expect(readAnnouncement(screen)).toBe('');

        const corrected = [entry({
            id: 'correction',
            text: 'Hello!',
            transcriptState: 'corrected',
            announce: true,
            announcementId: 'correction:2',
        })];
        await screen.update(<VoiceAnnouncerSurface {...LISTENING} transcriptEntries={corrected} />);
        expect(readAnnouncement(screen)).toBe('Hello!');

        // Re-rendering with the same entries must not re-announce; the live region
        // simply keeps its last text.
        await screen.update(<VoiceAnnouncerSurface {...LISTENING} transcriptEntries={[...corrected]} />);
        expect(readAnnouncement(screen)).toBe('Hello!');
        await screen.unmount();
    });

    it('announces a newest-first batch in chronological order', async () => {
        const screen = await renderScreen(
            <VoiceAnnouncerSurface {...LISTENING} transcriptEntries={[]} />,
        );

        await screen.update(
            <VoiceAnnouncerSurface
                {...LISTENING}
                transcriptEntries={[
                    entry({ id: 'batch-assistant', text: 'Second final', createdAt: 2 }),
                    entry({ id: 'batch-user', text: 'First final', createdAt: 1 }),
                ]}
            />,
        );

        expect(readAnnouncement(screen)).toBe('First final. Second final');
        await screen.unmount();
    });

    it('never announces provisional entries the projector marked non-announcing', async () => {
        const screen = await renderScreen(
            <VoiceAnnouncerSurface {...LISTENING} transcriptEntries={[]} />,
        );

        await screen.update(
            <VoiceAnnouncerSurface
                {...LISTENING}
                transcriptEntries={[entry({
                    id: 'partial-row',
                    text: 'Hel',
                    transcriptState: 'partial',
                    announce: false,
                })]}
            />,
        );

        expect(readAnnouncement(screen)).toBe('');
        await screen.unmount();
    });

    it('keeps seeded onboarding scenery silent, then announces the first real event', async () => {
        // `VoiceAnnouncer.appShell.test.tsx` pins the real fixture's rows to
        // `announce: false`; this owner-level case proves what that flag does.
        const scenery: readonly VoiceSurfaceTranscriptEntry[] = [
            entry({ id: 'journey-voice-user-1', text: 'Walk me through the auth change.', announce: false }),
            entry({ id: 'journey-voice-assistant-1', text: 'The dashboard session now gates on the relay token.', announce: false }),
            entry({ id: 'journey-voice-user-2', text: 'Queue a follow-up.', announce: false }),
        ];
        const screen = await renderScreen(
            <VoiceAnnouncerSurface {...LISTENING} transcriptEntries={[]} />,
        );

        await screen.update(<VoiceAnnouncerSurface {...LISTENING} transcriptEntries={scenery} />);
        expect(readAnnouncement(screen)).toBe('');

        await screen.update(
            <VoiceAnnouncerSurface
                {...LISTENING}
                transcriptEntries={[entry({ id: 'journey-first-real', text: 'Real event' }), ...scenery]}
            />,
        );
        expect(readAnnouncement(screen)).toBe('Real event');
        await screen.unmount();
    });

    it('does not re-announce an entry a previous announcer instance already claimed', async () => {
        // The module-global 512-entry FIFO, ported verbatim from the panel. Two
        // announcers must never both be mounted, but a remount across a shell
        // teardown must not replay the conversation into a screen reader.
        const claimed = [entry({ id: 'global-claim', text: 'Claimed once' })];
        const first = await renderScreen(<VoiceAnnouncerSurface {...LISTENING} transcriptEntries={[]} />);
        await first.update(<VoiceAnnouncerSurface {...LISTENING} transcriptEntries={claimed} />);
        expect(readAnnouncement(first)).toBe('Claimed once');
        await first.unmount();

        const second = await renderScreen(<VoiceAnnouncerSurface {...LISTENING} transcriptEntries={[]} />);
        await second.update(<VoiceAnnouncerSurface {...LISTENING} transcriptEntries={[...claimed]} />);
        expect(readAnnouncement(second)).toBe('');
        await second.unmount();
    });

    it('announces the same message id once in EACH scope it belongs to', async () => {
        /*
         * The claim owner is module-global, and transcript ids are only unique
         * within the account and conversation that produced them: a persisted
         * entry keys on `voice-persisted:<id>` and a canonical one on
         * `<entryId>:<revision>`, neither of which carries the server, the
         * account or the session. Keyed on the raw id, the SECOND server/account
         * to produce a colliding id is silently never spoken — a screen-reader
         * user simply stops being told what Voice said.
         */
        const colliding = [entry({ id: 'voice-persisted:message-7', text: 'Shared identifier' })];
        const scopeA = { ...LISTENING, announcementScopeKey: 'scope:server-a|account-a|session-a' } as const;
        const scopeB = { ...LISTENING, announcementScopeKey: 'scope:server-b|account-b|session-b' } as const;

        const first = await renderScreen(<VoiceAnnouncerSurface {...scopeA} transcriptEntries={[]} />);
        await first.update(<VoiceAnnouncerSurface {...scopeA} transcriptEntries={colliding} />);
        expect(readAnnouncement(first)).toBe('Shared identifier');
        await first.unmount();

        const second = await renderScreen(<VoiceAnnouncerSurface {...scopeB} transcriptEntries={[]} />);
        await second.update(<VoiceAnnouncerSurface {...scopeB} transcriptEntries={[...colliding]} />);
        expect(readAnnouncement(second)).toBe('Shared identifier');
        await second.unmount();

        // …and the scoping does not cost the same-scope remount guarantee.
        const third = await renderScreen(<VoiceAnnouncerSurface {...scopeB} transcriptEntries={[]} />);
        await third.update(<VoiceAnnouncerSurface {...scopeB} transcriptEntries={[...colliding]} />);
        expect(readAnnouncement(third)).toBe('');
        await third.unmount();
    });

    it('seeds existing rows on a direct scope switch, then announces one later row in the new scope', async () => {
        const firstScopeEntry = [entry({
            id: 'moving-scope-first',
            text: 'First scope text',
            createdAt: 1,
        })];
        const existingSecondScopeEntries = [entry({
            id: 'moving-scope-seeded',
            text: 'Existing second scope text',
            createdAt: 1,
        })];
        const scopeA = { ...LISTENING, announcementScopeKey: 'scope:moving-server-a|account-a|session-a' } as const;
        const scopeB = { ...LISTENING, announcementScopeKey: 'scope:moving-server-b|account-b|session-b' } as const;

        const screen = await renderScreen(
            <VoiceAnnouncerSurface {...scopeA} transcriptEntries={[]} />,
        );
        await screen.update(
            <VoiceAnnouncerSurface {...scopeA} transcriptEntries={firstScopeEntry} />,
        );
        expect(readAnnouncement(screen)).toBe('First scope text');

        // The app-shell owner persists while account/session scope changes. Rows
        // already present in the destination are history, not newly admitted
        // events, so no artificial empty render is allowed before this update.
        await screen.update(
            <VoiceAnnouncerSurface {...scopeB} transcriptEntries={existingSecondScopeEntries} />,
        );
        expect(readAnnouncement(screen)).toBe('First scope text');

        await screen.update(
            <VoiceAnnouncerSurface
                {...scopeB}
                transcriptEntries={[
                    entry({ id: 'moving-scope-new', text: 'New second scope text', createdAt: 2 }),
                    ...existingSecondScopeEntries,
                ]}
            />,
        );
        expect(readAnnouncement(screen)).toBe('New second scope text');

        await screen.update(
            <VoiceAnnouncerSurface
                {...scopeB}
                transcriptEntries={[
                    entry({ id: 'moving-scope-new', text: 'New second scope text', createdAt: 2 }),
                    ...existingSecondScopeEntries,
                ]}
            />,
        );
        expect(readAnnouncement(screen)).toBe('New second scope text');

        await screen.unmount();
    });

    it('does not let a stale old-scope row claim the destination scope', async () => {
        const scopeA = { ...LISTENING, announcementScopeKey: 'scope:stale-server-a|account-a|session-a' } as const;
        const scopeB = { ...LISTENING, announcementScopeKey: 'scope:stale-server-b|account-b|session-b' } as const;
        const colliding = [entry({
            id: 'stale-scope-collision',
            text: 'Scope-local identifier',
            announcementId: 'stale-scope-collision:1',
        })];

        const first = await renderScreen(
            <VoiceAnnouncerSurface {...scopeA} transcriptEntries={[]} />,
        );
        await first.update(
            <VoiceAnnouncerSurface {...scopeA} transcriptEntries={colliding} />,
        );
        expect(readAnnouncement(first)).toBe('Scope-local identifier');

        // During an account/server handoff the old projection can still be the
        // current render. It must be seeded as destination history, never claimed
        // under the destination's module-global identity.
        await first.update(
            <VoiceAnnouncerSurface {...scopeB} transcriptEntries={colliding} />,
        );
        expect(readAnnouncement(first)).toBe('Scope-local identifier');
        await first.unmount();

        // A genuinely new row with that provider-local id in scope B remains
        // eligible. If the stale render claimed it cross-scope, this is silent.
        const second = await renderScreen(
            <VoiceAnnouncerSurface {...scopeB} transcriptEntries={[]} />,
        );
        await second.update(
            <VoiceAnnouncerSurface {...scopeB} transcriptEntries={colliding} />,
        );
        expect(readAnnouncement(second)).toBe('Scope-local identifier');
        await second.unmount();
    });
});

describe('VoiceAnnouncer lifecycle announcements', () => {
    it('announces a lifecycle transition exactly once', async () => {
        const screen = await renderScreen(
            <VoiceAnnouncerSurface {...IDLE} transcriptEntries={[]} />,
        );
        expect(readAnnouncement(screen)).toBe('');

        await screen.update(<VoiceAnnouncerSurface {...LISTENING} transcriptEntries={[]} />);
        expect(readAnnouncement(screen)).toBe('Listening');

        // Same state, unrelated re-render: nothing new to say.
        await screen.update(<VoiceAnnouncerSurface {...LISTENING} transcriptEntries={[]} />);
        expect(readAnnouncement(screen)).toBe('Listening');

        await screen.update(<VoiceAnnouncerSurface {...IDLE} transcriptEntries={[]} />);
        expect(readAnnouncement(screen)).toBe('Voice assistant');

        // Returning to a state that was already announced earlier must announce
        // again — a lifecycle transition is not a transcript identity.
        await screen.update(<VoiceAnnouncerSurface {...LISTENING} transcriptEntries={[]} />);
        expect(readAnnouncement(screen)).toBe('Listening');
        await screen.unmount();
    });

    it('carries a lifecycle change and a transcript final that land together', async () => {
        const screen = await renderScreen(
            <VoiceAnnouncerSurface {...IDLE} transcriptEntries={[]} />,
        );

        await screen.update(
            <VoiceAnnouncerSurface
                {...LISTENING}
                transcriptEntries={[entry({ id: 'together', text: 'Both at once' })]}
            />,
        );

        expect(readAnnouncement(screen)).toBe('Listening. Both at once');
        await screen.unmount();
    });
});

describe('VoiceAnnouncer platform shape', () => {
    it.each(['web', 'android'] as const)(
        'publishes exactly one polite live region on %s and announces declaratively',
        async (os) => {
            platform.os = os;
            const screen = await renderScreen(
                <VoiceAnnouncerSurface {...IDLE} transcriptEntries={[]} />,
            );

            expect(screen.tree.root.findAllByProps({ accessibilityLiveRegion: 'polite' })).toHaveLength(1);

            await screen.update(
                <VoiceAnnouncerSurface
                    {...LISTENING}
                    transcriptEntries={[entry({ id: `declarative-${os}`, text: 'Declared' })]}
                />,
            );

            expect(readAnnouncement(screen)).toBe('Listening. Declared');
            expect(announceForAccessibilityMock).not.toHaveBeenCalled();
            await screen.unmount();
        },
    );

    it.each(['web', 'android'] as const)(
        'remounts the declarative announcement node for identical text and id in a new scope on %s',
        async (os) => {
            platform.os = os;
            const scopeA = {
                ...LISTENING,
                announcementScopeKey: `scope:declarative-${os}-server-a|account-a|session-a`,
            } as const;
            const scopeB = {
                ...LISTENING,
                announcementScopeKey: `scope:declarative-${os}-server-b|account-b|session-b`,
            } as const;
            const colliding = [entry({
                id: `declarative-delivery-${os}`,
                text: 'Identical spoken text',
                announcementId: `declarative-delivery-${os}:1`,
            })];
            const screen = await renderScreen(
                <VoiceAnnouncerSurface {...scopeA} transcriptEntries={[]} />,
            );

            await screen.update(
                <VoiceAnnouncerSurface {...scopeA} transcriptEntries={colliding} />,
            );
            const firstNode = screen.findByTestId(VOICE_ANNOUNCER_TEST_ID)?.children[0];

            await screen.update(
                <VoiceAnnouncerSurface {...scopeB} transcriptEntries={[]} />,
            );
            await screen.update(
                <VoiceAnnouncerSurface {...scopeB} transcriptEntries={[...colliding]} />,
            );
            const secondNode = screen.findByTestId(VOICE_ANNOUNCER_TEST_ID)?.children[0];

            expect(secondNode).not.toBe(firstNode);
            expect(readAnnouncement(screen)).toBe('Identical spoken text');
            await screen.unmount();
        },
    );

    it('announces imperatively on iOS, where a live region does not exist', async () => {
        platform.os = 'ios';
        const screen = await renderScreen(
            <VoiceAnnouncerSurface {...IDLE} transcriptEntries={[]} />,
        );

        // iOS has no `accessibilityLiveRegion`. Rendering one there is how Voice
        // stayed silent for VoiceOver while the declarative tests passed.
        expect(screen.tree.toJSON()).toBeNull();
        expect(announceForAccessibilityMock).not.toHaveBeenCalled();

        await screen.update(
            <VoiceAnnouncerSurface
                {...LISTENING}
                transcriptEntries={[entry({ id: 'ios-entry', text: 'Spoken' })]}
            />,
        );

        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(1);
        expect(announceForAccessibilityMock).toHaveBeenCalledWith('Listening. Spoken');

        // A re-render with nothing new must not speak again.
        await screen.update(
            <VoiceAnnouncerSurface
                {...LISTENING}
                transcriptEntries={[entry({ id: 'ios-entry', text: 'Spoken' })]}
            />,
        );
        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(1);
        await screen.unmount();
    });

    it('announces the same id again on iOS when the mounted owner follows a new scope', async () => {
        platform.os = 'ios';
        const scopeA = {
            ...LISTENING,
            announcementScopeKey: 'scope:ios-delivery-server-a|account-a|session-a',
        } as const;
        const scopeB = {
            ...LISTENING,
            announcementScopeKey: 'scope:ios-delivery-server-b|account-b|session-b',
        } as const;
        const firstScopeEntry = [entry({
            id: 'ios-delivery-collision',
            text: 'First iOS scope',
            announcementId: 'ios-delivery-collision:1',
        })];
        const secondScopeEntry = [entry({
            id: 'ios-delivery-collision',
            text: 'Second iOS scope',
            announcementId: 'ios-delivery-collision:1',
        })];
        const screen = await renderScreen(
            <VoiceAnnouncerSurface {...scopeA} transcriptEntries={[]} />,
        );

        await screen.update(
            <VoiceAnnouncerSurface {...scopeA} transcriptEntries={firstScopeEntry} />,
        );
        await screen.update(
            <VoiceAnnouncerSurface {...scopeB} transcriptEntries={[]} />,
        );
        await screen.update(
            <VoiceAnnouncerSurface {...scopeB} transcriptEntries={secondScopeEntry} />,
        );

        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(2);
        expect(announceForAccessibilityMock).toHaveBeenNthCalledWith(1, 'First iOS scope');
        expect(announceForAccessibilityMock).toHaveBeenNthCalledWith(2, 'Second iOS scope');
        await screen.unmount();
    });
});
