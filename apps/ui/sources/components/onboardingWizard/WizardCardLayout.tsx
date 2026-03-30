import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { layout } from '@/components/ui/layout/layout';
import { useModalCardDimensions } from '@/modal/components/card/useModalCardDimensions';
import { shadowLevelStyle } from '@/shadowElevation';

export type WizardCardLayoutProps = Readonly<{
    children: React.ReactNode;
    testID?: string;
    style?: StyleProp<ViewStyle>;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 20,
        paddingVertical: 24,
        backgroundColor: theme.colors.groupped.background,
    },
    card: {
        // Match our canonical modal/command-palette card frame radius.
        borderRadius: 14,
        backgroundColor: theme.colors.surface,
        overflow: 'hidden',
        flexDirection: 'column',
        ...shadowLevelStyle(theme.colors.shadowLevels[4]),
    },
}));

export function WizardCardLayout(props: WizardCardLayoutProps) {
    useUnistyles();
    const styles = stylesheet;
    const dimensions = useModalCardDimensions({
        size: 'md',
        width: 560,
    });
    const cardWidth = Math.min(dimensions.width, layout.maxWidth);
    return (
        <View style={styles.root}>
            <View
                testID={props.testID}
                style={[
                    styles.card,
                    {
                        width: cardWidth,
                        maxWidth: cardWidth,
                        height: dimensions.maxHeight,
                        maxHeight: dimensions.maxHeight,
                    },
                    props.style,
                ]}
            >
                {props.children}
            </View>
        </View>
    );
}
