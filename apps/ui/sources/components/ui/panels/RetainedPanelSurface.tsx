import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

type RetainedPanelSurfaceMode = 'absolute-overlay' | 'flow';

export const RetainedPanelSurface = React.memo((props: Readonly<{
    isActive: boolean;
    testID?: string;
    mode?: RetainedPanelSurfaceMode;
    children: React.ReactNode;
}>) => {
    const active = props.isActive;
    const [hasMounted, setHasMounted] = React.useState(active);
    const mode = props.mode ?? 'flow';

    React.useLayoutEffect(() => {
        if (active) {
            setHasMounted(true);
        }
    }, [active]);

    if (!active && !hasMounted) {
        return null;
    }

    if (mode === 'absolute-overlay') {
        return (
            <View
                testID={props.testID}
                pointerEvents={active ? 'auto' : 'none'}
                style={[
                    StyleSheet.absoluteFillObject,
                    {
                        opacity: active ? 1 : 0,
                        display: Platform.OS === 'web' ? (active ? 'flex' : 'none') : 'flex',
                    },
                ]}
            >
                {props.children}
            </View>
        );
    }

    return (
        <View
            testID={props.testID}
            pointerEvents={active ? 'auto' : 'none'}
            style={[
                { flex: 1, minHeight: 0, minWidth: 0 },
                !active ? { display: 'none' } : null,
            ]}
        >
            {props.children}
        </View>
    );
});
