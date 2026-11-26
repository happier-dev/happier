import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { View } from 'react-native';
import { HappierSkeletonBlock, HappierSkeletonRows, HappierSkeletonTitle, happierPageTextMetrics, type HappierSkeletonRowsProps } from '@happier-dev/plugin-ui/presentation';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Item } from '@/components/ui/lists/Item';
import { usePageRowMetrics } from '@/components/ui/lists/useResolvedItemDensity';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

export type SkeletonRowsProps = Omit<HappierSkeletonRowsProps, 'theme' | 'color' | 'reducedMotion'>;

/**
 * Happier core's binding of the one loading-rows owner (`HappierSkeletonRows`): core's theme, its quiet
 * skeleton ink and the user's reduced-motion preference. Each list passes only its own row shape
 * (height or row box, line heights, insets, glyph column, hairline), so the rows that land replace the
 * placeholders without a jump.
 */
export const SkeletonRows = React.memo(function SkeletonRows(props: SkeletonRowsProps) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const pluginTheme = usePluginUiTheme(theme);
    return (
        <HappierSkeletonRows
            {...props}
            theme={pluginTheme}
            color={theme.colors.surface.skeleton}
            reducedMotion={reducedMotion}
        />
    );
});

/**
 * Core's binding of the shared title placeholder bar (`HappierSkeletonTitle`): a name still arriving holds its title
 * slot with the loading rows' quiet bar, never the word "Loading…".
 */
export const SkeletonTitle = React.memo(function SkeletonTitle(props: Readonly<{ lineHeight: number; line?: 'title' | 'meta'; testID?: string }>) {
    const { theme } = useUnistyles();
    const pluginTheme = usePluginUiTheme(theme);
    return <HappierSkeletonTitle theme={pluginTheme} lineHeight={props.lineHeight} {...(props.line === undefined ? {} : { line: props.line })}
        {...(props.testID === undefined ? {} : { testID: props.testID })} />;
});

/**
 * One section row whose title and description lines are still arriving: the real `Item` holds its own height,
 * insets and hairline, so the row that lands replaces it without a jump. A section whose row count is not known yet
 * holds one.
 */
export const SkeletonItem = React.memo(function SkeletonItem(props: Readonly<{ testID?: string }>) {
    const rowMetrics = usePageRowMetrics();
    return <Item {...(props.testID === undefined ? {} : { testID: props.testID })}
        title={<SkeletonTitle lineHeight={rowMetrics.title.lineHeight} />}
        subtitle={<SkeletonTitle lineHeight={rowMetrics.subtitle.lineHeight} />}
        showChevron={false} />;
});

const SECTION_TITLE_LINE_HEIGHT = happierPageTextMetrics('sectionTitle').lineHeight;

/**
 * A section title still arriving: the section-title line holding one short bar. A section header sizes its title to
 * the title itself, so the bar takes a fixed width (the receipt's pending value and the page header placeholder's
 * title bar use the same) rather than a share of a width it does not have yet.
 */
export const SkeletonSectionTitle = React.memo(function SkeletonSectionTitle(props: Readonly<{ testID?: string }>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    return <View style={{ height: SECTION_TITLE_LINE_HEIGHT, justifyContent: 'center' }}>
        <HappierSkeletonBlock width={96} height={8} radius={4} color={theme.colors.surface.skeleton} reducedMotion={reducedMotion}
            {...(props.testID === undefined ? {} : { testID: props.testID })} />
    </View>;
});
