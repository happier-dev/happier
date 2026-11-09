import { isRecord, type JsonValue } from '@happier-dev/plugin-sdk';

import { PI_REQUEST_AUTH_PURPOSE_ROWS } from '../qualifiedPurposes.js';

import type { PiRequestAuthProviderId, PiRequestAuthPurposeMap } from './source.js';

export const PI_REQUEST_AUTH_CONSUMER = Object.freeze({
  pluginId: 'happier.agent.pi',
  localId: 'pi',
} as const);

export { PI_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID, PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID } from '../qualifiedPurposes.js';

type PiRequestAuthPurposeRow = (typeof PI_REQUEST_AUTH_PURPOSE_ROWS)[number];

export const PI_REQUEST_AUTH_DECLARED_PURPOSES = Object.freeze(Object.fromEntries(
  PI_REQUEST_AUTH_PURPOSE_ROWS.map((row) => [row.native.providerId, Object.freeze({
    consumer: PI_REQUEST_AUTH_CONSUMER,
    purpose: row.purpose,
  })]),
) as { readonly [Row in PiRequestAuthPurposeRow as Row['native']['providerId']]: Readonly<{
  consumer: typeof PI_REQUEST_AUTH_CONSUMER;
  purpose: Row['purpose'];
}> });

export const PI_REQUEST_AUTH_PROVIDER_MATERIALIZATIONS = Object.freeze(Object.fromEntries(
  PI_REQUEST_AUTH_PURPOSE_ROWS.map((row) => [row.native.providerId, row.requestAuth.materialization]),
) as { readonly [Row in PiRequestAuthPurposeRow as Row['native']['providerId']]: Row['requestAuth']['materialization'] });

// Native API-key headers must be stripped as well as request-auth lease headers.
export const PI_REQUEST_AUTH_PROVIDER_OWNED_HEADERS = Object.freeze(Object.fromEntries(
  PI_REQUEST_AUTH_PURPOSE_ROWS.map((row) => [row.native.providerId, row.requestAuth.ownedHeaders]),
) as { readonly [Row in PiRequestAuthPurposeRow as Row['native']['providerId']]: Row['requestAuth']['ownedHeaders'] });

export const PI_REQUEST_AUTH_USES = Object.freeze(PI_REQUEST_AUTH_PURPOSE_ROWS.map((row) => Object.freeze({
  purpose: row.purpose,
  materialization: row.requestAuth.materialization,
})));

export function isDeclaredPiRequestAuthPurpose(
  providerId: PiRequestAuthProviderId,
  purpose: JsonValue,
): boolean {
  const declared = PI_REQUEST_AUTH_DECLARED_PURPOSES[providerId];
  if (!isRecord(purpose)) return false;
  const consumer = isRecord(purpose.consumer) ? purpose.consumer : null;
  return consumer?.pluginId === declared.consumer.pluginId
    && consumer.localId === declared.consumer.localId
    && purpose.purpose === declared.purpose;
}

export function hasPiRequestAuthPurpose(purposes: PiRequestAuthPurposeMap): boolean {
  return PI_REQUEST_AUTH_PURPOSE_ROWS.some((row) => purposes[row.native.providerId] !== undefined);
}
