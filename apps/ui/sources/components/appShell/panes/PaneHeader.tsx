import * as React from 'react';
import { View, type StyleProp, type TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics, useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import type { PluginUiDetailsPanePresentation } from '@happier-dev/plugin-ui/advanced';

import { IconButton } from '@/components/ui/buttons/IconButton';
import {
    HEADER_BAND_HORIZONTAL_PADDING_PX,
    HEADER_BAND_SUBTITLE_TEXT,
    HEADER_BAND_TITLE_TEXT,
} from '@/components/ui/layout/headerBand';
import { pageTitleTypography } from '@/components/ui/layout/pageTitleTypography';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useHeaderHeight } from '@/utils/platform/responsive';

import type { PaneHeaderLine, PaneHeaderLineSegment } from './paneHeaderSlot';

export type { PaneHeaderLine, PaneHeaderLineSegment } from './paneHeaderSlot';

/** `+4 −2` reads as one fact: two change counts in a row are spaced, not dotted. */
function isToneSegment(segment: PaneHeaderLineSegment): boolean {
    return typeof segment !== 'string' && 'tone' in segment;
}

/** What a pane says about itself at the top: a title, an optional subtitle, optional actions. */
export type PaneHeaderContent = Readonly<{
    title: string;
    subtitle?: string | null;
    /**
     * The live line under the title (a branch, a count, what is waiting): real nouns joined by " · ".
     * Takes the subtitle's place when both are given.
     */
    line?: PaneHeaderLine | null;
    /** Trailing actions (icon buttons), before the close button. */
    actions?: React.ReactNode;
}>;

export type PaneHeaderProps = PaneHeaderContent & Readonly<{
    /** Semantic focus binding supplied by the pane content owner. */
    headingRef?: PluginUiDetailsPanePresentation['headingRef'];
    /** Identity mark beside the title; it has no backing tile. */
    leading?: React.ReactNode;
    /** A title that is itself a control, such as a named-object switcher. */
    titleControl?: React.ReactNode;
    /** null allows a long title to wrap; the default pane band stays on one line. */
    titleNumberOfLines?: number | null;
    titleTextStyle?: StyleProp<TextStyle>;
    /** View controls aligned with the facts rather than with the title actions. */
    lineTrailing?: React.ReactNode;
    /** An inline affordance belonging to the final fact (copying its identifier). */
    lineEnd?: React.ReactNode;
    /** Shows the close button. */
    onClose?: () => void;
    /**
     * `band` (default): the side pane's header, in the session header's band. `large`: a phone
     * screen's large title over the same live line, below the navigation bar.
     */
    size?: 'band' | 'large';
    testID?: string;
}>;

/**
 * The header of a side pane (the right sidebar and the details pane). It sits in the same band as
 * the session header beside it — same height, inset and text — so the two read as one line.
 */
export const PaneHeader = React.memo(function PaneHeader(props: PaneHeaderProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const height = useHeaderHeight();
    const testID = props.testID ?? 'pane-header';
    const large = props.size === 'large';
    const line = props.line ?? (props.subtitle ? { segments: [props.subtitle] } : null);
    return (
        <View testID={testID} style={[large ? styles.large : [styles.band, { height }], { backgroundColor: materialColor(theme.colors.surface.base, 'transparent') }]}>
            <View style={styles.titleBlock}>
                <View style={styles.titleRow}>
                {props.leading ? <View style={styles.identityMark}>{props.leading}</View> : null}
                {props.titleControl ?? (
                <Text
                    ref={props.headingRef}
                    tabIndex={props.headingRef ? -1 : undefined}
                    testID={`${testID}.title`}
                    numberOfLines={props.titleNumberOfLines === null ? undefined : props.titleNumberOfLines ?? 1}
                    accessibilityRole="header"
                    style={[large ? styles.largeTitle : styles.title, styles.titleText, props.titleTextStyle]}
                >
                    {props.title}
                </Text>
                )}
                </View>
                {(line && (line.segments.length > 0 || line.leading)) || props.lineTrailing ? (
                    <View style={[styles.line, large ? styles.largeLine : null]}>
                        {line?.leading ? <View style={[styles.lineLeading, line.segments.length === 0 ? styles.leadingOnly : null]}>{line.leading}</View> : null}
                        {line && line.segments.length > 0 ? <Text testID={`${testID}.subtitle`} numberOfLines={1} style={[styles.subtitle, large ? styles.largeSubtitle : null]}>
                            {line.segments.map((segment, index) => (
                                <React.Fragment key={index}>
                                    {index > 0 ? (isToneSegment(segment) && isToneSegment(line.segments[index - 1]!) ? ' ' : ' · ') : null}
                                    {typeof segment === 'string'
                                        ? segment
                                        : 'tone' in segment
                                            ? <Text style={segment.tone === 'added' ? styles.added : styles.removed}>{segment.text}</Text>
                                            : 'attention' in segment
                                                ? <Text style={styles.attention}>{segment.text}</Text>
                                                : <Text style={styles.emphasis}>{segment.text}</Text>}
                                </React.Fragment>
                            ))}
                        </Text> : null}
                        {props.lineEnd}
                        {props.lineTrailing ? <View style={styles.lineTrailing}>{props.lineTrailing}</View> : null}
                    </View>
                ) : null}
            </View>
            {props.actions ? <View style={styles.actions}>{props.actions}</View> : null}
            {props.onClose ? (
                <IconButton
                    testID={`${testID}.close`}
                    iconName="x"
                    accessibilityLabel={t('common.close')}
                    tooltip={props.size === 'large' ? undefined : t('common.close')}
                    variant="plain"
                    onPress={props.onClose}
                />
            ) : null}
        </View>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    band: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        paddingLeft: HEADER_BAND_HORIZONTAL_PADDING_PX,
        paddingRight: HEADER_BAND_HORIZONTAL_PADDING_PX / 2,
        gap: 2,
        backgroundColor: theme.colors.surface.base,
    },
    large: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        flexShrink: 0,
        paddingHorizontal: HEADER_BAND_HORIZONTAL_PADDING_PX,
        paddingTop: 12,
        paddingBottom: 12,
        gap: 8,
        backgroundColor: theme.colors.surface.base,
    },
    titleBlock: {
        flex: 1,
        minWidth: 0,
        justifyContent: 'center',
    },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
    titleText: { flexShrink: 1, minWidth: 0 },
    identityMark: { flexShrink: 0, alignSelf: 'flex-start', marginTop: 2 },
    lineTrailing: { flexShrink: 0, marginLeft: 'auto' },
    largeTitle: {
        ...pageTitleTypography(),
        color: theme.colors.text.primary,
    },
    line: {
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
        gap: 4,
    },
    largeLine: {
        marginTop: 4,
    },
    lineLeading: {
        flexShrink: 0,
        marginTop: HEADER_BAND_SUBTITLE_TEXT.marginTop,
    },
    leadingOnly: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        ...HEADER_BAND_TITLE_TEXT,
        ...Typography.default('semiBold'),
        color: theme.colors.chrome.header.foreground,
    },
    subtitle: {
        ...HEADER_BAND_SUBTITLE_TEXT,
        ...Typography.default(),
        flexShrink: 1,
        minWidth: 0,
        color: theme.colors.text.secondary,
    },
    largeSubtitle: {
        ...happierPageTextMetrics('pageDescription'),
        marginTop: 0,
    },
    emphasis: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    attention: {
        ...Typography.default('semiBold'),
        color: theme.colors.state.warning.foreground,
    },
    added: {
        color: theme.colors.diff.success,
        fontVariant: ['tabular-nums'],
    },
    removed: {
        color: theme.colors.diff.error,
        fontVariant: ['tabular-nums'],
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
}));
