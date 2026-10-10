import * as React from 'react';
import { Pressable, View, Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

const stylesheet = StyleSheet.create((theme) => ({
    chip: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    pressed: {
        opacity: motionTokens.press.opacity,
    },
    label: {
        fontSize: Platform.select({ ios: 13, default: 12 }),
        lineHeight: Platform.select({ ios: 16, default: 14 }),
        color: theme.colors.text.primary,
        marginLeft: 4,
    },
}));

export type SelectionListBackChipProps = Readonly<{
    label: string;
    onPress: () => void;
    testID?: string;
}>;

/**
 * Pill back affordance rendered in the SearchHeader's leading slot when the
 * step stack has more than one entry. The leading-slot swap (search-icon ↔
 * back-chip) is owned by `SelectionListSearchHeader`; this component is a
 * pure pressable.
 */
export function SelectionListBackChip(props: SelectionListBackChipProps): React.ReactElement {
    const { theme } = useUnistyles();
    const paintColor = useHappierMaterialColorResolver();
    const styles = stylesheet;
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityLabel={t('selectionList.backTo', { label: props.label })}
            onPress={props.onPress}
            hitSlop={{ top: 6, right: 6, bottom: 6, left: 6 }}
            style={({ pressed }) => [styles.chip, { backgroundColor: paintColor(theme.colors.surface.pressedOverlay) }, pressed && styles.pressed]}
        >
            <Icon name="caret-left" size={14} color={theme.colors.text.secondary} />
            <Text style={styles.label}>{props.label}</Text>
        </Pressable>
    );
}
