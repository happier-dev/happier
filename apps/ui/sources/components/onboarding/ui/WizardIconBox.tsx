import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Icon, type IconName } from '@/components/ui/icons/Icon';

type WizardIconBoxProps = Readonly<{
    icon: IconName;
    selected?: boolean;
    boxSize?: number;
    iconSize?: number;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 8,
        backgroundColor: theme.colors.surface.pressedOverlay,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    selected: {
        borderColor: theme.colors.border.strong,
        backgroundColor: theme.colors.surface.pressedOverlay,
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
            <Icon
                name={props.icon}
                size={iconSize}
                color={selected ? theme.colors.text.primary : theme.colors.text.secondary}
            />
        </View>
    );
});
