import * as React from 'react';

import {
    presentExternalSessionOperationActionError,
} from '@/components/sessions/external/progress/externalSessionOperationActionErrorPresentation';
import type { UseExternalSessionRuntimeResult } from '@/components/sessions/model/useExternalSessionRuntime';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import {
    machineExternalSessionMaterializeStart,
} from '@/sync/ops/machineExternalSessions';
import { t } from '@/text';

type UseExternalSessionMaterializeParams = Readonly<{
    sessionId: string;
    hasWriteAccess: boolean;
    externalSessionRuntime:
        Pick<
            UseExternalSessionRuntimeResult,
            'externalSessionLink' | 'sessionServerId' | 'status' | 'refreshNow'
        >;
}>;

export type UseExternalSessionMaterializeResult = Readonly<{
    materializeInFlight: boolean;
    requestMaterialize: () => Promise<boolean>;
}>;

export function useExternalSessionMaterialize(
    params: UseExternalSessionMaterializeParams,
): UseExternalSessionMaterializeResult {
    const [materializeInFlight, setMaterializeInFlight] = React.useState(false);
    const mountedRef = React.useRef(true);
    const generationRef = React.useRef(0);
    const requestPromiseRef = React.useRef<Promise<boolean> | null>(null);
    const idempotencyKeyRef = React.useRef<string | null>(null);
    const normalizedSessionId = React.useMemo(
        () => normalizeSessionId(params.sessionId),
        [params.sessionId],
    );
    const materializeScopeKey = React.useMemo(() => {
        const link = params.externalSessionRuntime.externalSessionLink;
        if (!link) return normalizedSessionId;
        return JSON.stringify([
            normalizedSessionId,
            link.machineId,
            link.agentId,
            link.remoteSessionId,
            link.linkedAtMs ?? null,
        ]);
    }, [normalizedSessionId, params.externalSessionRuntime.externalSessionLink]);

    React.useEffect(() => {
        mountedRef.current = true;
        generationRef.current += 1;
        requestPromiseRef.current = null;
        idempotencyKeyRef.current = null;
        setMaterializeInFlight(false);
        return () => {
            mountedRef.current = false;
            generationRef.current += 1;
            requestPromiseRef.current = null;
        };
    }, [materializeScopeKey]);

    const requestMaterialize = React.useCallback((): Promise<boolean> => {
        if (requestPromiseRef.current) {
            return requestPromiseRef.current;
        }
        if (!params.hasWriteAccess) {
            Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
            return Promise.resolve(false);
        }
        const link = params.externalSessionRuntime.externalSessionLink;
        if (!link) {
            return Promise.resolve(false);
        }

        const requestGeneration = generationRef.current;
        let requestPromise: Promise<boolean> | null = null;
        requestPromise = (async () => {
            setMaterializeInFlight(true);
            try {
                const latestStatus = await params.externalSessionRuntime.refreshNow();
                if (
                    !mountedRef.current
                    || generationRef.current !== requestGeneration
                ) {
                    return false;
                }
                if (!latestStatus) {
                    Modal.alert(
                        t('common.error'),
                        t('chatFooter.externalSessionStatusUnavailable'),
                    );
                    return false;
                }
                if (!latestStatus.machineOnline) {
                    Modal.alert(
                        t('common.error'),
                        t('chatFooter.externalSessionMachineOffline'),
                    );
                    return false;
                }

                idempotencyKeyRef.current ??= randomUUID();
                const result = await machineExternalSessionMaterializeStart({
                    machineId: link.machineId,
                    request: {
                        v: 1,
                        idempotencyKey: idempotencyKeyRef.current,
                        sessionId: normalizedSessionId,
                        plan: 'materialize',
                        targetStorageMode: 'external-linked',
                        targetRuntimeMode: null,
                    },
                }, {
                    serverId: params.externalSessionRuntime.sessionServerId,
                });
                if (
                    !mountedRef.current
                    || generationRef.current !== requestGeneration
                ) {
                    return false;
                }
                if (!result.ok) {
                    Modal.alert(
                        t('common.error'),
                        t(presentExternalSessionOperationActionError(result.error.code)),
                    );
                    return false;
                }
                return true;
            } catch {
                if (
                    mountedRef.current
                    && generationRef.current === requestGeneration
                ) {
                    Modal.alert(
                        t('common.error'),
                        t('externalSessions.operationActionErrorUnavailable'),
                    );
                }
                return false;
            } finally {
                if (
                    requestPromiseRef.current === requestPromise
                    && mountedRef.current
                    && generationRef.current === requestGeneration
                ) {
                    requestPromiseRef.current = null;
                    setMaterializeInFlight(false);
                }
            }
        })();
        requestPromiseRef.current = requestPromise;
        return requestPromise;
    }, [
        normalizedSessionId,
        params.externalSessionRuntime,
        params.hasWriteAccess,
    ]);

    return React.useMemo(() => ({
        materializeInFlight,
        requestMaterialize,
    }), [materializeInFlight, requestMaterialize]);
}
