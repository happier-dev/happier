import { MMKV } from 'react-native-mmkv';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { createServerAccountScope, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

// Presentation only: permission validity and settlement remain with the CLI.
// Never persist approvals, tokens, tool arguments or exception messages.
const storage = new MMKV({ id: scopedStorageId('notification-permission-actions', readStorageScopeFromEnv()) });

export type NotificationPermissionRecoveryNotice = Readonly<{
    target: ServerAccountScope | null;
}>;

export function markNotificationPermissionRecoveryNeeded(target?: ServerAccountScope | null): void {
    storage.set('recovery-needed', JSON.stringify({
        target: target ? createServerAccountScope(target.serverId, target.accountId) : null,
    }));
}

export function consumeNotificationPermissionRecoveryNotice(): NotificationPermissionRecoveryNotice | null {
    const record = storage.getString('recovery-needed');
    if (!record || record === '0') return null;
    storage.set('recovery-needed', '0');
    // The earlier content-free flag has no target. Review may explicitly open
    // the aggregate Inbox, but must never infer a Home or replay a decision.
    if (record === '1') return { target: null };
    try {
        const parsed: unknown = JSON.parse(record);
        if (!parsed || typeof parsed !== 'object' || !('target' in parsed)) return null;
        if (parsed.target === null) return { target: null };
        const target = parsed.target;
        if (!target || typeof target !== 'object' || !('serverId' in target) || !('accountId' in target)) return null;
        const scope = createServerAccountScope(target.serverId, target.accountId);
        return scope ? { target: scope } : null;
    } catch {
        return null;
    }
}

export function consumeNotificationPermissionRecoveryNeeded(): boolean {
    return consumeNotificationPermissionRecoveryNotice() !== null;
}
