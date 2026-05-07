import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { hapticsLight } from '@/components/ui/theme/haptics';
import { Text } from '@/components/ui/text/Text';
import {
    AttachmentImagePreviewModal,
    type AttachmentImagePreviewModalImage,
} from '@/components/sessions/attachments/preview/AttachmentImagePreviewModal';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';

import type {
    AgentInputAttachment,
    AgentInputAttachmentUploadProgress,
    AgentInputComposerAttachmentBadge,
} from '../agentInputContracts';

type ComposerAttachmentImagePreviewItem = Extract<AttachmentImagePreviewModalImage, Readonly<{ kind: 'direct' }>>;

function resolveAttachmentImagePreviewItems(attachments: readonly AgentInputAttachment[]): ComposerAttachmentImagePreviewItem[] {
    const previews: ComposerAttachmentImagePreviewItem[] = [];
    for (const attachment of attachments) {
        const imagePreviewUri =
            attachment.preview?.kind === 'image' && typeof attachment.preview.uri === 'string' && attachment.preview.uri.trim().length > 0
                ? attachment.preview.uri
                : null;
        if (!imagePreviewUri) continue;
        previews.push({
            kind: 'direct',
            uri: imagePreviewUri,
            title: attachment.label,
        });
    }
    return previews;
}

function resolveUploadProgressPercent(progress?: AgentInputAttachmentUploadProgress): number | null {
    if (!progress) return null;
    if (!Number.isFinite(progress.totalBytes) || progress.totalBytes <= 0) return null;
    if (!Number.isFinite(progress.uploadedBytes) || progress.uploadedBytes < 0) return null;
    const percent = Math.round((progress.uploadedBytes / progress.totalBytes) * 100);
    return Math.max(0, Math.min(100, percent));
}

const stylesheet = StyleSheet.create((theme) => ({
    attachmentsRow: {
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: 4,
    },
    attachmentChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    attachmentChipText: {
        color: theme.colors.text,
        fontSize: 12,
        maxWidth: 180,
        ...Typography.default(),
    },
    attachmentChipMeta: {
        color: theme.colors.textSecondary,
        fontSize: 11,
        ...Typography.default('semiBold'),
    },
    attachmentImageTile: {
        width: 58,
        height: 58,
        position: 'relative',
    },
    attachmentImageSurface: {
        width: 52,
        height: 52,
        marginTop: 6,
        marginRight: 6,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        overflow: 'hidden',
    },
    attachmentImage: {},
    attachmentImageOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: theme.colors.overlay.scrim,
    },
    attachmentImageOverlayText: {
        color: theme.colors.overlay.text,
        fontSize: 11,
        ...Typography.default('semiBold'),
    },
    attachmentImageErrorOverlay: {
        backgroundColor: theme.colors.box.error.background,
    },
    attachmentImageRemoveButton: {
        position: 'absolute',
        top: 0,
        right: 0,
    },
    rowContent: {
        gap: 8,
    },
}));

export const AgentInputAttachmentsRow = React.memo(function AgentInputAttachmentsRow(props: Readonly<{
    attachments: readonly AgentInputAttachment[];
    composerBadges?: readonly AgentInputComposerAttachmentBadge[];
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const attachmentImagePreviewItems = React.useMemo(
        () => resolveAttachmentImagePreviewItems(props.attachments),
        [props.attachments],
    );

    const composerBadges = props.composerBadges ?? [];

    if (props.attachments.length === 0 && composerBadges.length === 0) {
        return null;
    }

    return (
        <View style={styles.attachmentsRow}>
            <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.rowContent}
            >
                {composerBadges.map((badge) => {
                    const icon = badge.icon?.(theme.colors.textSecondary) ?? (
                        <Ionicons name="document-outline" size={14} color={theme.colors.textSecondary} />
                    );
                    const content = (
                        <>
                            {icon}
                            <Text
                                numberOfLines={1}
                                style={styles.attachmentChipText}
                            >
                                {badge.label}
                            </Text>
                        </>
                    );
                    const removeButton = badge.onRemove ? (
                        <Pressable
                            accessibilityLabel={badge.removeAccessibilityLabel ?? t('common.remove')}
                            accessibilityRole="button"
                            hitSlop={8}
                            onPress={(event) => {
                                event?.stopPropagation?.();
                                hapticsLight();
                                badge.onRemove?.();
                            }}
                            testID={badge.testID ? `${badge.testID}-remove` : undefined}
                        >
                            <Ionicons name="close-circle" size={16} color={theme.colors.textSecondary} />
                        </Pressable>
                    ) : null;

                    if (badge.onPress) {
                        return (
                            <Pressable
                                key={badge.key}
                                accessibilityLabel={badge.accessibilityLabel ?? badge.label}
                                accessibilityRole="button"
                                onPress={() => {
                                    hapticsLight();
                                    badge.onPress?.();
                                }}
                                style={styles.attachmentChip}
                                testID={badge.testID}
                            >
                                {content}
                                {removeButton}
                            </Pressable>
                        );
                    }

                    return (
                        <View key={badge.key} style={styles.attachmentChip} testID={badge.testID}>
                            {content}
                            {removeButton}
                        </View>
                    );
                })}
                {props.attachments.map((att) => {
                    const removingDisabled = att.status === 'uploading';
                    const percent = att.status === 'uploading' ? resolveUploadProgressPercent(att.uploadProgress) : null;
                    const imagePreviewUri =
                        att.preview?.kind === 'image' && typeof att.preview.uri === 'string' && att.preview.uri.trim().length > 0
                            ? att.preview.uri
                            : null;
                    const imagePreviewIndex = attachmentImagePreviewItems.findIndex((item) => item.uri === imagePreviewUri && item.title === att.label);

                    if (imagePreviewUri) {
                        return (
                            <View key={att.key} style={styles.attachmentImageTile}>
                                <Pressable
                                    accessibilityLabel={t('common.open')}
                                    accessibilityRole="button"
                                    onPress={() => {
                                        Modal.show({
                                            component: AttachmentImagePreviewModal,
                                            props: {
                                                images: attachmentImagePreviewItems,
                                                initialIndex: imagePreviewIndex >= 0 ? imagePreviewIndex : 0,
                                            },
                                        });
                                    }}
                                    style={styles.attachmentImageSurface}
                                    testID={`agent-input-attachment-image:${att.key}`}
                                >
                                    <Image
                                        source={{ uri: imagePreviewUri }}
                                        style={[{ width: '100%', height: '100%' }, styles.attachmentImage]}
                                        contentFit="cover"
                                    />
                                    {att.status === 'uploading' && percent != null ? (
                                        <View style={styles.attachmentImageOverlay}>
                                            <Text style={styles.attachmentImageOverlayText}>{percent}%</Text>
                                        </View>
                                    ) : null}
                                    {att.status === 'error' ? (
                                        <View style={[styles.attachmentImageOverlay, styles.attachmentImageErrorOverlay]}>
                                            <Ionicons name="alert-circle" size={20} color={theme.colors.overlay.text} />
                                        </View>
                                    ) : null}
                                </Pressable>
                                {att.onRemove ? (
                                    <Pressable
                                        testID={`agent-input-attachment-remove:${att.key}`}
                                        onPress={() => {
                                            if (removingDisabled) return;
                                            hapticsLight();
                                            att.onRemove?.();
                                        }}
                                        disabled={removingDisabled}
                                        hitSlop={8}
                                        style={styles.attachmentImageRemoveButton}
                                    >
                                        <Ionicons name="close-circle" size={18} color={theme.colors.textSecondary} />
                                    </Pressable>
                                ) : null}
                            </View>
                        );
                    }

                    return (
                        <View key={att.key} style={styles.attachmentChip}>
                            <Ionicons name="document-outline" size={14} color={theme.colors.textSecondary} />
                            <Text
                                numberOfLines={1}
                                style={styles.attachmentChipText}
                            >
                                {att.label}
                            </Text>
                            {att.status === 'uploading' ? (
                                percent != null ? (
                                    <Text style={styles.attachmentChipMeta}>{percent}%</Text>
                                ) : (
                                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                                )
                            ) : null}
                            {att.onRemove ? (
                                <Pressable
                                    testID={`agent-input-attachment-remove:${att.key}`}
                                    onPress={() => {
                                        if (removingDisabled) return;
                                        hapticsLight();
                                        att.onRemove?.();
                                    }}
                                    disabled={removingDisabled}
                                    hitSlop={8}
                                >
                                    <Ionicons name="close-circle" size={16} color={theme.colors.textSecondary} />
                                </Pressable>
                            ) : null}
                        </View>
                    );
                })}
            </ScrollView>
        </View>
    );
});
