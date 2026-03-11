import * as React from 'react';
import { Image, Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { SvgXml } from 'react-native-svg';

import { Modal } from '@/modal';
import { getImageMimeTypeFromPath } from '@/scm/utils/filePresentation';
import { useSessionImagePreview } from '@/components/sessions/files/content/imagePreview/useSessionImagePreview';
import {
    AttachmentImagePreviewModal,
    type AttachmentImagePreviewModalImage,
} from '@/components/sessions/attachments/preview/AttachmentImagePreviewModal';

export type InlineImageAttachmentSummary = Readonly<{
    name: string;
    path: string;
    mimeType?: string;
    sizeBytes: number;
    sha256?: string;
}>;

function resolveImageMimeType(attachment: InlineImageAttachmentSummary): string | null {
    if (typeof attachment.mimeType === 'string' && attachment.mimeType.startsWith('image/')) return attachment.mimeType;
    return getImageMimeTypeFromPath(attachment.path) ?? getImageMimeTypeFromPath(attachment.name);
}

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        marginTop: 2,
        marginBottom: 7,
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    tile: {
        width: 84,
        height: 84,
        borderRadius: 12,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHighest,
    },
    image: {
        width: '100%',
        height: '100%',
    },
    placeholder: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surfaceHighest,
    },
}));

function AttachmentsInlineImageTile(props: Readonly<{
    sessionId: string;
    attachment: InlineImageAttachmentSummary;
    mimeType: string;
    imageIndex: number;
    onOpenPath: (path: string) => void;
    onOpenPreview: (index: number) => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const preview = useSessionImagePreview({
        sessionId: props.sessionId,
        filePath: props.attachment.path,
        enabled: true,
        cacheKey: props.attachment.sha256 ?? null,
        mimeType: props.mimeType,
        sizeBytes: props.attachment.sizeBytes,
    });

    return (
        <Pressable
            testID={`message-attachments-inline-image:${props.attachment.path}`}
            onPress={() => {
                if (preview.status === 'error') {
                    props.onOpenPath(props.attachment.path);
                    return;
                }
                props.onOpenPreview(props.imageIndex);
            }}
            style={styles.tile}
        >
            {preview.status === 'loaded' ? (
                Platform.OS !== 'web' && preview.svgXml ? (
                    <SvgXml xml={preview.svgXml} width="100%" height="100%" />
                ) : (
                    <Image
                        testID={`message-attachments-inline-image-preview:${props.attachment.path}`}
                        source={{ uri: preview.uri }}
                        resizeMode="cover"
                        style={styles.image}
                    />
                )
            ) : (
                <View style={styles.placeholder}>
                    <Ionicons
                        name={preview.status === 'error' ? 'alert-circle-outline' : 'image-outline'}
                        size={22}
                        color={theme.colors.textSecondary}
                    />
                </View>
            )}
        </Pressable>
    );
}

export const AttachmentsInlineImages = React.memo(function AttachmentsInlineImages(props: Readonly<{
    sessionId: string;
    attachments: readonly InlineImageAttachmentSummary[];
    onOpenPath: (path: string) => void;
}>) {
    const styles = stylesheet;

    const images = React.useMemo(() => {
        const result: Array<Readonly<{
            attachment: InlineImageAttachmentSummary;
            mimeType: string;
            modalImage: AttachmentImagePreviewModalImage;
        }>> = [];
        for (const attachment of props.attachments) {
            const mimeType = resolveImageMimeType(attachment);
            if (!mimeType) continue;
            result.push({
                attachment,
                mimeType,
                modalImage: {
                    kind: 'session-image',
                    title: attachment.name,
                    sessionId: props.sessionId,
                    filePath: attachment.path,
                    mimeType,
                    sizeBytes: attachment.sizeBytes,
                    cacheKey: attachment.sha256 ?? null,
                },
            });
        }
        return result;
    }, [props.attachments, props.sessionId]);

    if (images.length === 0) return null;

    return (
        <View testID="message-attachments-inline-images" style={styles.container}>
            {images.map((entry, index) => (
                <AttachmentsInlineImageTile
                    key={`${entry.attachment.path}:${entry.attachment.name}`}
                    sessionId={props.sessionId}
                    attachment={entry.attachment}
                    mimeType={entry.mimeType}
                    imageIndex={index}
                    onOpenPath={props.onOpenPath}
                    onOpenPreview={(imageIndex) => {
                        Modal.show({
                            component: AttachmentImagePreviewModal,
                            props: {
                                images: images.map((imageEntry) => imageEntry.modalImage),
                                initialIndex: imageIndex,
                            },
                        });
                    }}
                />
            ))}
        </View>
    );
});
