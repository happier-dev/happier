import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { homeDomainActionFailureFromDomainFailure } from '@/sync/api/home/homeDomainActions';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import type { HomeActionFailure } from '@/sync/ops/home/homeActionOutcome';
import { t } from '@/text';

/** The Detail and embedded summary retain their useful content beside the same typed read failure. */
export function ReviewReadFailure(props: Readonly<{
    failure: HomeActionFailure;
    onRetry: () => void | Promise<void>;
    testID?: string;
    size?: React.ComponentProps<typeof SurfaceStateCard>['size'];
}>) {
    const failure = homeDomainActionFailureFromDomainFailure('review.get', props.failure);
    const presentation = presentActionExecutionFailure(failure, t('common.error'), { safeToRetry: props.failure.retryable });
    return <SurfaceStateCard testID={props.testID} kind="error" size={props.size}
        title={t('common.error')} reason={presentation.reason} diagnosticCode={failure.errorCode}
        diagnosticDetail={presentation.technicalDetails.filter(detail => detail.key !== 'code')
            .map(detail => `${detail.label}: ${detail.value}`).join('\n') || undefined}
        accessibilitySemantics="alert"
        action={props.failure.retryable ? { label: t('common.retry'), onPress: props.onRetry } : undefined} />;
}
