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

type HydratedProgressState = Readonly<{
    key: string;
    progress: ExternalSessionOperationProgressV1;
}> | null;

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
    const [hydrated, setHydrated] = React.useState<HydratedProgressState>(null);

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
                    setHydrated(null);
                }
                return;
            }
            setHydrated({
                key: snapshot.key,
                progress: result.progress,
            });
        } catch {
            if (
                mountedRef.current
                && latestRequestRef.current?.key === snapshot.key
                && latestRequestRef.current.sequence === sequence
                && currentRef.current.key === snapshot.key
            ) {
                setHydrated(null);
            }
        }
    }, [sessionId]);

    React.useEffect(() => {
        if (!authorized || !currentKey || !machineId || !presentation || !serverId) {
            readEpisodeRef.current = {
                key: null,
                readEligible: false,
            };
            setHydrated(null);
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
            setHydrated(null);
            return;
        }
        if (!current.readEligible) return;
        setHydrated(null);
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
    }, [loadCurrent]);

    const progress = (
        authorized
        && currentKey !== null
        && hydrated?.key === currentKey
        && presentation
        && matchesExternalSessionOperationPresentation(
            hydrated.progress,
            presentation,
        )
    )
        ? hydrated.progress
        : null;

    return React.useMemo(() => ({
        onActionResult,
        progress,
    }), [onActionResult, progress]);
}
