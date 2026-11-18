import * as React from 'react';
import { useLayoutPresentationSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

import {
    presentExternalSessionOperationActionError,
} from '@/components/sessions/external/progress/externalSessionOperationActionErrorPresentation';
import type { UseExternalSessionRuntimeResult } from '@/components/sessions/model/useExternalSessionRuntime';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import type { ExternalSessionOperationProgressV1 } from '@happier-dev/protocol/sessions/external/operationV1';
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
    /**
     * Resolves to the operation the daemon started or converged on, so a caller can follow that exact
     * operation to settlement; `null` when nothing was started (every refusal is already shown).
     */
    requestMaterialize: () => Promise<ExternalSessionOperationProgressV1 | null>;
}>;

export function useExternalSessionMaterialize(
    params: UseExternalSessionMaterializeParams,
): UseExternalSessionMaterializeResult {
    // Presentation only starts and stops this owner's request lifetime: a subscription, so hiding or
    // showing the surface does not render the Session view that hosts it.
    const presentation = useLayoutPresentationSignal();
    const [materializeInFlight, setMaterializeInFlight] = React.useState(false);
    const mountedRef = React.useRef(true);
    const generationRef = React.useRef(0);
    const requestPromiseRef = React.useRef<Promise<ExternalSessionOperationProgressV1 | null> | null>(null);
    const idempotencyKeyRef = React.useRef<string | null>(null);
    const requestControllerRef = React.useRef<AbortController | null>(null);
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
        const begin = (presentationActive: boolean) => {
            mountedRef.current = presentationActive;
            const controller = new AbortController();
            requestControllerRef.current = controller;
            const retirement = captureActiveServerAccountScopeCurrentness().onRetire(() => controller.abort());
            generationRef.current += 1;
            requestPromiseRef.current = null;
            idempotencyKeyRef.current = null;
            setMaterializeInFlight(false);
            return () => {
                controller.abort();
                retirement.dispose();
                mountedRef.current = false;
                generationRef.current += 1;
                requestPromiseRef.current = null;
            };
        };
        let presented = presentation.get();
        let end = begin(presented);
        const unsubscribe = presentation.subscribe(() => {
            if (presentation.get() === presented) return;
            presented = presentation.get();
            end();
            end = begin(presented);
        });
        return () => {
            unsubscribe();
            end();
        };
    }, [materializeScopeKey, params.externalSessionRuntime.sessionServerId, presentation]);

    const requestMaterialize = React.useCallback((): Promise<ExternalSessionOperationProgressV1 | null> => {
        const signal = requestControllerRef.current?.signal;
        if (!mountedRef.current || !signal || signal.aborted) return Promise.resolve(null);
        if (requestPromiseRef.current) {
            return requestPromiseRef.current;
        }
        if (!params.hasWriteAccess) {
            Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
            return Promise.resolve(null);
        }
        const link = params.externalSessionRuntime.externalSessionLink;
        if (!link) {
            return Promise.resolve(null);
        }

        const requestGeneration = generationRef.current;
        // Materialize is Account-scoped: it converts Account A's linked session on
        // Account A's machine. If the UI switches Account while the status read is
        // in flight, Account A's intent must not emit against Account B.
        const accountCurrentness = captureActiveServerAccountScopeCurrentness();
        const isRequestCurrent = () => (
            mountedRef.current
            && generationRef.current === requestGeneration
            && accountCurrentness.isCurrent()
        );
        let requestPromise: Promise<ExternalSessionOperationProgressV1 | null> | null = null;
        requestPromise = (async () => {
            setMaterializeInFlight(true);
            try {
                const latestStatus = await params.externalSessionRuntime.refreshNow();
                if (!isRequestCurrent()) {
                    return null;
                }
                if (!latestStatus) {
                    Modal.alert(
                        t('common.error'),
                        t('chatFooter.externalSessionStatusUnavailable'),
                    );
                    return null;
                }
                if (!latestStatus.machineOnline) {
                    Modal.alert(
                        t('common.error'),
                        t('chatFooter.externalSessionMachineOffline'),
                    );
                    return null;
                }

                if (!isRequestCurrent()) {
                    return null;
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
                    signal,
                });
                if (!isRequestCurrent()) {
                    return null;
                }
                if (!result.ok) {
                    Modal.alert(
                        t('common.error'),
                        t(presentExternalSessionOperationActionError(result.error.code)),
                    );
                    return null;
                }
                return result.progress;
            } catch {
                if (isRequestCurrent()) {
                    Modal.alert(
                        t('common.error'),
                        t('externalSessions.operationActionErrorUnavailable'),
                    );
                }
                return null;
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
