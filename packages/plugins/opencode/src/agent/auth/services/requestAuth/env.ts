import { isRecord, type JsonValue } from '@happier-dev/plugin-sdk';
import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '@happier-dev/plugin-sdk/connected-accounts';

import { isDeclaredOpenCodeRequestAuthPurpose } from './purposes.js';
import type { OpenCodeRequestAuthProvider } from './source.js';

export {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV as OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV,
};

export type OpenCodeRequestAuthPurposeMap = Readonly<
  Partial<Record<OpenCodeRequestAuthProvider, JsonValue>>
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

function readPurpose(value: unknown): JsonValue | null {
  const purpose = isRecord(value) ? value : null;
  const consumer = purpose && isRecord(purpose.consumer) ? purpose.consumer : null;
  const pluginId = readString(consumer?.pluginId);
  const localId = readString(consumer?.localId);
  const purposeId = readString(purpose?.purpose);
  if (!pluginId || !localId || !purposeId) return null;
  return Object.freeze({
    consumer: Object.freeze({ pluginId, localId }),
    purpose: purposeId,
  });
}

function readBinding(value: unknown): Readonly<{
  purpose: JsonValue;
  target: OpenCodeRequestAuthTarget;
  service: Readonly<{ pluginId: string; localId: string }>;
}> | null {
  const binding = isRecord(value) ? value : null;
  const purpose = readPurpose(binding?.purpose);
  const target = binding && isRecord(binding.target) ? binding.target : null;
  if (!purpose || !target) return null;

  if (target.kind === 'account') {
    const account = isRecord(target.account) ? target.account : null;
    const service = account && isRecord(account.service) ? account.service : null;
    const pluginId = readString(service?.pluginId);
    const localId = readString(service?.localId);
    const accountId = readString(account?.accountId);
    if (!pluginId || !localId || !accountId) return null;
    return {
      purpose,
      target: { kind: 'account', accountId },
      service: { pluginId, localId },
    };
  }

  if (target.kind === 'group') {
    const service = isRecord(target.service) ? target.service : null;
    const pluginId = readString(service?.pluginId);
    const localId = readString(service?.localId);
    const groupId = readString(target.groupId);
    if (!pluginId || !localId || !groupId) return null;
    return {
      purpose,
      target: { kind: 'group', groupId },
      service: { pluginId, localId },
    };
  }

  return null;
}

export function readOpenCodeRequestAuthMaterialization(
  value: unknown,
): OpenCodeRequestAuthMaterialization | null {
  const input = isRecord(value) ? value : null;
  if (!input) return null;
  const capabilityPath = readString(input.capabilityPath);
  if (!capabilityPath || !Array.isArray(input.purposeBindings)) return null;

  const purposes: {
    -readonly [K in OpenCodeRequestAuthProvider]?: JsonValue;
  } = {};
  const targets: {
    -readonly [K in OpenCodeRequestAuthProvider]?: OpenCodeRequestAuthTarget;
  } = {};
  for (const candidate of input.purposeBindings) {
    const parsed = readBinding(candidate);
    if (!parsed) return null;
    const { service, purpose, target } = parsed;
    const provider: OpenCodeRequestAuthProvider | null =
      service.pluginId === 'happier.agent.codex' && service.localId === 'openai-codex'
        ? 'openai'
        : service.pluginId === 'happier.agent.claude' && service.localId === 'claude-subscription'
          ? 'anthropic'
          : null;
    if (
      !provider
      || purposes[provider] !== undefined
      || !isDeclaredOpenCodeRequestAuthPurpose(provider, purpose)
    ) {
      return null;
    }
    purposes[provider] = purpose;
    targets[provider] = Object.freeze(target);
  }
  if (Object.keys(purposes).length === 0) return null;

  return Object.freeze({
    purposesByProvider: Object.freeze(purposes),
    targetsByProvider: Object.freeze(targets),
    capabilityPath,
  });
}
