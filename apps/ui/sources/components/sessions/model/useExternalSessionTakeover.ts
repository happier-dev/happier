import * as React from 'react';

import { showExternalSessionTakeoverDialog } from '@/components/sessions/external/takeover/showExternalSessionTakeoverDialog';
import { Modal } from '@/modal';
import type { UseExternalSessionRuntimeResult } from '@/components/sessions/model/useExternalSessionRuntime';
import { machineExternalSessionTakeover, machineExternalSessionTakeoverPersist } from '@/sync/ops/machineExternalSessions';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { sync } from '@/sync/sync';
import { t } from '@/text';

type DirectTakeoverMode = 'direct' | 'persisted';

type UseExternalSessionTakeoverParams = Readonly<{
    sessionId: string;
    hasWriteAccess: boolean;
    externalSessionRuntime: Pick<UseExternalSessionRuntimeResult, 'externalSessionLink' | 'sessionServerId' | 'status' | 'refreshNow'>;
}>;

type UseExternalSessionTakeoverResult = Readonly<{
    takeoverInFlight: DirectTakeoverMode | null;
    requestTakeover: (mode: DirectTakeoverMode, options?: Readonly<{ forceStop?: boolean; promptForForceStop?: boolean }>) => Promise<boolean>;
    ensureReadyForSend: () => Promise<boolean>;
}>;

export function useExternalSessionTakeover(params: UseExternalSessionTakeoverParams): UseExternalSessionTakeoverResult {
    const [takeoverInFlight, setTakeoverInFlight] = React.useState<DirectTakeoverMode | null>(null);
    const normalizedSessionId = React.useMemo(() => normalizeSessionId(params.sessionId), [params.sessionId]);

    const readLatestStatus = React.useCallback(async () => {
        return await params.externalSessionRuntime.refreshNow();
    }, [params.externalSessionRuntime]);

    const requestTakeover = React.useCallback(async (
        mode: DirectTakeoverMode,
        options?: Readonly<{ forceStop?: boolean; promptForForceStop?: boolean }>,
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

        let forceStop = options?.forceStop === true;
        if (!forceStop && latestStatus.canForceStop && options?.promptForForceStop !== false) {
            const confirmed = await Modal.confirm(
                t('chatFooter.directTakeoverForceStopConfirmTitle'),
                t('chatFooter.directTakeoverForceStopConfirmBody'),
                {
                    confirmText: t('chatFooter.directTakeoverForceStopConfirmAction'),
                    cancelText: t('common.cancel'),
                },
            );
            if (!confirmed) {
                return false;
            }
            forceStop = true;
        }

        setTakeoverInFlight(mode);
        try {
            const request = {
                machineId: externalSessionLink.machineId,
                sessionId: normalizedSessionId,
                ...(forceStop ? { forceStop: true } : {}),
            };
            const serverId = params.externalSessionRuntime.sessionServerId;
            const result = mode === 'persisted'
                ? await machineExternalSessionTakeoverPersist(request, { serverId })
                : await machineExternalSessionTakeover(request, { serverId });

            if (!result.ok) {
                Modal.alert(t('common.error'), result.error);
                return false;
            }

            await Promise.all([
                params.externalSessionRuntime.refreshNow(),
                sync.refreshSessionMessages(normalizedSessionId),
                mode === 'persisted' ? sync.refreshSessions() : Promise.resolve(),
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

        const latestStatus = await readLatestStatus();
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
            canForceStop: latestStatus.canForceStop,
        });
        if (!resolution.action) {
            return false;
        }

        return requestTakeover(resolution.action, {
            forceStop: resolution.forceStop,
            promptForForceStop: false,
        });
    }, [params.externalSessionRuntime, readLatestStatus, requestTakeover]);

    return React.useMemo(() => ({
        takeoverInFlight,
        requestTakeover,
        ensureReadyForSend,
    }), [ensureReadyForSend, requestTakeover, takeoverInFlight]);
}
