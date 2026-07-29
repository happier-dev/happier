import * as React from 'react';

import { showExternalSessionTakeoverDialog } from '@/components/sessions/external/takeover/showExternalSessionTakeoverDialog';
import { Modal } from '@/modal';
import type { UseExternalSessionRuntimeResult } from '@/components/sessions/model/useExternalSessionRuntime';
import {
    machineExternalSessionTakeoverStart,
    machineExternalSessionTakeoverPersist,
} from '@/sync/ops/machineExternalSessions';
import { randomUUID } from '@/platform/randomUUID';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { isTerminalAuthError } from '@/sync/runtime/connectivity/authErrors';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import {
    createExternalSessionTranscriptLiveSourceKeyFromLink,
} from '@/sync/runtime/external/externalSessionTranscriptAuthority';

type DirectTakeoverMode = 'direct' | 'persisted';

type UseExternalSessionTakeoverParams = Readonly<{
    sessionId: string;
    hasWriteAccess: boolean;
    externalSessionRuntime:
        Pick<UseExternalSessionRuntimeResult, 'externalSessionLink' | 'sessionServerId' | 'status' | 'refreshNow'>;
}>;

type UseExternalSessionTakeoverResult = Readonly<{
    takeoverInFlight: DirectTakeoverMode | null;
    takeoverPreflightInFlight: boolean;
    requestTakeover: (mode: DirectTakeoverMode) => Promise<boolean>;
    requestTakeoverPreflight: () => Promise<boolean>;
    ensureReadyForSend: () => Promise<boolean>;
}>;

export function useExternalSessionTakeover(params: UseExternalSessionTakeoverParams): UseExternalSessionTakeoverResult {
    const [takeoverInFlight, setTakeoverInFlight] = React.useState<DirectTakeoverMode | null>(null);
    const [takeoverPreflightInFlight, setTakeoverPreflightInFlight] = React.useState(false);
    const mountedRef = React.useRef(true);
    const preflightGenerationRef = React.useRef(0);
    const preflightPromiseRef = React.useRef<Promise<boolean> | null>(null);
    const takeoverIdempotencyKeysRef = React.useRef<
        Record<DirectTakeoverMode, string | null>
    >({ direct: null, persisted: null });
    const normalizedSessionId = React.useMemo(() => normalizeSessionId(params.sessionId), [params.sessionId]);
    const takeoverScopeKey = React.useMemo(() => {
        const link = params.externalSessionRuntime.externalSessionLink;
        if (!link) return normalizedSessionId;
        const authorityKey = createExternalSessionTranscriptLiveSourceKeyFromLink(link)
            ?? JSON.stringify(link);
        return `${normalizedSessionId}:${authorityKey}`;
    }, [normalizedSessionId, params.externalSessionRuntime.externalSessionLink]);

    React.useEffect(() => {
        mountedRef.current = true;
        preflightGenerationRef.current += 1;
        preflightPromiseRef.current = null;
        takeoverIdempotencyKeysRef.current = {
            direct: null,
            persisted: null,
        };
        setTakeoverPreflightInFlight(false);
        return () => {
            mountedRef.current = false;
            preflightGenerationRef.current += 1;
            preflightPromiseRef.current = null;
        };
    }, [takeoverScopeKey]);

    const readLatestStatus = React.useCallback(async (
        options?: Readonly<{ takeoverReadiness?: 'fresh' }>,
    ) => {
        return await params.externalSessionRuntime.refreshNow(options);
    }, [params.externalSessionRuntime]);

    const requestTakeover = React.useCallback(async (
        mode: DirectTakeoverMode,
    ): Promise<boolean> => {
        if (!params.hasWriteAccess) {
            Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
            return false;
        }

        const externalSessionLink = params.externalSessionRuntime.externalSessionLink;
        if (!externalSessionLink) {
            return false;
        }

        const latestStatus = await readLatestStatus();
        if (!latestStatus) {
            return false;
        }
        if (!latestStatus.machineOnline) {
            Modal.alert(t('common.error'), t('chatFooter.externalSessionMachineOffline'));
            return false;
        }

        setTakeoverInFlight(mode);
        try {
            const serverId = params.externalSessionRuntime.sessionServerId;
            const qualifiedIdentity = externalSessionLink.qualifiedIdentity;
            const linkedAtMs = externalSessionLink.linkedAtMs;
            if (
                !qualifiedIdentity
                || typeof linkedAtMs !== 'number'
                || !Number.isFinite(linkedAtMs)
                || linkedAtMs < 0
            ) {
                Modal.alert(
                    t('common.error'),
                    t('chatFooter.externalSessionStatusUnavailable'),
                );
                return false;
            }
            takeoverIdempotencyKeysRef.current[mode] ??= randomUUID();
            const takeoverInput = {
                machineId: externalSessionLink.machineId,
                request: {
                    v: 1 as const,
                    idempotencyKey:
                        takeoverIdempotencyKeysRef.current[mode],
                    sessionId: normalizedSessionId,
                    source: {
                        machineId: externalSessionLink.machineId,
                        remoteSessionId:
                            externalSessionLink.remoteSessionId,
                        qualifiedIdentity,
                        linkGeneration: String(linkedAtMs),
                    },
                    plan: 'takeover' as const,
                    targetStorageMode: mode === 'persisted'
                        ? 'persisted' as const
                        : 'external-linked' as const,
                    targetRuntimeMode: 'terminal' as const,
                },
            };
            const result = mode === 'persisted'
                ? await machineExternalSessionTakeoverPersist({
                    machineId: externalSessionLink.machineId,
                    request: takeoverInput.request,
                }, { serverId })
                : await machineExternalSessionTakeoverStart(
                    takeoverInput,
                    { serverId },
                );
            if (!result.ok) {
                Modal.alert(t('common.error'), result.error.message);
                return false;
            }

            await Promise.all([
                params.externalSessionRuntime.refreshNow(),
                sync.refreshSessionMessages(normalizedSessionId),
                sync.refreshSessions(),
            ]);

            return true;
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.failedToSwitchControl'));
            return false;
        } finally {
            setTakeoverInFlight(null);
        }
    }, [normalizedSessionId, params.externalSessionRuntime, params.hasWriteAccess, readLatestStatus]);

    const ensureReadyForSend = React.useCallback(async (): Promise<boolean> => {
        const externalSessionLink = params.externalSessionRuntime.externalSessionLink;
        if (!externalSessionLink) {
            return true;
        }

        let latestStatus: Awaited<ReturnType<typeof readLatestStatus>>;
        try {
            latestStatus = await readLatestStatus();
        } catch (error) {
            if (isTerminalAuthError(error)) {
                throw error;
            }
            return true;
        }
        if (!latestStatus) {
            return true;
        }
        if (latestStatus.runnerActive) {
            return true;
        }
        if (!latestStatus.machineOnline) {
            Modal.alert(t('common.error'), t('chatFooter.externalSessionMachineOffline'));
            return false;
        }

        const resolution = await showExternalSessionTakeoverDialog({
            canTakeOverDirect: latestStatus.canTakeOverDirect,
            canTakeOverPersist: latestStatus.canTakeOverPersist,
            canForceStop: false,
        });
        if (!resolution.action) {
            return false;
        }
        if (resolution.action === 'recheck') {
            return false;
        }

        await requestTakeover(resolution.action);
        // Start only creates/returns the durable operation. Admission and
        // spawn require an explicit operation Resume, so this send attempt
        // must not emit output against the still-linked external authority.
        return false;
    }, [params.externalSessionRuntime, readLatestStatus, requestTakeover]);

    const requestTakeoverPreflight = React.useCallback((): Promise<boolean> => {
        if (preflightPromiseRef.current) {
            return preflightPromiseRef.current;
        }

        const requestGeneration = preflightGenerationRef.current;
        let preflightPromise: Promise<boolean> | null = null;
        preflightPromise = (async (): Promise<boolean> => {
            setTakeoverPreflightInFlight(true);

            while (true) {
                let latestStatus: Awaited<ReturnType<typeof readLatestStatus>>;
                try {
                    latestStatus = await readLatestStatus({
                        takeoverReadiness: 'fresh',
                    });
                } catch (error) {
                    if (isTerminalAuthError(error)) {
                        throw error;
                    }
                    if (mountedRef.current && preflightGenerationRef.current === requestGeneration) {
                        Modal.alert(t('common.error'), t('chatFooter.externalSessionStatusUnavailable'));
                    }
                    return false;
                }

                if (!mountedRef.current || preflightGenerationRef.current !== requestGeneration) {
                    return false;
                }
                if (!latestStatus) {
                    Modal.alert(t('common.error'), t('chatFooter.externalSessionStatusUnavailable'));
                    return false;
                }
                if (!latestStatus.machineOnline) {
                    Modal.alert(t('common.error'), t('chatFooter.externalSessionMachineOffline'));
                    return false;
                }
                if (latestStatus.runnerActive) {
                    const runningResolution =
                        await showExternalSessionTakeoverDialog({
                            canTakeOverDirect: false,
                            canTakeOverPersist: false,
                            canForceStop: false,
                            runningProcessPid: latestStatus.trustedPid ?? null,
                        });
                    if (
                        !mountedRef.current
                        || preflightGenerationRef.current !== requestGeneration
                        || runningResolution.action !== 'recheck'
                    ) {
                        return false;
                    }
                    continue;
                }
                if (!latestStatus.canTakeOverDirect && !latestStatus.canTakeOverPersist) {
                    Modal.alert(t('common.error'), t('chatFooter.externalSessionTakeoverBlocked'));
                    return false;
                }

                const resolution = await showExternalSessionTakeoverDialog({
                    canTakeOverDirect: latestStatus.canTakeOverDirect,
                    canTakeOverPersist: latestStatus.canTakeOverPersist,
                    canForceStop: false,
                });
                if (
                    !mountedRef.current
                    || preflightGenerationRef.current !== requestGeneration
                    || resolution.action === 'recheck'
                    || !resolution.action
                ) {
                    return false;
                }

                return requestTakeover(resolution.action);
            }
        })().finally(() => {
            if (preflightPromiseRef.current !== preflightPromise) return;
            preflightPromiseRef.current = null;
            if (mountedRef.current && preflightGenerationRef.current === requestGeneration) {
                setTakeoverPreflightInFlight(false);
            }
        });

        preflightPromiseRef.current = preflightPromise;
        return preflightPromise;
    }, [readLatestStatus, requestTakeover]);

    return React.useMemo(() => ({
        takeoverInFlight,
        takeoverPreflightInFlight,
        requestTakeover,
        requestTakeoverPreflight,
        ensureReadyForSend,
    }), [
        ensureReadyForSend,
        requestTakeover,
        requestTakeoverPreflight,
        takeoverInFlight,
        takeoverPreflightInFlight,
    ]);
}
