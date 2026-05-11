import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { SessionContextChips } from '@/components/sessions/context/SessionContextChips';

export const InboxSessionAttentionHeader = React.memo(function InboxSessionAttentionHeader(props: Readonly<{
    sessionTitle: string;
    machineLabel: string | null;
    pathLabel: string | null;
    onOpenSession: () => void;
}>) {
    const { theme } = useUnistyles();

    return (
        <View style={styles.container}>
            <View style={styles.titleColumn}>
                <Text style={styles.title} numberOfLines={1}>
                    {props.sessionTitle}
                </Text>
                <SessionContextChips machineLabel={props.machineLabel} pathLabel={props.pathLabel} />
            </View>

            <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('common.open')}
                onPress={props.onOpenSession}
                style={({ pressed }) => [styles.openButton, pressed && styles.openButtonPressed]}
            >
                <Ionicons name="open-outline" size={16} color={theme.colors.text.primary} />
            </Pressable>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 12,
    },
    titleColumn: {
        flex: 1,
        minWidth: 0,
        gap: 8,
    },
    title: {
        fontSize: 16,
        fontWeight: '700',
        color: theme.colors.text.primary,
    },
    openButton: {
        width: 32,
        height: 32,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    openButtonPressed: {
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
}));
