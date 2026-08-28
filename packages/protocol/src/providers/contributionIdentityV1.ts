import {
  PluginContributionIdentityV1Schema,
  buildQualifiedPluginContributionKey,
  parseQualifiedPluginContributionKey,
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
  const identity = parseQualifiedPluginContributionKey(contributionKey);
  if (!identity) return null;
  return { identity, canonicalKey: buildQualifiedPluginContributionKey(identity) };
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
