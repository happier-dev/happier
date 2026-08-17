import { isRecord, type JsonValue } from '@happier-dev/plugin-sdk';

import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '@happier-dev/agents/request-auth';

import {
  isDeclaredPiRequestAuthPurpose,
} from './purposes.js';
import type {
  PiRequestAuthProviderId,
  PiRequestAuthPurposeMap,
} from './source.js';

export { CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV as PI_REQUEST_AUTH_CAPABILITY_PATH_ENV };

export const PI_REQUEST_AUTH_PRODUCER_VERSION_ENV =
  'HAPPIER_PI_REQUEST_AUTH_PRODUCER_VERSION';

export type PiRequestAuthMaterialization = Readonly<{
  purposesByProviderId: PiRequestAuthPurposeMap;
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

function readBinding(value: unknown): Readonly<{ purpose: JsonValue; service: Readonly<{
  pluginId: string;
  localId: string;
}> }> | null {
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
    return { purpose, service: { pluginId, localId } };
  }

  if (target.kind === 'group') {
    const service = isRecord(target.service) ? target.service : null;
    const pluginId = readString(service?.pluginId);
    const localId = readString(service?.localId);
    const groupId = readString(target.groupId);
    if (!pluginId || !localId || !groupId) return null;
    return { purpose, service: { pluginId, localId } };
  }

  return null;
}

export function readPiRequestAuthMaterialization(value: unknown): PiRequestAuthMaterialization | null {
  const input = isRecord(value) ? value : null;
  if (!input) return null;
  const capabilityPath = readString(input.capabilityPath);
  const bindingInput = input.purposeBindings;
  if (!capabilityPath || !Array.isArray(bindingInput)) return null;

  const purposes: Partial<Record<PiRequestAuthProviderId, PiRequestAuthPurposeMap[PiRequestAuthProviderId]>> = {};
  for (const candidate of bindingInput) {
    const parsed = readBinding(candidate);
    if (!parsed) return null;
    const { service, purpose } = parsed;
    const providerId: PiRequestAuthProviderId | null =
      service.pluginId === 'happier.agent.claude'
        && service.localId === 'claude-subscription'
        ? 'anthropic'
        : service.pluginId === 'happier.agent.codex'
          && service.localId === 'openai-codex'
          ? 'openai-codex'
          : null;
    if (
      !providerId
      || purposes[providerId] !== undefined
      || !isDeclaredPiRequestAuthPurpose(providerId, purpose)
    ) {
      return null;
    }
    purposes[providerId] = purpose;
  }
  if (Object.keys(purposes).length === 0) return null;

  return Object.freeze({
    purposesByProviderId: Object.freeze(purposes),
    capabilityPath,
  });
}
