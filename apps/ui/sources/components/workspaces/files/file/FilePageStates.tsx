import * as React from 'react';
import { StyleSheet as NativeStyleSheet, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable, HappierSkeletonBlock, formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

import { CODE_EDITOR_BASE_LINE_HEIGHT, CODE_GUTTER_METRICS } from '@/components/ui/code/editor/codeEditorFontMetrics';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useSurfaceStateElapsedSeconds } from '@/components/ui/surfaces/useSurfaceStateElapsedSeconds';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { getPreferredLanguage, t } from '@/text';

/** A file size as the page says it everywhere ("38.4 MB"): storage units in the viewer's locale. */
export function formatFilePageBytes(bytes: number): string {
    return formatHappierDataBytes(bytes, { kind: 'storage', locale: getPreferredLanguage() });
}

/** Line lengths of the placeholder, as a fraction of the reading column: a code-shaped rhythm, not a grid. */
const SKELETON_LINE_SHAPE = [0.52, 0.58, 0.48, 0.55, 0.62, 0.5, 0, 0.28, 0.23, 0.25, 0.1, 0, 0.07, 0.6, 0.58, 0.07, 0.53, 0.48, 0.37] as const;

/**
 * The body of a text file that is still on its way (lab FV1l): code-height lines with their gutter, so
 * the text replaces them without a shift. The header above already names the file.
 */
export function FileCodeSkeleton(props: Readonly<{ active?: boolean; testID?: string }>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const ink = theme.colors.surface.inset;
    return (
        <View testID={props.testID ?? 'file-details-loading'} style={styles.skeleton} accessibilityRole="progressbar"
            accessibilityLabel={t('common.loading')} aria-busy>
            {SKELETON_LINE_SHAPE.map((fraction, index) => (
                <View key={index} style={styles.skeletonRow}>
                    <View style={styles.skeletonGutter}>
                        <HappierSkeletonBlock color={ink} width={12} height={6} radius={3} animationEnabled={props.active !== false} reducedMotion={reducedMotion} />
                    </View>
                    {fraction > 0 ? (
                        <HappierSkeletonBlock color={ink} width={`${Math.round(fraction * 100)}%`} height={8} radius={4}
                            animationEnabled={props.active !== false} reducedMotion={reducedMotion} />
                    ) : null}
                </View>
            ))}
        </View>
    );
}

/**
 * "Reading it from MacBook Pro · 4 s": the present of a read that goes through a Machine, from its start
 * (RV-B m10). A leaf with its own clock, so the seconds never re-render the page.
 */
export function FileReadingLine(props: Readonly<{ machineName: string; testID?: string }>) {
    const { theme } = useUnistyles();
    const seconds = useSurfaceStateElapsedSeconds();
    return (
        <View testID={props.testID ?? 'file-details-reading'} style={styles.readingLine} accessibilityRole="text"
            accessibilityLiveRegion="polite" aria-live="polite">
            <ActivitySpinner size={12} color={theme.colors.text.tertiary} />
            <Text style={styles.readingText} numberOfLines={1}>
                {t('files.pane.page.readingFrom', { machine: props.machineName, seconds })}
            </Text>
        </View>
    );
}

/**
 * A file larger than the preview budget (lab FV2): what it is, and the ways to look at it. A text file
 * offers its first slice, its last (log tails) and Download; a file that can't be sliced offers Download.
 * Nothing failed, so nothing is red.
 */
export function FileTooLargeState(props: Readonly<{
    /** Absent when the Machine only said the file is over the budget. */
    sizeBytes: number | null;
    /** Text files only: the slice a partial view reads. */
    sliceBytes?: number;
    onShowFirst?: () => void;
    onShowLast?: () => void;
    onDownload?: () => void;
}>) {
    const size = props.sizeBytes === null ? null : formatFilePageBytes(props.sizeBytes);
    const slice = typeof props.sliceBytes === 'number' ? formatFilePageBytes(props.sliceBytes) : null;
    const download = props.onDownload
        ? { label: t('files.repositoryTree.actions.download'), onPress: props.onDownload, testID: 'file-details-too-large-download' }
        : undefined;
    const sliceable = slice !== null && props.onShowFirst && props.onShowLast;
    return (
        <SurfaceStateCard
            testID="file-details-too-large"
            kind="empty"
            iconName="file-text"
            title={size ? t('files.pane.page.tooLargeTitle', { size }) : t('files.fileTooLargeToPreview')}
            reason={sliceable ? t('files.pane.page.tooLargeBody', { slice }) : undefined}
            action={sliceable ? { label: t('files.pane.page.showFirst', { slice }), onPress: props.onShowFirst!, testID: 'file-details-show-first' } : download}
            secondaryAction={sliceable ? download : undefined}
            learnMore={sliceable ? { label: t('files.pane.page.showLast', { slice }), onPress: props.onShowLast!, testID: 'file-details-show-last' } : undefined}
        />
    );
}

/**
 * The end of a partial view (lab FV2t): which part is showing, and the whole file one tap away. It stays at
 * the bottom of the body while the slice scrolls.
 */
export function FilePartialFooter(props: Readonly<{
    slice: 'head' | 'tail';
    sliceBytes: number;
    totalBytes: number;
    onDownload?: () => void;
}>) {
    const { theme } = useUnistyles();
    const values = { slice: formatFilePageBytes(props.sliceBytes), size: formatFilePageBytes(props.totalBytes) };
    return (
        <View testID="file-details-partial" style={styles.partial}>
            <Icon name="info" size={14} color={theme.colors.text.tertiary} />
            <Text style={styles.partialText} numberOfLines={1}>
                {props.slice === 'head' ? t('files.pane.page.showingFirst', values) : t('files.pane.page.showingLast', values)}
            </Text>
            {props.onDownload ? (
                <HappierPressable testID="file-details-partial-download" accessibilityRole="button" accessibilityLabel={t('files.pane.page.downloadWholeFile')}
                    onPress={props.onDownload}
                    style={({ focused }) => [styles.partialLink, focusRingStyle({ focused, color: theme.colors.border.focus })]}>
                    <Text style={styles.partialLinkLabel}>{t('files.pane.page.downloadWholeFile')}</Text>
                </HappierPressable>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    skeleton: {
        paddingTop: CODE_GUTTER_METRICS.rowPadding,
    },
    skeletonRow: {
        height: CODE_EDITOR_BASE_LINE_HEIGHT,
        flexDirection: 'row',
        alignItems: 'center',
    },
    skeletonGutter: {
        width: CODE_GUTTER_METRICS.numberMinWidth + CODE_GUTTER_METRICS.numberPaddingLeft + CODE_GUTTER_METRICS.numberPaddingRight,
        paddingLeft: CODE_GUTTER_METRICS.numberPaddingLeft + theme.space.s8,
    },
    readingLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minHeight: 32,
        paddingHorizontal: theme.space.s16,
        borderBottomWidth: NativeStyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.subtle,
    },
    readingText: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
        flexShrink: 1,
    },
    partial: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minHeight: 40,
        paddingHorizontal: theme.space.s16,
        borderTopWidth: NativeStyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.subtle,
        backgroundColor: theme.colors.surface.base,
    },
    partialText: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        flex: 1,
        minWidth: 0,
        fontVariant: ['tabular-nums'],
    },
    partialLink: {
        justifyContent: 'center',
        minHeight: 32,
        paddingHorizontal: theme.space.s4,
        borderRadius: theme.space.s4,
    },
    partialLinkLabel: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.link,
    },
}));
