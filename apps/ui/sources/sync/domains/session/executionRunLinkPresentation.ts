import {
    readExecutionRunLinkV1,
    readSessionOriginViaV1,
    resolveExecutionRunLinkDeliveryStateV1,
    type ExecutionRunLinkV1,
    type ExecutionRunLinkDeliveryStateV1,
    type PrimaryTurnStatusV1,
} from '@happier-dev/protocol';

import { isTerminalPrimaryTurnStatus } from '@/sync/domains/session/attention/deriveSessionRuntimePresentationState';

export type ExecutionRunDeliveryState = ExecutionRunLinkDeliveryStateV1;

export type ExecutionRunTurnState = 'finished' | 'existing';

export type ExecutionRunLinkPresentationSource = Readonly<ExecutionRunLinkV1>;

/** Reads the complete committed link carrier, including its protocol-owned R21 receipts. */
export function readExecutionRunLinkPresentationSource(metadata: unknown): ExecutionRunLinkPresentationSource | null {
    return readExecutionRunLinkV1(metadata);
}

export function resolveExecutionRunDeliveryState(
    source: ExecutionRunLinkPresentationSource | null,
): ExecutionRunDeliveryState {
    if (!source) return resolveExecutionRunLinkDeliveryStateV1(null);
    return resolveExecutionRunLinkDeliveryStateV1(source);
}

export function resolveExecutionRunTurnState(input: Readonly<{
    latestTurnStatus: PrimaryTurnStatusV1 | null | undefined;
    pendingCount: number;
    hasPendingRequests: boolean;
}>): ExecutionRunTurnState {
    return isTerminalPrimaryTurnStatus(input.latestTurnStatus ?? null)
        && input.pendingCount === 0
        && !input.hasPendingRequests
        ? 'finished'
        : 'existing';
}

/** Includes an unbound team placeholder, whose correct delivery state is explicitly "not sent". */
export function shouldShowExecutionRunLinkPresentation(metadata: unknown): boolean {
    if (readExecutionRunLinkPresentationSource(metadata)) return true;
    return readSessionOriginViaV1(metadata) !== null;
}
