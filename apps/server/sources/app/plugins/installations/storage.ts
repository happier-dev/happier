import { Prisma } from "@prisma/client";
import type {
    PluginInstallationManifestProjectionV1,
    PluginInstallationManifestUpsertActionInputV1,
} from "@happier-dev/protocol";
import {
    PluginInstallationManifestProjectionV1Schema,
    PluginPermissionDeclarationV1Schema,
    PluginSourceSpecV1Schema,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";

export type PluginInstallationManifestListParams = Readonly<{
    accountId: string;
    machineId?: string;
    pluginId?: string;
    includeDisabled?: boolean;
    limit: number;
}>;

export type PluginInstallationManifestLookupParams = Readonly<{
    accountId: string;
    machineId?: string;
    pluginId: string;
}>;

export type PluginInstallationManifestUpsertParams = Readonly<{
    accountId: string;
    machineId: string;
    input: PluginInstallationManifestUpsertActionInputV1;
    now: number;
}>;

export type PluginInstallationManifestDeleteParams = Readonly<{
    accountId: string;
    machineId: string;
    pluginId: string;
}>;

export interface PluginInstallationManifestProjectionStore {
    list(params: PluginInstallationManifestListParams): Promise<readonly PluginInstallationManifestProjectionV1[]>;
    getEnabled(params: PluginInstallationManifestLookupParams): Promise<PluginInstallationManifestProjectionV1 | null>;
    upsert(params: PluginInstallationManifestUpsertParams): Promise<PluginInstallationManifestProjectionV1>;
    delete(params: PluginInstallationManifestDeleteParams): Promise<boolean>;
}

type ProjectionRow = {
    account_id: string;
    machine_id: string;
    plugin_id: string;
    schema_version: number | bigint;
    plugin_version: string;
    display_name: string;
    manifest_digest: string;
    source_json: string | null;
    required_permissions_json: string;
    optional_permissions_json: string;
    enabled: boolean | number | bigint;
    disabled_at: number | bigint | null;
    created_at: number | bigint;
    updated_at: number | bigint;
};

const PROJECTION_COLUMNS = Prisma.raw([
    "account_id",
    "machine_id",
    "plugin_id",
    "schema_version",
    "plugin_version",
    "display_name",
    "manifest_digest",
    "source_json",
    "required_permissions_json",
    "optional_permissions_json",
    "enabled",
    "disabled_at",
    "created_at",
    "updated_at",
].join(", "));

function stringifyJson(value: unknown): string {
    return JSON.stringify(value);
}

function parseJson(value: string): unknown {
    return JSON.parse(value);
}

function toNumber(value: number | bigint): number {
    return typeof value === "bigint" ? Number(value) : value;
}

function toBoolean(value: boolean | number | bigint): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "bigint") return value !== 0n;
    return value !== 0;
}

function rowToProjection(row: ProjectionRow): PluginInstallationManifestProjectionV1 {
    const source = row.source_json ? PluginSourceSpecV1Schema.parse(parseJson(row.source_json)) : undefined;
    return PluginInstallationManifestProjectionV1Schema.parse({
        v: 1,
        accountId: row.account_id,
        machineId: row.machine_id,
        pluginId: row.plugin_id,
        manifestVersion: row.plugin_version,
        manifestDigest: row.manifest_digest,
        displayName: row.display_name,
        ...(source ? { source } : {}),
        requiredPermissions: PluginPermissionDeclarationV1Schema.array().parse(parseJson(row.required_permissions_json)),
        optionalPermissions: PluginPermissionDeclarationV1Schema.array().parse(parseJson(row.optional_permissions_json)),
        enabled: toBoolean(row.enabled),
        disabledAt: row.disabled_at == null ? undefined : toNumber(row.disabled_at),
        createdAt: toNumber(row.created_at),
        updatedAt: toNumber(row.updated_at),
    });
}

function buildListWhere(params: PluginInstallationManifestListParams): Prisma.Sql[] {
    const where = [Prisma.sql`account_id = ${params.accountId}`];
    if (params.machineId) where.push(Prisma.sql`machine_id = ${params.machineId}`);
    if (params.pluginId) where.push(Prisma.sql`plugin_id = ${params.pluginId}`);
    if (!params.includeDisabled) where.push(Prisma.sql`enabled = true`);
    return where;
}

function appendLookupWhere(where: Prisma.Sql[], params: PluginInstallationManifestLookupParams): void {
    if (params.machineId) {
        where.push(Prisma.sql`machine_id = ${params.machineId}`);
    }
}

async function readProjection(params: PluginInstallationManifestLookupParams): Promise<PluginInstallationManifestProjectionV1 | null> {
    const where = [
        Prisma.sql`account_id = ${params.accountId}`,
        Prisma.sql`plugin_id = ${params.pluginId}`,
    ];
    appendLookupWhere(where, params);
    const rows = await db.$queryRaw<ProjectionRow[]>(Prisma.sql`
        SELECT ${PROJECTION_COLUMNS}
        FROM account_plugin_manifest_projections
        WHERE ${Prisma.join(where, " AND ")}
        ORDER BY updated_at DESC, machine_id ASC
        LIMIT 1
    `);
    const row = rows[0];
    return row ? rowToProjection(row) : null;
}

export function createSqlPluginInstallationManifestProjectionStore(): PluginInstallationManifestProjectionStore {
    return {
        async list(params) {
            const where = buildListWhere(params);
            const rows = await db.$queryRaw<ProjectionRow[]>(Prisma.sql`
                SELECT ${PROJECTION_COLUMNS}
                FROM account_plugin_manifest_projections
                WHERE ${Prisma.join(where, " AND ")}
                ORDER BY updated_at DESC, plugin_id ASC
                LIMIT ${params.limit}
            `);
            return rows.map(rowToProjection);
        },
        async getEnabled(params) {
            const where = [
                Prisma.sql`account_id = ${params.accountId}`,
                Prisma.sql`plugin_id = ${params.pluginId}`,
                Prisma.sql`enabled = true`,
            ];
            appendLookupWhere(where, params);
            const rows = await db.$queryRaw<ProjectionRow[]>(Prisma.sql`
                SELECT ${PROJECTION_COLUMNS}
                FROM account_plugin_manifest_projections
                WHERE ${Prisma.join(where, " AND ")}
                ORDER BY updated_at DESC, machine_id ASC
                LIMIT 1
            `);
            const row = rows[0];
            return row ? rowToProjection(row) : null;
        },
        async upsert(params) {
            const enabled = params.input.enabled;
            const disabledAt = enabled ? null : params.now;
            const sourceJson = params.input.source ? stringifyJson(params.input.source) : null;
            const requiredPermissionsJson = stringifyJson(params.input.requiredPermissions);
            const optionalPermissionsJson = stringifyJson(params.input.optionalPermissions);
            const updateExisting = async () => await db.$executeRaw(Prisma.sql`
                UPDATE account_plugin_manifest_projections
                SET schema_version = ${1},
                    plugin_version = ${params.input.manifestVersion},
                    display_name = ${params.input.displayName},
                    manifest_digest = ${params.input.manifestDigest},
                    source_json = ${sourceJson},
                    required_permissions_json = ${requiredPermissionsJson},
                    optional_permissions_json = ${optionalPermissionsJson},
                    enabled = ${enabled},
                    disabled_at = ${disabledAt},
                    updated_at = ${params.now}
                WHERE account_id = ${params.accountId}
                  AND machine_id = ${params.machineId}
                  AND plugin_id = ${params.input.pluginId}
            `);
            const updated = await updateExisting();
            if (Number(updated) === 0) {
                try {
                    await db.$executeRaw(Prisma.sql`
                        INSERT INTO account_plugin_manifest_projections (
                            account_id, machine_id, plugin_id, schema_version, plugin_version, display_name, manifest_digest,
                            source_json, required_permissions_json, optional_permissions_json, enabled, disabled_at,
                            created_at, updated_at
                        ) VALUES (
                            ${params.accountId}, ${params.machineId}, ${params.input.pluginId}, ${1}, ${params.input.manifestVersion},
                            ${params.input.displayName}, ${params.input.manifestDigest},
                            ${sourceJson}, ${requiredPermissionsJson}, ${optionalPermissionsJson},
                            ${enabled}, ${disabledAt}, ${params.now}, ${params.now}
                        )
                    `);
                } catch (error) {
                    const recovered = await updateExisting();
                    if (Number(recovered) === 0) {
                        throw error;
                    }
                }
            }
            const projection = await readProjection({
                accountId: params.accountId,
                machineId: params.machineId,
                pluginId: params.input.pluginId,
            });
            if (!projection) {
                throw new Error("plugin_installation_manifest_projection_missing_after_upsert");
            }
            return projection;
        },
        async delete(params) {
            const deleted = await db.$executeRaw(Prisma.sql`
                DELETE FROM account_plugin_manifest_projections
                WHERE account_id = ${params.accountId}
                  AND machine_id = ${params.machineId}
                  AND plugin_id = ${params.pluginId}
            `);
            return Number(deleted) > 0;
        },
    };
}
