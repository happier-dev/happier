import * as React from 'react';
import { Platform, View, type ViewProps } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

type RetainedPanelSurfaceMode = 'absolute-overlay' | 'flow';

const WebInertView = View as React.ComponentType<
    ViewProps & Pick<React.HTMLAttributes<HTMLElement>, 'inert'>
>;

export const RetainedPanelSurface = React.memo((props: Readonly<{
    isActive: boolean;
    testID?: string;
    mode?: RetainedPanelSurfaceMode;
    children: React.ReactNode;
}>) => {
    const active = props.isActive;
    const [hasMounted, setHasMounted] = React.useState(active);
    const mode = props.mode ?? 'flow';
    const isWeb = Platform.OS === 'web';

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
            <WebInertView
                testID={props.testID}
                pointerEvents={active ? 'auto' : 'none'}
                inert={isWeb && !active ? true : undefined}
                aria-hidden={isWeb && !active ? true : undefined}
                accessibilityElementsHidden={isWeb ? undefined : !active}
                importantForAccessibility={isWeb ? undefined : active ? 'auto' : 'no-hide-descendants'}
                style={[
                    StyleSheet.absoluteFillObject,
                    {
                        opacity: active ? 1 : 0,
                        display: isWeb ? (active ? 'flex' : 'none') : 'flex',
                    },
                ]}
            >
                <PluginSurfaceFocusEligibilityProvider active={active}>
                    {props.children}
                </PluginSurfaceFocusEligibilityProvider>
            </WebInertView>
        );
    }

    return (
        <WebInertView
            testID={props.testID}
            pointerEvents={active ? 'auto' : 'none'}
            inert={isWeb && !active ? true : undefined}
            aria-hidden={isWeb && !active ? true : undefined}
            accessibilityElementsHidden={isWeb ? undefined : !active}
            importantForAccessibility={isWeb ? undefined : active ? 'auto' : 'no-hide-descendants'}
            style={[
                { flex: 1, minHeight: 0, minWidth: 0 },
                !active ? { display: 'none' } : null,
            ]}
        >
            <PluginSurfaceFocusEligibilityProvider active={active}>
                {props.children}
            </PluginSurfaceFocusEligibilityProvider>
        </WebInertView>
    );
});
