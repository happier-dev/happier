import { presentActionExecutionFailure, resolveActionExecutionFailureTitle } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import type { ActionFailureContext } from '@/utils/errors/alertActionFailure';
import { t } from '@/text';

import type { ArtifactActionFailure } from './artifactActionsClient';

/** Artifact writes retain the Action owner's copy and sanitized cause in the shared disclosure. */
export function presentArtifactActionFailure(failure: ArtifactActionFailure, fallbackMessage: string): Readonly<{
    title: string; reason: string; code: string; context: ActionFailureContext;
}> {
    const presentation = presentActionExecutionFailure({ ok: false, errorCode: failure.code,
        ...(failure.failureCause ? { failureCause: failure.failureCause } : {}) }, fallbackMessage);
    return {
        title: resolveActionExecutionFailureTitle(failure, t('common.error')),
        reason: presentation.reason,
        code: failure.code,
        context: Object.fromEntries(presentation.technicalDetails.filter(detail => detail.key !== 'code')
            .map(detail => [detail.key, detail.value])),
    };
}
