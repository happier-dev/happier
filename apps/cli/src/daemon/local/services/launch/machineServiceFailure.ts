import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';

/** Missing service custody is an Action failure, not a successful domain observation. */
export function machineServiceAdmissionFailure(phase: string): ActionExecuteFailure {
    const error = Object.assign(new Error('admission_unavailable'), { code: 'admission_unavailable' });
    return { ok: false, ...normalizeActionExecutorThrownError(error, phase) };
}
