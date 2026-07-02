import type { PrimaryTurnStatusV1 } from '@happier-dev/protocol';

export type LatestTurnStatusSnapshot = PrimaryTurnStatusV1 | null;

export function readLatestTurnStatusSnapshot(value: unknown): LatestTurnStatusSnapshot | undefined {
    if (value === null) return null;
    if (
        value === 'in_progress'
        || value === 'completed'
        || value === 'failed'
        || value === 'cancelled'
    ) {
        return value;
    }
    return undefined;
}

export function isActiveLatestTurnStatus(status: LatestTurnStatusSnapshot | undefined): boolean {
    return status === 'in_progress';
}
