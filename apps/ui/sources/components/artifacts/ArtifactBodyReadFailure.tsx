import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { formatActionFailureDetails } from '@/utils/errors/alertActionFailure';

import { presentArtifactActionFailure } from './artifactActionFailure';
import { readArtifactActionFailure } from './artifactActionsClient';

/** The opened Artifact read keeps its typed cause through every kind's failure page. */
export function ArtifactBodyReadFailure(props: Readonly<{
    failure: unknown;
    onRetry: () => void;
    testID?: string;
    title?: string;
    replacesContent?: boolean;
}>): React.ReactElement {
    const refusal = presentArtifactActionFailure(readArtifactActionFailure(props.failure),
        t('artifacts.browser.loadFailedBody'), { safeToRetry: true });
    return <SurfaceStateCard
        testID={props.testID ?? 'artifact:bodyFailed'}
        kind="error"
        title={props.title ?? t('artifacts.error')}
        reason={refusal.reason}
        diagnosticCode={refusal.code}
        diagnosticDetail={formatActionFailureDetails({ code: refusal.code, context: refusal.context })}
        action={{ label: t('common.retry'), onPress: props.onRetry }}
        accessibilitySemantics="alert"
        replacesContent={props.replacesContent}
    />;
}
