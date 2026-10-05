import * as React from 'react';

import type { SessionFoldersV1 } from '@/sync/domains/session/folders/types';
import {
    partitionSessionFolderWritesByServerId,
    partitionSessionOrganizationGroupOrderByServerId,
    partitionSessionWorkspaceOrderByServerId,
    type SessionOrganizationOrderItemAddress,
} from '@/sync/domains/session/organization/viewState';
import {
    requireSessionOrganizationMutationScope,
    writeSessionOrganizationFolders,
    writeSessionOrganizationGroupOrder,
    writeSessionOrganizationWorkspaceOrder,
    type SessionOrganizationMutationScope,
} from '@/sync/ops/sessionOrganization';
import { Modal } from '@/modal';
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
    activeOrganizationServerId: string;
    availableSessionFoldersV1: SessionFoldersV1;
    orderItemAddressByItemKey: Readonly<Record<string, SessionOrganizationOrderItemAddress>>;
}>) {
    const runOrganizationMutation = React.useCallback((mutation: () => Promise<void>) => {
        void mutation().catch((error: unknown) => {
            Modal.alert(t('common.error'), error instanceof HappyError ? error.message : t('errors.unknownError'));
        });
    }, []);
    const setSessionListGroupOrderV1 = React.useCallback((nextOrder: Record<string, readonly string[] | undefined>, _scope?: SessionOrganizationMutationScope) => {
        runOrganizationMutation(async () => {
            const nextByServerId = partitionSessionOrganizationGroupOrderByServerId({ next: nextOrder, orderItemAddressByItemKey: input.orderItemAddressByItemKey });
            const scopedWrites = await Promise.all(Object.entries(nextByServerId).map(async ([serverId, next]) => ({ next, scope: await requireSessionOrganizationMutationScope(serverId) })));
            await Promise.all(scopedWrites.map(({ scope, next }) => runSessionOrganizationWriteForHome(scope.serverId, () => writeSessionOrganizationGroupOrder({ scope, next, orderItemAddressByItemKey: input.orderItemAddressByItemKey }))));
        });
    }, [input.orderItemAddressByItemKey, runOrganizationMutation]);
    const setSessionWorkspaceOrderV1 = React.useCallback((nextOrder: Record<string, readonly string[] | undefined>, _scope?: SessionOrganizationMutationScope) => {
        runOrganizationMutation(async () => {
            const nextByServerId = partitionSessionWorkspaceOrderByServerId({ next: nextOrder, fallbackServerId: input.activeOrganizationServerId });
            const scopedWrites = await Promise.all(Object.entries(nextByServerId).map(async ([serverId, next]) => ({ next, scope: await requireSessionOrganizationMutationScope(serverId) })));
            await Promise.all(scopedWrites.map(({ scope, next }) => runSessionOrganizationWriteForHome(scope.serverId, () => writeSessionOrganizationWorkspaceOrder({ scope, next }))));
        });
    }, [input.activeOrganizationServerId, runOrganizationMutation]);
    const setSessionFoldersV1 = React.useCallback((nextFolders: SessionFoldersV1, _scope?: SessionOrganizationMutationScope) => {
        runOrganizationMutation(async () => {
            const writesByServerId = partitionSessionFolderWritesByServerId({ current: input.availableSessionFoldersV1, next: nextFolders, orderItemAddressByItemKey: input.orderItemAddressByItemKey, fallbackServerId: input.activeOrganizationServerId });
            const scopedWrites = await Promise.all(Object.entries(writesByServerId).map(async ([serverId, write]) => ({ write, scope: await requireSessionOrganizationMutationScope(serverId) })));
            await Promise.all(scopedWrites.map(({ scope, write }) => runSessionOrganizationWriteForHome(scope.serverId, () => writeSessionOrganizationFolders({ scope, current: write.current, next: write.next }))));
        });
    }, [input.activeOrganizationServerId, input.availableSessionFoldersV1, input.orderItemAddressByItemKey, runOrganizationMutation]);
    return { setSessionListGroupOrderV1, setSessionWorkspaceOrderV1, setSessionFoldersV1 };
}
