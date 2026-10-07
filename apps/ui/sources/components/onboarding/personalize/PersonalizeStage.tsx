import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SessionListSample, type SessionListSampleGroup, type SessionListSampleRow } from '@/components/settings/session/SessionListPreview';
import { SessionComposerSample, SessionTranscriptSample } from '@/components/settings/session/SessionSettingPreviews';
import { APP_RAIL_WIDTH_PX, APP_SHELL_TITLE_STRIP_HEIGHT_PX } from '@/components/navigation/shell/appRail/appRailMetrics';
import { GlassPresetPreview } from '@/components/settings/appearance/GlassAppearanceControls';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import {
    applySessionListAttentionPlacementWithinGroups,
    buildSessionListAttentionPlacement,
} from '@/sync/domains/session/listing/sessionListAttentionPlacement';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionPersonalAttentionReasonV1 } from '@happier-dev/protocol';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { shadowLevelStyle } from '@/shadowElevation';
import type { SessionListLayoutChoice } from '@/sync/domains/session/listing/sessionListLayout';
import { t } from '@/text';

import type { AttentionPlacementChoice, PersonalizeChoices, PersonalizePageId } from './personalizeFlowModel';

/** The region a step changes, ringed on the stage. */
export type PersonalizeStageFocus = 'none' | 'window' | 'sessions' | 'transcript' | 'notifications';

export function resolvePersonalizeStageFocus(page: PersonalizePageId): PersonalizeStageFocus {
    if (page === 'conversation' || page === 'tools') return 'transcript';
    if (page === 'work' || page === 'attention') return 'sessions';
    if (page === 'notifications') return 'notifications';
    // Look changes the whole app (which already repaints); the style and the summary change nothing.
    return 'none';
}

type SampleKey = 'reconnect' | 'craft' | 'review' | 'pricing' | 'docs';

function sampleRow(key: SampleKey): SessionListSampleRow {
    switch (key) {
        case 'reconnect': return { id: 'personalize-reconnect', title: t('personalize.sampleSessionReconnect'), project: '~/happier', status: { label: t('personalize.sampleWorking'), tone: 'neutral' } };
        case 'craft': return { id: 'personalize-craft', title: t('personalize.sampleSessionCraft'), project: '~/happier', status: { label: t('personalize.sampleNeedsYou'), tone: 'attention' } };
        case 'review': return { id: 'personalize-review', title: t('personalize.sampleSessionReview'), project: '~/happier', status: { label: t('personalize.sampleNeedsYou'), tone: 'attention' } };
        case 'pricing': return { id: 'personalize-pricing', title: t('personalize.sampleSessionPricing'), project: '~/website', status: { label: t('personalize.sampleReady'), tone: 'attention' } };
        case 'docs': return { id: 'personalize-docs', title: t('personalize.sampleSessionDocs'), project: '~/website' };
    }
}

const SAMPLE_NOW_MS = 1_000_000;

function sampleSession(key: SampleKey, primary: SessionPersonalAttentionReasonV1 | null, patch: Partial<SessionListRenderableSession> = {}): SessionListRenderableSession {
    return {
        id: `personalize-${key}`,
        seq: 2,
        createdAt: 1,
        updatedAt: SAMPLE_NOW_MS,
        active: true,
        activeAt: SAMPLE_NOW_MS,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: null,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        viewer: {
            readState: { state: 'tracking', lastViewedSessionSeq: primary === 'ready_after_read' ? 1 : 2, unreadSince: null },
            relevance: { relevant: true, reasons: ['followed_by_me'] },
            follow: { follows: true, notificationLevel: 'none' },
            notification: { level: 'none', source: 'preference' },
            attention: { needsAttention: primary !== null, reasons: primary ? [primary] : [], primary, presentation: 'full' },
        },
        ...patch,
    };
}

// Static viewer/runtime facts, shaped exactly like the live listing owner's inputs.
const SAMPLE_SESSIONS: Readonly<Record<SampleKey, SessionListRenderableSession>> = {
    reconnect: sampleSession('reconnect', null, { thinking: true, thinkingAt: SAMPLE_NOW_MS, latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: SAMPLE_NOW_MS }),
    craft: sampleSession('craft', 'permission_required', { hasPendingPermissionRequests: true, pendingRequestObservedAt: SAMPLE_NOW_MS }),
    review: sampleSession('review', 'user_action_required', { hasPendingUserActionRequests: true, pendingRequestObservedAt: SAMPLE_NOW_MS }),
    pricing: sampleSession('pricing', 'ready_after_read', { latestTurnStatus: 'completed', latestTurnStatusObservedAt: SAMPLE_NOW_MS, lastTurnCompletedAt: SAMPLE_NOW_MS }),
    docs: sampleSession('docs', null, { active: false }),
};

/** Static group fixtures consume the live owner's reason classification and ordering. */
export function buildPersonalizeListSample(layout: SessionListLayoutChoice, attention: AttentionPlacementChoice): SessionListSampleGroup[] {
    const groups: Array<{ heading: string; keys: SampleKey[] }> = layout === 'projects'
        ? [{ heading: '~/happier', keys: ['reconnect', 'craft', 'review'] }, { heading: '~/website', keys: ['pricing', 'docs'] }]
        : layout === 'recent_activity'
            ? [{ heading: t('sessionHistory.today'), keys: ['reconnect', 'review', 'pricing'] }, { heading: t('sessionHistory.yesterday'), keys: ['craft', 'docs'] }]
            : [{ heading: t('common.active'), keys: ['reconnect', 'review', 'pricing'] }, { heading: t('common.inactive'), keys: ['craft', 'docs'] }];
    const rows = new Map(groups.flatMap(group => group.keys.map(key => [SAMPLE_SESSIONS[key].id, { session: SAMPLE_SESSIONS[key], row: sampleRow(key) }] as const)));
    const source: SessionListIndexItem[] = groups.flatMap((group, index): SessionListIndexItem[] => {
        const groupKey = `personalize-group-${index}`;
        const groupKind: 'project' | 'date' | 'active' = layout === 'projects' ? 'project' : layout === 'recent_activity' ? 'date' : 'active';
        return [
            { type: 'header' as const, title: group.heading, groupKey },
            ...group.keys.map(key => ({ type: 'session' as const, serverId: 'personalize-sample-home', sessionId: SAMPLE_SESSIONS[key].id, groupKey, groupKind })),
        ];
    });
    const params = {
        source,
        options: { mode: attention },
        resolveSessionRow: (_serverId: string | null | undefined, id: string) => rows.get(id)?.session ?? null,
        nowMs: SAMPLE_NOW_MS,
    };
    const global = buildSessionListAttentionPlacement(params);
    const arranged = global ? [...global.attentionItems, ...global.remainder] : applySessionListAttentionPlacementWithinGroups(params);
    const result: Array<{ heading: string; rows: SessionListSampleRow[] }> = [];
    for (const item of arranged) {
        if (item.type === 'header') result.push({ heading: item.title, rows: [] });
        else if (item.type === 'session') {
            const row = rows.get(item.sessionId)?.row;
            if (row) result.at(-1)?.rows.push(row);
        }
    }
    return result.filter(group => group.rows.length > 0);
}

const SIDEBAR_WIDTH = 248;

/**
 * Personalize's one live stage: a sessions column and a two-turn session drawn by the real row and
 * transcript components at the draft's choices, in the theme on screen, with a ring on the region the
 * current step changes. Static props only: no session, subscription or RPC.
 */
export const PersonalizeStage = React.memo(function PersonalizeStage(props: Readonly<{
    draft: PersonalizeChoices;
    focus: PersonalizeStageFocus;
    /**
     * `window`: the desktop stage. `card`: the phone's single preview card (one region, no window
     * chrome). `miniature`: the window alone at a fixed canvas, for a tile that scales it down.
     */
    presentation: 'window' | 'card' | 'miniature';
    note?: string;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const { draft, focus } = props;
    const groups = React.useMemo(
        () => buildPersonalizeListSample(draft.listLayout, draft.attention),
        [draft.attention, draft.listLayout],
    );
    const ring = { borderColor: theme.colors.state.active.foreground };
    const sessions = (
        <GlassSurface surfaceGroup="sidebar" testID={props.testID ? `${props.testID}-sessions` : undefined} style={[styles.sessions, props.presentation !== 'card' ? styles.sessionsSidebar : null, focus === 'sessions' ? [styles.ring, ring] : null]}>
            <SessionListSample density={draft.listDensity} groups={groups} />
        </GlassSurface>
    );
    const transcript = (
        <GlassSurface surfaceGroup="content" testID={props.testID ? `${props.testID}-transcript` : undefined} solidColor={theme.colors.background.canvas} style={[styles.transcript, focus === 'transcript' ? [styles.ring, ring] : null]}>
            <View style={styles.sessionHeader}>
                <Icon name="chat-circle" size={16} color={theme.colors.text.secondary} />
                <Text numberOfLines={1} style={styles.sessionTitle}>{t('personalize.sampleSessionReconnect')}</Text>
            </View>
            <View style={styles.messages}><SessionTranscriptSample
                layout={draft.transcriptLayout}
                thinking={draft.thinking}
                toolChrome={draft.toolChrome}
                toolDetail={draft.toolDetail}
            /></View>
            {props.presentation !== 'card' ? <SessionComposerSample layout="wrap" labels="core" width="100%" /> : null}
        </GlassSurface>
    );

    if (props.presentation === 'card') {
        const showSessions = focus === 'sessions';
        return (
            <GlassPresetPreview preset={draft.glass} settings={draft.glassSettings} style={styles.preview}>
                <View testID={props.testID} style={styles.card}>
                    {showSessions ? sessions : focus === 'notifications' ? <NotificationSamples draft={draft} /> : transcript}
                </View>
            </GlassPresetPreview>
        );
    }

    const window = (
        <GlassPresetPreview preset={draft.glass} settings={draft.glassSettings} style={[styles.window, props.presentation === 'miniature' ? styles.windowMiniature : null, focus === 'window' ? [styles.ring, ring] : null]}>
            <GlassSurface surfaceGroup="chrome" style={styles.titleStrip}>
                <Icon name="caret-left" size={16} color={theme.colors.text.secondary} />
                <Icon name="caret-right" size={16} color={theme.colors.text.secondary} />
                <Text numberOfLines={1} style={styles.windowTitle}>{t('personalize.sampleSessionReconnect')}</Text>
            </GlassSurface>
            <View style={styles.windowBody}>
                <GlassSurface surfaceGroup="chrome" style={styles.appRail}>
                    <Icon name="chat-circle" size={20} color={theme.colors.text.primary} />
                    <Icon name="folder" size={20} color={theme.colors.text.secondary} />
                    <Icon name="bell" size={20} color={theme.colors.text.secondary} />
                </GlassSurface>
                {sessions}
                {transcript}
                <GlassSurface surfaceGroup="chrome" style={styles.appRail}>
                    <Icon name="dots-three" size={20} color={theme.colors.text.secondary} />
                </GlassSurface>
                {focus === 'notifications' ? (
                    <View style={[styles.banners, styles.ring, ring]}>
                        <NotificationSamples draft={draft} />
                    </View>
                ) : null}
            </View>
        </GlassPresetPreview>
    );
    if (props.presentation === 'miniature') return window;
    return (
        <View style={styles.preview}>
            <View testID={props.testID} style={styles.stage}>
                {window}
                {props.note ? <Text style={styles.note}>{props.note}</Text> : null}
            </View>
        </View>
    );
});

/** Sample banners drawn by the page: no notification is sent or requested. */
function NotificationSamples(props: Readonly<{ draft: PersonalizeChoices }>) {
    const { draft } = props;
    const samples = [
        ...(draft.notifyNeedsYou ? [{ key: 'needs', title: t('personalize.sampleNeedsYouTitle'), body: t('personalize.sampleNeedsYouBody') }] : []),
        ...(draft.notifyFinished ? [{ key: 'ready', title: t('personalize.sampleReadyTitle'), body: t('personalize.sampleReadyBody') }] : []),
    ];
    if (samples.length === 0) {
        return <GlassSurface style={styles.banner}><Text style={styles.bannerBody}>{t('personalize.notificationsOff')}</Text></GlassSurface>;
    }
    return (
        <View style={styles.bannerStack}>
            {samples.map((sample) => (
                <GlassSurface key={sample.key} style={styles.banner}>
                    <Text numberOfLines={1} style={styles.bannerTitle}>{sample.title}</Text>
                    <Text numberOfLines={2} style={styles.bannerBody}>{draft.notifyPreview ? sample.body : t('personalize.sampleStatusBody')}</Text>
                </GlassSurface>
            ))}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    preview: { flex: 1, minHeight: 0, minWidth: 0 },
    windowBody: { flex: 1, flexDirection: 'row', minHeight: 0, minWidth: 0 },
    stage: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        justifyContent: 'center',
        paddingHorizontal: 40,
        paddingVertical: 40,
        gap: 16,
        backgroundColor: theme.colors.background.canvas,
    },
    window: {
        flex: undefined,
        flexDirection: 'column',
        width: '100%',
        aspectRatio: 840 / 540,
        minHeight: 0,
        maxHeight: 680,
        flexShrink: 1,
        overflow: 'hidden',
        borderRadius: 14,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
    },
    windowMiniature: {
        flex: 1,
        maxHeight: undefined,
        boxShadow: undefined,
        shadowOpacity: 0,
        elevation: 0,
    },
    titleStrip: {
        height: APP_SHELL_TITLE_STRIP_HEIGHT_PX,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        gap: 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
    },
    windowTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 16,
        flexShrink: 1,
    },
    appRail: {
        width: APP_RAIL_WIDTH_PX,
        alignItems: 'center',
        paddingTop: 16,
        gap: 20,
    },
    messages: { flex: 1, minHeight: 0, overflow: 'hidden' },
    ring: {
        borderWidth: 2,
    },
    sessions: {
        paddingHorizontal: 8,
        paddingTop: 12,
        overflow: 'hidden',
        borderRightWidth: 1,
        borderRightColor: theme.colors.border.default,
        borderRadius: 12,
        borderCurve: 'continuous',
    },
    sessionsSidebar: { width: SIDEBAR_WIDTH },
    transcript: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        paddingHorizontal: 20,
        paddingBottom: 16,
        borderRadius: 12,
        borderCurve: 'continuous',
        borderColor: 'transparent',
    },
    sessionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 12,
        marginBottom: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
    },
    sessionTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 14,
        lineHeight: 18,
        flexShrink: 1,
    },
    banners: {
        position: 'absolute',
        top: 12,
        right: 12,
        width: 340,
        padding: 6,
        borderRadius: 16,
        borderCurve: 'continuous',
    },
    bannerStack: {
        gap: 8,
    },
    banner: {
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 12,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        gap: 2,
    },
    bannerTitle: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 13,
        lineHeight: 17,
    },
    bannerBody: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 16,
    },
    card: {
        height: 300,
        overflow: 'hidden',
        padding: 12,
        borderRadius: 20,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    note: {
        textAlign: 'center',
        color: theme.colors.text.tertiary,
        fontSize: 13,
        lineHeight: 18,
    },
}));
