import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonRows, HappierSkeletonTitle, type HappierSkeletonRowsProps } from '@happier-dev/plugin-ui/presentation';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
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
export const SkeletonTitle = React.memo(function SkeletonTitle(props: Readonly<{ lineHeight: number; testID?: string }>) {
    const { theme } = useUnistyles();
    const pluginTheme = usePluginUiTheme(theme);
    return <HappierSkeletonTitle theme={pluginTheme} lineHeight={props.lineHeight} {...(props.testID === undefined ? {} : { testID: props.testID })} />;
});
