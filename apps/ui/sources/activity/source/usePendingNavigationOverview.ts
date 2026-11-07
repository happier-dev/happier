import * as React from 'react';

import { areSessionAddressesEqual, type SessionAddress } from '@/sync/domains/session/sessionAddress';

import {
    classifyPendingNavigationCandidates,
    type PendingNavigationCandidate,
    type PendingNavigationEntry,
} from './buildPendingNavigationFromSource';
import { createActivitySourceAddressTable } from './activitySourceSessionAddresses';
import { useSharedActivitySourceProjection, type ActivitySourceProjector } from './sharedActivitySourceProjection';

/** Every pending candidate, before any consumer leaves its own Session out. */
export type PendingNavigationProjection = Readonly<{
    candidates: readonly PendingNavigationCandidate[];
    nextAttentionBoundaryMs: number | null;
}>;

type PendingNavigationSnapshot = PendingNavigationProjection & Readonly<{ count: number }>;

function isSamePendingNavigationEntry(left: PendingNavigationEntry, right: PendingNavigationEntry): boolean {
    return left.nextAttentionBoundaryMs === right.nextAttentionBoundaryMs
        && left.candidate.session === right.candidate.session && left.candidate.waitsFor === right.candidate.waitsFor
        && areSessionAddressesEqual(left.candidate.address, right.candidate.address);
}

/** A Session row write re-classifies that address; the candidate list is rebuilt only when an entry moved. */
function createPendingNavigationProjector(): ActivitySourceProjector<PendingNavigationProjection> {
    let nowMs = Date.now();
    const table = createActivitySourceAddressTable<PendingNavigationEntry>({
        includeWarmSourceWhenNotReady: false,
        classify: (source, addresses) => classifyPendingNavigationCandidates(source, nowMs, addresses),
        isSame: isSamePendingNavigationEntry,
    });
    let published: PendingNavigationProjection | undefined;
    return {
        project: ({ source, nowMs: projectedAtMs, state }) => {
            nowMs = projectedAtMs;
            if (!table.update(source, state) && published) return published;
            const candidates: PendingNavigationCandidate[] = [];
            let nextAttentionBoundaryMs: number | null = null;
            // Proportional to the pending candidates, not the corpus.
            for (const entry of table.entries().values()) {
                candidates.push(entry.candidate);
                const ms = entry.nextAttentionBoundaryMs;
                if (ms !== null && (nextAttentionBoundaryMs === null || ms < nextAttentionBoundaryMs)) nextAttentionBoundaryMs = ms;
            }
            published = { candidates, nextAttentionBoundaryMs };
            return published;
        },
        observeUnchangedSource: state => table.observeUnchangedSource(state),
    };
}

function retainPendingNavigationProjection(previous: PendingNavigationProjection | undefined, next: PendingNavigationProjection) {
    return previous && previous.nextAttentionBoundaryMs === next.nextAttentionBoundaryMs
        && previous.candidates.length === next.candidates.length
        && previous.candidates.every((candidate, index) => candidate === next.candidates[index]) ? previous : next;
}

/** One pending projection for every mounted reader (pills, the Next host), each leaving out its own Session. */
export function usePendingNavigationProjection(presented = true): PendingNavigationProjection {
    return useSharedActivitySourceProjection(createPendingNavigationProjector, retainPendingNavigationProjection,
        { presented, changeDetection: 'identity' });
}

/** Pending chrome consumes pending candidates, rather than the whole Activity source. */
/** `presented: false` (a hidden retained surface) holds the last projection; presenting again re-reads the current one. */
export function usePendingNavigationOverview(excluding: SessionAddress | null, includeCandidateDetails: boolean, presented = true): PendingNavigationSnapshot {
    const serverId = excluding?.serverId;
    const sessionId = excluding?.sessionId;
    // This reader's own exclusion, applied at the subscription, so another Session's change renders it only when its answer moved.
    const pick = React.useMemo(() => {
        let previous: PendingNavigationSnapshot | undefined;
        let previousProjection: PendingNavigationProjection | undefined;
        const excluded = serverId && sessionId ? { serverId, sessionId } : null;
        return (projection: PendingNavigationProjection): PendingNavigationSnapshot => {
            if (previous && previousProjection === projection) return previous;
            previousProjection = projection;
            const candidates = projection.candidates.filter(candidate => !areSessionAddressesEqual(candidate.address, excluded));
            const next = { nextAttentionBoundaryMs: projection.nextAttentionBoundaryMs, count: candidates.length,
                candidates: includeCandidateDetails ? candidates : [] };
            if (previous && previous.nextAttentionBoundaryMs === next.nextAttentionBoundaryMs && previous.count === next.count
                && previous.candidates.length === next.candidates.length
                && previous.candidates.every((candidate, index) => {
                    const current = next.candidates[index]!;
                    return candidate.session === current.session && candidate.waitsFor === current.waitsFor
                        && candidate.address.serverId === current.address.serverId
                        && candidate.address.sessionId === current.address.sessionId;
                })) return previous;
            previous = next;
            return next;
        };
    }, [includeCandidateDetails, serverId, sessionId]);
    return useSharedActivitySourceProjection(createPendingNavigationProjector, retainPendingNavigationProjection,
        { presented, changeDetection: 'identity', pick });
}
