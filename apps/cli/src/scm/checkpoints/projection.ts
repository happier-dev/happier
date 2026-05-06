import type { TurnChangeSet } from '@happier-dev/protocol';

import type {
    RepositoryCheckpointDiffResult,
    RepositoryCheckpointReceipt,
} from './types';

type TurnRepositoryCheckpoint = NonNullable<TurnChangeSet['repositoryCheckpoint']>;

function toProtocolReceipts(receipts: readonly RepositoryCheckpointReceipt[]): TurnRepositoryCheckpoint['receipts'] {
    return receipts.map((receipt) => ({
        id: receipt.id,
        ...(receipt.ref ? { ref: receipt.ref } : {}),
        ...(receipt.commitSha ? { commitSha: receipt.commitSha } : {}),
        ...(receipt.treeSha ? { treeSha: receipt.treeSha } : {}),
        ...(receipt.phase ? { phase: receipt.phase } : {}),
        ...(typeof receipt.prunedCount === 'number' ? { prunedCount: receipt.prunedCount } : {}),
        ...(receipt.refs ? { refs: [...receipt.refs] } : {}),
    }));
}

export function projectRepositoryCheckpointTurnChangeSet(params: Readonly<{
    providerTurnChangeSet: TurnChangeSet;
    checkpointDiff: RepositoryCheckpointDiffResult;
    scopeId: string;
    startRef?: string;
    finalRef?: string;
}>): TurnChangeSet {
    const repositoryCheckpoint: TurnRepositoryCheckpoint = {
        version: 1,
        scopeId: params.scopeId,
        ...(params.startRef ? { startRef: params.startRef } : {}),
        ...(params.finalRef ? { finalRef: params.finalRef } : {}),
        baseRefSource: params.checkpointDiff.success
            ? params.checkpointDiff.baseRefSource
            : params.checkpointDiff.baseRefSource,
        contentConfidence: params.checkpointDiff.contentConfidence,
        attributionScope: params.checkpointDiff.attributionScope,
        receipts: toProtocolReceipts(params.checkpointDiff.receipts),
        ...(!params.checkpointDiff.success ? { unavailableReason: params.checkpointDiff.reason } : {}),
    };

    return {
        ...params.providerTurnChangeSet,
        files: params.checkpointDiff.success
            ? [...params.providerTurnChangeSet.files, ...params.checkpointDiff.files]
            : [...params.providerTurnChangeSet.files],
        repositoryCheckpoint,
    };
}
