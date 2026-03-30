import * as React from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

export type WizardLogotypeProps = Readonly<{
    height?: number;
    testID?: string;
}>;

const stylesheet = StyleSheet.create(() => ({
    root: {
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 10,
        marginBottom: 20,
    },
    image: {
        width: 220,
        height: 45,
    },
}));

export const WizardLogotype = React.memo(function WizardLogotype(props: WizardLogotypeProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const height = props.height ?? 28;
    return (
        <View style={styles.root}>
            <Image
                testID={props.testID}
                source={theme.dark ? require('@/assets/images/logotype-light.png') : require('@/assets/images/logotype-dark.png')}
                contentFit="contain"
                style={[styles.image, { height, width: Math.round(height * 5) }]}
            />
        </View>
    );
});
