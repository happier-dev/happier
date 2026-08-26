import { refreshAccountSettingsForMinimumVersion } from '@/settings/accountSettings/refreshAccountSettingsForMinimumVersion';

export type AccountSettingsFreshnessRefreshResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; error: unknown }>;

export async function refreshAccountSettingsForDaemonRequest(input: Readonly<{
    credentials: Parameters<typeof refreshAccountSettingsForMinimumVersion>[0]['credentials'];
    accountSettingsVersionHint: number | undefined;
}>): Promise<AccountSettingsFreshnessRefreshResult> {
    if (typeof input.accountSettingsVersionHint !== 'number') {
        return { ok: true };
    }

    try {
        await refreshAccountSettingsForMinimumVersion({
            credentials: input.credentials,
            minSettingsVersion: input.accountSettingsVersionHint,
            mode: 'blocking',
            forceRefresh: true,
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, error };
    }
}
