import * as React from 'react';
import { Platform, ScrollView, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { layout } from '@/components/ui/layout/layout';
import { useModalCardDimensions } from '@/modal/components/card/useModalCardDimensions';
import { shadowLevelStyle } from '@/shadowElevation';

export type WizardCardLayoutProps = Readonly<{
    children: React.ReactNode;
    testID?: string;
    presentation?: 'auto' | 'card' | 'fullscreen';
    style?: StyleProp<ViewStyle>;
}>;

type WizardCardLayoutMetrics = Readonly<{
    cardWidth: number;
}>;

const WizardCardLayoutMetricsContext = React.createContext<WizardCardLayoutMetrics | null>(null);

export function useWizardCardLayoutMetrics(): WizardCardLayoutMetrics | null {
    return React.useContext(WizardCardLayoutMetricsContext);
}

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        backgroundColor: theme.colors.overlay.scrimWizard,
        ...Platform.select({
            web: {
                // Ensure the wizard scrim covers the entire viewport even when rendered
                // inside other modal shells that size to content.
                minHeight: '100vh',
                height: '100vh',
                width: '100%',
            },
            default: {},
        }),
    },
    rootFullscreen: {
        flex: 1,
        backgroundColor: theme.colors.surface,
        ...Platform.select({
            web: {
                minHeight: '100vh',
                height: '100vh',
                width: '100%',
            },
            default: {},
        }),
    },
    container: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 20,
        paddingVertical: 24,
        flexGrow: 1,
    },
    containerFullscreen: {
        alignItems: 'stretch',
        justifyContent: 'flex-start',
        paddingHorizontal: 0,
        paddingVertical: 0,
        flexGrow: 1,
    },
    cardBase: {
        alignSelf: 'center',
        overflow: 'hidden',
        flexDirection: 'column',
        flexGrow: 0,
        flexShrink: 1,
        minHeight: 0,
    },
    card: {
        borderRadius: theme.borderRadius.modalCard,
        backgroundColor: theme.colors.surface,
        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
    },
    cardFullscreen: {
        borderRadius: 0,
        backgroundColor: theme.colors.surface,
    },
}));

export function WizardCardLayout(props: WizardCardLayoutProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { width: windowWidth } = useWindowDimensions();
    const dimensions = useModalCardDimensions({
        size: 'md',
        width: 500,
    });
    const presentation = props.presentation ?? 'auto';
    const wantsFullscreen = presentation === 'fullscreen' || (presentation === 'auto' && windowWidth <= 430);
    const cardWidth = wantsFullscreen ? windowWidth : Math.min(dimensions.width, layout.maxWidth);
    const metrics: WizardCardLayoutMetrics = React.useMemo(() => ({
        cardWidth,
    }), [cardWidth]);
    const webBackdropStyle = Platform.OS === 'web' && !wantsFullscreen
        ? ({ backdropFilter: 'blur(6px)' } as unknown as ViewStyle)
        : null;
    const webFixedViewportStyle = Platform.OS === 'web' && !wantsFullscreen
        ? ({
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
        } as unknown as ViewStyle)
        : null;
    return (
        <ScrollView
            style={[
                wantsFullscreen ? styles.rootFullscreen : styles.root,
                webBackdropStyle,
                webFixedViewportStyle,
            ]}
            contentContainerStyle={wantsFullscreen ? styles.containerFullscreen : styles.container}
            showsVerticalScrollIndicator={false}
        >
            <View
                testID={props.testID ? `${props.testID}-card` : undefined}
                {...(Platform.OS === 'web'
                    ? ({ dataSet: { happyModalCardBoundary: 'true' } } as unknown as Record<string, unknown>)
                    : null)}
                style={[
                    styles.cardBase,
                    wantsFullscreen ? styles.cardFullscreen : styles.card,
                    wantsFullscreen ? { borderRadius: 0 } : null,
                    props.style,
                    wantsFullscreen
                        ? { width: '100%', maxWidth: '100%' }
                        : { width: cardWidth, maxWidth: cardWidth },
                ]}
            >
                <WizardCardLayoutMetricsContext.Provider value={metrics}>
                    {props.children}
                </WizardCardLayoutMetricsContext.Provider>
            </View>
        </ScrollView>
    );
}
