import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/plugin-sdk/experimental/cloud/auth';

import {
  buildOpenCodeBrokerMarker,
  OPEN_CODE_BROKER_PLUGIN_VERSION,
  type OpenCodeBrokerProvider,
  type OpenCodeBrokerProviderSelection,
} from '../broker/index.js';

import { identityFragment, readProviderAccountId, requireTokenCredential } from './credential.js';

export type AuthRecord = Record<string, unknown>;

/**
 * Mutable accumulator shared by the per-provider materializers. Each provider branch contributes to
 * the OpenCode `auth` content, the broker selections (for brokered providers), the brokered-provider
 * list (drives config isolation + selection identity), and the stable identity fragments.
 */
export type OpenCodeAuthMaterializationAccumulator = {
  readonly auth: AuthRecord;
  readonly brokerSelections: { -readonly [K in OpenCodeBrokerProvider]?: OpenCodeBrokerProviderSelection };
  readonly brokeredProviders: OpenCodeBrokerProvider[];
  readonly identityFragments: string[];
};

export function createOpenCodeAuthMaterializationAccumulator(): OpenCodeAuthMaterializationAccumulator {
  return {
    auth: {},
    brokerSelections: {},
    brokeredProviders: [],
    identityFragments: [],
  };
}

/** Broker a subscription/OAuth provider: stable non-refreshable marker + selection (NO tokens). */
export function brokerProvider(
  accumulator: OpenCodeAuthMaterializationAccumulator,
  provider: OpenCodeBrokerProvider,
  serviceId: OpenCodeBrokerProviderSelection['serviceId'],
  record: ConnectedServiceCredentialRecordV1,
  groupId?: string | null,
): void {
  accumulator.auth[provider] = {
    type: 'api',
    key: buildOpenCodeBrokerMarker(provider, OPEN_CODE_BROKER_PLUGIN_VERSION),
  };
  accumulator.brokerSelections[provider] = {
    serviceId,
    profileId: record.profileId,
    accountId: readProviderAccountId(record),
    planType: null,
  };
  accumulator.brokeredProviders.push(provider);
  accumulator.identityFragments.push(identityFragment(record, groupId));
}

/** Use a direct API key (real `{type:'api', key}`) for a Console/platform key provider. */
export function directApiKeyProvider(
  accumulator: OpenCodeAuthMaterializationAccumulator,
  authKey: 'openai' | 'anthropic',
  serviceId: string,
  record: ConnectedServiceCredentialRecordV1,
  groupId?: string | null,
): void {
  const tokenRecord = requireTokenCredential(record, serviceId);
  accumulator.auth[authKey] = { type: 'api', key: tokenRecord.token.token };
  accumulator.identityFragments.push(identityFragment(record, groupId));
}
