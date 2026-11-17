import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { withActionFailureCauseDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import { logger } from '@/ui/logger';

/**
 * A refusal or swallowed failure keeps its existing public result.
 * Its closed cause (phase, error class and code) is logged once and, when a
 * result carries it, attached as the hidden diagnostic. Never the message or
 * payload: native output and requester credentials may be in either.
 */
export function recordFailureCause(error: unknown, phase: string): void;
export function recordFailureCause<T extends object>(error: unknown, phase: string, result: T): T;
export function recordFailureCause<T extends object>(error: unknown, phase: string, result?: T): T | void {
    logger.warnLocalFile('[Failure cause] Retained closed cause', { phase, failureCause: projectActionFailureCauseV1(error, phase) });
    return result === undefined ? undefined : withActionFailureCauseDiagnostic(result, error, phase);
}
