import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SystemTaskProgressCard } from '@/components/systemTasks';
import type { SystemTaskRunState } from '@/components/systemTasks/types';
import { createBackdropNativeStyle, createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';

const stylesheet = StyleSheet.create({
    overlay: {
        ...StyleSheet.absoluteFillObject,
        position: 'absolute',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 12,
        borderRadius: 12,
        overflow: 'hidden',
    },
    overlayCard: {
        width: '100%',
        maxWidth: 420,
    },
});

export const RelayAccessWizardBusyOverlay = React.memo(function RelayAccessWizardBusyOverlay(props: Readonly<{
    testID?: string;
    snapshot: SystemTaskRunState | null;
    visible: boolean;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    if (!props.visible || !props.snapshot) {
        return null;
    }

    const overlayScrimColor = theme.colors.overlay?.scrimWizard ?? theme.colors.surface.base;

    return (
        <View testID={props.testID} style={styles.overlay}>
            {Platform.OS !== 'web' ? (
                (() => {
                    try {
                        // eslint-disable-next-line @typescript-eslint/no-var-requires
                        const { BlurView } = require('expo-blur');
                        if (BlurView) {
                            return (
                                <BlurView
                                    intensity={Platform.OS === 'ios' ? 12 : 3}
                                    tint="default"
                                    pointerEvents="none"
                                    style={StyleSheet.absoluteFillObject}
                                />
                            );
                        }
                    } catch {
                        // fall back
                    }
                    return (
                        <View
                            pointerEvents="none"
                            style={[
                                StyleSheet.absoluteFillObject,
                                createBackdropNativeStyle({ backgroundColor: overlayScrimColor }),
                            ]}
                        />
                    );
                })()
            ) : (
                <View
                    pointerEvents="none"
                    style={[
                        StyleSheet.absoluteFillObject,
                        (createBackdropWebStyle({ backgroundColor: overlayScrimColor, blurPx: 2 }) as unknown as Record<string, unknown>),
                    ]}
                />
            )}
            <View style={styles.overlayCard}>
                <SystemTaskProgressCard
                    snapshot={props.snapshot}
                    variant="checklistOnly"
                    title={null}
                    showStepMessages={false}
                    showOpenLogs={false}
                />
            </View>
        </View>
    );
});
