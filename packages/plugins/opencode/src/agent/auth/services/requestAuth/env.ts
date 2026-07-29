import {
  QualifiedConnectedAccountPurposeBindingV1Schema,
  type QualifiedConnectedAccountPurposeV1,
} from '@happier-dev/protocol';
import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '@happier-dev/plugin-sdk/experimental/cloud/request-auth';

import { isDeclaredOpenCodeRequestAuthPurpose } from './purposes.js';
import type { OpenCodeRequestAuthProvider } from './source.js';

export {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV as OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV,
};

export type OpenCodeRequestAuthPurposeMap = Readonly<
  Partial<Record<OpenCodeRequestAuthProvider, QualifiedConnectedAccountPurposeV1>>
>;

export type OpenCodeRequestAuthTarget =
  | Readonly<{ kind: 'account'; accountId: string }>
  | Readonly<{ kind: 'group'; groupId: string }>;

export type OpenCodeRequestAuthMaterialization = Readonly<{
  purposesByProvider: OpenCodeRequestAuthPurposeMap;
  targetsByProvider: Readonly<
    Partial<Record<OpenCodeRequestAuthProvider, OpenCodeRequestAuthTarget>>
  >;
  capabilityPath: string;
}>;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function readOpenCodeRequestAuthMaterialization(
  value: unknown,
): OpenCodeRequestAuthMaterialization | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const capabilityPath = readString(input.capabilityPath);
  if (!capabilityPath || !Array.isArray(input.purposeBindings)) return null;

  const purposes: {
    -readonly [K in OpenCodeRequestAuthProvider]?: QualifiedConnectedAccountPurposeV1;
  } = {};
  const targets: {
    -readonly [K in OpenCodeRequestAuthProvider]?: OpenCodeRequestAuthTarget;
  } = {};
  for (const candidate of input.purposeBindings) {
    const parsed = QualifiedConnectedAccountPurposeBindingV1Schema.safeParse(candidate);
    if (!parsed.success) return null;
    const service = parsed.data.target.kind === 'account'
      ? parsed.data.target.account.service
      : parsed.data.target.service;
    const provider: OpenCodeRequestAuthProvider | null =
      service.pluginId === 'happier.agent.codex' && service.localId === 'openai-codex'
        ? 'openai'
        : service.pluginId === 'happier.agent.claude' && service.localId === 'claude-subscription'
          ? 'anthropic'
          : null;
    if (
      !provider
      || purposes[provider] !== undefined
      || !isDeclaredOpenCodeRequestAuthPurpose(provider, parsed.data.purpose)
    ) {
      return null;
    }
    purposes[provider] = parsed.data.purpose;
    targets[provider] = parsed.data.target.kind === 'account'
      ? Object.freeze({
          kind: 'account',
          accountId: parsed.data.target.account.accountId,
        })
      : Object.freeze({
          kind: 'group',
          groupId: parsed.data.target.groupId,
        });
  }
  if (Object.keys(purposes).length === 0) return null;

  return Object.freeze({
    purposesByProvider: Object.freeze(purposes),
    targetsByProvider: Object.freeze(targets),
    capabilityPath,
  });
}
