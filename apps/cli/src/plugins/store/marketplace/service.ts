import { createHash } from 'node:crypto';

import { MarketplaceIndexQueryResultV1Schema, MarketplaceIndexQueryV1Schema, type MarketplaceIndexQueryResultV1, type MarketplaceIndexSourceKindV1, type MarketplaceIndexSourceSnapshotV1 } from '@happier-dev/protocol';

import { createMarketplaceSourceRegistryStore } from './sources/store';
import { createNpmRegistryProfileService } from '@/plugins/distribution/npm/profiles/service';
import { normalizeNpmArtifactRequest } from '@/plugins/distribution/npm/normalize';
import { createMarketplaceIndex } from './index';
import { loadMarketplaceIndexSource } from './indexSourceLoader';

const MAX_ACTIVE_MARKETPLACE_INDEX_SOURCES = 65;
const PUBLIC_NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';

function revisionForFingerprint(fingerprint: string): number {
  return Number.parseInt(createHash('sha256').update(fingerprint).digest('hex').slice(0, 13), 16);
}

export function projectMarketplaceArtifactAccess(
  item: MarketplaceIndexQueryResultV1['items'][number],
  profiles: readonly {
    profileId: string;
    displayName?: string;
    origin: string;
    scopes?: readonly string[];
    useAsDefault?: boolean;
    hasCredentials?: boolean;
    availability: 'unknown' | 'available' | 'sign_in_required' | 'offline';
    updatedAtMs?: number;
  }[],
  source?: Readonly<{ registryProfileId?: string | null }>,
): MarketplaceIndexQueryResultV1['items'][number] {
  const catalogProfileId = item.distribution.registryProfileId;
  const profileId = source?.registryProfileId ?? null;
  if (!profileId) {
    if (!catalogProfileId && item.distribution.registryOrigin === PUBLIC_NPM_REGISTRY_ORIGIN) return item;
    if (!catalogProfileId) {
      return { ...item, artifactAccess: { state: 'unverified-profile', registryProfileId: null } };
    }
    return { ...item, artifactAccess: { state: 'unverified-profile', registryProfileId: catalogProfileId } };
  }
  // Catalog documents are remote input. Only the persisted host binding can
  // select a profile; the catalog-supplied id remains non-authoritative.
  const profile = profiles.find((entry) => entry.profileId === profileId) ?? null;
  if (!profile) return { ...item, artifactAccess: { state: 'source-removed', registryProfileId: profileId } };
  try {
    normalizeNpmArtifactRequest({
      packageName: item.distribution.packageName,
      curatedExactOrigin: item.distribution.registryOrigin,
      explicitProfileId: profileId,
      profiles: profiles.map((entry) => ({
        version: 1,
        id: entry.profileId,
        displayName: entry.displayName ?? entry.profileId,
        origin: entry.origin,
        scopes: [...(entry.scopes ?? [])],
        useAsDefault: entry.useAsDefault ?? false,
        createdAtMs: entry.updatedAtMs ?? 0,
        updatedAtMs: entry.updatedAtMs ?? 0,
      })),
    });
  } catch {
    return { ...item, artifactAccess: { state: 'unverified-profile', registryProfileId: profileId } };
  }
  if (profile.availability === 'offline') {
    return { ...item, artifactAccess: { state: 'offline', registryProfileId: profileId } };
  }
  if (profile.availability !== 'available' || profile.hasCredentials !== true) {
    return { ...item, artifactAccess: { state: 'auth-unavailable', registryProfileId: profileId } };
  }
  return { ...item, artifactAccess: { state: 'available', registryProfileId: profileId } };
}

export type MarketplaceIndexSourceConfig = Readonly<{
  id: string;
  title: string;
  sourceUrl: string;
  enabled: boolean;
  origin: MarketplaceIndexSourceKindV1;
  registryProfileId?: string | null;
}>;

export const COMMUNITY_NPM_MARKETPLACE_SOURCE: MarketplaceIndexSourceConfig = Object.freeze({
  id: 'marketplace:community-npm',
  title: 'Community npm',
  sourceUrl: 'https://registry.npmjs.org/-/v1/search?text=keywords:happier-plugin&size=100',
  enabled: true,
  origin: 'community-npm',
});

export function createMarketplaceIndexService(params?: Readonly<{
  happyHomeDir?: string;
  loadSource?: typeof loadMarketplaceIndexSource;
}>): Readonly<{
  query: (raw: unknown) => Promise<MarketplaceIndexQueryResultV1>;
  querySources: (raw: unknown, sources: readonly MarketplaceIndexSourceConfig[]) => Promise<MarketplaceIndexQueryResultV1>;
}> {
  const registry = createMarketplaceSourceRegistryStore({ happyHomeDir: params?.happyHomeDir });
  const registryProfiles = createNpmRegistryProfileService({ happyHomeDir: params?.happyHomeDir });
  async function querySources(raw: unknown, enabled: readonly MarketplaceIndexSourceConfig[]): Promise<MarketplaceIndexQueryResultV1> {
      const query = MarketplaceIndexQueryV1Schema.parse(raw);
      if (enabled.length > MAX_ACTIVE_MARKETPLACE_INDEX_SOURCES) {
        throw new Error(`Marketplace active source limit is ${MAX_ACTIVE_MARKETPLACE_INDEX_SOURCES}`);
      }
      const diagnostics: { code: string; message: string }[] = [];
      const snapshots: MarketplaceIndexSourceSnapshotV1[] = [];
      for (let offset = 0; offset < enabled.length; offset += 4) {
        const batch = await Promise.all(enabled.slice(offset, offset + 4).map(async (source) => {
          try {
            return await (params?.loadSource ?? loadMarketplaceIndexSource)({ happyHomeDir: params?.happyHomeDir, source: { id: source.id, title: source.title, sourceUrl: source.sourceUrl, kind: source.origin } });
          } catch (error) {
            diagnostics.push({ code: 'marketplace_source_invalid', message: error instanceof Error ? error.message : 'Marketplace source is invalid' });
            return null;
          }
        }));
        snapshots.push(...batch.filter((snapshot) => snapshot !== null));
      }
      const profileState = await registryProfiles.snapshot().catch(() => {
        diagnostics.push({ code: 'marketplace_registry_profiles_unavailable', message: 'Private registry profile state is unavailable' });
        return { revision: -1, profiles: [] };
      });
      const fingerprint = JSON.stringify([
        enabled.map((source) => [source.id, source.sourceUrl, source.registryProfileId ?? null]),
        snapshots.map((snapshot) => ({ source: snapshot.source, freshnessState: snapshot.freshness.state, entries: snapshot.entries, diagnostics: snapshot.diagnostics })),
        diagnostics,
        profileState.revision,
        profileState.profiles.map((profile) => [profile.profileId, profile.origin, profile.scopes, profile.useAsDefault, profile.availability, profile.hasCredentials]),
      ]);
      const revision = revisionForFingerprint(fingerprint);
      const result = createMarketplaceIndex({ revision, sources: snapshots, query, diagnostics });
      return MarketplaceIndexQueryResultV1Schema.parse({
        ...result,
        items: result.items.map((item) => projectMarketplaceArtifactAccess(
          item,
          profileState.profiles,
          enabled.find((source) => source.id === item.source.id && source.sourceUrl === item.source.sourceUrl),
        )),
      });
  }
  return {
    query: async (raw) => {
      const configured = (await registry.read()).sources.filter((source) => source.enabled);
      return await querySources(raw, [...configured, COMMUNITY_NPM_MARKETPLACE_SOURCE]);
    },
    querySources,
  };
}
