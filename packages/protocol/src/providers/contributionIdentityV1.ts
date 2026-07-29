import {
  PluginContributionIdentityV1Schema,
  buildQualifiedPluginContributionKey,
  type PluginContributionIdentityV1,
} from '../plugins/contributionIdentity.js';
import { ProviderContributionKeySchema } from './ids.js';

export type ParsedProviderContributionIdentityV1 = Readonly<{
  identity: PluginContributionIdentityV1;
  canonicalKey: string;
}>;

/**
 * Parses the canonical slash identity. Opaque forward-compatible contribution
 * keys are intentionally not interpreted as identities.
 */
export function parseProviderContributionIdentityV1(
  contributionKeyInput: unknown,
): ParsedProviderContributionIdentityV1 | null {
  const parsedContributionKey = ProviderContributionKeySchema.safeParse(contributionKeyInput);
  if (!parsedContributionKey.success) return null;
  const contributionKey = parsedContributionKey.data;
  const canonicalSeparatorIndex = contributionKey.indexOf('/');
  if (canonicalSeparatorIndex <= 0) return null;
  const identity = PluginContributionIdentityV1Schema.safeParse({
    pluginId: contributionKey.slice(0, canonicalSeparatorIndex),
    localId: contributionKey.slice(canonicalSeparatorIndex + 1),
  });
  if (!identity.success) return null;
  const canonicalKey = buildQualifiedPluginContributionKey(identity.data);
  if (canonicalKey !== contributionKey) return null;
  return { identity: identity.data, canonicalKey };
}

export function normalizeProviderContributionKeyV1(contributionKeyInput: unknown): string | null {
  return parseProviderContributionIdentityV1(contributionKeyInput)?.canonicalKey ?? null;
}

/** Preserves valid opaque keys while canonicalizing recognized identities. */
export function canonicalizeProviderContributionKeyV1(contributionKeyInput: string): string {
  const contributionKey = ProviderContributionKeySchema.parse(contributionKeyInput);
  return normalizeProviderContributionKeyV1(contributionKey) ?? contributionKey;
}

export function areProviderContributionKeysEqualV1(left: string, right: string): boolean {
  return canonicalizeProviderContributionKeyV1(left) === canonicalizeProviderContributionKeyV1(right);
}
