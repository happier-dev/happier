import { IrohEndpointDescriptorV1Schema } from '@happier-dev/protocol/connectivity/iroh/endpointDescriptorV1';

import type { IrohRelayPolicy } from './types.js';

export const IROH_RELAY_POLICY_ENV_KEY = 'HAPPIER_IROH_RELAY_POLICY';
export const IROH_RELAY_URLS_ENV_KEY = 'HAPPIER_IROH_RELAY_URLS';

export type IrohRelayEnvConfig = Readonly<{
  relayPolicy: IrohRelayPolicy;
  relayUrls: readonly string[];
  explicitlyConfigured: boolean;
}>;

function parseRelayUrls(raw: string): readonly string[] {
  const candidates = raw.split(',').map((entry) => entry.trim());
  if (candidates.some((entry) => entry.length === 0)) {
    throw new Error(`${IROH_RELAY_URLS_ENV_KEY} must not contain empty relay URL entries`);
  }
  const result = IrohEndpointDescriptorV1Schema.shape.relayUrls.safeParse(candidates);
  if (!result.success || result.data === undefined) {
    throw new Error(
      `${IROH_RELAY_URLS_ENV_KEY} entries must be unique absolute HTTP(S) URLs without credentials, query material, or fragments`,
    );
  }
  return [...result.data].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Canonical operator relay env boundary. No default or ambient relays are discovered. */
export function readIrohRelayConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): IrohRelayEnvConfig {
  const rawPolicy = String(env[IROH_RELAY_POLICY_ENV_KEY] ?? '').trim().toLowerCase();
  const rawRelayUrls = String(env[IROH_RELAY_URLS_ENV_KEY] ?? '').trim();
  const explicitlyConfigured = rawPolicy.length > 0 || rawRelayUrls.length > 0;

  if (rawPolicy.length > 0 && rawPolicy !== 'automatic' && rawPolicy !== 'disabled') {
    throw new Error(`${IROH_RELAY_POLICY_ENV_KEY} must be "automatic" or "disabled"`);
  }
  const relayUrls = rawRelayUrls.length > 0 ? parseRelayUrls(rawRelayUrls) : [];
  const relayPolicy: IrohRelayPolicy = rawPolicy === 'disabled' ? 'disabled' : 'automatic';
  if (relayPolicy === 'disabled' && relayUrls.length > 0) {
    throw new Error(`${IROH_RELAY_POLICY_ENV_KEY}=disabled cannot be combined with ${IROH_RELAY_URLS_ENV_KEY}`);
  }
  return Object.freeze({ relayPolicy, relayUrls: Object.freeze([...relayUrls]), explicitlyConfigured });
}
