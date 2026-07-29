import {
    buildQualifiedPluginContributionKey,
    type PluginContributionIdentityV1,
    type PluginProjectionV2,
} from '@happier-dev/protocol';

export type ScmProjectedBackend = Readonly<{
    id: string;
    localId: string;
    pluginId: string | null;
    title: string;
    description: string;
    kind: string | null;
    capabilities: readonly string[];
}>;

export type ScmProjectedHostingProvider = Readonly<{
    id: string;
    localId: string;
    pluginId: string | null;
    title: string;
    description: string;
    kind: string | null;
    authService: PluginContributionIdentityV1 | null;
    connectedServiceId: string | null;
    capabilities: Readonly<Record<string, unknown>>;
}>;

export type ScmContributionCatalog = Readonly<{
    source: 'daemon' | 'legacy' | 'unavailable';
    state: 'fresh' | 'stale' | 'unavailable';
    generation: number | null;
    backends: readonly ScmProjectedBackend[];
    hostingProviders: readonly ScmProjectedHostingProvider[];
}>;

const LEGACY_BACKENDS: readonly ScmProjectedBackend[] = Object.freeze([
    Object.freeze({
        id: 'git',
        localId: 'git',
        pluginId: null,
        title: 'Git',
        description: 'Git source control settings.',
        kind: 'git',
        capabilities: Object.freeze([]),
    }),
    Object.freeze({
        id: 'sapling',
        localId: 'sapling',
        pluginId: null,
        title: 'Sapling',
        description: 'Sapling source control settings.',
        kind: 'sapling',
        capabilities: Object.freeze([]),
    }),
]);

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | null {
    const value = record[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readStringArray(record: Readonly<Record<string, unknown>>, key: string): readonly string[] {
    const value = record[key];
    if (!Array.isArray(value)) return Object.freeze([]);
    return Object.freeze(value.flatMap((entry) => (
        typeof entry === 'string' && entry.trim() ? [entry.trim()] : []
    )));
}

function readContributionIdentity(value: unknown): PluginContributionIdentityV1 | null {
    const record = readRecord(value);
    if (!record) return null;
    const pluginId = readString(record, 'pluginId');
    const localId = readString(record, 'localId');
    return pluginId && localId ? Object.freeze({ pluginId, localId }) : null;
}

function projectBackends(entriesById: Readonly<Record<string, unknown>>): readonly ScmProjectedBackend[] {
    return Object.freeze(Object.entries(entriesById)
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([key, value]) => {
            const record = readRecord(value);
            if (!record) return [];
            const id = readString(record, 'id') ?? key.trim();
            if (!id) return [];
            const localId = readString(record, 'localId') ?? id.split('/').at(-1) ?? id;
            return [Object.freeze({
                id,
                localId,
                pluginId: readString(record, 'pluginId'),
                title: readString(record, 'displayName') ?? readString(record, 'title') ?? localId,
                description: readString(record, 'description') ?? '',
                kind: readString(record, 'kind'),
                capabilities: readStringArray(record, 'capabilities'),
            })];
        }));
}

function indexConnectedServiceIds(
    entriesById: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, string | null> {
    const serviceIdsByIdentity = new Map<string, string | null>();
    for (const value of Object.values(entriesById)) {
        const record = readRecord(value);
        if (!record) continue;
        const pluginId = readString(record, 'pluginId');
        const localId = readString(record, 'id');
        const serviceId = readString(record, 'serviceId');
        if (!pluginId || !localId || !serviceId) continue;
        const key = buildQualifiedPluginContributionKey({ pluginId, localId });
        const existing = serviceIdsByIdentity.get(key);
        serviceIdsByIdentity.set(key, existing === undefined || existing === serviceId ? serviceId : null);
    }
    return serviceIdsByIdentity;
}

function projectHostingProviders(
    entriesById: Readonly<Record<string, unknown>>,
    connectedServiceIdsByIdentity: ReadonlyMap<string, string | null>,
): readonly ScmProjectedHostingProvider[] {
    return Object.freeze(Object.entries(entriesById)
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([key, value]) => {
            const record = readRecord(value);
            if (!record) return [];
            const id = readString(record, 'id') ?? key.trim();
            if (!id) return [];
            const localId = readString(record, 'localId') ?? id.split('/').at(-1) ?? id;
            const authService = readContributionIdentity(record.authService);
            return [Object.freeze({
                id,
                localId,
                pluginId: readString(record, 'pluginId'),
                title: readString(record, 'displayName') ?? readString(record, 'title') ?? localId,
                description: readString(record, 'description') ?? '',
                kind: readString(record, 'kind'),
                authService,
                connectedServiceId: authService
                    ? connectedServiceIdsByIdentity.get(buildQualifiedPluginContributionKey(authService)) ?? null
                    : null,
                capabilities: readRecord(record.capabilities) ?? Object.freeze({}),
            })];
        }));
}

export function createScmContributionCatalog(
    projection: PluginProjectionV2 | null,
    options?: Readonly<{ allowLegacyFallback?: boolean }>,
): ScmContributionCatalog {
    const backendFamily = projection?.familiesById.scmBackends;
    if (!backendFamily) {
        if (options?.allowLegacyFallback === false) {
            return Object.freeze({
                source: 'unavailable',
                state: 'unavailable',
                generation: projection?.generation ?? null,
                backends: Object.freeze([]),
                hostingProviders: Object.freeze([]),
            });
        }
        // New UI -> released daemon compatibility for stable cli-v0.2.1
        // (b1d15a8) and preview cli-v0.2.2-preview.1775586717.26498 (4913c1e),
        // whose daemon projections predate the SCM families. Remove this fallback
        // once those releases are outside the supported mixed-version window.
        // Once a family exists, even an empty family is authoritative so uninstall
        // and stale-generation removal cannot resurrect this inventory.
        return Object.freeze({
            source: 'legacy',
            state: 'fresh',
            generation: projection?.generation ?? null,
            backends: LEGACY_BACKENDS,
            hostingProviders: Object.freeze([]),
        });
    }

    const hostingFamily = projection.familiesById.scmHostingProviders;
    const connectedServiceIdsByIdentity = indexConnectedServiceIds(
        projection.familiesById.connectedAccounts?.entriesById ?? {},
    );
    return Object.freeze({
        source: 'daemon',
        state: 'fresh',
        generation: projection.generation,
        backends: projectBackends(backendFamily.entriesById),
        hostingProviders: projectHostingProviders(
            hostingFamily?.entriesById ?? {},
            connectedServiceIdsByIdentity,
        ),
    });
}
