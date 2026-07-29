import { readPendingLocalId } from '@happier-dev/protocol';

export const DEFAULT_COMMITTED_USER_MESSAGE_SEQ_TRACKER_MAX_ENTRIES = 256;

export type CommittedUserMessageSeqObservation = Readonly<{
    localId: string;
    seq: number;
}>;

export type CommittedUserMessageSeqListener = (
    observation: CommittedUserMessageSeqObservation,
) => void;

function normalizeSeq(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
}

export class CommittedUserMessageSeqTracker {
    private readonly committedSeqByLocalId = new Map<string, number>();
    private readonly listeners = new Set<CommittedUserMessageSeqListener>();

    constructor(
        private readonly maxEntries: number = DEFAULT_COMMITTED_USER_MESSAGE_SEQ_TRACKER_MAX_ENTRIES,
    ) {}

    get(localId: string): number | null {
        return this.committedSeqByLocalId.get(localId) ?? null;
    }

    record(localId: string | null | undefined, seq: unknown): number | null {
        const pendingLocalId = readPendingLocalId(localId);
        if (pendingLocalId === null) return null;
        const normalizedSeq = normalizeSeq(seq);
        if (normalizedSeq === null) return null;

        const existingSeq = this.committedSeqByLocalId.get(pendingLocalId) ?? null;
        if (existingSeq !== null) return existingSeq;

        this.committedSeqByLocalId.set(pendingLocalId, normalizedSeq);
        this.trimCommittedSeqs();
        const observation = Object.freeze({
            localId: pendingLocalId,
            seq: normalizedSeq,
        });
        for (const listener of [...this.listeners]) {
            try {
                listener(observation);
            } catch {
                // A consumer cannot invalidate the canonical committed sequence or block peers.
            }
        }
        return normalizedSeq;
    }

    subscribe(listener: CommittedUserMessageSeqListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    clear(): void {
        this.committedSeqByLocalId.clear();
        this.listeners.clear();
    }

    private trimCommittedSeqs(): void {
        const maxEntries = Math.max(1, Math.trunc(this.maxEntries));
        while (this.committedSeqByLocalId.size > maxEntries) {
            const oldest = this.committedSeqByLocalId.keys().next().value;
            if (typeof oldest !== 'string') return;
            this.committedSeqByLocalId.delete(oldest);
        }
    }
}
