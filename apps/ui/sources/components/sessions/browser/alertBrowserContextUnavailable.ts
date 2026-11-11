import { readActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

import type { BrowserShellContextState } from '@/components/browser/BrowserShell';
import { t } from '@/text';
import { alertActionFailure, readSafeFailureDetails } from '@/utils/errors/alertActionFailure';

/** Browser capture failures retain their codes without revealing page or transport content. */
export const alertBrowserContextUnavailable: NonNullable<BrowserShellContextState['onAttachUnavailable']> = (reason) => {
    const message = t('browserContext.composer.contextUnavailable');
    if (!('ok' in reason)) {
        alertActionFailure({ reason: message, code: reason.reasonCode, context: { lifecycleState: reason.lifecycleState } });
        return;
    }
    const cause = reason.failureCause === undefined ? null : readActionFailureCauseV1(reason.failureCause);
    alertActionFailure({
        reason: message,
        code: reason.errorCode ?? null,
        context: {
            ...readSafeFailureDetails(reason.details),
            ...(cause ? {
                phase: cause.phase,
                errorClass: cause.errorClass,
                causeCode: cause.errorCode,
                httpStatus: cause.httpStatus,
            } : {}),
        },
    });
};
