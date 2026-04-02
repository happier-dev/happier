import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

type WizardIconBoxProps = Readonly<{
    icon: React.ComponentProps<typeof Ionicons>['name'];
    selected?: boolean;
    boxSize?: number;
    iconSize?: number;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 8,
        backgroundColor: theme.colors.surfacePressedOverlay,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    selected: {
        borderColor: theme.colors.accent.blue,
        backgroundColor: theme.colors.surfaceSelected,
    },
}));

export const WizardIconBox = React.memo(function WizardIconBox(props: WizardIconBoxProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const size = props.boxSize ?? 32;
    const iconSize = props.iconSize ?? 18;
    const selected = props.selected === true;

    return (
        <View
            style={[
                styles.root,
                {
                    width: size,
                    height: size,
                },
                selected ? styles.selected : null,
            ]}
        >
            <Ionicons
                name={props.icon}
                size={iconSize}
                color={selected ? theme.colors.accent.blue : theme.colors.textSecondary}
            />
        </View>
    );
});
