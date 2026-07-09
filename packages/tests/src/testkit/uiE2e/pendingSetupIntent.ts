import type { Page } from '@playwright/test';

import {
    encodeUiStorageKeyPart,
    normalizeServerUrlForUiPendingSetup,
    normalizeUiStorageScope,
    scopedUiStorageId,
    serverAccountScopedUiStorageKey,
    uniqueNonEmptyStrings,
} from './uiWebStorageContract';

export type DismissedPendingSetupIntentSeedOptions = Readonly<{
    serverUrl?: string | null;
    serverId?: string | null;
    serverIdentityId?: string | null;
    legacyServerIds?: readonly (string | null | undefined)[];
    accountId?: string | null;
}>;

export async function seedDismissedPendingSetupIntent(
    page: Pick<Page, 'addInitScript' | 'evaluate'>,
    storageScopeRaw: string,
    options: DismissedPendingSetupIntentSeedOptions = {},
): Promise<void> {
    const scope = normalizeUiStorageScope(storageScopeRaw);
    const normalizedServerUrl = normalizeServerUrlForUiPendingSetup(options.serverUrl);
    const accountId = String(options.accountId ?? '').trim();
    const serverIds = uniqueNonEmptyStrings([
        options.serverIdentityId,
        options.serverId,
        ...(options.legacyServerIds ?? []),
    ]);
    const accountScopedPrefix = scopedUiStorageId('pending-setup-intent-record:v2', scope);
    const accountScopedKeys = accountId
        ? serverIds.map((serverId) => serverAccountScopedUiStorageKey(accountScopedPrefix, serverId, accountId))
        : [];
    const serverScopedKey = normalizedServerUrl
        ? `${scopedUiStorageId('pending-setup-intent-record:server:v1', scope)}:${encodeUiStorageKeyPart(normalizedServerUrl)}`
        : null;
    const seedParams = {
        scope,
        relayUrl: normalizedServerUrl,
        accountScopedKeys,
        serverScopedKey,
    };
    const apply = (params: typeof seedParams) => {
        const record = JSON.stringify({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: params.relayUrl ?? null,
            createdAtMs: Date.now(),
        });

        try {
            // Current key family (used by pendingSetupIntent.web.ts):
            window.localStorage.setItem('pending-setup-intent-record', record);
            if (params.scope) {
                window.localStorage.setItem(`pending-setup-intent-record__${params.scope}`, record);
            }

            for (const key of params.accountScopedKeys) {
                window.localStorage.setItem(key, record);
            }

            if (params.serverScopedKey) {
                window.localStorage.setItem(params.serverScopedKey, record);
            }

            // Legacy MMKV key family:
            window.localStorage.setItem('mmkv.pending-setup-intent\\\\record', record);
            if (params.scope) {
                window.localStorage.setItem(`mmkv.pending-setup-intent__${params.scope}\\\\record`, record);
            }
        } catch {
            // Ignore storage failures (opaque origin / sandboxed contexts).
        }
    };

    await page.addInitScript(apply, seedParams);
    try {
        await page.evaluate(apply, seedParams);
    } catch {
        // Ignore evaluation failures prior to navigation; the init script will still run.
    }
}
