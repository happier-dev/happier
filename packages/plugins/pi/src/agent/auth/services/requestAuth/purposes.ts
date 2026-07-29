import type {
  ConnectedAccountRequestAuthUseV1,
  QualifiedConnectedAccountPurposeV1,
} from '@happier-dev/protocol';

import type { PiRequestAuthProviderId, PiRequestAuthPurposeMap } from './source.js';

export const PI_REQUEST_AUTH_CONSUMER = Object.freeze({
  pluginId: 'happier.agent.pi',
  localId: 'pi',
} as const);

export const PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID = 'anthropic-model-request' as const;
export const PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID = 'openai-codex-model-request' as const;

export const PI_REQUEST_AUTH_DECLARED_PURPOSES = Object.freeze({
  anthropic: Object.freeze({
    consumer: PI_REQUEST_AUTH_CONSUMER,
    purpose: PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
  }),
  'openai-codex': Object.freeze({
    consumer: PI_REQUEST_AUTH_CONSUMER,
    purpose: PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
  }),
} satisfies Readonly<Record<PiRequestAuthProviderId, QualifiedConnectedAccountPurposeV1>>);

export const PI_REQUEST_AUTH_PROVIDER_MATERIALIZATIONS = Object.freeze({
  anthropic: Object.freeze({
    kind: 'httpHeaders' as const,
    origin: 'https://api.anthropic.com',
    headerNames: Object.freeze(['authorization']),
  }),
  'openai-codex': Object.freeze({
    kind: 'httpHeaders' as const,
    origin: 'https://chatgpt.com',
    headerNames: Object.freeze(['authorization', 'chatgpt-account-id']),
  }),
} satisfies Readonly<
  Record<PiRequestAuthProviderId, ConnectedAccountRequestAuthUseV1['materialization']>
>);

// These are stripped before every wrapped attempt. Anthropic includes x-api-key for
// native/API-key isolation even though the request-auth lease itself is OAuth Bearer.
export const PI_REQUEST_AUTH_PROVIDER_OWNED_HEADERS = Object.freeze({
  anthropic: Object.freeze(['authorization', 'x-api-key']),
  'openai-codex': Object.freeze(['authorization', 'chatgpt-account-id']),
} satisfies Readonly<Record<PiRequestAuthProviderId, readonly string[]>>);

export const PI_REQUEST_AUTH_USES = Object.freeze([
  Object.freeze({
    purpose: PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
    materialization: PI_REQUEST_AUTH_PROVIDER_MATERIALIZATIONS.anthropic,
  }),
  Object.freeze({
    purpose: PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
    materialization: PI_REQUEST_AUTH_PROVIDER_MATERIALIZATIONS['openai-codex'],
  }),
] satisfies readonly ConnectedAccountRequestAuthUseV1[]);

export function isDeclaredPiRequestAuthPurpose(
  providerId: PiRequestAuthProviderId,
  purpose: QualifiedConnectedAccountPurposeV1,
): boolean {
  const declared = PI_REQUEST_AUTH_DECLARED_PURPOSES[providerId];
  return purpose.consumer.pluginId === declared.consumer.pluginId
    && purpose.consumer.localId === declared.consumer.localId
    && purpose.purpose === declared.purpose;
}

export function hasPiRequestAuthPurpose(purposes: PiRequestAuthPurposeMap): boolean {
  return purposes.anthropic !== undefined || purposes['openai-codex'] !== undefined;
}
