import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierApprovalPendingNotice, HappierPressable, type HappierApprovalPendingNoticeTextRender } from '@happier-dev/plugin-ui/presentation';
import { NoticeLine } from '@/components/ui/lists/NoticeLine';
import { attentionBannerTextStyles } from '@/components/ui/lists/AttentionBanner';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useListPresentation } from '@/components/ui/lists/listPresentation';
import { useIsInsideItemSection } from '@/components/ui/lists/sectionLeadingColumn';
import { t } from '@/text';

/**
 * Core's binding of the shared pending-approval notice (`HappierApprovalPendingNotice`, plugin-ui):
 * an Action that is waiting on an approval, with one way to open it. The originating Action
 * continuation owns settlement.
 */
export const ActionApprovalPendingNotice = React.memo(function ActionApprovalPendingNotice(props: Readonly<{
    /** The waiting state; the row's title when no `summary` names what waits. */
    message: string;
    onOpenApproval: () => void;
    /** What is waiting, in the approval's own words ("Write docs/getting-started.md in d-dc-hello-world."). */
    summary?: string | null;
    /** `banner` only: what finishes once it is approved. */
    description?: string | null;
    /** The open control's name; `Review` by default. */
    openLabel?: string;
    /**
     * `row` (default): a sheet row. `inline`: one quiet line for a host's own bar (the Code bar), so the
     * page doesn't move when an approval starts or settles. `banner`: the page notice above what waits.
     * `line`: the compact form among a picker's other status lines, naming what waits.
     */
    presentation?: 'row' | 'inline' | 'banner' | 'line';
    testID?: string;
}>) {
    if (props.presentation === 'banner' || props.presentation === 'line') {
        return <SharedApprovalPendingNotice {...props} presentation={props.presentation} />;
    }
    return <ApprovalPendingRowOrInline {...props} presentation={props.presentation} />;
});

const ApprovalPendingRowOrInline = React.memo(function ApprovalPendingRowOrInline(props: Readonly<{
    message: string;
    onOpenApproval: () => void;
    summary?: string | null;
    openLabel?: string;
    presentation?: 'row' | 'inline';
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const page = useListPresentation() === 'page';
    const inSection = useIsInsideItemSection();
    const summary = props.summary?.trim().replace(/[.]$/u, '') || null;
    // Inline, the line takes whatever room its host bar has left: it names the file when it fits,
    // then only that it waits, then only Review. It never wraps or pushes the bar taller.
    const [room, setRoom] = React.useState<number | null>(null);
    const onRoomLayout = React.useCallback((event: { nativeEvent: { layout: { width: number } } }) => {
        const next = Math.round(event.nativeEvent.layout.width);
        setRoom((previous) => (previous === next ? previous : next));
    }, []);
    if (props.presentation === 'inline') {
        const label = summary ? `${summary} · ${t('approvals.waitingForYou')}` : t('approvals.waitingForYou');
        const tier = room === null ? 'full' : room >= INLINE_FULL_MIN_PX ? 'full' : room >= INLINE_WAITING_MIN_PX ? 'waiting' : 'review';
        return (
            <View style={styles.inlineRoom} onLayout={onRoomLayout}>
            <HappierPressable
                testID={props.testID}
                accessibilityRole="button"
                accessibilityLabel={`${label}. ${props.openLabel ?? t('approvals.review')}`}
                onPress={props.onOpenApproval}
                style={(state) => [
                    styles.inline,
                    focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                    state.pressed || state.hovered ? { backgroundColor: theme.colors.surface.pressed } : null,
                ]}
            >
                {/* Amber: it needs you. */}
                <Icon name="clock" size={ICON_SIZE.xs} color={theme.colors.state.warning.foreground} />
                {tier === 'review' ? null : (
                    <Text numberOfLines={1} style={styles.inlineText}>
                        {summary && tier === 'full' ? <Text style={styles.inlineSubject}>{summary}</Text> : null}
                        {summary && tier === 'full' ? ' · ' : null}
                        {t('approvals.waitingForYou')}
                    </Text>
                )}
                <Text style={styles.inlineAction}>{props.openLabel ?? t('approvals.review')}</Text>
            </HappierPressable>
            </View>
        );
    }
    const row = (
        <Item
            testID={props.testID}
            mode="info"
            title={summary ?? props.message}
            subtitle={summary ? t('approvals.waitingForYou') : undefined}
            subtitleLines={0}
            showChevron={false}
            rightElement={<RoundButton testID={props.testID ? `${props.testID}.open` : undefined} size="small" display="secondary" title={props.openLabel ?? t('approvals.review')} onPress={props.onOpenApproval} />}
        />
    );
    // Placed straight on a configuration page, the row brings its own sheet so it keeps the column.
    return page && !inSection ? <ItemGroup>{row}</ItemGroup> : row;
});

/** The banner and the compact line, drawn by the shared owner with core's text, glyph and button. */
const SharedApprovalPendingNotice = React.memo(function SharedApprovalPendingNotice(props: Readonly<{
    message: string;
    onOpenApproval: () => void;
    summary?: string | null;
    description?: string | null;
    openLabel?: string;
    presentation: 'banner' | 'line';
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const presentationTheme = usePluginUiTheme(theme);
    const openLabel = props.openLabel ?? t('approvals.review');
    const openTestID = props.testID ? `${props.testID}.open` : undefined;
    if (props.presentation === 'line') {
        return (
            <NoticeLine
                testID={props.testID ?? 'approval-pending-line'}
                iconName="info"
                iconColor={theme.colors.text.secondary}
                subject={props.summary}
                title={props.message}
                action={{ testID: openTestID, label: openLabel, iconName: 'caret-right', onPress: props.onOpenApproval }}
            />
        );
    }
    const palette = theme.colors.state.neutral;
    return (
        // On a page the notice takes a section's place in the flow, like every page banner.
        <ItemGroup surface="none">
            <HappierApprovalPendingNotice
                presentation="banner"
                testID={props.testID}
                theme={presentationTheme}
                title={props.message}
                description={props.description}
                renderText={renderBannerText}
                tint={{ background: palette.background, border: palette.border }}
                icon={<Icon name="info" size={ICON_SIZE.md} color={palette.foreground} />}
                open={<RoundButton testID={openTestID} size="mini" display="secondary" title={openLabel} onPress={props.onOpenApproval} />}
            />
        </ItemGroup>
    );
});

/** App `Text` on the shared banner's text steps (the same as every page banner), so font scaling applies. */
const renderBannerText: HappierApprovalPendingNoticeTextRender = (input) => (
    <Text style={input.role === 'title' ? attentionBannerTextStyles.title : attentionBannerTextStyles.description}>{input.text}</Text>
);

/** Room for a file name and the waiting line; below it the line drops the name, then the words. */
const INLINE_FULL_MIN_PX = 360;
const INLINE_WAITING_MIN_PX = 220;

const styles = StyleSheet.create((theme) => ({
    inlineRoom: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        justifyContent: 'flex-end',
    },
    // The pill never grows past its room: its words truncate inside it and Review stays inside the press target.
    // It never clips: its hit area reaches past the pill.
    inline: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
        paddingHorizontal: theme.space.s8,
        paddingVertical: theme.space.s4,
        borderRadius: theme.borderRadius.md,
    },
    inlineText: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        flexShrink: 1,
        minWidth: 0,
    },
    inlineSubject: {
        color: theme.colors.text.primary,
    },
    inlineAction: {
        flexShrink: 0,
        ...Typography.variant('meta'),
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
}));
