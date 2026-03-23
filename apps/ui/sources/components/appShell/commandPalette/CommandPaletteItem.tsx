import React from 'react';
import { View } from 'react-native';
import { Command } from './types';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';


interface CommandPaletteItemProps {
    command: Command;
    isSelected: boolean;
    onPress: () => void;
    onHover?: () => void;
}

export function CommandPaletteItem({ command, isSelected, onPress, onHover }: CommandPaletteItemProps) {
    const { theme } = useUnistyles();

    return (
        <SelectableRow
            variant="selectable"
            selected={isSelected}
            onPress={onPress}
            onHover={onHover}
            left={command.icon ? (
                <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: theme.colors.surfacePressedOverlay, alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons
                        name={command.icon as any}
                        size={20}
                        color={isSelected ? theme.colors.accent.blue : theme.colors.textSecondary}
                    />
                </View>
            ) : null}
            title={command.title}
            subtitle={command.subtitle ?? undefined}
            right={command.shortcut ? (
                <View style={{ paddingHorizontal: 10, paddingVertical: 5, backgroundColor: theme.colors.surfacePressedOverlay, borderRadius: 6 }}>
                    <Text style={{ ...Typography.mono(), fontSize: 12, color: theme.colors.textSecondary, fontWeight: '500' }}>
                        {command.shortcut}
                    </Text>
                </View>
            ) : null}
        />
    );
}
