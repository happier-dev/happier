import {
    CLIENT_UPGRADE_REQUIRED_ERROR_CODE,
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    classifyCurrentAccountStoredContentServerCompatibility,
    type AccountStoredContentServerCompatibilityDecision,
} from '@happier-dev/protocol';

import {
    getServerFeaturesSnapshot,
    type ServerFeaturesSnapshot,
} from './serverFeaturesClient';

export class AccountStoredContentClientUpgradeRequiredError extends Error {
    readonly code = CLIENT_UPGRADE_REQUIRED_ERROR_CODE;
    readonly retryable = false as const;
    readonly canTryAgain = false as const;
    readonly minimumProtocolVersion =
        CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION;

    constructor(
        readonly decision: Exclude<
            AccountStoredContentServerCompatibilityDecision,
            'compatible'
        >,
    ) {
        super(
            'This server does not support the current account stored-content protocol.',
        );
        this.name = 'AccountStoredContentClientUpgradeRequiredError';
    }
}

export function isAccountStoredContentClientUpgradeRequiredError(
    error: unknown,
): boolean {
    return error instanceof AccountStoredContentClientUpgradeRequiredError
        || (
            typeof error === 'object'
            && error !== null
            && 'code' in error
            && error.code === CLIENT_UPGRADE_REQUIRED_ERROR_CODE
        );
}

export function assertCurrentAccountStoredContentServerCompatibility(
    snapshot: ServerFeaturesSnapshot,
): void {
    const requirements = snapshot.status === 'ready'
        ? snapshot.features.capabilities.accountStoredContentCompatibility
        : undefined;
    const decision =
        classifyCurrentAccountStoredContentServerCompatibility(requirements);
    if (decision === 'compatible') return;
    throw new AccountStoredContentClientUpgradeRequiredError(decision);
}

export async function requireCurrentAccountStoredContentServerCompatibility(
    params: Readonly<{ serverId?: string }> = {},
): Promise<void> {
    const snapshot = await getServerFeaturesSnapshot({
        force: true,
        ...(params.serverId ? { serverId: params.serverId } : {}),
    });
    assertCurrentAccountStoredContentServerCompatibility(snapshot);
}
