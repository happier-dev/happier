import * as React from 'react';

import type { SessionFoldersV1 } from '@/sync/domains/session/folders/types';
import {
    partitionSessionFolderWritesByServerId,
    type SessionOrganizationOrderItemAddress,
} from '@/sync/domains/session/organization/viewState';
import {
    writeSessionOrganizationFolders,
    writeSessionOrganizationGroupOrder,
    writeSessionOrganizationWorkspaceOrder,
    type SessionOrganizationMutationScope,
} from '@/sync/ops/sessionOrganization';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';
import { shouldRetryError } from '@/sync/runtime/connectivity/transientConnectivityErrors';

async function runSessionOrganizationWriteForHome(serverId: string, write: () => Promise<void>): Promise<void> {
    try {
        await write();
    } catch (error) {
        const message = error instanceof HappyError ? error.message : t('errors.unknownError');
        const canTryAgain = shouldRetryError(error);
        throw new HappyError(
            `${t('teams.homeLabel')} ${serverId}: ${message}${canTryAgain ? ` ${t('common.retry')}` : ''}`,
            canTryAgain,
            { code: error instanceof HappyError ? error.code : 'session_organization_write_failed' },
        );
    }
}

/** The merged list projection feeds the canonical Home-local organization writers. */
export function useSessionListOrganizationWriters(input: Readonly<{
    availableSessionFoldersV1: SessionFoldersV1;
    orderItemAddressByItemKey: Readonly<Record<string, SessionOrganizationOrderItemAddress>>;
}>) {
    const setSessionListGroupOrderV1 = React.useCallback((
        next: Record<string, readonly string[] | undefined>,
        scope: SessionOrganizationMutationScope,
    ): Promise<void> => runSessionOrganizationWriteForHome(scope.serverId, () => writeSessionOrganizationGroupOrder({
        scope,
        next,
        orderItemAddressByItemKey: input.orderItemAddressByItemKey,
    })), [input.orderItemAddressByItemKey]);
    const setSessionWorkspaceOrderV1 = React.useCallback((
        next: Record<string, readonly string[] | undefined>,
        scope: SessionOrganizationMutationScope,
    ): Promise<void> => runSessionOrganizationWriteForHome(scope.serverId, () => writeSessionOrganizationWorkspaceOrder({ scope, next })), []);
    const setSessionFoldersV1 = React.useCallback(async (
        nextFolders: SessionFoldersV1,
        scope: SessionOrganizationMutationScope,
    ): Promise<void> => {
        // The merged projection may contain other Homes' same-id folders. Only the
        // captured Home's partition reaches its writer, including its profile aliases.
        const writesByServerId = partitionSessionFolderWritesByServerId({
            current: input.availableSessionFoldersV1,
            next: nextFolders,
            orderItemAddressByItemKey: input.orderItemAddressByItemKey,
            fallbackServerId: scope.serverId,
        });
        const allowedServerIds = new Set([scope.serverId, ...scope.serverIdAliases]);
        const writes = Object.entries(writesByServerId).filter(([serverId]) => allowedServerIds.has(serverId));
        if (writes.length === 0) return;
        await runSessionOrganizationWriteForHome(scope.serverId, () => writeSessionOrganizationFolders({
            scope,
            current: { v: 1, folders: writes.flatMap(([, write]) => write.current.folders) },
            next: { v: 1, folders: writes.flatMap(([, write]) => write.next.folders) },
        }));
    }, [input.availableSessionFoldersV1, input.orderItemAddressByItemKey]);
    return { setSessionListGroupOrderV1, setSessionWorkspaceOrderV1, setSessionFoldersV1 };
}
