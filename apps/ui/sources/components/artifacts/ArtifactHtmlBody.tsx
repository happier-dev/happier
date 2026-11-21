import * as React from 'react';

import type { ArtifactBodyV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import type { ArtifactHtmlPreview } from '@/sync/domains/artifacts/artifactTypes';
import { HtmlDocumentFrame } from '@/components/ui/surfaces/framed/HtmlDocumentFrame';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';

type Preview = Readonly<{ key: string; body: ArtifactBodyV1 | null | undefined }> & (
    | Readonly<{ phase: 'loading' }>
    | Readonly<{ phase: 'failed'; failure?: unknown }>
    | (Readonly<{ phase: 'ready' }> & ArtifactHtmlPreview)
);

/** Sync owns authorized bundle delivery; this view owns the opaque frame's lifetime. */
export function ArtifactHtmlBody(props: Readonly<{
    artifactId: string;
    headerVersion: number;
    bodyVersion?: number;
    body: ArtifactBodyV1 | null | undefined;
    name: string;
    readPreview: (artifactId: string, signal?: AbortSignal) => Promise<ArtifactHtmlPreview>;
    /** Private opened content prepared in the parent view's finite operation. */
    preview?: ArtifactHtmlPreview;
    onRetry?: () => void;
}>) {
    const key = `${props.artifactId}:${props.headerVersion}:${props.bodyVersion ?? ''}`;
    const [preview, setPreview] = React.useState<Preview>({ key, body: props.body, phase: 'loading' });
    const [attempt, setAttempt] = React.useState(0);
    React.useEffect(() => {
        const controller = new AbortController();
        const body = props.body;
        setPreview({ key, body, phase: 'loading' });
        void (props.preview ? Promise.resolve(props.preview) : props.readPreview(props.artifactId, controller.signal)).then(value => {
            if (controller.signal.aborted) return;
            setPreview({ key, body, phase: 'ready', bundle: value.bundle });
        }).catch(failure => {
            if (!controller.signal.aborted) setPreview({ key, body, phase: 'failed', failure });
        });
        return () => controller.abort();
    }, [key, props.artifactId, props.body, props.readPreview, props.preview, attempt]);

    const current = preview.key === key && preview.body === props.body ? preview : null;
    const fail = () => setPreview(value => value === current ? { key, body: props.body, phase: 'failed' } : value);
    return <HtmlDocumentFrame testID="artifact:htmlBody" frameTestID="artifact:htmlPreview" frameKey={key} title={props.name}
        state={current?.phase === 'ready' ? current : { phase: current?.phase ?? 'loading' }}
        onError={fail}
        failure={<SurfaceStateCard
            testID="artifact:htmlPreviewFailed"
            kind="error"
            title={t('artifacts.error')}
            reason={resolveActionExecutionErrorMessage(current?.phase === 'failed' ? current.failure : undefined,
                t('artifacts.browser.loadFailedBody'), { safeToRetry: true })}
            action={{ label: t('common.retry'), testID: 'artifact:htmlPreviewRetry', onPress: props.onRetry ?? (() => setAttempt(value => value + 1)) }}
            accessibilitySemantics="alert"
        />}
        loading={<SurfaceStateCard
            testID="artifact:htmlPreviewLoading" kind="loading" title={t('common.loading')}
        />} />;
}
