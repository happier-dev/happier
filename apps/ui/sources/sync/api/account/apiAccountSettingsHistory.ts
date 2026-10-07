import {
    AccountSettingsV2HistoryListResponseSchema,
    type AccountSettingsV2HistoryListResponse,
} from '@happier-dev/protocol/account/settings/accountSettingsApiV2';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { captureAccountSettingsRequest } from './accountSettingsRequest';

/**
 * Content-free Account Settings history listing (SET-11): versions, times,
 * content kind, and byte lengths only. Snapshot content is fetched separately,
 * in its recorded envelope, by the classification-aware restore owner.
 */
export type AccountSettingsHistoryFetchResult =
    | Readonly<{ status: 'ready'; snapshots: AccountSettingsV2HistoryListResponse['snapshots'] }>
    | Readonly<{ status: 'unavailable' }>;

export async function fetchAccountSettingsHistory(
    credentials: AuthCredentials,
    options: Readonly<{ settingsScope: AccountSettingsScope; signal?: AbortSignal }>,
): Promise<AccountSettingsHistoryFetchResult> {
    const captured = await captureAccountSettingsRequest({ credentials, ...options });
    if (!captured) return Object.freeze({ status: 'unavailable' as const });
    try {
        const response = await captured.request('/v2/account/settings/history', {
            headers: { 'Content-Type': 'application/json' },
        });
        if (!response.ok) return Object.freeze({ status: 'unavailable' as const });
        const data: unknown = await response.json();
        if (!captured.isCurrent()) return Object.freeze({ status: 'unavailable' as const });
        const parsed = AccountSettingsV2HistoryListResponseSchema.safeParse(data);
        if (!parsed.success) return Object.freeze({ status: 'unavailable' as const });
        return Object.freeze({ status: 'ready' as const, snapshots: parsed.data.snapshots });
    } catch {
        return Object.freeze({ status: 'unavailable' as const });
    } finally {
        captured.dispose();
    }
}
