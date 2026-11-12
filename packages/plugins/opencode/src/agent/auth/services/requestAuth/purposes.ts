import { isRecord, type JsonValue } from '@happier-dev/plugin-sdk';

import type { OpenCodeRequestAuthProvider } from './source.js';
import { OPEN_CODE_REQUEST_AUTH_CONSUMER, OPEN_CODE_REQUEST_AUTH_DESCRIPTORS, type OpenCodeRequestAuthPurposeId } from '../purposes.js';

export {
  OPEN_CODE_REQUEST_AUTH_CONSUMER,
  OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
  OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
} from '../purposes.js';

/**
 * The request-auth leaf may only materialize a leased bearer at the origin declared
 * for its corresponding provider contribution.
 */
export const OPEN_CODE_REQUEST_AUTH_TARGET_ORIGINS = Object.freeze(Object.fromEntries(
  OPEN_CODE_REQUEST_AUTH_DESCRIPTORS.map(({ provider, requestAuthOrigin }) => [provider, requestAuthOrigin]),
)) as Readonly<Record<OpenCodeRequestAuthProvider, string>>;

export const OPEN_CODE_REQUEST_AUTH_DECLARED_PURPOSES = Object.freeze(Object.fromEntries(
  OPEN_CODE_REQUEST_AUTH_DESCRIPTORS.map(({ provider, declaration }) => [provider, Object.freeze({
    consumer: OPEN_CODE_REQUEST_AUTH_CONSUMER,
    purpose: declaration.purpose,
  })]),
)) as Readonly<Record<OpenCodeRequestAuthProvider, Readonly<{
  consumer: typeof OPEN_CODE_REQUEST_AUTH_CONSUMER;
  purpose: OpenCodeRequestAuthPurposeId;
}>>>;

export function isDeclaredOpenCodeRequestAuthPurpose(
  provider: OpenCodeRequestAuthProvider,
  purpose: JsonValue,
): boolean {
  const declared = OPEN_CODE_REQUEST_AUTH_DECLARED_PURPOSES[provider];
  if (!isRecord(purpose)) return false;
  const consumer = isRecord(purpose.consumer) ? purpose.consumer : null;
  return consumer?.pluginId === declared.consumer.pluginId
    && consumer.localId === declared.consumer.localId
    && purpose.purpose === declared.purpose;
}
