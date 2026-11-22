import { Typography } from '@/constants/Typography';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';

export type MessageAttachmentSummary = Readonly<{
    name: string;
    path: string;
    mimeType?: string;
    sizeBytes: number;
    removed?: boolean;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        marginTop: theme.space.s2,
        marginBottom: theme.space.s6,
        gap: theme.space.s8,
    },
    row: {
        flexDirection: 'row',
        gap: theme.space.s8,
    },
    attachmentChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        paddingHorizontal: theme.space.s10,
        paddingVertical: theme.space.s6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
        maxWidth: 260,
    },
    attachmentText: {
        color: theme.colors.text.primary,
        ...Typography.variant('meta', 'semiBold'),
        flexShrink: 1,
    },
    attachmentMeta: {
        color: theme.colors.text.secondary,
        fontSize: 11,
        flexShrink: 0,
    },
}));

function resolveAttachmentIconName(mimeType?: string): IconName {
    if (!mimeType) return 'file';
    if (mimeType === 'inode/directory') return 'folder';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('text/')) return 'file-text';
    return 'file';
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
                {props.attachments.map((attachment) => {
                    const open = !attachment.removed && props.onOpenPath;
                    const Chip = open ? Pressable : View;
                    return (
                        <Chip key={`${attachment.path}:${attachment.name}`} style={styles.attachmentChip}
                            {...(open ? { onPress: () => open(attachment.path) } : {})}>
                            <Icon name={resolveAttachmentIconName(attachment.mimeType)} size={14} color={theme.colors.text.secondary} />
                            <Text numberOfLines={1} style={styles.attachmentText}>{attachment.name}</Text>
                            <Text style={styles.attachmentMeta}>{attachment.removed ? t('composerReferences.attachmentRemoved')
                                : formatHappierDataBytes(attachment.sizeBytes, { kind: 'storage' })}</Text>
                        </Chip>
                    );
                })}
            </ScrollView>
        </View>
    );
});
