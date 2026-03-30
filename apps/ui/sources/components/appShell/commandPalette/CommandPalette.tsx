import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';

import { CommandPaletteInput } from './CommandPaletteInput';
import { CommandPaletteResults } from './CommandPaletteResults';
import { useCommandPalette } from './useCommandPalette';
import { Command } from './types';

export type CommandPaletteProps = CustomModalInjectedProps & Readonly<{
    commands: Command[];
}>;

const stylesheet = StyleSheet.create(() => ({
    body: {
        flex: 1,
        minHeight: 0,
        width: '100%',
    },
}));

export function CommandPalette(props: CommandPaletteProps) {
    useUnistyles();
    const styles = stylesheet;
    const title = t('settingsFeatures.commandPalette');
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title,
        testID: 'command-palette:modal',
        closeButtonTestID: 'command-palette:close',
        layout: 'fill' as const,
        dimensions: {
            width: 800,
            maxHeightRatio: 0.6,
            size: 'lg' as const,
        },
    }), [title]);

    useModalCardChrome(props.setChrome, chrome);

    const {
        searchQuery,
        selectedIndex,
        filteredCategories,
        inputRef,
        handleSearchChange,
        handleSelectCommand,
        handleKeyPress,
        setSelectedIndex,
    } = useCommandPalette(props.commands, props.onClose);

    // Only render on web
    if (Platform.OS !== 'web') {
        return null;
    }

    return (
        <View style={styles.body}>
            <CommandPaletteInput
                value={searchQuery}
                onChangeText={handleSearchChange}
                onKeyPress={handleKeyPress}
                inputRef={inputRef}
                autoFocus={true}
            />
            <CommandPaletteResults
                categories={filteredCategories}
                selectedIndex={selectedIndex}
                onSelectCommand={handleSelectCommand}
                onSelectionChange={setSelectedIndex}
            />
        </View>
    );
}
