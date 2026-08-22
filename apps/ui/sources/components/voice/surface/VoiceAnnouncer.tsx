import * as React from 'react';
import { AccessibilityInfo, Platform, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import {
    useVoiceAttemptControl,
    VOICE_ATTEMPT_IDLE_TARGET_GLOBAL,
} from '@/components/voice/attempt/useVoiceAttemptControl';
import { useActiveServerAccountScope, useSetting } from '@/sync/domains/state/storage';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { t } from '@/text';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { resolveVoicePresentedProviderId } from '@/voice/settings/resolveVoiceProviderId';
import { useVoiceSessionSnapshot } from '@/voice/session/voiceSession';

import { resolveVoiceSurfaceStatusPresentation } from './resolveVoiceSurfaceStatusPresentation';
import { useVoiceSurfaceConversationState } from './useVoiceSurfaceConversationState';
import type { VoiceSurfaceTranscriptEntry } from './mergeVoiceSurfaceTranscriptEntries';

export const VOICE_ANNOUNCER_TEST_ID = 'voice-announcer';

const voiceProviderRegistry = createDefaultVoiceProviderRegistry();

/*
 * The bounded announcement dedupe, moved out of `VoiceActivityPanel` rather than
 * shared with it (§5.4a). A panel that still held a cursor would claim first and
 * starve this owner — `claimAnnouncement` is first-caller-wins, and React runs
 * child effects before parent effects.
 *
 * 512 entries, FIFO, never reset: a long conversation must not grow without
 * bound, and a remounted announcer must not replay the transcript into a screen
 * reader.
 *
 * Claims are keyed by SCOPE + id, never by the raw id. An announcement id is only
 * unique inside the account and conversation that minted it — a persisted entry
 * keys on `voice-persisted:<id>` and a canonical one on `<entryId>:<revision>`,
 * and neither carries the server, the account or the session. Keyed on the raw id
 * a single module-global claim silently swallows the SECOND scope to produce a
 * colliding id, and a screen-reader user simply stops being told what Voice said.
 */
const CLAIMED_ANNOUNCEMENT_LIMIT = 512;
const claimedAnnouncements = new Set<string>();
const claimedAnnouncementOrder: string[] = [];

type AnnouncementHistory = Readonly<{
    ids: Set<string>;
    order: string[];
}>;

function rememberAnnouncement(history: AnnouncementHistory, key: string): boolean {
    if (history.ids.has(key)) return false;
    history.ids.add(key);
    history.order.push(key);
    while (history.order.length > CLAIMED_ANNOUNCEMENT_LIMIT) {
        const retired = history.order.shift();
        if (retired) history.ids.delete(retired);
    }
    return true;
}

/**
 * Collision-safe identity shared by both dedupe layers.
 *
 * Length-prefixed like `serverAccountScopeKeySuffix` so no scope can be forged by
 * an id that happens to contain the separator.
 */
function scopedAnnouncementKey(scopeKey: string, announcementId: string): string {
    return `${scopeKey.length}:${scopeKey}${announcementId}`;
}

/** The one module-global claim owner. */
function claimAnnouncement(scopedKey: string): boolean {
    return rememberAnnouncement(
        { ids: claimedAnnouncements, order: claimedAnnouncementOrder },
        scopedKey,
    );
}

type VoiceAnnouncement = Readonly<{ key: string; text: string }>;

/**
 * The announcement composer and live region, with no store behind it.
 *
 * Split from `VoiceAnnouncer` so the transcript's two dedupe layers — the
 * per-instance cursor and the module-global claim are provable without standing
 * up the Voice lifecycle, the binding store and the session-message projection.
 */
export const VoiceAnnouncerSurface = React.memo(function VoiceAnnouncerSurface(props: Readonly<{
    /** What the current lifecycle state says. Already translated. */
    statusAnnouncement: string;
    /** Changes exactly when the lifecycle state changes. */
    statusTransitionKey: string;
    /**
     * Canonical server/account/session identity of the conversation these
     * announcements belong to.
     *
     * The module-global claim is what stops a remounted announcer replaying a
     * transcript into a screen reader, and it has to survive that remount — so it
     * cannot be reset per instance. Scoping the key is what keeps it from also
     * silencing a genuinely different conversation that happens to reuse an id.
     */
    announcementScopeKey: string;
    /**
     * Newest-first, as `visibleTranscriptEntries` produces them
     * (`useVoiceSurfaceConversationState.ts:161-167`). Reading the chronological
     * list instead silently flips the order of a batch.
     */
    transcriptEntries: readonly VoiceSurfaceTranscriptEntry[];
}>) {
    const [announcement, setAnnouncement] = React.useState<VoiceAnnouncement | null>(null);
    const initializedRef = React.useRef(false);
    const activeScopeKeyRef = React.useRef<string | null>(null);
    const lastStatusKeyRef = React.useRef<string | null>(null);
    /**
     * Layer one: what *this* announcer has already seen. Kept beside the global
     * claim because a late-mounting owner would otherwise announce a whole
     * conversation it merely arrived in the middle of.
     */
    const observedAnnouncements = React.useRef<AnnouncementHistory>({ ids: new Set(), order: [] });

    React.useEffect(() => {
        /*
         * Rendering stays newest-first, but speech is temporal: when several
         * finals become visible in one projection, announce the oldest newly
         * admitted row first. Reversing this filtered copy cannot affect the
         * Horizon transcript array or its scroll/virtualization contract.
         */
        const candidates = props.transcriptEntries.filter((entry) => entry.announce).reverse();
        const statusChanged = lastStatusKeyRef.current !== props.statusTransitionKey;
        lastStatusKeyRef.current = props.statusTransitionKey;
        const scopeChanged = activeScopeKeyRef.current !== props.announcementScopeKey;
        activeScopeKeyRef.current = props.announcementScopeKey;
        const wasInitialized = initializedRef.current;

        const keys: string[] = [];
        const texts: string[] = [];

        if (!wasInitialized || scopeChanged) {
            /*
             * Mounting in a conversation and entering another account/server/
             * session scope are both state, not transcript events. Seed every
             * row already visible in that scope without touching the
             * module-global claim. The latter is load-bearing: an old-scope
             * projection can remain visible for the scope-switch render, and
             * claiming it under the destination scope would silence a genuine
             * destination row with the same provider-local id later.
             */
            initializedRef.current = true;
            for (const entry of candidates) {
                rememberAnnouncement(
                    observedAnnouncements.current,
                    scopedAnnouncementKey(props.announcementScopeKey, entry.announcementId),
                );
            }
            if (!wasInitialized || !statusChanged || !props.statusAnnouncement) return;
        }

        /*
         * The lifecycle cursor is deliberately per-instance only. A transition is
         * not an identity: idle → connecting → idle must announce "idle" twice,
         * and routing it through the global claim would starve the second one
         * forever.
         */
        if (statusChanged && props.statusAnnouncement) {
            keys.push(props.statusTransitionKey);
            texts.push(props.statusAnnouncement);
        }
        for (const entry of candidates) {
            const key = entry.announcementId;
            const scopedKey = scopedAnnouncementKey(props.announcementScopeKey, key);
            if (!rememberAnnouncement(observedAnnouncements.current, scopedKey)) continue;
            if (!claimAnnouncement(scopedKey)) continue;
            keys.push(scopedKey);
            texts.push(entry.text);
        }
        if (texts.length > 0) {
            setAnnouncement({ key: keys.join('|'), text: texts.join('. ') });
        }
    }, [
        props.announcementScopeKey,
        props.statusAnnouncement,
        props.statusTransitionKey,
        props.transcriptEntries,
    ]);

    /*
     * `accessibilityLiveRegion` is Android + web only — it is absent from
     * `BaseViewConfig.ios.js` and present at `BaseViewConfig.android.js:227`. A
     * declarative-only announcer leaves VoiceOver silent while every declarative
     * test passes, so iOS announces imperatively instead. Shape proven at
     * `components/sessions/external/progress/ExternalSessionOperationAccessibilityStatus.tsx:17-51`.
     */
    const lastSpokenKeyRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (Platform.OS !== 'ios' || announcement === null) return;
        if (lastSpokenKeyRef.current === announcement.key) return;
        lastSpokenKeyRef.current = announcement.key;
        try {
            AccessibilityInfo.announceForAccessibility(announcement.text);
        } catch {
            // Accessibility announcements are best effort on native platforms.
        }
    }, [announcement]);

    if (Platform.OS === 'ios') return null;

    const text = announcement?.text ?? '';
    return (
        <View
            testID={VOICE_ANNOUNCER_TEST_ID}
            accessible
            accessibilityLabel={text}
            accessibilityLiveRegion="polite"
            pointerEvents="none"
            style={styles.region}
            {...({
                role: 'status',
                'aria-live': 'polite',
                'aria-atomic': true,
            } as Record<string, unknown>)}
        >
            {/*
              * Keyed on the announcement so an identical string announced twice
              * still remounts the node. Android fires on content change, and two
              * byte-identical renders are not one.
              */}
            <Text key={announcement?.key ?? 'voice-announcer:idle'}>{text}</Text>
        </View>
    );
});

/**
 * The one automatic Voice announcer in the app (§5.4a).
 *
 * Horizon, the orb and the composer planet expose labels, states, hints and
 * actions; none of them owns a live region. Two regions do not coalesce — two
 * `aria-live` nodes are two queues and two Android views are two events — and
 * Horizon and the orb are routinely mounted at the same time.
 *
 * It consumes lifecycle changes and new transcript finals. Diagnostics recovery
 * remains a Voice Settings concern rather than an automatic Voice announcement.
 *
 * It reads the placement-free `useVoiceAttemptControl` projection, never the
 * Horizon model: `surfaceLocation`/`scopeDefault` are Horizon's placement policy
 * and an announcer that inherited them would go quiet whenever the user moved
 * the vessel.
 *
 * Mounted **outside** `AuthenticatedAppRuntimeMountsGate` — that gate returns
 * null while the onboarding journey is active, and the journey still renders a
 * Voice surface.
 */
export const VoiceAnnouncer = React.memo(function VoiceAnnouncer(): React.ReactElement | null {
    // The announcer starts nothing, so the idle target is inert here: it reads the running
    // attempt's own facts. It states the app-level scope rather than a session it would have had
    // to infer from a route — which is the placement knowledge this surface must not carry.
    const control = useVoiceAttemptControl(VOICE_ATTEMPT_IDLE_TARGET_GLOBAL);
    const voice = useSetting('voice');
    const canonicalVoice = React.useMemo(() => voiceSettingsParse(voice), [voice]);
    const snap = useVoiceSessionSnapshot();
    const providerId = resolveVoicePresentedProviderId(snap, canonicalVoice, voiceProviderRegistry) ?? 'off';
    /*
     * Gated on the same setting the surfaces are (`useVoiceSurfaceModel.ts:153`).
     * Reading canonical transcript state directly would start announcing the
     * conversation to users who switched the activity feed off — and would open
     * the session-message subscription for them too.
     */
    const activityFeedEnabled = canonicalVoice.ui.activityFeedEnabled === true;
    const { visibleTranscriptEntries } = useVoiceSurfaceConversationState({
        providerId,
        activeControlSessionId: control.sessionId,
        // Placement-free by construction: the announcer follows the attempt, not a route.
        surfaceSessionId: null,
        transcriptEnabled: activityFeedEnabled,
        voiceSettings: voice,
    });
    /*
     * The claim scope: the canonical server/account pair this app is signed in to,
     * plus the attempt's session. `useActiveServerAccountScope` is the same owner
     * every scoped persistence key in this app already goes through, and
     * `serverAccountScopeKeySuffix` is its collision-safe encoding — reimplementing
     * either here would put a second answer behind "which account is this".
     *
     * Signed out, or before the profile scope has landed, everything shares one
     * `unscoped` bucket: that is the pre-existing behaviour and it is correct,
     * because there is no second account to collide with yet.
     */
    const accountScope = useActiveServerAccountScope();
    const announcementScopeKey = React.useMemo(() => [
        accountScope ? serverAccountScopeKeySuffix(accountScope) : 'unscoped',
        control.sessionId ?? '',
    ].join('|'), [accountScope, control.sessionId]);

    const statusPresentation = resolveVoiceSurfaceStatusPresentation(control.surfaceState);
    return (
        <VoiceAnnouncerSurface
            announcementScopeKey={announcementScopeKey}
            statusAnnouncement={t(statusPresentation.labelKey)}
            statusTransitionKey={`voice-status:${control.surfaceState}`}
            transcriptEntries={visibleTranscriptEntries}
        />
    );
});

const styles = StyleSheet.create({
    region: {
        position: 'absolute',
        width: 1,
        height: 1,
        overflow: 'hidden',
    },
});
