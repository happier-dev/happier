import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { HappierStoredImage } from '@happier-dev/plugin-ui/presentation';
import { STORED_IMAGE_HOST } from '@/components/ui/media/StoredImagePicture';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { useFilePreviewSource, type UseFilePreviewSourceInput } from '@/components/ui/media/useFilePreviewSource';
import type { MediaStageItem } from '@/components/ui/media/stage/mediaStageItems';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { useImageBacking } from '@/components/ui/media/imageBacking';
import { useMediaStage } from '@/components/ui/media/stage/useMediaStage';
import { Icon } from '@/components/ui/icons/Icon';
import {
    resolveSessionMediaInlineImageLayout,
} from '@/components/sessions/media/resolveSessionMediaInlineImageLayout';
import { SessionMediaVideoPreview } from '@/components/sessions/media/SessionMediaVideoPreview';
import { ImageNumberBadge } from '@/components/ui/referenceChip/ImageNumberBadge';
import { useTranscriptNativeItemReveal } from '@/components/sessions/transcript/viewport/shell/renderer/TranscriptNativeItemReveal';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type {
    SessionMediaInlineImageAvailableSummary,
    SessionMediaInlineMediaSummary,
    SessionMediaInlineImageSummary,
    SessionMediaInlineImageUnavailableSummary,
    SessionMediaInlineVideoAvailableSummary,
} from '@/sync/domains/session/media/sessionMediaMessageMeta';

/** One preview identity per tile, shared with its Media stage item so the stage reuses the loaded bytes. */
function inlineImagePreviewInput(
    media: SessionMediaInlineImageAvailableSummary,
    sessionId: string,
    workspaceScope: WorkspaceScopeBase | null | undefined,
): UseFilePreviewSourceInput {
    return {
        source: media.attachmentHandle
            ? { kind: 'attachment', handle: media.attachmentHandle, fileName: media.path }
            : workspaceScope
                ? { kind: 'workspace', scope: workspaceScope, filePath: media.path }
                : { kind: 'session', sessionId, filePath: media.path },
        enabled: true,
        cacheKey: media.sha256 ?? null,
        mimeType: media.mimeType,
        sizeBytes: media.sizeBytes,
    };
}

function inlineVideoPreviewInput(media: SessionMediaInlineVideoAvailableSummary, sessionId: string): UseFilePreviewSourceInput {
    return {
        source: media.attachmentHandle
            ? { kind: 'attachment', handle: media.attachmentHandle, fileName: media.path }
            : { kind: 'session', sessionId, filePath: media.path },
        enabled: true,
        cacheKey: media.sha256 ?? null,
        mimeType: media.mimeType,
        sizeBytes: media.sizeBytes,
    };
}

/** Where an inline picture's bytes come from: the Session's files by default, or an owner's own resource read. */
export type SessionMediaInlinePreviewSource = (
    media: SessionMediaInlineImageAvailableSummary | SessionMediaInlineVideoAvailableSummary,
) => UseFilePreviewSourceInput;

type SessionMediaInlineRenderableSummary =
    | SessionMediaInlineImageSummary
    | SessionMediaInlineMediaSummary;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        marginTop: theme.space.s2,
        marginBottom: theme.space.s6,
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s8,
    },
    tile: {
        borderRadius: 12,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
    },
    placeholder: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.surface.elevated,
    },
    unavailableText: {
        marginTop: theme.space.s6,
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
    ring: {
        position: 'absolute',
        top: -4,
        left: -4,
        right: -4,
        bottom: -4,
        borderRadius: 16,
        borderWidth: 2,
        borderColor: theme.colors.border.focus,
    },
    videoLabel: {
        marginTop: theme.space.s6,
        color: theme.colors.text.secondary,
        textAlign: 'center',
        paddingHorizontal: theme.space.s8,
    },
    recordingStatus: {
        marginTop: theme.space.s4,
        maxWidth: 168,
        color: theme.colors.text.secondary,
    },
}));

function isUnavailableInlineImage(
    media: SessionMediaInlineRenderableSummary,
): media is SessionMediaInlineImageUnavailableSummary {
    return media.status === 'unavailable';
}

function isInlineVideo(
    media: SessionMediaInlineRenderableSummary,
): media is SessionMediaInlineVideoAvailableSummary {
    return 'mediaKind' in media && media.mediaKind === 'video';
}

function recordingStatus(media: SessionMediaInlineImageAvailableSummary | SessionMediaInlineVideoAvailableSummary): string | undefined {
    return media.browserRecording?.outcomeReason === 'policy_revoked'
        ? t('browserRecording.status.stoppedForPrivacy')
        : undefined;
}

function RecordingStatusLabel({ media }: Readonly<{
    media: SessionMediaInlineImageAvailableSummary | SessionMediaInlineVideoAvailableSummary;
}>): React.ReactElement | null {
    const status = recordingStatus(media);
    return status ? <Text variant="meta" style={stylesheet.recordingStatus}>{status}</Text> : null;
}

function resolveInlineImageAccessibilityLabel(media: SessionMediaInlineImageSummary): string {
    const status = media.status !== 'unavailable' ? recordingStatus(media) : undefined;
    const label = media.category === 'attachment'
        ? t('files.sessionMedia.attachmentImageA11y', { name: media.name })
        : media.category === 'tool-artifact'
            ? t('files.sessionMedia.toolArtifactImageA11y', { name: media.name })
            : t('files.sessionMedia.generatedImageA11y', { name: media.name });
    return status ? `${label}. ${status}` : label;
}

function resolveInlineVideoAccessibilityLabel(media: SessionMediaInlineVideoAvailableSummary): string {
    const status = recordingStatus(media);
    const label = media.category === 'attachment'
        ? t('files.sessionMedia.attachmentVideoA11y', { name: media.name })
        : media.category === 'tool-artifact'
            ? t('files.sessionMedia.toolArtifactVideoA11y', { name: media.name })
            : t('files.sessionMedia.generatedVideoA11y', { name: media.name });
    return status ? `${label}. ${status}` : label;
}

function SessionMediaInlineVideoTile(props: Readonly<{
    previewInput: UseFilePreviewSourceInput;
    media: SessionMediaInlineVideoAvailableSummary;
    testIdPrefix: string;
    originRef: React.RefObject<View | null>;
    onOpenPreview: () => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const preview = useFilePreviewSource(props.previewInput);
    const accessibilityLabel = resolveInlineVideoAccessibilityLabel(props.media);

    return (
        <View>
        <Pressable
            ref={props.originRef}
            testID={`${props.testIdPrefix}-inline-video:${props.media.path}`}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityHint={preview.status === 'error'
                ? t('files.sessionMedia.previewUnavailableA11y')
                : undefined}
            onPress={props.onOpenPreview}
            style={[styles.tile, { width: 168, height: 104 }]}
        >
            {preview.status === 'loaded' ? (
                <SessionMediaVideoPreview
                    uri={preview.uri}
                    accessibilityLabel={accessibilityLabel}
                />
            ) : (
                <View style={styles.placeholder}>
                    <Icon
                        name={preview.status === 'error' ? 'warning-circle' : 'video-camera'}
                        size={24}
                        color={theme.colors.text.secondary}
                    />
                    <Text style={styles.videoLabel} numberOfLines={2}>
                        {props.media.name}
                    </Text>
                </View>
            )}
        </Pressable>
        <RecordingStatusLabel media={props.media} />
        </View>
    );
}

function SessionMediaInlineImageTile(props: Readonly<{
    previewInput: UseFilePreviewSourceInput;
    media: SessionMediaInlineImageAvailableSummary;
    imageIndex: number;
    testIdPrefix: string;
    onOpenPath: (path: string) => void;
    fileOpenEnabled: boolean;
    originRef: React.RefObject<View | null>;
    onOpenPreview: (index: number) => void;
    number?: number;
    ringed?: boolean;
    onPreviewLoaded?: (path: string, uri: string) => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();

    const preview = useFilePreviewSource(props.previewInput);
    const viewerKind = resolveFileViewerKind({ path: props.media.path, mimeType: props.media.mimeType });
    const backing = useImageBacking(viewerKind.kind === 'svg' ? 'svg' : 'image', !isInlineVideo(props.media) && viewerKind.alphaCapable);
    const actionable = preview.status !== 'error' || props.fileOpenEnabled;
    const { onPreviewLoaded } = props;
    const loadedUri = preview.status === 'loaded' ? preview.uri : null;
    const revealNativeItem = useTranscriptNativeItemReveal();
    React.useEffect(() => {
        if (loadedUri && onPreviewLoaded) onPreviewLoaded(props.media.path, loadedUri);
    }, [loadedUri, onPreviewLoaded, props.media.path]);
    // An "Image #N" chip asking for this picture brings it into view.
    React.useEffect(() => {
        if (!props.ringed) return;
        if (Platform.OS !== 'web') {
            const node = props.originRef.current;
            return node ? revealNativeItem?.(node) : undefined;
        }
        const node = props.originRef.current as unknown as { scrollIntoView?: (options: ScrollIntoViewOptions) => void } | null;
        node?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }, [props.originRef, props.ringed, revealNativeItem]);

    return (
        <View ref={props.originRef} collapsable={false}>
        <HappierStoredImage
            identity={JSON.stringify([props.media.path, props.media.sha256])}
            status={preview.status}
            uri={preview.uri}
            dimensions={props.media}
            host={STORED_IMAGE_HOST}
            borderColor={theme.colors.border.default}
            backgroundColor={theme.colors.surface.elevated}
            checkerboardColor={backing.checkerboard ? theme.colors.text.primary : undefined}
            imageTestID={`${props.testIdPrefix}-inline-image-preview:${props.media.path}`}
            testID={`${props.testIdPrefix}-inline-image:${props.media.path}`}
            accessibilityLabel={resolveInlineImageAccessibilityLabel(props.media)}
            accessibilityHint={preview.status === 'error'
                ? t('files.sessionMedia.previewUnavailableA11y')
                : undefined}
            onPress={actionable
                ? () => {
                    if (preview.status === 'error') {
                        props.onOpenPath(props.media.path);
                        return;
                    }
                    props.onOpenPreview(props.imageIndex);
                }
                : undefined}
            placeholder={(
                    <Icon
                        name={preview.status === 'error' ? 'warning-circle' : 'image'}
                        size={20}
                        color={theme.colors.text.secondary}
                    />
            )}
        />
        {props.number !== undefined ? <ImageNumberBadge number={props.number} /> : null}
        {props.ringed ? <View pointerEvents="none" style={stylesheet.ring} testID={`${props.testIdPrefix}-inline-image-ring:${props.media.path}`} /> : null}
        <RecordingStatusLabel media={props.media} />
        </View>
    );
}

function SessionMediaInlineInertTile(props: Readonly<{
    media: SessionMediaInlineImageAvailableSummary | SessionMediaInlineVideoAvailableSummary;
    testIdPrefix: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const video = isInlineVideo(props.media);
    const size = video
        ? { width: 168, height: 104 }
        : resolveSessionMediaInlineImageLayout({
            persistedDimensions: props.media,
            loadedDimensions: null,
        });

    return (
        <View>
        <View
            testID={`${props.testIdPrefix}-inline-${video ? 'video' : 'image'}:${props.media.path}`}
            accessibilityRole="image"
            accessibilityLabel={video
                ? resolveInlineVideoAccessibilityLabel(props.media)
                : resolveInlineImageAccessibilityLabel(props.media)}
            style={[styles.tile, size]}
        >
            <View style={styles.placeholder}>
                <Icon
                    name={video ? 'video-camera' : 'image'}
                    size={video ? 24 : 22}
                    color={theme.colors.text.secondary}
                />
                {video ? (
                    <Text style={styles.videoLabel} numberOfLines={2}>
                        {props.media.name}
                    </Text>
                ) : null}
            </View>
        </View>
        <RecordingStatusLabel media={props.media} />
        </View>
    );
}

function SessionMediaUnavailableInlineImageTile(props: Readonly<{
    media: SessionMediaInlineImageUnavailableSummary;
    testIdPrefix: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    return (
        <View
            testID={`${props.testIdPrefix}-inline-image-unavailable:${props.media.id}`}
            accessibilityRole="image"
            accessibilityLabel={t('files.sessionMedia.unavailableImageA11y', { name: props.media.name })}
            style={[styles.tile, styles.placeholder, { width: 84, height: 84 }]}
        >
            <Icon
                name="warning-circle"
                size={20}
                color={theme.colors.text.secondary}
            />
            <Text style={styles.unavailableText} numberOfLines={2}>
                {t('files.sessionMedia.previewUnavailableA11y')}
            </Text>
        </View>
    );
}

export const SessionMediaInlineImages = React.memo(function SessionMediaInlineImages(props: (Readonly<{
    sessionId: string;
    /**
     * Where the files live when it is not the Session's working directory (media the daemon stored
     * under its own home for this Session). Omitted, the Session's workspace is the root.
     */
    workspaceScope?: WorkspaceScopeBase | null;
    previewSource?: undefined;
}> | Readonly<{
    /** A conversation that owns its files (a Discussion's message attachments) reads them itself. */
    previewSource: SessionMediaInlinePreviewSource;
    sessionId?: undefined;
    workspaceScope?: undefined;
}>) & Readonly<{
    media: readonly SessionMediaInlineRenderableSummary[];
    onOpenPath: (path: string) => void;
    fileOpenEnabled: boolean;
    mediaPreviewEnabled: boolean;
    testIdPrefix?: string;
    /** "Image #N" by picture path, drawn on each numbered picture's corner (D5). */
    numbers?: ReadonlyMap<string, number>;
    /** The picture its chip was just pressed for. */
    ringedPath?: string | null;
    onPreviewLoaded?: (path: string, uri: string) => void;
}>) {
    const styles = stylesheet;
    const resolvePreviewInput = React.useMemo<SessionMediaInlinePreviewSource>(() => {
        if (props.previewSource !== undefined) return props.previewSource;
        const { sessionId, workspaceScope } = props;
        return (media) => isInlineVideo(media) ? inlineVideoPreviewInput(media, sessionId) : inlineImagePreviewInput(media, sessionId, workspaceScope);
    }, [props.previewSource, props.sessionId, props.workspaceScope]);
    const testIdPrefix = props.testIdPrefix ?? 'message-session-media';

    const stage = useMediaStage();
    const originRefs = React.useRef(new Map<string, React.RefObject<View | null>>());
    const originRefFor = (key: string) => {
        let ref = originRefs.current.get(key);
        if (!ref) {
            ref = React.createRef<View | null>();
            originRefs.current.set(key, ref);
        }
        return ref;
    };
    // The gallery is this message's images and videos in order, frozen by the stage when it opens.
    const images = React.useMemo(() => {
        let nextStageIndex = 0;
        return props.media.map((media): Readonly<{
            media: SessionMediaInlineRenderableSummary;
            key: string;
            stageItem: Omit<MediaStageItem, 'originRef'> | null;
            stageIndex: number | null;
        }> => {
            if (isUnavailableInlineImage(media)) return { media, key: media.id, stageItem: null, stageIndex: null };
            const key = `${media.id}:${media.path}`;
            const stageIndex = nextStageIndex;
            nextStageIndex += 1;
            const openFile = props.fileOpenEnabled ? () => props.onOpenPath(media.path) : undefined;
            return {
                media,
                key,
                stageItem: {
                    kind: isInlineVideo(media) ? 'video' : 'image',
                    title: media.name,
                    subtitle: recordingStatus(media),
                    source: resolvePreviewInput(media),
                    sizeBytes: media.sizeBytes ?? null,
                    alphaCapable: !isInlineVideo(media) && resolveFileViewerKind({ path: media.path, mimeType: media.mimeType }).alphaCapable,
                    ...(openFile ? { openFile } : {}),
                },
                stageIndex,
            };
        });
    }, [props.fileOpenEnabled, props.media, props.onOpenPath, resolvePreviewInput]);
    const openStage = (stageIndex: number) => {
        const items = images.flatMap((entry) => (entry.stageItem ? [{ ...entry.stageItem, originRef: originRefFor(entry.key) }] : []));
        if (items.length > 0) stage.open(items, Math.min(stageIndex, items.length - 1));
    };

    if (images.length === 0) return null;

    return (
        <View testID={`${testIdPrefix}-inline-images`} style={styles.container}>
            {images.map((entry, index) => (
                isUnavailableInlineImage(entry.media) ? (
                    <SessionMediaUnavailableInlineImageTile
                        key={entry.media.id}
                        media={entry.media}
                        testIdPrefix={testIdPrefix}
                    />
                ) : !props.mediaPreviewEnabled ? (
                    <SessionMediaInlineInertTile
                        key={`${entry.media.id}:${entry.media.path}`}
                        media={entry.media}
                        testIdPrefix={testIdPrefix}
                    />
                ) : isInlineVideo(entry.media) ? (
                    <SessionMediaInlineVideoTile
                        key={`${entry.media.id}:${entry.media.path}`}
                        previewInput={resolvePreviewInput(entry.media)}
                        media={entry.media}
                        testIdPrefix={testIdPrefix}
                        originRef={originRefFor(entry.key)}
                        onOpenPreview={() => openStage(entry.stageIndex ?? 0)}
                    />
                ) : (
                    <SessionMediaInlineImageTile
                        key={`${entry.media.id}:${entry.media.path}`}
                        previewInput={resolvePreviewInput(entry.media)}
                        media={entry.media}
                        imageIndex={entry.stageIndex ?? 0}
                        originRef={originRefFor(entry.key)}
                        testIdPrefix={testIdPrefix}
                        onOpenPath={props.onOpenPath}
                        fileOpenEnabled={props.fileOpenEnabled}
                        onOpenPreview={openStage}
                        number={props.numbers?.get(entry.media.path)}
                        ringed={props.ringedPath === entry.media.path}
                        onPreviewLoaded={props.onPreviewLoaded}
                    />
                )
            ))}
        </View>
    );
});
