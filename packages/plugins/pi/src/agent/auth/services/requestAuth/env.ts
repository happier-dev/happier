import {
  QualifiedConnectedAccountPurposeBindingV1Schema,
} from '@happier-dev/protocol';

import {
  CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
} from '@happier-dev/plugin-sdk/experimental/cloud/request-auth';

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

export function readPiRequestAuthMaterialization(value: unknown): PiRequestAuthMaterialization | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const capabilityPath = readString(input.capabilityPath);
  const bindingInput = input.purposeBindings;
  if (!capabilityPath || !Array.isArray(bindingInput)) return null;

  const purposes: Partial<Record<PiRequestAuthProviderId, PiRequestAuthPurposeMap[PiRequestAuthProviderId]>> = {};
  for (const candidate of bindingInput) {
    const parsed = QualifiedConnectedAccountPurposeBindingV1Schema.safeParse(candidate);
    if (!parsed.success) return null;
    const service = parsed.data.target.kind === 'account'
      ? parsed.data.target.account.service
      : parsed.data.target.service;
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
      || !isDeclaredPiRequestAuthPurpose(providerId, parsed.data.purpose)
    ) {
      return null;
    }
    purposes[providerId] = parsed.data.purpose;
  }
  if (Object.keys(purposes).length === 0) return null;

  return Object.freeze({
    purposesByProviderId: Object.freeze(purposes),
    capabilityPath,
  });
}
