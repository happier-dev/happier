import {
    iconMatchedSpinnerSize,
    resolveHappierWebSpinnerPresentation,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import {
    ActivityIndicator as RNActivityIndicator,
    Platform,
    View,
    type ActivityIndicatorProps as RNActivityIndicatorProps,
} from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

export { iconMatchedSpinnerSize };

export type ActivitySpinnerProps = RNActivityIndicatorProps & Readonly<{
    /** Keep the web spinner visible while disabling the CSS transform animation. */
    animationEnabled?: boolean;
}>;

/**
 * Happier core's activity-spinner adapter.
 *
 * The shared presentation owner supplies web-spinner visibility, sizing and
 * motion semantics. This adapter owns the native RN hosts and their complete
 * style/prop contract, plus the resolved Unistyles colour and app-wide
 * reduced-motion preference (§3.10.2).
 *
 * The preference is read only on the web branch, exactly as before. Spinners
 * mount by the hundred in virtualized lists, and the native branch cannot use
 * the value — subscribing every instance to a preference it ignores is the cost
 * the split here exists to avoid.
 */
export function ActivitySpinner(props: ActivitySpinnerProps) {
    const { theme } = useUnistyles();
    const resolvedColor = props.color ?? theme.colors.text.secondary;

    if (Platform.OS !== 'web') {
        const { animationEnabled: _animationEnabled, ...nativeProps } = props;
        return <RNActivityIndicator {...nativeProps} color={resolvedColor} />;
    }

    return <WebActivitySpinner {...props} resolvedColor={resolvedColor} />;
}

function WebActivitySpinner(props: ActivitySpinnerProps & Readonly<{ resolvedColor: unknown }>) {
    const reducedMotion = useReducedMotionPreference();

    const {
        animating,
        animationEnabled,
        color: _color,
        hidesWhenStopped,
        size,
        style,
        resolvedColor,
        ...viewProps
    } = props;
    const presentation = resolveHappierWebSpinnerPresentation({
        animating,
        animationEnabled,
        color: resolvedColor,
        hidesWhenStopped,
        reducedMotion,
        size,
    });

    if (!presentation) {
        return null;
    }

    return (
        <View
            {...viewProps}
            accessibilityRole={props.accessibilityRole ?? presentation.accessibilityRole}
            style={[presentation.style, style]}
        />
    );
}
