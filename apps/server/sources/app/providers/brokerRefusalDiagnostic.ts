import { logger } from '@/utils/logging/log';

type BrokerOperation = 'open' | 'catalog' | 'request' | 'account_open' | 'account_admit' | 'action_open' | 'resource_test';

/** Emit the settled refusal outside replayable transactions. Callers supply only closed causes. */
export function reportBrokerAdmissionFailure<const T extends Readonly<{ ok: false; reasonCode: string; refusalReason?: string }>>(
    operation: BrokerOperation, result: T,
): Omit<T, 'refusalReason'> {
    const { refusalReason, ...response } = result;
    try {
        logger.warn({ module: 'provider-broker-admission', operation,
            reasonCode: result.reasonCode, refusalReason: refusalReason ?? result.reasonCode });
    } catch {
        // A diagnostic sink failure cannot replace the admission decision.
    }
    return response;
}
