import * as React from 'react';
import { Platform, ScrollView, View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { layout } from '@/components/ui/layout/layout';
import { useModalCardDimensions } from '@/modal/components/card/useModalCardDimensions';
import { shadowLevelStyle } from '@/shadowElevation';

export type WizardCardLayoutProps = Readonly<{
    children: React.ReactNode;
    testID?: string;
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
    },
    container: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 20,
        paddingVertical: 24,
        minHeight: '100%',
    },
    card: {
        alignSelf: 'center',
        borderRadius: theme.borderRadius.modalCard,
        backgroundColor: theme.colors.surface,
        overflow: 'hidden',
        flexDirection: 'column',
        flexGrow: 0,
        flexShrink: 1,
        minHeight: 0,
        ...Platform.select({
            web: {
                height: 'auto',
            },
            default: {},
        }),
        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
    },
}));

export function WizardCardLayout(props: WizardCardLayoutProps) {
    useUnistyles();
    const styles = stylesheet;
    const dimensions = useModalCardDimensions({
        size: 'md',
        width: 500,
    });
    const cardWidth = Math.min(dimensions.width, layout.maxWidth);
    const metrics: WizardCardLayoutMetrics = React.useMemo(() => ({
        cardWidth,
    }), [cardWidth]);
    return (
        <ScrollView
            style={styles.root}
            contentContainerStyle={styles.container}
            showsVerticalScrollIndicator={false}
        >
            <View
                testID={props.testID}
                style={[
                    styles.card,
                    props.style,
                    {
                        width: cardWidth,
                        maxWidth: cardWidth,
                    },
                ]}
            >
                <WizardCardLayoutMetricsContext.Provider value={metrics}>
                    {props.children}
                </WizardCardLayoutMetricsContext.Provider>
            </View>
        </ScrollView>
    );
}
