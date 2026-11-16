import { gt as semverGt } from 'semver';
import type { MarketplaceIndexEntryV1, MarketplaceIndexSourceSnapshotV1 } from './marketplaceIndexV1.js';

/** Published catalog identities have the same meaning in browsing and exact review. */
export function readMarketplaceSourceListingsV1(snapshot: MarketplaceIndexSourceSnapshotV1,
  pinned?: Readonly<{ pluginId: string; version: string }>): Readonly<{
  entries: readonly MarketplaceIndexEntryV1[];
  diagnostics: MarketplaceIndexSourceSnapshotV1['diagnostics'];
}> {
  const entries = new Map<string, MarketplaceIndexEntryV1>();
  const distributions = new Map<string, MarketplaceIndexEntryV1>();
  const diagnostics = [...snapshot.diagnostics];
  const diagnose = (code: string, message: string) => { diagnostics.push({ code, message }); };
  for (const entry of snapshot.entries) {
    const prior = entries.get(entry.pluginId);
    const channel = `${entry.distribution.registryOrigin}\u0000${entry.distribution.packageName.toLowerCase()}`;
    const priorChannel = prior ? `${prior.distribution.registryOrigin}\u0000${prior.distribution.packageName.toLowerCase()}` : null;
    if (priorChannel && priorChannel !== channel) {
      diagnose('marketplace_distribution_rebinding', `Source '${snapshot.source.id}' attempted to rebind plugin '${entry.pluginId}' to another registry/package channel`);
      continue;
    }
    const key = `${channel}\u0000${entry.distribution.version}`;
    const priorDistribution = distributions.get(key);
    if (priorDistribution && priorDistribution.pluginId !== entry.pluginId) {
      diagnose('marketplace_distribution_identity_conflict', `Source '${snapshot.source.id}' assigned an existing distribution identity to plugin '${entry.pluginId}'`);
      continue;
    }
    if (priorDistribution && (priorDistribution.distribution.integrity !== entry.distribution.integrity
      || priorDistribution.manifestDigest !== entry.manifestDigest || priorDistribution.publisher.id !== entry.publisher.id)) {
      diagnose('marketplace_distribution_metadata_conflict', `Source '${snapshot.source.id}' conflicts with the bound publisher/manifest identity for plugin '${entry.pluginId}'`);
      continue;
    }
    if (priorDistribution) {
      diagnose('marketplace_duplicate_distribution_identity', `Source '${snapshot.source.id}' contains duplicate distribution identity for plugin '${entry.pluginId}'`);
      continue;
    }
    distributions.set(key, entry);
    if (!prior || semverGt(entry.distribution.version, prior.distribution.version)) entries.set(entry.pluginId, entry);
  }
  // Validate the entire source before selecting a frozen version. Browsing
  // still projects latest, but an exact read must not silently substitute it.
  return { entries: pinned ? [...distributions.values()].filter(entry => entry.pluginId === pinned.pluginId
    && entry.distribution.version === pinned.version) : [...entries.values()], diagnostics };
}
