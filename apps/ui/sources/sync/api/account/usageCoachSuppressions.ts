import { createUsageCoachSuppressionPort, USAGE_COACH_SUPPRESSIONS_KV_KEY, type UsageCoachSuppressionStateV1 } from '@happier-dev/protocol/usage/coach/coachActions';
import { createAccountKvJsonTransport } from '@/sync/ops/account/accountKvJsonTransport';
import { readAccountSettingsForScope } from '@/sync/domains/state/accountSettingsPersistence';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { UsageQueryAccountContext } from './usageQueryResource';
import type { AccountEncryptionIdentity } from '@happier-dev/sync-client';

export function createUiCoachSuppressionPort(account: UsageQueryAccountContext, signal?: AbortSignal,
    readLegacy?: () => Promise<UsageCoachSuppressionStateV1['suppressions']>,
    readIdentity?: () => Promise<AccountEncryptionIdentity>) {
    return createUsageCoachSuppressionPort({
        transport: createAccountKvJsonTransport({ credentials: account.credentials, key: USAGE_COACH_SUPPRESSIONS_KV_KEY,
            ...(readIdentity ? { readIdentity } : {}),
            request: (path, init, options) => account.request(path, { ...init, signal }, options),
            shouldContinue: () => !signal?.aborted && account.accountLifetime.isCurrent() }),
        readLegacy: readLegacy ?? (async () => {
            const state = readRegisteredStorageState();
            return readAccountSettingsForScope({ scope: account.accountLifetime.scope,
                focusedScope: state?.settingsScope, focusedSettings: state?.settings ?? settingsDefaults }).usageCoachPreferencesV1.suppressions;
        }),
    });
}
