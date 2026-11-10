import * as React from 'react';
import { captureExternalSessionTakeoverStartInputV1 } from '@happier-dev/protocol/sessions/external/operationActionSchemasV1';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

import { showExternalSessionTakeoverDialog } from '@/components/sessions/external/takeover/showExternalSessionTakeoverDialog';
import { Modal } from '@/modal';
import type { UseExternalSessionRuntimeResult } from '@/components/sessions/model/useExternalSessionRuntime';
import {
    machineExternalSessionTakeoverStart,
    machineExternalSessionTakeoverPersist,
} from '@/sync/ops/machineExternalSessions';
import { randomUUID } from '@/platform/randomUUID';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { captureActiveServerAccountScopeCurrentness } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { isTerminalAuthError } from '@/sync/runtime/connectivity/authErrors';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import {
    createExternalSessionTranscriptLiveSourceKeyFromLink,
} from '@/sync/runtime/external/externalSessionTranscriptAuthority';
import { resolveExternalSessionTakeoverTargetDirectory } from '@/components/sessions/external/takeover/resolveExternalSessionTakeoverTargetDirectory';

type DirectTakeoverMode = 'direct' | 'persisted';
type TakeoverIdempotencyEntry = Readonly<{
    targetDirectory: string;
    idempotencyKey: string;
}>;

type UseExternalSessionTakeoverParams = Readonly<{
    sessionId: string;
    accountLifetime?: ServerAccountScopeLifetime | null;
    hasWriteAccess: boolean;
    externalSessionRuntime:
        Pick<UseExternalSessionRuntimeResult, 'externalSessionLink' | 'sessionServerId' | 'status' | 'refreshNow'>;
    targetMachineHomeDir?: string | null;
    targetDirectorySuggestion?: string | null;
    targetMachinePlatform?: string | null;
}>;

type UseExternalSessionTakeoverResult = Readonly<{
    takeoverInFlight: DirectTakeoverMode | null;
    takeoverPreflightInFlight: boolean;
    requestTakeover: (mode: DirectTakeoverMode, targetDirectory: string) => Promise<boolean>;
    requestTakeoverPreflight: () => Promise<boolean>;
    ensureReadyForSend: () => Promise<boolean>;
}>;

export function useExternalSessionTakeover(params: UseExternalSessionTakeoverParams): UseExternalSessionTakeoverResult {
    const presentationActive = useLayoutPresentationActive();
    const requestControllerRef = React.useRef<AbortController | null>(null);
    const [takeoverInFlight, setTakeoverInFlight] = React.useState<DirectTakeoverMode | null>(null);
    const [takeoverPreflightInFlight, setTakeoverPreflightInFlight] = React.useState(false);
    const mountedRef = React.useRef(true);
    const preflightGenerationRef = React.useRef(0);
    const preflightPromiseRef = React.useRef<Promise<boolean> | null>(null);
    const takeoverIdempotencyKeysRef = React.useRef<
        Record<DirectTakeoverMode, TakeoverIdempotencyEntry | null>
    >({ direct: null, persisted: null });
    const normalizedSessionId = React.useMemo(() => normalizeSessionId(params.sessionId), [params.sessionId]);
    const takeoverScopeKey = React.useMemo(() => {
        const link = params.externalSessionRuntime.externalSessionLink;
        if (!link) return normalizedSessionId;
        const authorityKey = createExternalSessionTranscriptLiveSourceKeyFromLink(link)
            ?? JSON.stringify(link);
        return `${normalizedSessionId}:${authorityKey}`;
    }, [normalizedSessionId, params.externalSessionRuntime.externalSessionLink]);
    const currentTakeoverScopeKeyRef = React.useRef(takeoverScopeKey);
    currentTakeoverScopeKeyRef.current = takeoverScopeKey;
    const takeoverDialogTarget = React.useMemo(() => {
        const link = params.externalSessionRuntime.externalSessionLink;
        if (!link) return null;
        const machineHomeDir = params.targetMachineHomeDir?.trim()
            ? params.targetMachineHomeDir
            : '';
        return {
            machineId: link.machineId,
            machineHomeDir,
            initialDirectory:
                params.targetDirectorySuggestion?.trim()
                    ? params.targetDirectorySuggestion
                    : machineHomeDir,
            ...(params.targetMachinePlatform
                ? { machinePlatform: params.targetMachinePlatform }
                : {}),
            ...(params.externalSessionRuntime.sessionServerId
                ? { serverId: params.externalSessionRuntime.sessionServerId }
                : {}),
        };
    }, [
        params.externalSessionRuntime.externalSessionLink,
        params.externalSessionRuntime.sessionServerId,
        params.targetDirectorySuggestion,
        params.targetMachineHomeDir,
        params.targetMachinePlatform,
    ]);

    React.useEffect(() => {
        mountedRef.current = presentationActive;
        const controller = new AbortController();
        requestControllerRef.current = controller;
        const lifetime = params.accountLifetime === undefined
            ? captureActiveServerAccountScopeCurrentness() : params.accountLifetime;
        const retirement = lifetime?.onRetire(() => controller.abort());
        preflightGenerationRef.current += 1;
        preflightPromiseRef.current = null;
        takeoverIdempotencyKeysRef.current = {
            direct: null,
            persisted: null,
        };
        setTakeoverInFlight(null);
        setTakeoverPreflightInFlight(false);
        return () => {
            controller.abort();
            retirement?.dispose();
            mountedRef.current = false;
            preflightGenerationRef.current += 1;
            preflightPromiseRef.current = null;
        };
    }, [takeoverScopeKey, params.accountLifetime, params.externalSessionRuntime.sessionServerId, presentationActive]);

    const readLatestStatus = React.useCallback(async () => {
        return await params.externalSessionRuntime.refreshNow();
    }, [params.externalSessionRuntime]);

    const requestTakeover = React.useCallback(async (
        mode: DirectTakeoverMode,
        targetDirectory: string,
    ): Promise<boolean> => {
        const requestGeneration = preflightGenerationRef.current;
        const requestScopeKey = takeoverScopeKey;
        // Takeover is Account-scoped: the durable start runs against the Account
        // that owns this machine and session. If the UI switches Account while a
        // status read, confirmation dialog or projection refresh is in flight,
        // Account A's intent must not emit against Account B.
        const accountCurrentness = params.accountLifetime === undefined
            ? captureActiveServerAccountScopeCurrentness()
            : params.accountLifetime;
        const isRequestCurrent = () => (
            mountedRef.current
            && requestControllerRef.current?.signal.aborted === false
            && preflightGenerationRef.current === requestGeneration
            && currentTakeoverScopeKeyRef.current === requestScopeKey
            && accountCurrentness?.isCurrent() === true
        );
        if (!isRequestCurrent()) {
            return false;
        }
        if (!params.hasWriteAccess) {
            Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
            return false;
        }

        const normalizedTargetDirectory = resolveExternalSessionTakeoverTargetDirectory(
            targetDirectory,
            params.targetMachineHomeDir,
        );
        if (!normalizedTargetDirectory) {
            return false;
        }

        const externalSessionLink = params.externalSessionRuntime.externalSessionLink;
        if (!externalSessionLink) {
            return false;
        }

        let latestStatus: Awaited<ReturnType<typeof readLatestStatus>>;
        try {
            latestStatus = await readLatestStatus();
        } catch (error) {
            if (!isRequestCurrent()) {
                return false;
            }
            if (isTerminalAuthError(error)) {
                throw error;
            }
            Modal.alert(t('common.error'), t('chatFooter.externalSessionStatusUnavailable'));
            return false;
        }
        if (!isRequestCurrent()) {
            return false;
        }
        if (!latestStatus) {
            // The user already confirmed a takeover mode and directory, so a
            // silent `false` here would read as a dead button after an explicit
            // choice. Report it exactly like the preflight and send-preflight
            // paths do; the dialog's Check Again route stays available.
            Modal.alert(t('common.error'), t('chatFooter.externalSessionStatusUnavailable'));
            return false;
        }
        if (!latestStatus.machineOnline) {
            Modal.alert(t('common.error'), t('chatFooter.externalSessionMachineOffline'));
            return false;
        }

        setTakeoverInFlight(mode);
        try {
            const serverId = params.externalSessionRuntime.sessionServerId;
            const existingIdempotencyEntry = takeoverIdempotencyKeysRef.current[mode];
            const idempotencyEntry = existingIdempotencyEntry?.targetDirectory === normalizedTargetDirectory
                ? existingIdempotencyEntry
                : {
                    targetDirectory: normalizedTargetDirectory,
                    idempotencyKey: randomUUID(),
                };
            const captured = captureExternalSessionTakeoverStartInputV1({
                request: {
                    v: 1 as const,
                    idempotencyKey: idempotencyEntry.idempotencyKey,
                    sessionId: normalizedSessionId,
                    plan: 'takeover' as const,
                    targetStorageMode: mode === 'persisted'
                        ? 'persisted' as const
                        : 'external-linked' as const,
                    targetDirectory: normalizedTargetDirectory,
                    targetRuntimeMode: 'terminal' as const,
                },
            }, externalSessionLink);
            if (!captured) {
                Modal.alert(t('common.error'), t('chatFooter.externalSessionStatusUnavailable'));
                return false;
            }
            takeoverIdempotencyKeysRef.current[mode] = idempotencyEntry;
            const takeoverInput = { machineId: externalSessionLink.machineId, ...captured };
            if (!isRequestCurrent()) {
                return false;
            }
            const result = mode === 'persisted'
                ? await machineExternalSessionTakeoverPersist({
                    machineId: externalSessionLink.machineId,
                    request: takeoverInput.request,
                }, { serverId, signal: requestControllerRef.current?.signal, ...(params.accountLifetime ? { accountLifetime: params.accountLifetime } : {}) })
                : await machineExternalSessionTakeoverStart(
                    takeoverInput,
                    { serverId, signal: requestControllerRef.current?.signal, ...(params.accountLifetime ? { accountLifetime: params.accountLifetime } : {}) },
                );
            if (
                takeoverIdempotencyKeysRef.current[mode]?.idempotencyKey
                    === idempotencyEntry.idempotencyKey
                && takeoverIdempotencyKeysRef.current[mode]?.targetDirectory
                    === normalizedTargetDirectory
            ) {
                takeoverIdempotencyKeysRef.current[mode] = null;
            }
            if (!isRequestCurrent()) {
                return false;
            }
            if (!result.ok) {
                Modal.alert(t('common.error'), result.error.message);
                return false;
            }

            // The typed `ok` result IS the accepted durable outcome. Projection
            // refresh below is best-effort read-side catch-up owned by the status
            // and session readers, which retry on their own cadence; a refresh
            // failure must never present an accepted takeover as failed and send
            // the user into a Retry that collides with the live operation.
            await Promise.all([
                params.externalSessionRuntime.refreshNow(),
                sync.refreshSessionMessages(normalizedSessionId),
                sync.refreshSessions(),
            ]).catch(() => {});

            return true;
        } catch (error) {
            if (isRequestCurrent()) {
                Modal.alert(t('common.error'), error instanceof Error ? error.message : t('errors.failedToSwitchControl'));
            }
            return false;
        } finally {
            if (isRequestCurrent()) {
                setTakeoverInFlight(null);
            }
        }
    }, [normalizedSessionId, params.accountLifetime, params.externalSessionRuntime, params.hasWriteAccess, params.targetMachineHomeDir, readLatestStatus, takeoverScopeKey]);

    const ensureReadyForSend = React.useCallback(async (): Promise<boolean> => {
        const requestGeneration = preflightGenerationRef.current;
        const requestScopeKey = takeoverScopeKey;
        // Takeover is Account-scoped: the durable start runs against the Account
        // that owns this machine and session. If the UI switches Account while a
        // status read, confirmation dialog or projection refresh is in flight,
        // Account A's intent must not emit against Account B.
        const accountCurrentness = captureActiveServerAccountScopeCurrentness();
        const isRequestCurrent = () => (
            mountedRef.current
            && preflightGenerationRef.current === requestGeneration
            && currentTakeoverScopeKeyRef.current === requestScopeKey
            && accountCurrentness.isCurrent()
        );
        const externalSessionLink = params.externalSessionRuntime.externalSessionLink;
        if (!externalSessionLink) {
            return isRequestCurrent();
        }

        let latestStatus: Awaited<ReturnType<typeof readLatestStatus>>;
        try {
            latestStatus = await readLatestStatus();
        } catch (error) {
            if (!isRequestCurrent()) {
                return false;
            }
            if (isTerminalAuthError(error)) {
                throw error;
            }
            Modal.alert(t('common.error'), t('chatFooter.externalSessionStatusUnavailable'));
            return false;
        }
        if (!isRequestCurrent()) {
            return false;
        }
        if (!latestStatus) {
            Modal.alert(t('common.error'), t('chatFooter.externalSessionStatusUnavailable'));
            return false;
        }
        if (latestStatus.runnerActive) {
            return isRequestCurrent();
        }
        if (!latestStatus.machineOnline) {
            Modal.alert(t('common.error'), t('chatFooter.externalSessionMachineOffline'));
            return false;
        }

        if (!isRequestCurrent()) {
            return false;
        }
        const resolution = await showExternalSessionTakeoverDialog({
            canTakeOverDirect: latestStatus.canTakeOverDirect,
            canTakeOverPersist: latestStatus.canTakeOverPersist,
            ...(takeoverDialogTarget ? { target: takeoverDialogTarget } : {}),
        });
        if (!isRequestCurrent()) {
            return false;
        }
        if (!resolution.action) {
            return false;
        }
        if (resolution.action === 'recheck') {
            return false;
        }

        if (!resolution.targetDirectory) {
            return false;
        }
        await requestTakeover(resolution.action, resolution.targetDirectory);
        // Start only creates/returns the durable operation. Admission and
        // spawn require an explicit operation Resume, so this send attempt
        // must not emit output against the still-linked external authority.
        return false;
    }, [params.externalSessionRuntime, readLatestStatus, requestTakeover, takeoverDialogTarget, takeoverScopeKey]);

    const requestTakeoverPreflight = React.useCallback((): Promise<boolean> => {
        if (preflightPromiseRef.current) {
            return preflightPromiseRef.current;
        }

        const requestGeneration = preflightGenerationRef.current;
        const requestScopeKey = takeoverScopeKey;
        // Takeover is Account-scoped: the durable start runs against the Account
        // that owns this machine and session. If the UI switches Account while a
        // status read, confirmation dialog or projection refresh is in flight,
        // Account A's intent must not emit against Account B.
        const accountCurrentness = captureActiveServerAccountScopeCurrentness();
        const isRequestCurrent = () => (
            mountedRef.current
            && preflightGenerationRef.current === requestGeneration
            && currentTakeoverScopeKeyRef.current === requestScopeKey
            && accountCurrentness.isCurrent()
        );
        let preflightPromise: Promise<boolean> | null = null;
        preflightPromise = (async (): Promise<boolean> => {
            setTakeoverPreflightInFlight(true);

            while (true) {
                let latestStatus: Awaited<ReturnType<typeof readLatestStatus>>;
                try {
                    latestStatus = await readLatestStatus();
                } catch (error) {
                    if (!isRequestCurrent()) {
                        return false;
                    }
                    if (isTerminalAuthError(error)) {
                        throw error;
                    }
                    Modal.alert(t('common.error'), t('chatFooter.externalSessionStatusUnavailable'));
                    return false;
                }

                if (!isRequestCurrent()) {
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
                            runningProcessPid: latestStatus.trustedPid ?? null,
                    });
                    if (
                        !isRequestCurrent()
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
                    ...(takeoverDialogTarget ? { target: takeoverDialogTarget } : {}),
                });
                if (
                    !isRequestCurrent()
                    || resolution.action === 'recheck'
                    || !resolution.action
                ) {
                    return false;
                }

                if (!resolution.targetDirectory) {
                    return false;
                }
                return requestTakeover(
                    resolution.action,
                    resolution.targetDirectory,
                );
            }
        })().finally(() => {
            if (preflightPromiseRef.current !== preflightPromise) return;
            preflightPromiseRef.current = null;
            if (isRequestCurrent()) {
                setTakeoverPreflightInFlight(false);
            }
        });

        preflightPromiseRef.current = preflightPromise;
        return preflightPromise;
    }, [readLatestStatus, requestTakeover, takeoverDialogTarget, takeoverScopeKey]);

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
