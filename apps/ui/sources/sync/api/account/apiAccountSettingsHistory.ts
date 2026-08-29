import {
    AccountSettingsV2HistoryListResponseSchema,
    type AccountSettingsV2HistoryListResponse,
} from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';

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
    options?: Readonly<{ signal?: AbortSignal }>,
): Promise<AccountSettingsHistoryFetchResult> {
    try {
        const response = await serverFetch('/v2/account/settings/history', {
            ...(options?.signal ? { signal: options.signal } : {}),
            headers: {
                Authorization: `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
        }, { includeAuth: false });
        if (!response.ok) return Object.freeze({ status: 'unavailable' as const });
        const data: unknown = await response.json();
        const parsed = AccountSettingsV2HistoryListResponseSchema.safeParse(data);
        if (!parsed.success) return Object.freeze({ status: 'unavailable' as const });
        return Object.freeze({ status: 'ready' as const, snapshots: parsed.data.snapshots });
    } catch {
        return Object.freeze({ status: 'unavailable' as const });
    }
}
