import * as React from 'react';
import { DestinationBodyLoading } from '@/components/appShell/workspace/DestinationBodyLoading';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy/resolveReasonCopy';
import { t } from '@/text';
import type { DetailsSurfaceStatusV1 } from './types';

export type DetailsSurfaceFallbackStatus = DetailsSurfaceStatusV1 | 'unsupported' | 'renderer-error';

function fallbackCopy(status: Exclude<DetailsSurfaceFallbackStatus, 'pending'>, reason?: string | null): Readonly<{
    kind: 'unavailable' | 'error';
    title: string;
    explanation?: string;
}> {
    if (status === 'renderer-error') {
        return { kind: 'error', title: t('common.requestFailed') };
    }
    if (status === 'unsupported' || status === 'available') {
        return { kind: 'unavailable', title: t('session.detailsPanel.unsupportedTab') };
    }
    if (status === 'missing' || reason === 'resource_missing') {
        return { kind: 'unavailable', title: t('errors.fileNotFound') };
    }
    if (status === 'disabled') {
        return { kind: 'unavailable', title: t('common.disabled') };
    }
    if (status === 'stale') {
        return { kind: 'unavailable', title: t('common.unavailable') };
    }
    return { kind: 'unavailable', title: t('common.unavailable') };
}

export function DetailsSurfaceFallback(props: Readonly<{
    status: DetailsSurfaceFallbackStatus;
    reason?: string | null;
    onRetry?: () => void;
}>): React.ReactElement {
    if (props.status === 'pending') {
        return <DestinationBodyLoading testID="details-surface-fallback-pending" holdLaunchCurtain={false} />;
    }
    const copy = fallbackCopy(props.status, props.reason);
    const destinationReason = props.reason?.startsWith('details_destination_')
        ? resolveReasonCopy({ reasonCode: props.reason, kind: 'pluginRuntime' }).body
        : null;
    return (
        <SurfaceStateCard
            testID={`details-surface-fallback-${props.status}`}
            kind={copy.kind}
            title={copy.title}
            reason={destinationReason ?? copy.explanation}
            diagnosticCode={props.reason}
            action={props.onRetry ? { label: t('common.retry'), onPress: props.onRetry } : undefined}
        />
    );
}
