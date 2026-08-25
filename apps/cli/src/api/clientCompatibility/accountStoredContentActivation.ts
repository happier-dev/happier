import {
  CLIENT_UPGRADE_REQUIRED_ERROR_CODE,
  CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
  classifyCurrentAccountStoredContentServerCompatibility,
  type AccountStoredContentServerCompatibilityDecision,
} from '@happier-dev/protocol';

import {
  fetchServerFeaturesSnapshot,
  type CliServerFeaturesSnapshot,
} from '@/features/serverFeaturesClient';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

export class AccountStoredContentClientUpgradeRequiredError extends Error {
  readonly code = CLIENT_UPGRADE_REQUIRED_ERROR_CODE;
  readonly retryable = false as const;
  readonly minimumProtocolVersion =
    CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION;
  readonly requirement = {
    v: 1 as const,
    kind: 'account-stored-content' as const,
    minimumProtocolVersion:
      CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
  };

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

export class AccountStoredContentServerCompatibilityUnavailableError extends Error {
  readonly code = 'account_stored_content_compatibility_unavailable' as const;
  readonly retryable = true as const;

  constructor(
    readonly reason: Extract<CliServerFeaturesSnapshot, { status: 'error' }>['reason'],
  ) {
    super('Account stored-content server compatibility is temporarily unavailable.');
    this.name = 'AccountStoredContentServerCompatibilityUnavailableError';
  }
}

export function createAccountStoredContentClientUpgradeRequiredError(
    decision: Exclude<
      AccountStoredContentServerCompatibilityDecision,
      'compatible'
  > = 'server-too-old',
): AccountStoredContentClientUpgradeRequiredError {
  return new AccountStoredContentClientUpgradeRequiredError(decision);
}

export function assertCurrentAccountStoredContentServerCompatibility(
  snapshot: CliServerFeaturesSnapshot | undefined,
): void {
  if (snapshot?.status === 'error') {
    throw new AccountStoredContentServerCompatibilityUnavailableError(
      snapshot.reason,
    );
  }
  const requirements = snapshot?.status === 'ready'
    ? snapshot.features.capabilities.accountStoredContentCompatibility
    : undefined;
  const decision =
    classifyCurrentAccountStoredContentServerCompatibility(requirements);
  if (decision === 'compatible') return;
  throw new AccountStoredContentClientUpgradeRequiredError(decision);
}

export async function requireCurrentAccountStoredContentServerCompatibility(
  params: Readonly<{
    resolveSnapshot?: () => Promise<CliServerFeaturesSnapshot | undefined>;
  }> = {},
): Promise<void> {
  const snapshot = await (
    params.resolveSnapshot
      ?? (() => fetchServerFeaturesSnapshot({
        serverUrl: resolveServerHttpBaseUrl(),
      }))
  )();
  assertCurrentAccountStoredContentServerCompatibility(snapshot);
}
