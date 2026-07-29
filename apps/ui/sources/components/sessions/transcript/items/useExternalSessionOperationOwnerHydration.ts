import * as React from 'react';

import type {
    ExternalSessionOperationProgressV1,
    ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol';

import { machineExternalSessionOperationStatus } from '@/sync/ops/machineExternalSessions';
import { fireAndForget } from '@/utils/system/fireAndForget';

type HydratedProgressState = Readonly<{
    key: string;
    progress: ExternalSessionOperationProgressV1;
}> | null;

function createOperationKey(params: Readonly<{
    sessionId: string;
    presentation: ExternalSessionOperationSharedPresentationV1;
}>): string {
    return JSON.stringify([
        params.sessionId,
        params.presentation.operationId,
        params.presentation.revision,
    ]);
}

function matchesPresentation(
    progress: ExternalSessionOperationProgressV1,
    presentation: ExternalSessionOperationSharedPresentationV1,
): boolean {
    return progress.operationId === presentation.operationId
        && progress.revision === presentation.revision;
}

export function useExternalSessionOperationOwnerHydration(params: Readonly<{
    isExactOwner: boolean;
    machineId: string | null;
    machineOnline: boolean;
    presentation: ExternalSessionOperationSharedPresentationV1 | null;
    serverId: string | null;
    sessionId: string;
}>) {
    const {
        isExactOwner,
        machineId,
        machineOnline,
        presentation,
        serverId,
        sessionId,
    } = params;
    const eligible = isExactOwner && machineId !== null && machineOnline;
    const currentKey = presentation
        ? createOperationKey({ sessionId, presentation })
        : null;
    const currentRef = React.useRef<Readonly<{
        eligible: boolean;
        key: string | null;
        machineId: string | null;
        presentation: ExternalSessionOperationSharedPresentationV1 | null;
        serverId: string | null;
    }>>({
        eligible,
        key: currentKey,
        machineId,
        presentation,
        serverId,
    });
    currentRef.current = {
        eligible,
        key: currentKey,
        machineId,
        presentation,
        serverId,
    };
    const attemptedKeysRef = React.useRef(new Set<string>());
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
            serverId: string | null;
        }>,
    ) => {
        try {
            const result = await machineExternalSessionOperationStatus({
                machineId: snapshot.machineId,
                sessionId,
                operationId: snapshot.presentation.operationId,
                revision: snapshot.presentation.revision,
            }, snapshot.serverId ? { serverId: snapshot.serverId } : undefined);
            const current = currentRef.current;
            if (!mountedRef.current) return;
            if (
                !current.eligible
                || current.key !== snapshot.key
                || !result.ok
                || !matchesPresentation(result.progress, snapshot.presentation)
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
                && currentRef.current.key === snapshot.key
            ) {
                setHydrated(null);
            }
        }
    }, [sessionId]);

    React.useEffect(() => {
        if (!eligible || !currentKey || !machineId || !presentation) {
            setHydrated(null);
            return;
        }
        if (attemptedKeysRef.current.has(currentKey)) return;
        attemptedKeysRef.current.add(currentKey);
        fireAndForget(loadCurrent({
            key: currentKey,
            machineId,
            presentation,
            serverId,
        }), { tag: 'externalSessionOperation.ownerHydration' });
    }, [
        currentKey,
        eligible,
        loadCurrent,
        machineId,
        presentation,
        serverId,
    ]);

    const onActionResult = React.useCallback((
        progress: ExternalSessionOperationProgressV1,
    ) => {
        const current = currentRef.current;
        if (
            !current.eligible
            || !current.key
            || !current.machineId
            || !current.presentation
        ) {
            setHydrated(null);
            return;
        }
        setHydrated(null);
        if (!matchesPresentation(progress, current.presentation)) return;
        fireAndForget(loadCurrent({
            key: current.key,
            machineId: current.machineId,
            presentation: current.presentation,
            serverId: current.serverId,
        }), { tag: 'externalSessionOperation.ownerActionRevalidation' });
    }, [loadCurrent]);

    const progress = (
        eligible
        && currentKey !== null
        && hydrated?.key === currentKey
        && presentation
        && matchesPresentation(hydrated.progress, presentation)
    )
        ? hydrated.progress
        : null;

    return React.useMemo(() => ({
        onActionResult,
        progress,
    }), [onActionResult, progress]);
}
