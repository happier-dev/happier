import * as React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';

import { useComposerKeyboardLayout } from './ComposerKeyboardContext';
import type { ComposerKeyboardLayout } from './ComposerKeyboardContext';

function normalizeInsetHeight(height: number): number {
    return typeof height === 'number' && Number.isFinite(height)
        ? Math.max(0, height)
        : 0;
}

function resolveNativeCurrentInsetHeight(layout: ComposerKeyboardLayout): number {
    return normalizeInsetHeight(
        layout.composerHeight.value
        + Math.max(layout.keyboardHeightForInset.value, layout.bottomInset.value),
    );
}

function resolveCurrentInsetHeight(layout: ComposerKeyboardLayout | null): number {
    if (!layout) return 0;
    if (Platform.OS === 'web') {
        return normalizeInsetHeight(layout.listBottomInset.value);
    }
    return resolveNativeCurrentInsetHeight(layout);
}

export function ComposerKeyboardScrollInset(props: Readonly<{
    onHeightChange?: (height: number) => void;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>): React.ReactElement | null {
    const layout = useComposerKeyboardLayout();
    const [height, setHeight] = React.useState(() => resolveCurrentInsetHeight(layout));
    const lastReportedHeightRef = React.useRef<number | null>(null);
    const applyHeight = React.useCallback((nextHeight: number) => {
        const normalizedHeight = normalizeInsetHeight(nextHeight);
        setHeight((current) => (current === normalizedHeight ? current : normalizedHeight));
        if (lastReportedHeightRef.current !== normalizedHeight) {
            lastReportedHeightRef.current = normalizedHeight;
            props.onHeightChange?.(normalizedHeight);
        }
    }, [props.onHeightChange]);

    React.useEffect(() => {
        if (!layout) {
            applyHeight(0);
            return undefined;
        }
        applyHeight(resolveCurrentInsetHeight(layout));
        if (layout.subscribeListBottomInset) {
            return layout.subscribeListBottomInset((nextHeight) => {
                if (Platform.OS === 'web') {
                    applyHeight(nextHeight);
                    return;
                }
                applyHeight(resolveNativeCurrentInsetHeight(layout));
            });
        }
        return undefined;
    }, [applyHeight, layout]);

    if (!layout) {
        return null;
    }

    return (
        <View
            pointerEvents="none"
            testID={props.testID}
            style={[props.style, { height }]}
        />
    );
}
