import { MarketplaceIndexQueryResultV1Schema } from '@happier-dev/protocol/marketplace/marketplaceIndexV1';
import type { MarketplaceIndexQueryResultV1, MarketplaceIndexSourceKindV1 } from '@happier-dev/protocol';
import { PUBLIC_NPM_REGISTRY_ORIGIN_V1 } from '@happier-dev/protocol/marketplace/communityNpmDiscoveryV1';
import { registryMarketplaceSourceV1, registrySourceSupportsKindV1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { readStoredCredentials } from '@/persistence';
import { createNpmRegistryProfileService } from '@/plugins/distribution/npm/profiles/service';
import { normalizeNpmArtifactRequest } from '@/plugins/distribution/npm/normalize';

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
    if (!catalogProfileId && distribution.registryOrigin === PUBLIC_NPM_REGISTRY_ORIGIN_V1) return null;
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
  /** The current canonical descriptor proves any installed-declaration binding. */
  registrySource: RegistrySourceDescriptorV1;
}>;

/** Marketplace install sources are a projection of the one Account source owner. */
export type MarketplaceRegistrySourcesReaderV1 = () => Promise<readonly RegistrySourceDescriptorV1[]>;
export type MarketplaceRegistryHostV1 = Pick<ReturnType<typeof createCliRegistryHostV1>, 'withSource'>;

async function createAccountSourceReader(): Promise<MarketplaceRegistrySourcesReaderV1> {
  const credentials = await readStoredCredentials();
  return createCliRegistryHostV1({ ...(credentials ? { credentials } : {}) }).readSources;
}

export async function readMarketplaceInstallSources(input: Readonly<{ readRegistrySources?: MarketplaceRegistrySourcesReaderV1 }> = {}): Promise<readonly MarketplaceIndexSourceConfig[]> {
  const readSources = input.readRegistrySources ?? await createAccountSourceReader();
  return (await readSources()).flatMap(source => {
    const projected = projectMarketplaceInstallSource(source);
    return projected ? [projected] : [];
  });
}

function projectMarketplaceInstallSource(source: RegistrySourceDescriptorV1): MarketplaceIndexSourceConfig | null {
  if ('packageContent' in source || !(source.kinds.includes('plugin') || source.kinds.includes('agent'))
    || !(source.format === 'happier-catalog' || source.format === 'happier-npm')) return null;
  const projected = registryMarketplaceSourceV1(source);
  return { id: source.id, title: source.title, sourceUrl: source.url, enabled: source.enabled, registrySource: source,
    origin: projected.kind, ...(source.npmRegistryProfileId ? { registryProfileId: source.npmRegistryProfileId } : {}) };
}

type ExactMarketplaceQueryResult =
  | Readonly<{ ok: true; source: MarketplaceIndexSourceConfig; result: MarketplaceIndexQueryResultV1 }>
  | Readonly<{ ok: false; code: 'install_unavailable' | 'source_changed'; message: string }>;

export function createMarketplaceIndexService(params?: Readonly<{
  happyHomeDir?: string;
  registryHost?: MarketplaceRegistryHostV1;
  /** A Runner's admitted sealed commitment supplies one read-only source;
   *  ordinary CLI/daemon consumers use the captured Account catalog owner. */
  readRegistrySources?: MarketplaceRegistrySourcesReaderV1;
}>): Readonly<{
  queryExactListing: (params: Readonly<{ sourceId: string; pluginId: string; packageName?: string; version?: string }>) => Promise<ExactMarketplaceQueryResult>;
}> {
  const registryProfiles = createNpmRegistryProfileService({ happyHomeDir: params?.happyHomeDir });
  let accountHost: Promise<ReturnType<typeof createCliRegistryHostV1>> | undefined;
  const registryHost = async () => {
    if (params?.registryHost) return params.registryHost;
    accountHost ??= (async () => {
      const credentials = params?.readRegistrySources ? null : await readStoredCredentials();
      return createCliRegistryHostV1({ ...(credentials ? { credentials } : {}), readSources: params?.readRegistrySources });
    })();
    return await accountHost;
  };
  return {
    async queryExactListing(exact) {
      const sourceId = exact.sourceId.trim(), pluginId = exact.pluginId.trim();
      if (!sourceId || !pluginId) return { ok: false, code: 'install_unavailable',
        message: 'An Account marketplace source identity and plugin ID are required.' };
      try {
        return await (await registryHost()).withSource(sourceId, async (descriptor, fetchRequest): Promise<ExactMarketplaceQueryResult> => {
          const source = projectMarketplaceInstallSource(descriptor);
          if (!source) return { ok: false, code: 'install_unavailable', message: 'No Account marketplace source is configured for this Install and trust action.' };
          const kind = registrySourceSupportsKindV1(source.registrySource, 'plugin') ? 'plugin' : 'agent';
          let itemId = source.origin === 'community-npm' ? exact.packageName : pluginId;
          // Plugin-id-only callers discover the package through the same
          // admitted source. Clicked listings already carry the exact package.
          if (!itemId) {
            const listed = await fetchRequest({ op: 'list', kind, query: pluginId });
            itemId = listed.op === 'list' ? listed.page.items.find(item => item.pluginListing?.pluginId === pluginId)?.itemId : undefined;
          }
          if (!itemId) return { ok: false, code: 'install_unavailable', message: 'No exact marketplace package was found.' };
          const acquired = await fetchRequest({ op: 'read', kind, itemId,
            ...(exact.version !== undefined ? { version: exact.version } : {}) });
          if (acquired.op !== 'read' || acquired.item.payload.kind !== 'plugin') {
            return { ok: false, code: 'install_unavailable', message: 'The exact marketplace source facts are currently unavailable.' };
          }
          const profileState = await registryProfiles.snapshot().catch(() => ({ revision: -1, profiles: [] }));
          const { listing, source: listingSource } = acquired.item.payload;
          const freshness = { state: 'fresh' as const, fetchedAtMs: acquired.item.fetchedAt };
          return { ok: true, source, result: MarketplaceIndexQueryResultV1Schema.parse({
            revision: 0, nextCursor: null, diagnostics: [],
            sources: [{ source: listingSource, freshness, diagnostics: [] }],
            items: [projectMarketplaceArtifactAccess({ ...listing, source: listingSource, freshness,
              admission: { install: 'full-review', mutatesInstalledTrust: false, disablesInstalledCode: false, directNpmRequiresFullReview: true },
              artifactAccess: listing.distribution.registryProfileId
                ? { state: 'unverified-profile', registryProfileId: listing.distribution.registryProfileId }
                : { state: 'public', registryProfileId: null },
            }, profileState.profiles, source)],
          }) };
        });
      } catch { return { ok: false, code: 'install_unavailable', message: 'The exact marketplace source facts are currently unavailable.' }; }
    },
  };
}
