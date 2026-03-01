import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

export type MessageAttachmentSummary = Readonly<{
    name: string;
    path: string;
    mimeType?: string;
    sizeBytes: number;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        marginTop: 2,
        marginBottom: 7,
        gap: 8,
    },
    row: {
        flexDirection: 'row',
        gap: 8,
    },
    attachmentChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHighest,
        maxWidth: 260,
    },
    attachmentText: {
        color: theme.colors.text,
        fontSize: 12,
        fontWeight: '600',
        flexShrink: 1,
    },
    attachmentMeta: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        flexShrink: 0,
    },
}));

function formatBytes(bytes: number): string {
    const value = Number.isFinite(bytes) ? bytes : 0;
    if (value < 1024) return `${Math.max(0, Math.floor(value))} B`;
    const kb = value / 1024;
    if (kb < 1024) return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(gb >= 100 ? 0 : 1)} GB`;
}

function resolveAttachmentIconName(mimeType?: string): React.ComponentProps<typeof Ionicons>['name'] {
    if (!mimeType) return 'document-outline';
    if (mimeType.startsWith('image/')) return 'image-outline';
    if (mimeType.startsWith('text/')) return 'document-text-outline';
    return 'document-outline';
}

export const AttachmentsMessageRow = React.memo(function AttachmentsMessageRow(props: Readonly<{
    attachments: readonly MessageAttachmentSummary[];
    onOpenPath?: (path: string) => void;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    if (props.attachments.length === 0) return null;

    return (
        <View testID="message-attachments-row" style={styles.container}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
                {props.attachments.map((a) => (
                    <Pressable
                        key={`${a.path}:${a.name}`}
                        onPress={props.onOpenPath ? () => props.onOpenPath?.(a.path) : undefined}
                        style={styles.attachmentChip}
                    >
                        <Ionicons name={resolveAttachmentIconName(a.mimeType)} size={14} color={theme.colors.textSecondary} />
                        <Text numberOfLines={1} style={styles.attachmentText}>{a.name}</Text>
                        <Text style={styles.attachmentMeta}>{formatBytes(a.sizeBytes)}</Text>
                    </Pressable>
                ))}
            </ScrollView>
        </View>
    );
});
