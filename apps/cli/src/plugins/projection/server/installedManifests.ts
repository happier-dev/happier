import axios, { type AxiosRequestConfig } from 'axios';

import {
    isReservedHappierPluginId,
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
    PluginInstallationManifestDeleteActionOutputV1Schema,
    PluginInstallationManifestUpsertActionOutputV1Schema,
    type PluginInstallationManifestDeleteActionInputV1,
    type PluginInstallationManifestUpsertActionInputV1,
    type PluginPermissionDeclarationV1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { readCredentials, type Credentials } from '@/persistence';
import {
    createDefaultPluginInstallationPublisherHeader,
    type CreatePluginInstallationPublisherHeader,
} from '@/plugins/installations/publisherProof';
import { readInstalledPluginCatalog, type PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

export type InstalledPluginManifestProjectionCatalogEntry = Pick<
    PluginCatalogEntry,
    'pluginId' | 'title' | 'version' | 'enabled' | 'manifestDigest' | 'manifest' | 'diagnostics'
>;

export type InstalledPluginManifestProjectionSyncPlan = Readonly<{
    upserts: readonly PluginInstallationManifestUpsertActionInputV1[];
    deletes: readonly string[];
    skipped: readonly Readonly<{
        pluginId: string;
        reason:
            | 'reserved_plugin_id'
            | 'disabled'
            | 'diagnostics_present'
            | 'manifest_missing'
            | 'manifest_digest_missing'
            | 'manifest_id_mismatch';
    }>[];
}>;

export type InstalledPluginManifestProjectionSyncResult = Readonly<{
    ok: boolean;
    attempted: boolean;
    upserted: number;
    deleted: number;
    skipped: number;
    diagnostics: readonly string[];
}>;

type PostResponse = Readonly<{
    status: number;
    data: unknown;
}>;

type PostInstalledManifestProjectionRequest = (
    url: string,
    body: unknown,
    config: AxiosRequestConfig,
) => Promise<PostResponse>;

function normalizePluginIds(pluginIds: readonly string[] | undefined): readonly string[] {
    const normalized = new Set<string>();
    for (const pluginId of pluginIds ?? []) {
        const trimmed = pluginId.trim();
        if (trimmed.length > 0) {
            normalized.add(trimmed);
        }
    }
    return Object.freeze([...normalized].sort());
}

function shouldConsiderEntry(params: Readonly<{
    pluginId: string;
    requestedPluginIds: ReadonlySet<string>;
}>): boolean {
    return params.requestedPluginIds.size === 0 || params.requestedPluginIds.has(params.pluginId);
}

function createProjectionInput(entry: InstalledPluginManifestProjectionCatalogEntry): PluginInstallationManifestUpsertActionInputV1 | null {
    if (!entry.manifest || !entry.manifestDigest) {
        return null;
    }
    return {
        pluginId: entry.pluginId,
        manifestVersion: entry.manifest.version,
        manifestDigest: entry.manifestDigest,
        displayName: entry.manifest.displayName || entry.title || entry.pluginId,
        requiredPermissions: [...entry.manifest.permissions],
        optionalPermissions: [...(entry.manifest.optionalPermissions ?? [])],
        enabled: true,
    };
}

function skipReasonForEntry(
    entry: InstalledPluginManifestProjectionCatalogEntry,
): InstalledPluginManifestProjectionSyncPlan['skipped'][number]['reason'] | null {
    if (isReservedHappierPluginId(entry.pluginId)) {
        return 'reserved_plugin_id';
    }
    if (!entry.enabled) {
        return 'disabled';
    }
    if (entry.diagnostics.length > 0) {
        return 'diagnostics_present';
    }
    if (!entry.manifest) {
        return 'manifest_missing';
    }
    if (entry.manifest.id !== entry.pluginId) {
        return 'manifest_id_mismatch';
    }
    if (!entry.manifestDigest) {
        return 'manifest_digest_missing';
    }
    return null;
}

export function buildInstalledPluginManifestProjectionSyncPlan(params: Readonly<{
    entries: readonly InstalledPluginManifestProjectionCatalogEntry[];
    pluginIds?: readonly string[];
}>): InstalledPluginManifestProjectionSyncPlan {
    const requestedPluginIds = new Set(normalizePluginIds(params.pluginIds));
    const entriesByPluginId = new Map(params.entries.map((entry) => [entry.pluginId, entry]));
    const upserts: PluginInstallationManifestUpsertActionInputV1[] = [];
    const deletes = new Set<string>();
    const skipped: InstalledPluginManifestProjectionSyncPlan['skipped'][number][] = [];

    for (const entry of params.entries) {
        if (!shouldConsiderEntry({ pluginId: entry.pluginId, requestedPluginIds })) {
            continue;
        }
        const reason = skipReasonForEntry(entry);
        if (reason) {
            skipped.push({ pluginId: entry.pluginId, reason });
            if (!isReservedHappierPluginId(entry.pluginId)) {
                deletes.add(entry.pluginId);
            }
            continue;
        }
        const upsert = createProjectionInput(entry);
        if (upsert) {
            upserts.push(upsert);
        }
    }

    for (const pluginId of requestedPluginIds) {
        if (!entriesByPluginId.has(pluginId) && !isReservedHappierPluginId(pluginId)) {
            deletes.add(pluginId);
        }
    }

    return Object.freeze({
        upserts: Object.freeze(upserts.sort((left, right) => left.pluginId.localeCompare(right.pluginId))),
        deletes: Object.freeze([...deletes].sort()),
        skipped: Object.freeze(skipped),
    });
}

async function postProjectionRequest(params: Readonly<{
    baseUrl: string;
    token: string;
    path: string;
    body: unknown;
    timeoutMs: number;
    createPublisherHeader: CreatePluginInstallationPublisherHeader;
    post: PostInstalledManifestProjectionRequest;
}>): Promise<PostResponse | null> {
    const publisherHeader = await params.createPublisherHeader({
        method: 'POST',
        path: params.path,
        body: params.body,
    });
    if (!publisherHeader) {
        return null;
    }
    return await params.post(`${params.baseUrl}${params.path}`, params.body, {
        headers: {
            Authorization: `Bearer ${params.token}`,
            [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader,
        },
        timeout: params.timeoutMs,
        validateStatus: () => true,
    }).catch(() => null);
}

export async function publishInstalledPluginManifestProjectionsToServer(params?: Readonly<{
    pluginIds?: readonly string[];
    readCredentials?: () => Promise<Credentials | null>;
    readInstalledPluginCatalog?: () => Promise<readonly InstalledPluginManifestProjectionCatalogEntry[]>;
    resolveServerBaseUrl?: () => string;
    timeoutMs?: number;
    createPublisherHeader?: CreatePluginInstallationPublisherHeader;
    post?: PostInstalledManifestProjectionRequest;
}>): Promise<InstalledPluginManifestProjectionSyncResult> {
    const credentials = await (params?.readCredentials ?? readCredentials)().catch(() => null);
    if (!credentials) {
        return {
            ok: true,
            attempted: false,
            upserted: 0,
            deleted: 0,
            skipped: 0,
            diagnostics: Object.freeze(['credentials_missing']),
        };
    }

    const entries = await (params?.readInstalledPluginCatalog ?? (() => readInstalledPluginCatalog({ happyHomeDir: configuration.happyHomeDir })))()
        .catch(() => null);
    if (!entries) {
        return {
            ok: false,
            attempted: true,
            upserted: 0,
            deleted: 0,
            skipped: 0,
            diagnostics: Object.freeze(['installed_plugin_catalog_unavailable']),
        };
    }

    const plan = buildInstalledPluginManifestProjectionSyncPlan({
        entries,
        pluginIds: params?.pluginIds,
    });
    const baseUrl = (params?.resolveServerBaseUrl ?? resolveServerHttpBaseUrl)().replace(/\/+$/u, '');
    const timeoutMs = params?.timeoutMs ?? configuration.sessionControlHttpTimeoutMs;
    const createPublisherHeader = params?.createPublisherHeader ?? createDefaultPluginInstallationPublisherHeader;
    const post = params?.post ?? (async (url, body, config) => {
        const response = await axios.post(url, body, config);
        return {
            status: response.status,
            data: response.data,
        };
    });
    const diagnostics: string[] = [];
    let upserted = 0;
    let deleted = 0;

    for (const body of plan.upserts) {
        const response = await postProjectionRequest({
            baseUrl,
            token: credentials.token,
            path: '/v1/plugins/installations/manifests/upsert',
            body,
            timeoutMs,
            createPublisherHeader,
            post,
        });
        if (!response) {
            diagnostics.push(`upsert_unavailable:${body.pluginId}`);
            continue;
        }
        const parsed = PluginInstallationManifestUpsertActionOutputV1Schema.safeParse(response.data);
        if (response.status < 200 || response.status >= 300 || !parsed.success) {
            diagnostics.push(`upsert_failed:${body.pluginId}`);
            continue;
        }
        upserted += 1;
    }

    for (const pluginId of plan.deletes) {
        const body: PluginInstallationManifestDeleteActionInputV1 = { pluginId };
        const response = await postProjectionRequest({
            baseUrl,
            token: credentials.token,
            path: '/v1/plugins/installations/manifests/delete',
            body,
            timeoutMs,
            createPublisherHeader,
            post,
        });
        if (!response) {
            diagnostics.push(`delete_unavailable:${pluginId}`);
            continue;
        }
        const parsed = PluginInstallationManifestDeleteActionOutputV1Schema.safeParse(response.data);
        if (response.status < 200 || response.status >= 300 || !parsed.success) {
            diagnostics.push(`delete_failed:${pluginId}`);
            continue;
        }
        deleted += 1;
    }

    return {
        ok: diagnostics.length === 0,
        attempted: true,
        upserted,
        deleted,
        skipped: plan.skipped.length,
        diagnostics: Object.freeze(diagnostics),
    };
}
