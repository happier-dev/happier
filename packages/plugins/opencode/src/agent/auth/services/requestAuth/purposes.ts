import { isRecord, type JsonValue } from '@happier-dev/plugin-sdk';

import type { OpenCodeRequestAuthProvider } from './source.js';

export const OPEN_CODE_REQUEST_AUTH_CONSUMER = Object.freeze({
  pluginId: 'happier.agent.opencode',
  localId: 'opencode',
} as const);

export const OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID = 'anthropic-model-request' as const;
export const OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID = 'openai-codex-model-request' as const;

/**
 * The request-auth leaf may only materialize a leased bearer at the origin declared
 * for its corresponding provider contribution.
 */
export const OPEN_CODE_REQUEST_AUTH_TARGET_ORIGINS = Object.freeze({
  anthropic: 'https://api.anthropic.com',
  openai: 'https://chatgpt.com',
} as const satisfies Readonly<Record<OpenCodeRequestAuthProvider, string>>);

export const OPEN_CODE_REQUEST_AUTH_DECLARED_PURPOSES = Object.freeze({
  anthropic: Object.freeze({
    consumer: OPEN_CODE_REQUEST_AUTH_CONSUMER,
    purpose: OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
  }),
  openai: Object.freeze({
    consumer: OPEN_CODE_REQUEST_AUTH_CONSUMER,
    purpose: OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
  }),
});

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
