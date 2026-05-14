import * as React from 'react';
import { ActivityIndicator as NativeActivityIndicator, Platform, View, type ActivityIndicatorProps, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

const DEFAULT_SMALL_SPINNER_SIZE = 20;
const DEFAULT_LARGE_SPINNER_SIZE = 36;
const DEFAULT_NUMERIC_SPINNER_SIZE = 20;
const SPINNER_ANIMATION_NAME = 'happierActivitySpinnerSpin';

type WebActivitySpinnerStyle = ViewStyle & {
    animationDuration?: string;
    animationIterationCount?: string;
    animationName?: string;
    animationTimingFunction?: string;
    borderTopColor?: string;
    willChange?: string;
};

export type ActivitySpinnerProps = Omit<ActivityIndicatorProps, 'size'> & {
    size?: ActivityIndicatorProps['size'] | number;
};

function resolveSpinnerSize(size: ActivityIndicatorProps['size']): number {
    if (typeof size === 'number' && Number.isFinite(size)) {
        return Math.max(1, size);
    }
    if (size === 'large') {
        return DEFAULT_LARGE_SPINNER_SIZE;
    }
    return DEFAULT_SMALL_SPINNER_SIZE;
}

function resolveSpinnerBorderWidth(size: number): number {
    return Math.max(1.5, Math.min(3, size / 8));
}

export function ActivitySpinner(props: ActivitySpinnerProps) {
    const { theme } = useUnistyles();
    const resolvedColor = props.color ?? theme.colors.text.secondary;

    if (Platform.OS !== 'web') {
        return <NativeActivityIndicator {...props} color={resolvedColor} />;
    }

    const {
        animating = true,
        color,
        hidesWhenStopped = true,
        size,
        style,
        ...viewProps
    } = props;

    if (!animating && hidesWhenStopped) {
        return null;
    }

    const resolvedSize = resolveSpinnerSize(size ?? DEFAULT_NUMERIC_SPINNER_SIZE);
    const spinnerStyle: WebActivitySpinnerStyle = {
        width: resolvedSize,
        height: resolvedSize,
        alignSelf: 'center',
        borderRadius: resolvedSize / 2,
        borderWidth: resolveSpinnerBorderWidth(resolvedSize),
        borderColor: typeof resolvedColor === 'string' ? resolvedColor : 'currentColor',
        borderTopColor: 'transparent',
        animationDuration: '850ms',
        animationIterationCount: 'infinite',
        animationName: SPINNER_ANIMATION_NAME,
        animationTimingFunction: 'linear',
        opacity: animating ? 1 : 0,
        willChange: 'transform',
    };

    return (
        <View
            {...viewProps}
            accessibilityRole={props.accessibilityRole ?? 'progressbar'}
            style={[spinnerStyle, style]}
        />
    );
}
