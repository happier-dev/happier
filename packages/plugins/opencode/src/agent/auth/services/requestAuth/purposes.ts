import type { QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol';

import type { OpenCodeRequestAuthProvider } from './source.js';

export const OPEN_CODE_REQUEST_AUTH_CONSUMER = Object.freeze({
  pluginId: 'happier.agent.opencode',
  localId: 'opencode',
} as const);

export const OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID = 'anthropic-model-request' as const;
export const OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID = 'openai-codex-model-request' as const;

export const OPEN_CODE_REQUEST_AUTH_DECLARED_PURPOSES = Object.freeze({
  anthropic: Object.freeze({
    consumer: OPEN_CODE_REQUEST_AUTH_CONSUMER,
    purpose: OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
  }),
  openai: Object.freeze({
    consumer: OPEN_CODE_REQUEST_AUTH_CONSUMER,
    purpose: OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
  }),
} satisfies Readonly<Record<OpenCodeRequestAuthProvider, QualifiedConnectedAccountPurposeV1>>);

export function isDeclaredOpenCodeRequestAuthPurpose(
  provider: OpenCodeRequestAuthProvider,
  purpose: QualifiedConnectedAccountPurposeV1,
): boolean {
  const declared = OPEN_CODE_REQUEST_AUTH_DECLARED_PURPOSES[provider];
  return purpose.consumer.pluginId === declared.consumer.pluginId
    && purpose.consumer.localId === declared.consumer.localId
    && purpose.purpose === declared.purpose;
}
