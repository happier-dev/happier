import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ArtifactBlobReferenceV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { createActionExecuteFailureError, parseActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { FileViewerBody, type FileViewerStageHandle } from '@/components/workspaces/files/file/FileViewerBody';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useFilePreviewSource, type UseFilePreviewSourceInput } from '@/components/ui/media/useFilePreviewSource';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { createArtifactActionsClient, createMountedArtifactActionExecute, readArtifactActionFailure, type ArtifactActionsClient } from './artifactActionsClient';
import { presentArtifactActionFailure } from './artifactActionFailure';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { HappyError } from '@/utils/errors/errors';
import { formatFilePageBytes } from '@/components/workspaces/files/file/FilePageStates';
import type { PdfPageInfo } from '@/components/ui/media/pdf/PdfViewerStates';
import type { PdfZoom } from '@/components/ui/media/pdf/pdfZoom';
import { usePublishArtifactBodyActions, type ArtifactBodyActions } from './artifactBodyActions';

/** A PDF well fits one page at the column's width (US Letter, the common page; taller A4 pages scroll a few points). */
const PDF_PAGE_ASPECT = 11 / 8.5;

type Preview = Readonly<{ key: string }> & (
    | Readonly<{ phase: 'loading' }>
    | Readonly<{ phase: 'failed'; failure: unknown }>
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
    const viewer = resolveFileViewerKind({ path: props.name, mimeType: reference.mime, isBinaryContent: true });
    const previewable = viewer.previewable;
    const window = useWindowDimensions();
    const [preview, setPreview] = React.useState<Preview>({ key, phase: 'loading' });
    const [attempt, setAttempt] = React.useState(0);
    const [downloading, setDownloading] = React.useState(false);
    const [downloadFailed, setDownloadFailed] = React.useState(false);
    const [stage, setStage] = React.useState<FileViewerStageHandle | null>(null);
    const [pdfZoom, setPdfZoom] = React.useState<PdfZoom>('fit-width');
    const [pdfPages, setPdfPages] = React.useState<Readonly<{ key: string; total: number }> | null>(null);
    const onPdfPageInfo = React.useCallback((info: PdfPageInfo) => {
        setPdfPages(current => current?.key === key && current.total === info.total ? current : { key, total: info.total });
    }, [key]);
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
        })().catch(failure => {
            if (!controller.signal.aborted) setPreview({ key, phase: 'failed', failure });
        });
        return () => {
            controller.abort();
        };
    }, [props.artifactId, props.name, props.readBytes, props.initialBytes, reference.blobId, reference.mime, reference.sha256, reference.sizeBytes, previewable, key, attempt]);
    const ready = preview.key === key && preview.phase === 'ready' ? preview : null;
    // The read owner says whether another attempt can succeed; a deleted or refused file stays that way.
    const readFailedForGood = preview.key === key && preview.phase === 'failed'
        && preview.failure instanceof HappyError && !preview.failure.canTryAgain;
    const previewInput = React.useMemo<UseFilePreviewSourceInput>(() => ({
        enabled: previewable && ready !== null,
        source: ready ? { kind: 'bytes', bytes: ready.bytes, name: props.name } : { kind: 'uri', uri: '' },
        cacheScopeId: props.artifactId,
        cacheKey: key,
        mimeType: reference.mime,
        sizeBytes: reference.sizeBytes,
    }), [previewable, ready?.bytes, props.name, props.artifactId, key, reference.mime, reference.sizeBytes]);
    const filePreview = useFilePreviewSource(previewInput);
    const download = useEventCallback(async () => {
        if (downloadController.current) return;
        const controller = new AbortController();
        downloadController.current = controller;
        setDownloading(true); setDownloadFailed(false);
        try {
            const outcome = await actions?.exportArtifact({ artifactId: props.artifactId, destination: 'client',
                reference, fileName: props.name }, { signal: controller.signal });
            if (outcome && 'approvalId' in outcome) return;
            if (outcome && !outcome.ok) throw createActionExecuteFailureError({ ok: false, errorCode: outcome.failure.code,
                error: outcome.failure.code, failureCause: outcome.failure.failureCause });
            if (!outcome?.ok || !('status' in outcome.value)) throw new Error('artifact_export_failed');
        } catch (error) {
            if (!controller.signal.aborted) {
                setDownloadFailed(true);
                alertActionFailure(presentArtifactActionFailure(
                    readArtifactActionFailure(parseActionExecuteFailure(error) ?? normalizeActionExecutorThrownError(error)),
                    t('artifacts.browser.loadFailedBody'),
                ));
            }
        }
        finally {
            if (downloadController.current === controller) downloadController.current = null;
            if (!controller.signal.aborted) setDownloading(false);
        }
    });
    const [columnWidth, setColumnWidth] = React.useState<number | null>(null);
    const openFullScreen = stage?.open ?? null;
    // Download reads the same bytes, so it is not offered once the read has failed for good.
    const bodyActions = React.useMemo((): ArtifactBodyActions | null => previewable && !readFailedForGood ? {
        openFullScreen, download: () => { void download(); }, downloading,
    } : null, [previewable, readFailedForGood, openFullScreen, download, downloading]);
    // In the Artifact view these sit in its action row beside Share; a History version keeps them under its body.
    const hosted = usePublishArtifactBodyActions(bodyActions);
    const scrollingWellHeight = Math.round(window.height * 0.75);
    const wellHeight = viewer.kind === 'pdf' && columnWidth !== null
        // The page sits inside the well's gap on every side (the PDF page CSS uses the same step).
        ? Math.min(scrollingWellHeight, Math.round((columnWidth - theme.space.s16 * 2) * PDF_PAGE_ASPECT) + theme.space.s16 * 2)
        : scrollingWellHeight;
    const pdfPageCount = viewer.kind === 'pdf' && pdfPages?.key === key ? pdfPages.total : null;
    const facts = [t(viewer.labelKey as never), formatFilePageBytes(reference.sizeBytes),
        ...(pdfPageCount === null ? [] : [t('files.viewer.pdfPageCount', { count: pdfPageCount })])].join(' · ');
    const card = <View style={{ gap: theme.space.s8 }} testID="artifact:fileCard">
        <Icon name={reference.mime.startsWith('image/') ? 'image' : 'file'} size={24} color={theme.colors.text.secondary} />
        <Text>{props.name}</Text>
    </View>;
    return <View style={{ gap: theme.space.s16 }} testID="artifact:binaryBody">
        {previewable ? <Text variant="meta" style={{ color: theme.colors.text.secondary }} testID="artifact:binaryFacts">{facts}</Text> : null}
        {ready && filePreview.status === 'loaded' ? (
            // Pages, players and wells are the File page's bodies over these bytes (lab files AD1); a
            // scrolling page bounds the scrolling kinds to most of the window so the page still scrolls past.
            <View style={viewer.kind === 'pdf' || viewer.kind === 'video' ? { height: wellHeight } : null}
                onLayout={(event) => setColumnWidth(event.nativeEvent.layout.width)}>
                <FileViewerBody viewer={viewer} title={props.name} source={previewInput} sizeBytes={reference.sizeBytes}
                    isActive findSurfaceId={`artifact:${props.artifactId}`} layout="inline" stageRef={setStage}
                    pdf={{ zoom: pdfZoom, onZoomChange: setPdfZoom, onPageInfo: onPdfPageInfo }} testID="artifact:viewerBody" />
            </View>
        )
            : previewable && preview.key === key && (preview.phase === 'failed' || filePreview.status === 'error') ? <SurfaceStateCard testID="artifact:previewFailed" kind="error"
                title={readFailedForGood ? resolveActionExecutionErrorMessage(preview.failure, t('artifacts.error')) : t('artifacts.error')}
                reason={readFailedForGood ? undefined : preview.phase === 'failed'
                    ? resolveActionExecutionErrorMessage(preview.failure, t('artifacts.browser.loadFailedBody'), { safeToRetry: true })
                    : filePreview.error === t('files.imagePreviewTooLarge') ? filePreview.error : t('artifacts.browser.loadFailedBody')}
                detail={filePreview.error ?? undefined}
                action={readFailedForGood ? undefined : { label: t('common.retry'), onPress: props.onRetry ?? (() => setAttempt(value => value + 1)) }} />
            : !previewable ? <FileViewerBody viewer={viewer} title={props.name} source={previewInput} sizeBytes={reference.sizeBytes}
                isActive findSurfaceId={`artifact:${props.artifactId}`} onDownload={() => { void download(); }} testID="artifact" /> : card}
        {!previewable || hosted || readFailedForGood ? null : <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s8 }}>
            {stage ? <RoundButton testID="artifact:fullScreen" title={t('files.viewer.viewFullScreen')} size="small" display="secondary" onPress={stage.open} /> : null}
            <RoundButton testID="artifact:download" title={t('files.repositoryTree.actions.download')} size="small" display="secondary" loading={downloading} onPress={() => { void download(); }} />
        </View>}
        {downloadFailed ? <Text accessibilityRole="alert" testID="artifact:downloadFailed">{t('artifacts.browser.loadFailedBody')}</Text> : null}
    </View>;
}
