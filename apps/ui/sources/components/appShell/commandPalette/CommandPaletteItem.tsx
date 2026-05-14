import React from 'react';
import { View } from 'react-native';
import { Command } from './types';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';


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
                <View style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: theme.colors.surface.pressedOverlay, alignItems: 'center', justifyContent: 'center' }}>
                    <Ionicons
                        name={command.icon as any}
                        size={20}
                        color={isSelected ? theme.colors.accent.blue : theme.colors.text.secondary}
                    />
                </View>
            ) : null}
            title={command.title}
            subtitle={command.subtitle ?? undefined}
            right={command.shortcut ? <KeyHint label={command.shortcut} /> : null}
        />
    );
}
