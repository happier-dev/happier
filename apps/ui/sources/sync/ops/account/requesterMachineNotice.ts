import {
    REQUESTER_MACHINE_NOTICE_PREFIX,
    claimPendingRequesterMachineNotice,
    recordRequesterMachineNotice,
    requesterMachineNoticeKey,
} from '@happier-dev/protocol/machines/managed/requesterMachineNotice';

import { presentRequesterMachineNotice } from '@/components/machines/managed/requesterDisclosureNotice';
import { kvList } from '@/sync/api/account/apiKv';
import { resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { subscribeKvPrefixChanges } from '@/sync/engine/socket/kvUpdateDispatcher';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createAccountKvJsonTransport, openUiAccountKvJsonRow } from './accountKvJsonTransport';

type NoticeAccount = Pick<LazyActionAccountContext,
    'serverId' | 'serverIdentityId' | 'credentials' | 'request' | 'accountLifetime' | 'resolveAccountEncryption'>;

/** The admitted Action proceeds independently of the notice. */
export function tellRequesterMachineUseOnce(
    account: NoticeAccount, serverIdentityId: string, machineId: string,
): void {
    void (async () => {
        const shouldContinue = account.accountLifetime.isCurrent;
        const { encryption } = await account.resolveAccountEncryption();
        const { compareAndSet } = createAccountKvJsonTransport({
            credentials: account.credentials, request: account.request, shouldContinue, encryption, key: requesterMachineNoticeKey(machineId),
        });
        if (await recordRequesterMachineNotice(compareAndSet) && shouldContinue()) {
            presentRequesterMachineNotice({ serverId: account.serverId, serverIdentityId, machineId });
        }
    })().catch(() => { /* The next use can claim an unwritten notice. */ });
}

/** Deliver Agent-originated notices through the existing Account push and catch-up stream. */
export function observeRequesterMachineNotices(account: NoticeAccount): () => void {
    const { credentials, request, serverId } = account;
    const serverIdentityId = account.serverIdentityId ?? serverId;
    let stopped = false;
    const shouldContinue = () => !stopped && account.accountLifetime.isCurrent();
    const requireCurrent = () => {
        if (!shouldContinue()) throw new Error('Requester Machine notice Account retired');
    };
    const transport = (key: string) => createAccountKvJsonTransport({ credentials, request, shouldContinue, key });
    const claim = async (key: string, row: Readonly<{ value: unknown; version: number }>) => {
        const claimed = await claimPendingRequesterMachineNotice(transport(key).compareAndSet, row);
        if (claimed && shouldContinue()) presentRequesterMachineNotice({
            serverId, serverIdentityId, machineId: key.slice(REQUESTER_MACHINE_NOTICE_PREFIX.length),
        });
    };
    const catchUp = async () => {
        const context = await resolveAccountStorageContext(credentials, { request, usage: 'identity' });
        let afterKey: string | undefined;
        while (shouldContinue()) {
            const { items } = await kvList(credentials, { prefix: REQUESTER_MACHINE_NOTICE_PREFIX, afterKey, request, retry: 'none' });
            for (const row of items) {
                await claim(row.key, await openUiAccountKvJsonRow({ credentials, context, row, request, requireCurrent }));
            }
            afterKey = items.at(-1)?.key;
            if (!afterKey) return;
        }
    };
    const dispose = subscribeKvPrefixChanges(REQUESTER_MACHINE_NOTICE_PREFIX, changes => {
        if (changes.some(({ key }) => key === null)) {
            void catchUp().catch(() => {});
            return;
        }
        for (const { key } of changes) {
            if (key !== null) void transport(key).read().then(row => claim(key, row)).catch(() => {});
        }
    }, { credentials, shouldContinue });
    void catchUp().catch(() => {});
    return () => { stopped = true; dispose(); };
}
