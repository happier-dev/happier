import * as React from 'react';
import { Platform, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ArtifactBlobReferenceV1 } from '@happier-dev/protocol';
import { FileUriPreview } from '@/components/workspaces/files/file/FileUriPreview';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { createNativeCacheFileSink, shareNativeCacheFile } from '@/sync/runtime/files/nativeCacheFileSink';
import { downloadWebFile } from '@/sync/runtime/files/downloadWebFile';
import { t } from '@/text';
import { formatByteSize } from '@/utils/files/formatByteSize';

type Preview = Readonly<{ key: string }> & (
    | Readonly<{ phase: 'loading' | 'failed' }>
    | Readonly<{ phase: 'ready'; uri: string; bytes: Uint8Array; signal: AbortSignal }>
);

/** Binary transport stays with Sync; this view owns only its temporary preview lifetime. */
export function ArtifactBinaryBody(props: Readonly<{ artifactId: string; name: string; reference: ArtifactBlobReferenceV1;
    readBytes: (artifactId: string, reference: ArtifactBlobReferenceV1, signal?: AbortSignal) => Promise<Uint8Array>;
    /** Bytes opened by the parent view's completed finite Account operation. */
    initialBytes?: Uint8Array;
    onRetry?: () => void;
}>) {
    const { theme } = useUnistyles();
    const reference = props.reference;
    const key = `${props.artifactId}:${reference.blobId}:${reference.sha256}`;
    const previewable = reference.mime.startsWith('image/') || (Platform.OS === 'web' && reference.mime === 'application/pdf');
    const [preview, setPreview] = React.useState<Preview>({ key, phase: 'loading' });
    const [attempt, setAttempt] = React.useState(0);
    const [downloading, setDownloading] = React.useState(false);
    const [downloadFailed, setDownloadFailed] = React.useState(false);
    const downloadController = React.useRef<AbortController | null>(null);
    const imagePreviewModal = React.useRef<string | null>(null);
    React.useEffect(() => {
        setDownloading(false); setDownloadFailed(false);
        return () => {
            downloadController.current?.abort();
            downloadController.current = null;
        };
    }, [key]);
    React.useEffect(() => {
        if (!previewable) return;
        const controller = new AbortController();
        let cleanup: (() => void | Promise<void>) | null = null;
        setPreview({ key, phase: 'loading' });
        void (async () => {
            const bytes = props.initialBytes ?? await props.readBytes(props.artifactId, reference, controller.signal);
            controller.signal.throwIfAborted();
            let uri: string;
            if (Platform.OS === 'web') {
                uri = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: reference.mime }));
                cleanup = () => URL.revokeObjectURL(uri);
            } else {
                const sink = await createNativeCacheFileSink({ directoryName: 'happier-session-file-previews', fileName: props.name });
                if (!sink.ok) throw new Error(sink.error);
                cleanup = sink.cleanup;
                await sink.writeBytes(bytes);
                await sink.close();
                uri = sink.fileUri;
            }
            if (controller.signal.aborted) { await cleanup?.(); cleanup = null; return; }
            setPreview({ key, phase: 'ready', uri, bytes, signal: controller.signal });
        })().catch(async () => {
            await cleanup?.(); cleanup = null;
            if (!controller.signal.aborted) setPreview({ key, phase: 'failed' });
        });
        return () => {
            controller.abort();
            if (imagePreviewModal.current) Modal.hide(imagePreviewModal.current);
            imagePreviewModal.current = null;
            void cleanup?.(); cleanup = null;
        };
    }, [props.artifactId, props.name, props.readBytes, props.initialBytes, reference.blobId, reference.mime, reference.sha256, reference.sizeBytes, previewable, key, attempt]);
    const ready = preview.key === key && preview.phase === 'ready' ? preview : null;
    const download = async () => {
        if (downloadController.current) return;
        const controller = new AbortController();
        downloadController.current = controller;
        setDownloading(true); setDownloadFailed(false);
        try {
            const bytes = ready?.bytes ?? await props.readBytes(props.artifactId, reference, controller.signal);
            controller.signal.throwIfAborted();
            if (Platform.OS === 'web') downloadWebFile(new Blob([new Uint8Array(bytes)], { type: reference.mime }), props.name, async () => {});
            else {
                const sink = await createNativeCacheFileSink({ directoryName: 'happier-downloads', fileName: props.name });
                if (!sink.ok) throw new Error(sink.error);
                let retainCacheFile = false;
                try {
                    await sink.writeBytes(bytes); await sink.close();
                    const shared = await shareNativeCacheFile({ fileUri: sink.fileUri, name: props.name,
                        mimeType: reference.mime, isCurrent: () => !controller.signal.aborted });
                    if (shared.status === 'canceled') return;
                    if (shared.status === 'unavailable') throw new Error(t('files.fileSharingUnavailable'));
                    retainCacheFile = shared.retainCacheFile;
                } finally { if (!retainCacheFile) await sink.cleanup(); }
            }
        } catch { if (!controller.signal.aborted) setDownloadFailed(true); }
        finally {
            if (downloadController.current === controller) downloadController.current = null;
            if (!controller.signal.aborted) setDownloading(false);
        }
    };
    const card = <View style={{ gap: 8 }} testID="artifact:fileCard">
        <Icon name={reference.mime.startsWith('image/') ? 'image' : 'file'} size={24} color={theme.colors.text.secondary} />
        <Text>{props.name}</Text>
        <Text style={{ color: theme.colors.text.secondary }}>{`${reference.mime} · ${formatByteSize(reference.sizeBytes)}`}</Text>
    </View>;
    return <View style={{ gap: 16 }} testID="artifact:binaryBody">
        {ready ? <FileUriPreview uri={ready.uri} mime={reference.mime} title={props.name} fallback={card}
            onOpenImage={() => {
                void import('@/components/sessions/attachments/preview/AttachmentImagePreviewModal').then(({ AttachmentImagePreviewModal }) => {
                    if (ready.signal.aborted) return;
                    if (imagePreviewModal.current) Modal.hide(imagePreviewModal.current);
                    imagePreviewModal.current = Modal.show({ component: AttachmentImagePreviewModal, props: { images: [{ kind: 'direct', uri: ready.uri, title: props.name }] } });
                }).catch(() => {
                    if (!ready.signal.aborted) setPreview({ key, phase: 'failed' });
                });
            }} />
            : previewable && preview.key === key && preview.phase === 'failed' ? <SurfaceStateCard testID="artifact:previewFailed" kind="error"
                title={t('artifacts.error')} reason={t('artifacts.browser.loadFailedBody')}
                action={{ label: t('common.retry'), onPress: props.onRetry ?? (() => setAttempt(value => value + 1)) }} /> : card}
        <RoundButton testID="artifact:download" title={t('files.repositoryTree.actions.download')} size="small" display="secondary" loading={downloading} onPress={() => { void download(); }} />
        {downloadFailed ? <Text accessibilityRole="alert" testID="artifact:downloadFailed">{t('artifacts.browser.loadFailedBody')}</Text> : null}
    </View>;
}
