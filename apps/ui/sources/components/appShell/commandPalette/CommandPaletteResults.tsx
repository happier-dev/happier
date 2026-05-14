import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Command, CommandCategory } from './types';
import { CommandPaletteItem } from './CommandPaletteItem';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { Eyebrow } from '@/components/ui/text/Eyebrow';
import { useScrollViewWheelScrollTo } from '@/components/ui/scroll/useScrollViewWheelScrollTo';
import { useIsInsideModalBoundary } from '@/modal/context/ModalBoundaryContext';


interface CommandPaletteResultsProps {
    categories: CommandCategory[];
    selectedIndex: number;
    onSelectCommand: (command: Command) => void;
    onSelectionChange: (index: number) => void;
}

export function CommandPaletteResults({ 
    categories, 
    selectedIndex, 
    onSelectCommand, 
    onSelectionChange 
}: CommandPaletteResultsProps) {
    const scrollViewRef = React.useRef<ScrollView>(null);
    const itemRefs = React.useRef<{ [key: number]: View | null }>({});
    const isInsideModalBoundary = useIsInsideModalBoundary();
    const wheelScrollHandlers = useScrollViewWheelScrollTo(scrollViewRef);
    
    // Flatten commands for index tracking
    const allCommands = React.useMemo(() => {
        return categories.flatMap(cat => cat.commands);
    }, [categories]);

    // Scroll to selected item when index changes
    React.useEffect(() => {
        const selectedItem = itemRefs.current[selectedIndex];
        if (selectedItem && scrollViewRef.current) {
            // For web, we need to use the DOM API
            if (typeof (selectedItem as any).scrollIntoView === 'function') {
                (selectedItem as any).scrollIntoView({
                    behavior: 'smooth',
                    block: 'nearest',
                });
            }
        }
    }, [selectedIndex]);

    if (categories.length === 0 || allCommands.length === 0) {
        return (
            <View style={styles.emptyContainer}>
                <Text style={[styles.emptyText, Typography.default()]}>
                    {t('commandPalette.noCommandsFound')}
                </Text>
            </View>
        );
    }

    let currentIndex = 0;

    return (
        <ScrollView 
            ref={scrollViewRef}
            style={styles.container}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            onScroll={isInsideModalBoundary ? wheelScrollHandlers.onScroll : undefined}
            {...(isInsideModalBoundary ? ({ onWheel: wheelScrollHandlers.onWheel } as any) : {})}
        >
            {categories.map(category => {
                if (category.commands.length === 0) return null;
                
                const categoryStartIndex = currentIndex;
                const categoryCommands = category.commands.map((command, idx) => {
                    const commandIndex = categoryStartIndex + idx;
                    const isSelected = commandIndex === selectedIndex;
                    currentIndex++;
                    
                    return (
                        <View
                            key={command.id}
                            ref={(ref) => {
                                itemRefs.current[commandIndex] = ref;
                            }}
                        >
                            <CommandPaletteItem
                                command={command}
                                isSelected={isSelected}
                                onPress={() => onSelectCommand(command)}
                                onHover={() => onSelectionChange(commandIndex)}
                            />
                        </View>
                    );
                });

                return (
                    <View key={category.id}>
                        <Eyebrow style={styles.categoryTitle}>
                            {category.title}
                        </Eyebrow>
                        {categoryCommands}
                    </View>
                );
            })}
        </ScrollView>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        minHeight: 0,
        paddingVertical: 8,
    },
    emptyContainer: {
        padding: 48,
        alignItems: 'center',
    },
    emptyText: {
        fontSize: 15,
        color: theme.colors.input.placeholder,
        letterSpacing: -0.2,
    },
    categoryTitle: {
        paddingHorizontal: 32,
        paddingTop: 16,
        paddingBottom: 8,
        color: theme.colors.input.placeholder,
    },
}));
