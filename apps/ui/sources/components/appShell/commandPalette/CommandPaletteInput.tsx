import React from 'react';
import { View, Platform } from 'react-native';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { TextInput } from '@/components/ui/text/Text';


interface CommandPaletteInputProps {
    value: string;
    onChangeText: (text: string) => void;
    onKeyPress?: (key: string) => void;
    inputRef?: React.RefObject<React.ElementRef<typeof TextInput> | null>;
    placeholder?: string;
    autoFocus?: boolean;
}

export function CommandPaletteInput({ value, onChangeText, onKeyPress, inputRef, placeholder, autoFocus = true }: CommandPaletteInputProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    const handleKeyDown = React.useCallback((e: any) => {
        if (Platform.OS === 'web' && onKeyPress) {
            const key = e.nativeEvent.key;
            
            // Handle navigation keys
            if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(key)) {
                e.preventDefault();
                e.stopPropagation();
                onKeyPress(key);
            }
        }
    }, [onKeyPress]);

    return (
        <View style={styles.container}>
            <TextInput
                ref={inputRef}
                style={[styles.input, Typography.default()]}
                value={value}
                onChangeText={onChangeText}
                placeholder={placeholder ?? t('commandPalette.placeholder')}
                placeholderTextColor={theme.colors.input.placeholder}
                autoFocus={autoFocus}
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType="go"
                onKeyPress={handleKeyDown}
                blurOnSubmit={false}
            />
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
    },
    input: {
        paddingHorizontal: 32,
        paddingVertical: 24,
        fontSize: 20,
        color: theme.colors.text,
        letterSpacing: -0.3,
        // Remove outline on web
        ...(Platform.OS === 'web' ? {
            outlineStyle: 'none',
            outlineWidth: 0,
        } as any : {}),
    },
}));
