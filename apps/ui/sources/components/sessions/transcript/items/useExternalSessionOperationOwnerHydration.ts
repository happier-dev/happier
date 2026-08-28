import * as React from 'react';

import type {
    ExternalSessionOperationProgressV1,
    ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol';

import { machineExternalSessionOperationStatus } from '@/sync/ops/machineExternalSessions';
import {
    createExternalSessionOperationPresentationIdentity,
    matchesExternalSessionOperationPresentation,
} from '@/sync/runtime/external/externalSessionOperationPresentationIdentity';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * The SETTLED exact-owner status read for ONE operation identity.
 *
 * `unavailable` is a first-class outcome, not the absence of a read: a transient status
 * read failure must stay distinguishable from "this reader is not the owner" and from
 * "the machine is offline", because only the failure is recoverable by asking again.
 *
 * Only settled outcomes are recorded, and a revalidation cannot blank an already-hydrated
 * matching row: the reader keeps seeing the last good progress until a newer good read lands.
 * An initial read failure remains `unavailable`; a later refresh failure does not erase detail.
 */
type OwnerHydrationRead =
    | Readonly<{
        key: string;
        outcome: 'ready';
        progress: ExternalSessionOperationProgressV1;
    }>
    | Readonly<{ key: string; outcome: 'unavailable' }>;

export type ExternalSessionOperationOwnerHydrationStatus =
    | 'not_owner'
    | 'offline'
    | 'loading'
    | 'ready'
    | 'unavailable';

function createOperationKey(params: Readonly<{
    machineId: string;
    ownerScopeKey: string;
    serverId: string;
    sessionId: string;
    presentation: ExternalSessionOperationSharedPresentationV1;
}>): string {
    return JSON.stringify([
        params.serverId,
        params.ownerScopeKey,
        params.machineId,
        params.sessionId,
        createExternalSessionOperationPresentationIdentity(params.presentation),
    ]);
}

export function useExternalSessionOperationOwnerHydration(params: Readonly<{
    isExactOwner: boolean;
    machineId: string | null;
    machineOnline: boolean;
    ownerScopeKey: string | null;
    presentation: ExternalSessionOperationSharedPresentationV1 | null;
    serverId: string | null;
    sessionId: string;
}>) {
    const {
        isExactOwner,
        machineId,
        machineOnline,
        ownerScopeKey,
        presentation,
        serverId,
        sessionId,
    } = params;
    const authorized = isExactOwner
        && machineId !== null
        && ownerScopeKey !== null
        && serverId !== null;
    const readEligible = authorized && machineOnline;
    const currentKey = authorized && presentation
        ? createOperationKey({
            machineId,
            ownerScopeKey,
            presentation,
            serverId,
            sessionId,
        })
        : null;
    const currentRef = React.useRef<Readonly<{
        authorized: boolean;
        key: string | null;
        machineId: string | null;
        presentation: ExternalSessionOperationSharedPresentationV1 | null;
        readEligible: boolean;
        serverId: string | null;
    }>>({
        authorized,
        key: currentKey,
        machineId,
        presentation,
        readEligible,
        serverId,
    });
    currentRef.current = {
        authorized,
        key: currentKey,
        machineId,
        presentation,
        readEligible,
        serverId,
    };
    const readEpisodeRef = React.useRef<Readonly<{
        key: string | null;
        readEligible: boolean;
    }>>({
        key: null,
        readEligible: false,
    });
    const requestSequenceRef = React.useRef(0);
    const latestRequestRef = React.useRef<Readonly<{
        key: string;
        sequence: number;
    }> | null>(null);
    const mountedRef = React.useRef(true);
    const [hydrated, setHydrated] = React.useState<OwnerHydrationRead | null>(null);
    const hydratedRef = React.useRef<OwnerHydrationRead | null>(hydrated);
    // One writer for the read outcome so the imperative mirror can never drift from state:
    // `checkAgain` reads the mirror synchronously, before React has re-rendered.
    const commitRead = React.useCallback((next: OwnerHydrationRead | null) => {
        hydratedRef.current = next;
        setHydrated(next);
    }, []);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    const loadCurrent = React.useCallback(async (
        snapshot: Readonly<{
            key: string;
            machineId: string;
            presentation: ExternalSessionOperationSharedPresentationV1;
            serverId: string;
        }>,
    ) => {
        const sequence = requestSequenceRef.current + 1;
        requestSequenceRef.current = sequence;
        latestRequestRef.current = {
            key: snapshot.key,
            sequence,
        };
        try {
            const result = await machineExternalSessionOperationStatus({
                machineId: snapshot.machineId,
                sessionId,
                operationId: snapshot.presentation.operationId,
                revision: snapshot.presentation.revision,
            }, { serverId: snapshot.serverId });
            const current = currentRef.current;
            if (!mountedRef.current) return;
            if (
                latestRequestRef.current?.key !== snapshot.key
                || latestRequestRef.current.sequence !== sequence
            ) return;
            if (
                !current.authorized
                || current.key !== snapshot.key
                || !result.ok
                || !current.presentation
                || !matchesExternalSessionOperationPresentation(
                    result.progress,
                    current.presentation,
                )
            ) {
                if (current.key === snapshot.key) {
                    const settled = hydratedRef.current;
                    if (settled?.key !== snapshot.key || settled.outcome !== 'ready') {
                        commitRead({ key: snapshot.key, outcome: 'unavailable' });
                    }
                }
                return;
            }
            commitRead({
                key: snapshot.key,
                outcome: 'ready',
                progress: result.progress,
            });
        } catch {
            if (
                mountedRef.current
                && latestRequestRef.current?.key === snapshot.key
                && latestRequestRef.current.sequence === sequence
                && currentRef.current.key === snapshot.key
            ) {
                const settled = hydratedRef.current;
                if (settled?.key !== snapshot.key || settled.outcome !== 'ready') {
                    commitRead({ key: snapshot.key, outcome: 'unavailable' });
                }
            }
        }
    }, [commitRead, sessionId]);

    React.useEffect(() => {
        if (!authorized || !currentKey || !machineId || !presentation || !serverId) {
            readEpisodeRef.current = {
                key: null,
                readEligible: false,
            };
            commitRead(null);
            return;
        }
        if (!readEligible) {
            readEpisodeRef.current = {
                key: currentKey,
                readEligible: false,
            };
            return;
        }
        const readEpisode = readEpisodeRef.current;
        if (
            readEpisode.key === currentKey
            && readEpisode.readEligible
        ) return;
        readEpisodeRef.current = {
            key: currentKey,
            readEligible: true,
        };
        fireAndForget(loadCurrent({
            key: currentKey,
            machineId,
            presentation,
            serverId,
        }), { tag: 'externalSessionOperation.ownerHydration' });
    }, [
        authorized,
        commitRead,
        currentKey,
        loadCurrent,
        machineId,
        presentation,
        readEligible,
        serverId,
    ]);

    const onActionResult = React.useCallback((
        progress: ExternalSessionOperationProgressV1,
    ) => {
        const current = currentRef.current;
        if (
            !current.authorized
            || !current.key
            || !current.machineId
            || !current.presentation
            || !current.serverId
        ) {
            commitRead(null);
            return;
        }
        if (!current.readEligible) return;
        if (!matchesExternalSessionOperationPresentation(
            progress,
            current.presentation,
        )) return;
        fireAndForget(loadCurrent({
            key: current.key,
            machineId: current.machineId,
            presentation: current.presentation,
            serverId: current.serverId,
        }), { tag: 'externalSessionOperation.ownerActionRevalidation' });
    }, [commitRead, loadCurrent]);

    /**
     * The exact owner's ONE manual recovery for a failed status read. It re-issues the
     * same read against the CURRENT operation identity — never a captured stale one — and
     * the existing request-sequence fence still discards any superseded response. It is
     * inert unless the current read actually failed, so it cannot become a poll.
     */
    const checkAgain = React.useCallback(() => {
        const current = currentRef.current;
        if (
            !current.authorized
            || !current.readEligible
            || !current.key
            || !current.machineId
            || !current.presentation
            || !current.serverId
        ) return;
        const read = hydratedRef.current;
        if (read?.key !== current.key || read.outcome !== 'unavailable') return;
        fireAndForget(loadCurrent({
            key: current.key,
            machineId: current.machineId,
            presentation: current.presentation,
            serverId: current.serverId,
        }), { tag: 'externalSessionOperation.ownerHydrationCheckAgain' });
    }, [loadCurrent]);

    const currentRead = currentKey !== null && hydrated?.key === currentKey
        ? hydrated
        : null;
    const progress = (
        authorized
        && currentRead?.outcome === 'ready'
        && presentation
        && matchesExternalSessionOperationPresentation(
            currentRead.progress,
            presentation,
        )
    )
        ? currentRead.progress
        : null;
    const status: ExternalSessionOperationOwnerHydrationStatus = !authorized || !presentation
        ? 'not_owner'
        : !readEligible
            ? 'offline'
            : progress !== null
                ? 'ready'
                : currentRead?.outcome === 'unavailable'
                    ? 'unavailable'
                    : 'loading';

    return React.useMemo(() => ({
        checkAgain,
        onActionResult,
        progress,
        status,
    }), [checkAgain, onActionResult, progress, status]);
}
