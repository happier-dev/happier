import { useEffect } from 'react';

import { useOptionalAuth } from '@/auth/context/AuthContext';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { observeRequesterMachineNotices } from '@/sync/ops/account/requesterMachineNotice';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

export function RequesterMachineNoticeRuntime(): null {
    const scope = useActiveServerAccountScope();
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const token = useOptionalAuth()?.credentials?.token;
    useEffect(() => {
        if (!serverId || !accountId || !token) return;
        const controller = new AbortController();
        let dispose: (() => void) | undefined;
        void captureLazyActionAccountContext(serverId, controller.signal, undefined, { serverId, accountId }).then(account => {
            if (controller.signal.aborted) { account.dispose(); return; }
            const stop = observeRequesterMachineNotices(account);
            dispose = () => { stop(); account.dispose(); };
        }).catch(() => {});
        return () => { controller.abort(); dispose?.(); };
    }, [serverId, accountId, token]);
    return null;
}
