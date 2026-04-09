import * as React from 'react';

import { showDirectSessionTakeoverDialog } from '@/components/sessions/directSessions/takeover/showDirectSessionTakeoverDialog';
import { Modal } from '@/modal';
import type { UseDirectSessionRuntimeResult } from '@/components/sessions/model/useDirectSessionRuntime';
import { machineDirectSessionTakeover, machineDirectSessionTakeoverPersist } from '@/sync/ops/machineDirectSessions';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { sync } from '@/sync/sync';
import { t } from '@/text';

type DirectTakeoverMode = 'direct' | 'persisted';

type UseDirectSessionTakeoverParams = Readonly<{
    sessionId: string;
    hasWriteAccess: boolean;
    directSessionRuntime: Pick<UseDirectSessionRuntimeResult, 'directSessionLink' | 'sessionServerId' | 'status' | 'refreshNow'>;
}>;

type UseDirectSessionTakeoverResult = Readonly<{
    takeoverInFlight: DirectTakeoverMode | null;
    requestTakeover: (mode: DirectTakeoverMode, options?: Readonly<{ forceStop?: boolean; promptForForceStop?: boolean }>) => Promise<boolean>;
    ensureReadyForSend: () => Promise<boolean>;
}>;

export function useDirectSessionTakeover(params: UseDirectSessionTakeoverParams): UseDirectSessionTakeoverResult {
    const [takeoverInFlight, setTakeoverInFlight] = React.useState<DirectTakeoverMode | null>(null);
    const normalizedSessionId = React.useMemo(() => normalizeSessionId(params.sessionId), [params.sessionId]);

    const readLatestStatus = React.useCallback(async () => {
        return await params.directSessionRuntime.refreshNow();
    }, [params.directSessionRuntime]);

    const requestTakeover = React.useCallback(async (
        mode: DirectTakeoverMode,
        options?: Readonly<{ forceStop?: boolean; promptForForceStop?: boolean }>,
    ): Promise<boolean> => {
        if (!params.hasWriteAccess) {
            Modal.alert(t('common.error'), t('session.sharing.noEditPermission'));
            return false;
        }

        const directSessionLink = params.directSessionRuntime.directSessionLink;
        if (!directSessionLink) {
            return false;
        }

        const latestStatus = await readLatestStatus();
        if (!latestStatus) {
            return false;
        }
        if (!latestStatus.machineOnline) {
            Modal.alert(t('common.error'), t('chatFooter.directSessionMachineOffline'));
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
                machineId: directSessionLink.machineId,
                sessionId: normalizedSessionId,
                ...(forceStop ? { forceStop: true } : {}),
            };
            const serverId = params.directSessionRuntime.sessionServerId;
            const result = mode === 'persisted'
                ? await machineDirectSessionTakeoverPersist(request, { serverId })
                : await machineDirectSessionTakeover(request, { serverId });

            if (!result.ok) {
                Modal.alert(t('common.error'), result.error);
                return false;
            }

            await Promise.all([
                params.directSessionRuntime.refreshNow(),
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
    }, [normalizedSessionId, params.directSessionRuntime, params.hasWriteAccess, readLatestStatus]);

    const ensureReadyForSend = React.useCallback(async (): Promise<boolean> => {
        const directSessionLink = params.directSessionRuntime.directSessionLink;
        if (!directSessionLink) {
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
            Modal.alert(t('common.error'), t('chatFooter.directSessionMachineOffline'));
            return false;
        }

        const resolution = await showDirectSessionTakeoverDialog({
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
    }, [params.directSessionRuntime, readLatestStatus, requestTakeover]);

    return React.useMemo(() => ({
        takeoverInFlight,
        requestTakeover,
        ensureReadyForSend,
    }), [ensureReadyForSend, requestTakeover, takeoverInFlight]);
}
