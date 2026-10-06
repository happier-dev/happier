import { createHash } from 'node:crypto';

import { MarketplaceIndexQueryResultV1Schema, MarketplaceIndexQueryV1Schema } from '@happier-dev/protocol/marketplace/marketplaceIndexV1';
import type { MarketplaceIndexQueryResultV1, MarketplaceIndexQueryV1, MarketplaceIndexSourceKindV1 } from '@happier-dev/protocol';
import { COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1 } from '@happier-dev/protocol/marketplace/expectedMarketplaceListingV1';

import { createMarketplaceSourceRegistryStore } from './sources/store';
import { createNpmRegistryProfileService } from '@/plugins/distribution/npm/profiles/service';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';
import { normalizeNpmArtifactRequest } from '@/plugins/distribution/npm/normalize';
import { createMarketplaceIndexFromNormalizedQuery } from './index';
import { loadMarketplaceIndexSource, type LoadedMarketplaceIndexSource, type MarketplaceIndexSourceQuery } from './indexSourceLoader';

const MAX_ACTIVE_MARKETPLACE_INDEX_SOURCES = 65;
const PUBLIC_NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org';

function revisionForFingerprint(fingerprint: string): number {
  return Number.parseInt(createHash('sha256').update(fingerprint).digest('hex').slice(0, 13), 16);
}

function communityCursorIdentity(query: MarketplaceIndexQueryV1): string {
  return createHash('sha256')
    .update(JSON.stringify({ ...query, cursor: null }))
    .digest('hex')
    .slice(0, 24);
}

function decodeCommunityCursor(cursor: string | null, identity: string): Readonly<{ from: number; offset: number }> {
  if (!cursor) return { from: 0, offset: 0 };
  const match = /^community:([a-f0-9]{24}):from:(\d+):offset:(\d+)$/u.exec(cursor);
  if (!match || match[1] !== identity) throw new Error('Marketplace index cursor does not match its query');
  const from = Number(match[2]);
  const offset = Number(match[3]);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(offset)) throw new Error('Marketplace index cursor offset is invalid');
  return { from, offset };
}

function encodeCommunityCursor(identity: string, from: number, offset: number): string {
  return `community:${identity}:from:${from}:offset:${offset}`;
}

type MarketplaceArtifactAccessProfile = Readonly<{
  profileId: string;
  displayName?: string;
  origin: string;
  scopes?: readonly string[];
  useAsDefault?: boolean;
  availability: 'unknown' | 'available' | 'sign_in_required' | 'offline';
  updatedAtMs?: number;
}>;

type MarketplaceArtifactAccess = MarketplaceIndexQueryResultV1['items'][number]['artifactAccess'];

export function projectMarketplaceArtifactAccess(
  item: MarketplaceIndexQueryResultV1['items'][number],
  profiles: readonly MarketplaceArtifactAccessProfile[],
  source?: Readonly<{ registryProfileId?: string | null }>,
): MarketplaceIndexQueryResultV1['items'][number] {
  const artifactAccess = resolveMarketplaceArtifactAccess(item.distribution, profiles, source);
  return artifactAccess ? { ...item, artifactAccess } : item;
}

/**
 * Whether this Home can reach one listed npm artifact through the persisted
 * source binding, decided from the distribution facts alone. `null` means the
 * listing's own public access stands. The exact-install preparer consumes the
 * same decision before any registry access, so a listing that needs a registry
 * profile is asked for one at preparation rather than refused after review.
 */
export function resolveMarketplaceArtifactAccess(
  distribution: Pick<
    MarketplaceIndexQueryResultV1['items'][number]['distribution'],
    'packageName' | 'registryOrigin' | 'registryProfileId'
  >,
  profiles: readonly MarketplaceArtifactAccessProfile[],
  source?: Readonly<{ registryProfileId?: string | null }>,
): MarketplaceArtifactAccess | null {
  const catalogProfileId = distribution.registryProfileId;
  const profileId = source?.registryProfileId ?? null;
  if (!profileId) {
    if (!catalogProfileId && distribution.registryOrigin === PUBLIC_NPM_REGISTRY_ORIGIN) return null;
    if (!catalogProfileId) {
      return { state: 'unverified-profile', registryProfileId: null };
    }
    return { state: 'unverified-profile', registryProfileId: catalogProfileId };
  }
  // Catalog documents are remote input. Only the persisted host binding can
  // select a profile; the catalog-supplied id remains non-authoritative.
  const profile = profiles.find((entry) => entry.profileId === profileId) ?? null;
  if (!profile) return { state: 'source-removed', registryProfileId: profileId };
  try {
    normalizeNpmArtifactRequest({
      packageName: distribution.packageName,
      curatedExactOrigin: distribution.registryOrigin,
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
    return { state: 'unverified-profile', registryProfileId: profileId };
  }
  if (profile.availability === 'offline') {
    return { state: 'offline', registryProfileId: profileId };
  }
  // Availability is the profile owner's own answer, and it already folds
  // credential state in: a profile referencing a credential it can no longer
  // read is projected as `sign_in_required`. A profile that intentionally
  // references no credential — an anonymous internal registry — stays
  // installable, exactly as the artifact-request path treats it.
  if (profile.availability !== 'available') {
    return { state: 'auth-unavailable', registryProfileId: profileId };
  }
  return { state: 'available', registryProfileId: profileId };
}

export type MarketplaceIndexSourceConfig = Readonly<{
  id: string;
  title: string;
  sourceUrl: string;
  enabled: boolean;
  origin: MarketplaceIndexSourceKindV1;
  registryProfileId?: string | null;
}>;

/**
 * Direct public npm discovery is a Preview outcome: one synthesized source
 * whose search requests are built from the caller's query text. It is never a
 * persisted registry row — `MarketplaceSourceOriginV1` has no community-npm
 * member — so exact-install resolution treats this constant, not the store,
 * as the source of truth for this id.
 */
export const COMMUNITY_NPM_MARKETPLACE_SOURCE: MarketplaceIndexSourceConfig = Object.freeze({
  id: COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1,
  title: 'Community npm',
  sourceUrl: 'https://registry.npmjs.org/-/v1/search',
  enabled: true,
  origin: 'community-npm',
});

function selectMarketplaceSourcesForQuery(
  query: MarketplaceIndexQueryV1,
  sources: readonly MarketplaceIndexSourceConfig[],
): readonly MarketplaceIndexSourceConfig[] {
  return sources.filter((source) => (
    source.enabled
    && (!query.filters.sourceIds?.length || query.filters.sourceIds.includes(source.id))
    && (!query.filters.sourceKinds?.length || query.filters.sourceKinds.includes(source.origin))
  ));
}

/**
 * Resolves which source may answer for one source id, from persisted state
 * alone. This is source targeting before acquisition: it decides the binding
 * without touching a registry or catalog, so a caller can refuse a listing
 * that names a removed, disabled, or rebound source before any network access.
 * Both the exact-listing query and the daemon staging owner consume it, so
 * there is one rule for what a source id means.
 */
export async function resolveExactMarketplaceSourceBinding(params: Readonly<{
  happyHomeDir?: string;
  sourceId: string;
}>): Promise<
  | Readonly<{ ok: true; source: MarketplaceIndexSourceConfig }>
  | Readonly<{ ok: false; code: 'install_unavailable'; message: string }>
> {
  const sourceId = params.sourceId.trim();
  const configured = sourceId
    ? (await createMarketplaceSourceRegistryStore({ happyHomeDir: params.happyHomeDir }).read())
      .sources.find((entry) => entry.id === sourceId) ?? null
    : null;
  const source: MarketplaceIndexSourceConfig | null = configured
    ?? (sourceId === COMMUNITY_NPM_MARKETPLACE_SOURCE.id ? COMMUNITY_NPM_MARKETPLACE_SOURCE : null);
  if (!source || !source.enabled) {
    return {
      ok: false,
      code: 'install_unavailable',
      message: 'No enabled exact marketplace source is configured for this Install and trust action.',
    };
  }
  return { ok: true, source };
}

export function createMarketplaceIndexService(params?: Readonly<{
  happyHomeDir?: string;
  loadSource?: typeof loadMarketplaceIndexSource;
}>): Readonly<{
  query: (raw: unknown) => Promise<MarketplaceIndexQueryResultV1>;
  querySources: (raw: unknown, sources: readonly MarketplaceIndexSourceConfig[]) => Promise<MarketplaceIndexQueryResultV1>;
  queryExactListing: (params: Readonly<{ sourceId: string; pluginId: string; packageName?: string }>) => Promise<
    | Readonly<{ ok: true; source: MarketplaceIndexSourceConfig; result: MarketplaceIndexQueryResultV1 }>
    | Readonly<{ ok: false; code: 'install_unavailable' | 'source_changed'; message: string }>
  >;
}> {
  const registry = createMarketplaceSourceRegistryStore({ happyHomeDir: params?.happyHomeDir });
  const registryProfiles = createNpmRegistryProfileService({ happyHomeDir: params?.happyHomeDir });
  async function querySelectedSources(
    query: MarketplaceIndexQueryV1,
    selectedSources: readonly MarketplaceIndexSourceConfig[],
    exactPackageName?: string,
  ): Promise<MarketplaceIndexQueryResultV1> {
    if (selectedSources.length > MAX_ACTIVE_MARKETPLACE_INDEX_SOURCES) {
      throw new Error(`Marketplace active source limit is ${MAX_ACTIVE_MARKETPLACE_INDEX_SOURCES}`);
    }
    const usesPagedCommunity = !exactPackageName && selectedSources.some((source) => source.origin === 'community-npm');
    const cursorIdentity = communityCursorIdentity(query);
    const paging = usesPagedCommunity ? decodeCommunityCursor(query.cursor, cursorIdentity) : { from: 0, offset: 0 };
    const sourceQuery: MarketplaceIndexSourceQuery = {
      text: query.text,
      ...(exactPackageName ? { exactPackageName } : {}),
    };
    const diagnostics: { code: string; message: string }[] = [];
    const snapshots: LoadedMarketplaceIndexSource[] = [];
    for (let offset = 0; offset < selectedSources.length; offset += 4) {
      const batch = await Promise.all(selectedSources.slice(offset, offset + 4).map(async (source) => {
        try {
          const snapshot = await (params?.loadSource ?? loadMarketplaceIndexSource)({
            happyHomeDir: params?.happyHomeDir,
            source: { id: source.id, title: source.title, sourceUrl: source.sourceUrl, kind: source.origin },
            query: source.origin === 'community-npm' && usesPagedCommunity
              ? { ...sourceQuery, from: paging.from, size: query.limit }
              : sourceQuery,
          });
          return { snapshot } as const;
        } catch (error) {
          return {
            diagnostic: { code: 'marketplace_source_invalid', message: projectPluginFailureText(error) },
          } as const;
        }
      }));
      for (const outcome of batch) {
        if (outcome.snapshot !== undefined) snapshots.push(outcome.snapshot);
        else diagnostics.push(outcome.diagnostic);
      }
    }
    const profileState = await registryProfiles.snapshot().catch(() => {
      diagnostics.push({ code: 'marketplace_registry_profiles_unavailable', message: 'Private registry profile state is unavailable' });
      return { revision: -1, profiles: [] };
    });
    const boundProfileIds = [...new Set(selectedSources.flatMap((source) => (
      source.registryProfileId ? [source.registryProfileId] : []
    )))];
    // A Community npm cursor is private paging position for one normalized
    // query intent. Source/profile authority belongs in the outward revision:
    // that lets the existing UI revision guard discard a continuation loaded
    // across a rebind instead of rejecting the opaque cursor before a result
    // can report the change. Conversely, profiles no selected source binds do
    // not affect any projected artifactAccess fact and therefore cannot
    // invalidate this result chain.
    const fingerprint = JSON.stringify([
      selectedSources.map((source) => [
        source.id,
        source.title,
        source.sourceUrl,
        source.origin,
        source.registryProfileId ?? null,
      ]),
      usesPagedCommunity ? cursorIdentity : null,
      snapshots.map((snapshot) => snapshot.source.kind === 'community-npm'
        ? { source: snapshot.source, freshnessState: snapshot.freshness.state }
        : { source: snapshot.source, freshnessState: snapshot.freshness.state, entries: snapshot.entries, diagnostics: snapshot.diagnostics }),
      diagnostics,
      boundProfileIds.map((profileId) => {
        const profile = profileState.profiles.find((candidate) => candidate.profileId === profileId);
        return profile
          ? [profile.profileId, profile.origin, [...profile.scopes].sort(), profile.availability]
          : [profileId, null];
      }),
    ]);
    const revision = revisionForFingerprint(fingerprint);
    const cleanSnapshots = snapshots.map(({ communityNpmPage: _page, ...snapshot }) => snapshot);
    const result = createMarketplaceIndexFromNormalizedQuery({
      revision,
      sources: cleanSnapshots,
      query: usesPagedCommunity ? { ...query, cursor: null } : query,
      diagnostics,
      ...(usesPagedCommunity ? { offset: paging.offset } : {}),
    });
    const communityPage = snapshots.find((snapshot) => snapshot.source.kind === 'community-npm')?.communityNpmPage;
    let nextCursor = result.nextCursor;
    if (usesPagedCommunity) {
      if (result.nextCursor) {
        nextCursor = encodeCommunityCursor(cursorIdentity, paging.from, paging.offset + result.items.length);
      } else if (communityPage && communityPage.returned > 0 && communityPage.from + communityPage.returned < communityPage.total) {
        const communityItems = createMarketplaceIndexFromNormalizedQuery({
          revision,
          sources: cleanSnapshots.filter((snapshot) => snapshot.source.kind === 'community-npm'),
          query: { ...query, cursor: null, limit: 100 },
          diagnostics: [],
        }).items.length;
        const combinedCount = paging.offset + result.items.length;
        nextCursor = encodeCommunityCursor(
          cursorIdentity,
          communityPage.from + communityPage.returned,
          Math.max(0, combinedCount - communityItems),
        );
      } else {
        nextCursor = null;
      }
    }
    return MarketplaceIndexQueryResultV1Schema.parse({
      ...result,
      nextCursor,
      items: result.items.map((item) => projectMarketplaceArtifactAccess(
        item,
        profileState.profiles,
        selectedSources.find((source) => source.id === item.source.id && source.sourceUrl === item.source.sourceUrl),
      )),
    });
  }

  async function querySources(
    raw: unknown,
    sources: readonly MarketplaceIndexSourceConfig[],
    exactPackageName?: string,
  ): Promise<MarketplaceIndexQueryResultV1> {
    const query = MarketplaceIndexQueryV1Schema.parse(raw);
    return await querySelectedSources(
      query,
      selectMarketplaceSourcesForQuery(query, sources),
      exactPackageName,
    );
  }
  /**
   * The one exact-listing query. An install names one source, one plugin id
   * and — when the caller acted on a listing it already saw — that listing's
   * untrusted package name. Those facts target the source before acquisition:
   * a community npm source turns them into a single search request for that
   * package instead of walking every discovery page, and the returned facts
   * are re-derived from the registry rather than trusted from the caller.
   */
  async function queryExactListing(exact: Readonly<{
    sourceId: string;
    pluginId: string;
    packageName?: string;
  }>): Promise<
    | Readonly<{ ok: true; source: MarketplaceIndexSourceConfig; result: MarketplaceIndexQueryResultV1 }>
    | Readonly<{ ok: false; code: 'install_unavailable' | 'source_changed'; message: string }>
  > {
    const sourceId = exact.sourceId.trim();
    const pluginId = exact.pluginId.trim();
    const packageName = exact.packageName?.trim() ?? '';
    if (!sourceId || !pluginId) {
      return { ok: false, code: 'install_unavailable', message: 'A persisted marketplace source identity and plugin ID are required.' };
    }
    const binding = await resolveExactMarketplaceSourceBinding({ happyHomeDir: params?.happyHomeDir, sourceId });
    if (!binding.ok) return binding;
    const source = binding.source;
    let result: MarketplaceIndexQueryResultV1;
    try {
      result = await querySources({
        // A community npm source has no catalog document to filter, so the
        // plugin id is also the search text when no package name was carried.
        text: source.origin === 'community-npm' && !packageName ? pluginId : '',
        cursor: null,
        limit: 1,
        filters: { sourceIds: [source.id], pluginIds: [pluginId], includeUnavailable: true },
      }, [source], packageName || undefined);
    } catch {
      return { ok: false, code: 'install_unavailable', message: 'The exact marketplace source facts are currently unavailable.' };
    }
    const currentSource = source.origin === 'community-npm'
      ? COMMUNITY_NPM_MARKETPLACE_SOURCE
      : (await registry.read()).sources.find((entry) => entry.id === source.id) ?? null;
    if (!currentSource
      || !currentSource.enabled
      || currentSource.origin !== source.origin
      || currentSource.sourceUrl !== source.sourceUrl
      || (currentSource.registryProfileId ?? null) !== (source.registryProfileId ?? null)) {
      return { ok: false, code: 'source_changed', message: 'The persisted marketplace source binding changed while exact facts were loading.' };
    }
    return { ok: true, source, result };
  }
  return {
    query: async (raw) => {
      const query = MarketplaceIndexQueryV1Schema.parse(raw);
      const configured = (await registry.read()).sources;
      return await querySelectedSources(
        query,
        selectMarketplaceSourcesForQuery(query, [...configured, COMMUNITY_NPM_MARKETPLACE_SOURCE]),
      );
    },
    querySources,
    queryExactListing,
  };
}
