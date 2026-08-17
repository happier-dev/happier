import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierProgress } from '@happier-dev/plugin-ui/presentation';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useUnistyles } from 'react-native-unistyles';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { t } from '@/text';

const TRACK_HEIGHT = 2;

// When loading begins before the engine reports a real fraction we still show a
// visible sliver so the surface never reads as frozen, growing toward this cap.
const INDETERMINATE_WIDTH = 0.15;
const MIN_VISIBLE_WIDTH = 0.04;

const stylesheet = StyleSheet.create((theme) => ({
    track: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: TRACK_HEIGHT,
        backgroundColor: 'transparent',
        overflow: 'hidden',
        zIndex: 2,
    },
    fill: {
        height: TRACK_HEIGHT,
        backgroundColor: theme.colors.accent.blue,
    },
    glow: {
        shadowColor: theme.colors.accent.blue,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.9,
        shadowRadius: 4,
    },
}));

export function BrowserLoadProgressBar(props: Readonly<{
    progress: number | null;
    loading: boolean;
    reducedMotion?: boolean;
    testID?: string;
}>): React.ReactElement | null {
    const detectedReducedMotion = useReducedMotionPreference();
    const { theme } = useUnistyles();
    const presentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
    const reducedMotion = props.reducedMotion ?? detectedReducedMotion;
    const testID = props.testID ?? 'browser-load-progress';

    if (!props.loading) {
        return null;
    }

    return (
        <HappierProgress
            testID={testID}
            label={t('common.loading')}
            value={props.progress ?? undefined}
            theme={presentationTheme}
            pointerEvents="none"
            style={stylesheet.track}
            renderFill={(percentage) => (
              <View
                testID={`${testID}-fill`}
                style={[
                    stylesheet.fill,
                    { width: `${Math.max(
                        Math.round(MIN_VISIBLE_WIDTH * 100),
                        props.progress === null ? Math.round(INDETERMINATE_WIDTH * 100) : percentage,
                    )}%` },
                    reducedMotion ? null : stylesheet.glow,
                ]}
              />
            )}
        />
    );
}
