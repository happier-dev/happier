import * as React from 'react';
import {
    projectOperationsRunOutcome,
    type OperationsRunOutcomeInput,
} from '@/sync/domains/workflows/operationsRunOutcome';

/** Compose the existing opened result owners; this hook adds no reads or subscriptions. */
export function useOperationsRunOutcome(input: OperationsRunOutcomeInput) {
    return React.useMemo(() => projectOperationsRunOutcome(input), [input.subject, input.finding, input.produced,
        input.pullRequest, input.approval, input.operation, input.receipt, input.subjectReceipt, input.healthServerId, input.health]);
}
