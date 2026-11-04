import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SessionListSample } from '@/components/settings/session/SessionListPreview';
import { buildSessionListArrangementSample } from '@/components/settings/session/sessionListArrangementSample';
import { SessionComposerSample, SessionTranscriptSample } from '@/components/settings/session/SessionSettingPreviews';
import { APP_RAIL_WIDTH_PX, APP_SHELL_TITLE_STRIP_HEIGHT_PX } from '@/components/navigation/shell/appRail/appRailMetrics';
import { GlassPresetPreview } from '@/components/settings/appearance/GlassAppearanceControls';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { shadowLevelStyle } from '@/shadowElevation';
import { t } from '@/text';

import type { PersonalizeChoices, PersonalizePageId } from './personalizeFlowModel';

/** The region a step changes, ringed on the stage. */
export type PersonalizeStageFocus = 'none' | 'window' | 'sessions' | 'transcript' | 'notifications';

export function resolvePersonalizeStageFocus(page: PersonalizePageId): PersonalizeStageFocus {
    if (page === 'conversation' || page === 'tools') return 'transcript';
    if (page === 'work' || page === 'attention') return 'sessions';
    if (page === 'notifications') return 'notifications';
    // Look changes the whole app (which already repaints); the style and the summary change nothing.
    return 'none';
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
        () => buildSessionListArrangementSample(draft.listLayout, draft.attention),
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
        paddingHorizontal: theme.space.s40,
        paddingVertical: theme.space.s40,
        gap: theme.space.s16,
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
        paddingHorizontal: theme.space.s16,
        gap: theme.space.s12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
    },
    windowTitle: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta', 'semiBold'),
        flexShrink: 1,
    },
    appRail: {
        width: APP_RAIL_WIDTH_PX,
        alignItems: 'center',
        paddingTop: theme.space.s16,
        gap: theme.space.s20,
    },
    messages: { flex: 1, minHeight: 0, overflow: 'hidden' },
    ring: {
        borderWidth: 2,
    },
    sessions: {
        paddingHorizontal: theme.space.s8,
        paddingTop: theme.space.s12,
        overflow: 'hidden',
        borderRightWidth: 1,
        borderRightColor: theme.colors.border.default,
        borderRadius: 0,
        borderCurve: 'continuous',
    },
    sessionsSidebar: { width: SIDEBAR_WIDTH },
    transcript: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        paddingHorizontal: theme.space.s20,
        paddingBottom: theme.space.s16,
        borderRadius: 0,
        borderCurve: 'continuous',
        borderColor: 'transparent',
    },
    sessionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingVertical: theme.space.s12,
        marginBottom: theme.space.s8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
    },
    sessionTitle: {
        color: theme.colors.text.primary,
        ...Typography.variant('label', 'semiBold'),
        flexShrink: 1,
    },
    banners: {
        position: 'absolute',
        top: 12,
        right: 12,
        width: 340,
        padding: theme.space.s6,
        borderRadius: 16,
        borderCurve: 'continuous',
    },
    bannerStack: {
        gap: theme.space.s8,
    },
    banner: {
        paddingHorizontal: 14,
        paddingVertical: theme.space.s10,
        borderRadius: 12,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        gap: theme.space.s2,
    },
    bannerTitle: {
        color: theme.colors.text.primary,
        ...Typography.variant('body', 'semiBold'),
    },
    bannerBody: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 16,
    },
    card: {
        height: 240,
        overflow: 'hidden',
        borderRadius: PAGE_LIST_METRICS.sheetRadiusPx,
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
