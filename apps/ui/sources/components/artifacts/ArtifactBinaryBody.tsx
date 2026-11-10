import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ArtifactBlobReferenceV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { FileViewerBody, type FileViewerStageHandle } from '@/components/workspaces/files/file/FileViewerBody';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useFilePreviewSource, type UseFilePreviewSourceInput } from '@/components/ui/media/useFilePreviewSource';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { createArtifactActionsClient, createMountedArtifactActionExecute, type ArtifactActionsClient } from './artifactActionsClient';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { formatHappierDataBytes } from '@happier-dev/plugin-ui/presentation';

type Preview = Readonly<{ key: string }> & (
    | Readonly<{ phase: 'loading' | 'failed' }>
    | Readonly<{ phase: 'ready'; bytes: Uint8Array; signal: AbortSignal }>
);

/** The mounted client handoff and its existing in-place approval recipient. */
export function useArtifactBinaryActions(injectedActions?: Pick<ArtifactActionsClient, 'exportArtifact'>,
    capturedScope?: ServerAccountScope | null) {
    const activeScope = useActiveServerAccountScope();
    const scope = capturedScope === undefined ? activeScope : capturedScope;
    const mounted = useMountedActionExecution(scope, { retainInvocation: true });
    const actions = React.useMemo(() => scope
        ? createArtifactActionsClient(scope, createMountedArtifactActionExecute(mounted.execute)) : null,
    [scope, mounted.execute]);
    return { actions: injectedActions ?? actions, ready: mounted.ready, approval: mounted.approval };
}

/** Binary transport stays with Sync; temporary sources belong to the shared preview owner. */
export function ArtifactBinaryBody(props: Readonly<{ artifactId: string; name: string; reference: ArtifactBlobReferenceV1;
    readBytes: (artifactId: string, reference: ArtifactBlobReferenceV1, signal?: AbortSignal) => Promise<Uint8Array>;
    /** Bytes opened by the parent view's completed finite Account operation. */
    initialBytes?: Uint8Array;
    onRetry?: () => void;
    /** History retains the original Account even when another Home is focused. */
    scope?: ServerAccountScope | null;
    actions?: Pick<ArtifactActionsClient, 'exportArtifact'>;
}>) {
    const { theme } = useUnistyles();
    const reference = props.reference;
    const { actions } = useArtifactBinaryActions(props.actions, props.scope);
    const key = `${props.artifactId}:${reference.blobId}:${reference.sha256}`;
    const viewer = resolveFileViewerKind({ path: props.name, mimeType: reference.mime });
    const previewable = viewer.previewable;
    const window = useWindowDimensions();
    const [preview, setPreview] = React.useState<Preview>({ key, phase: 'loading' });
    const [attempt, setAttempt] = React.useState(0);
    const [downloading, setDownloading] = React.useState(false);
    const [downloadFailed, setDownloadFailed] = React.useState(false);
    const [stage, setStage] = React.useState<FileViewerStageHandle | null>(null);
    const downloadController = React.useRef<AbortController | null>(null);
    React.useEffect(() => {
        setDownloading(false); setDownloadFailed(false);
        return () => {
            downloadController.current?.abort();
            downloadController.current = null;
        };
    }, [key, actions]);
    React.useEffect(() => {
        if (!previewable) return;
        const controller = new AbortController();
        setPreview({ key, phase: 'loading' });
        void (async () => {
            const bytes = props.initialBytes ?? await props.readBytes(props.artifactId, reference, controller.signal);
            controller.signal.throwIfAborted();
            setPreview({ key, phase: 'ready', bytes, signal: controller.signal });
        })().catch(() => {
            if (!controller.signal.aborted) setPreview({ key, phase: 'failed' });
        });
        return () => {
            controller.abort();
        };
    }, [props.artifactId, props.name, props.readBytes, props.initialBytes, reference.blobId, reference.mime, reference.sha256, reference.sizeBytes, previewable, key, attempt]);
    const ready = preview.key === key && preview.phase === 'ready' ? preview : null;
    const previewInput = React.useMemo<UseFilePreviewSourceInput>(() => ({
        enabled: previewable && ready !== null,
        source: ready ? { kind: 'bytes', bytes: ready.bytes, name: props.name } : { kind: 'uri', uri: '' },
        cacheScopeId: props.artifactId,
        cacheKey: key,
        mimeType: reference.mime,
        sizeBytes: reference.sizeBytes,
    }), [previewable, ready?.bytes, props.name, props.artifactId, key, reference.mime, reference.sizeBytes]);
    const filePreview = useFilePreviewSource(previewInput);
    const download = async () => {
        if (downloadController.current) return;
        const controller = new AbortController();
        downloadController.current = controller;
        setDownloading(true); setDownloadFailed(false);
        try {
            const outcome = await actions?.exportArtifact({ artifactId: props.artifactId, destination: 'client',
                reference, fileName: props.name }, { signal: controller.signal });
            if (outcome && 'approvalId' in outcome) return;
            if (!outcome?.ok || !('status' in outcome.value)) throw new Error('artifact_export_failed');
        } catch { if (!controller.signal.aborted) setDownloadFailed(true); }
        finally {
            if (downloadController.current === controller) downloadController.current = null;
            if (!controller.signal.aborted) setDownloading(false);
        }
    };
    const card = <View style={{ gap: theme.space.s8 }} testID="artifact:fileCard">
        <Icon name={reference.mime.startsWith('image/') ? 'image' : 'file'} size={24} color={theme.colors.text.secondary} />
        <Text>{props.name}</Text>
        <Text style={{ color: theme.colors.text.secondary }}>{`${reference.mime} · ${formatHappierDataBytes(reference.sizeBytes, { kind: 'storage' })}`}</Text>
    </View>;
    return <View style={{ gap: theme.space.s16 }} testID="artifact:binaryBody">
        {ready && filePreview.status === 'loaded' ? (
            // Pages, players and wells are the File page's bodies over these bytes (lab files AD1); a
            // scrolling page bounds the scrolling kinds to most of the window so the page still scrolls past.
            <View style={viewer.kind === 'pdf' || viewer.kind === 'video' ? { height: Math.round(window.height * 0.75) } : null}>
                <FileViewerBody viewer={viewer} title={props.name} source={previewInput} sizeBytes={reference.sizeBytes}
                    isActive findSurfaceId={`artifact:${props.artifactId}`} layout="inline" stageRef={setStage} testID="artifact:viewerBody" />
            </View>
        )
            : previewable && preview.key === key && (preview.phase === 'failed' || filePreview.status === 'error') ? <SurfaceStateCard testID="artifact:previewFailed" kind="error"
                title={t('artifacts.error')}
                reason={filePreview.error === t('files.imagePreviewTooLarge') ? filePreview.error : t('artifacts.browser.loadFailedBody')}
                detail={filePreview.error ?? undefined}
                action={{ label: t('common.retry'), onPress: props.onRetry ?? (() => setAttempt(value => value + 1)) }} />
            : !previewable ? <FileViewerBody viewer={viewer} title={props.name} source={previewInput} sizeBytes={reference.sizeBytes}
                isActive findSurfaceId={`artifact:${props.artifactId}`} onDownload={() => { void download(); }} testID="artifact" /> : card}
        {!previewable ? null : <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8 }}>
            {stage ? <RoundButton testID="artifact:fullScreen" title={t('files.viewer.viewFullScreen')} size="small" display="secondary" onPress={stage.open} /> : null}
            <RoundButton testID="artifact:download" title={t('files.repositoryTree.actions.download')} size="small" display="secondary" loading={downloading} onPress={() => { void download(); }} />
        </View>}
        {downloadFailed ? <Text accessibilityRole="alert" testID="artifact:downloadFailed">{t('artifacts.browser.loadFailedBody')}</Text> : null}
    </View>;
}
