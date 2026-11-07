import { createUsageCoachSuppressionPort, USAGE_COACH_SUPPRESSIONS_KV_KEY } from '@happier-dev/protocol/usage/coach/coachActions';
import { createAccountKvJsonTransport } from '@/sync/ops/account/accountKvJsonTransport';
import type { UsageQueryAccountContext } from './usageQueryResource';
import type { AccountEncryptionIdentity } from '@happier-dev/sync-client';

export function createUiCoachSuppressionPort(account: UsageQueryAccountContext, signal?: AbortSignal,
    readIdentity?: () => Promise<AccountEncryptionIdentity>) {
    return createUsageCoachSuppressionPort({
        transport: createAccountKvJsonTransport({ credentials: account.credentials, key: USAGE_COACH_SUPPRESSIONS_KV_KEY,
            ...(readIdentity ? { readIdentity } : {}),
            request: (path, init, options) => account.request(path, { ...init, signal }, options),
            shouldContinue: () => !signal?.aborted && account.accountLifetime.isCurrent() }),
    });
}
