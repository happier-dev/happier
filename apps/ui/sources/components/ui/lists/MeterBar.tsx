import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { HappierProgress } from '@happier-dev/plugin-ui/presentation';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

export type MeterTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface MeterBarProps {
    tone: MeterTone;
    /**
     * Visual fill in 0..1 (clamped); the bar decides nothing about what it means. Progress
     * consumers pass the done/consumed fraction; quota rows do not use `MeterBar` directly —
     * `UsageMeterRow` owns quota rows and fills them with what is left.
     */
    fillFraction: number;
    caption?: React.ReactNode;
    /** Track height in px (default 6). */
    height?: number;
    trackColor?: string;
    /** A host surface may bind an existing neutral text fill instead of a state tint. */
    fillColor?: string;
    /**
     * When the bar reports progress (not a capacity), its accessible name. The bar then exposes
     * `progressbar` semantics with the fill as a 0–100 value.
     */
    progressAccessibilityLabel?: string;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}

const DEFAULT_TRACK_HEIGHT_PX = 6;

const stylesheet = StyleSheet.create((theme) => ({
    caption: {
        color: theme.colors.text.secondary,
        marginTop: 4,
        fontSize: 12,
        lineHeight: 16,
    },
}));

export const MeterBar = React.memo<MeterBarProps>((props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const height = props.height ?? DEFAULT_TRACK_HEIGHT_PX;
    const presentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
    const fill = Number.isFinite(props.fillFraction) ? props.fillFraction : 0;
    // Read the token directly — never apply a runtime opacity/rgba transform to a
    // theme token (web var-ification turns such transforms into silent no-ops).
    const fillColor = props.fillColor ?? theme.colors.state[props.tone].foreground;
    const trackColor = props.trackColor ?? (theme.dark ? theme.colors.surface.pressedOverlay : theme.colors.border.default);

    return (
        <View
            testID={props.testID}
            style={props.style}
        >
            <HappierProgress
                testID={props.testID ? `${props.testID}:track` : undefined}
                fillTestID={props.testID ? `${props.testID}:fill` : undefined}
                value={fill}
                label={props.progressAccessibilityLabel ?? ''}
                semantics={props.progressAccessibilityLabel ? 'progress' : 'none'}
                theme={presentationTheme}
                height={height}
                fillColor={fillColor}
                trackColor={trackColor}
                style={{ width: '100%' }}
            />
            {props.caption != null ? (
                typeof props.caption === 'string' || typeof props.caption === 'number' ? (
                    <Text
                        testID={props.testID ? `${props.testID}:caption` : undefined}
                        style={styles.caption}
                    >
                        {props.caption}
                    </Text>
                ) : (
                    props.caption
                )
            ) : null}
        </View>
    );
});

MeterBar.displayName = 'MeterBar';
