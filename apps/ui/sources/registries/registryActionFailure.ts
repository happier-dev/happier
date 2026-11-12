import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { readRegistryFailureStatus } from './describeRegistrySourceStatus';

/** The same failed Action retained by first-page and subsequent-page reads. */
export class RegistryActionFailure extends Error {
    readonly status;
    readonly presentation;
    constructor(readonly result: ActionExecuteFailure) {
        const presentation = presentActionExecutionFailure({ ...result, message: result.error });
        super(presentation.reason);
        this.presentation = presentation;
        this.status = readRegistryFailureStatus(result.details);
    }
}
