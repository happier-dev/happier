import type { Prisma as PrismaTypes } from "@prisma/client";
import type {
    PluginPermissionCapabilityV1,
    PluginPermissionGrantAuditEventV1,
    PluginPermissionGrantAuthoritySourceV1,
    PluginPermissionGrantRequestV1,
    PluginPermissionGrantTargetScopeV1,
    PluginPermissionGrantV1,
} from "@happier-dev/protocol";
import {
    computeCanonicalDomainSeparatedDigest,
    PluginPermissionGrantRequestV1Schema,
    PluginPermissionGrantV1Schema,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { prismaRuntime as Prisma } from "@/storage/prisma";
import { PluginPermissionGrantOperationError } from "./errors";
import { appendPluginPermissionGrantAuditEvent } from "./events";

export type PluginPermissionGrantListParams = Readonly<{
    accountId: string;
    pluginId?: string;
    capability?: PluginPermissionCapabilityV1;
    targetScope?: PluginPermissionGrantTargetScopeV1;
    authoritySource?: PluginPermissionGrantAuthoritySourceV1;
    includeRevoked?: boolean;
    includeResolvedRequests?: boolean;
    limit: number;
}>;

export type PluginPermissionGrantRequestLookupParams = Readonly<{
    accountId: string;
    requestId: string;
}>;

export type PluginPermissionGrantLookupParams = Readonly<{
    accountId: string;
    grantId: string;
}>;

export type PluginPermissionGrantListResult = Readonly<{
    grants: readonly PluginPermissionGrantV1[];
    pendingRequests: readonly PluginPermissionGrantRequestV1[];
}>;

export interface PluginPermissionGrantStore {
    list(params: PluginPermissionGrantListParams): Promise<PluginPermissionGrantListResult>;
    getRequest(params: PluginPermissionGrantRequestLookupParams): Promise<PluginPermissionGrantRequestV1 | null>;
    getGrant(params: PluginPermissionGrantLookupParams): Promise<PluginPermissionGrantV1 | null>;
    createPendingRequest(params: Readonly<{
        pendingRequest: PluginPermissionGrantRequestV1;
        event: PluginPermissionGrantAuditEventV1;
    }>): Promise<void>;
    grantPendingRequest(params: Readonly<{
        pendingRequest: PluginPermissionGrantRequestV1;
        grant: PluginPermissionGrantV1;
        event: PluginPermissionGrantAuditEventV1;
    }>): Promise<void>;
    resolvePendingRequestWithExistingGrant(params: Readonly<{
        pendingRequest: PluginPermissionGrantRequestV1;
        event: PluginPermissionGrantAuditEventV1;
    }>): Promise<void>;
    revokeGrant(params: Readonly<{
        grant: PluginPermissionGrantV1;
        event: PluginPermissionGrantAuditEventV1;
    }>): Promise<void>;
    dismissPendingRequest(params: Readonly<{
        pendingRequest: PluginPermissionGrantRequestV1;
        event: PluginPermissionGrantAuditEventV1;
    }>): Promise<void>;
}

type GrantRow = {
    id: string;
    account_id: string;
    plugin_id: string;
    capability: string;
    scope_kind: string;
    scope_project_id: string | null;
    scope_workspace_id: string | null;
    authority_kind: string;
    authority_machine_id: string | null;
    authority_installation_id: string | null;
    status: string;
    request_id: string | null;
    granted_by_user_id: string;
    granted_at: number | bigint;
    revoked_by_user_id: string | null;
    revoked_at: number | bigint | null;
    created_at: number | bigint;
    updated_at: number | bigint;
};

type RequestRow = {
    id: string;
    account_id: string;
    plugin_id: string;
    capability: string;
    scope_kind: string;
    scope_project_id: string | null;
    scope_workspace_id: string | null;
    authority_kind: string;
    authority_machine_id: string | null;
    authority_installation_id: string | null;
    requester_json: string;
    reason: string;
    status: string;
    grant_id: string | null;
    created_by_user_id: string | null;
    decided_by_user_id: string | null;
    decided_at: number | bigint | null;
    created_at: number | bigint;
    updated_at: number | bigint;
};

const GRANT_COLUMNS = Prisma.raw([
    "id",
    "account_id",
    "plugin_id",
    "capability",
    "scope_kind",
    "scope_project_id",
    "scope_workspace_id",
    "authority_kind",
    "authority_machine_id",
    "authority_installation_id",
    "status",
    "request_id",
    "granted_by_user_id",
    "granted_at",
    "revoked_by_user_id",
    "revoked_at",
    "created_at",
    "updated_at",
].join(", "));

const REQUEST_COLUMNS = Prisma.raw([
    "id",
    "account_id",
    "plugin_id",
    "capability",
    "scope_kind",
    "scope_project_id",
    "scope_workspace_id",
    "authority_kind",
    "authority_machine_id",
    "authority_installation_id",
    "requester_json",
    "reason",
    "status",
    "grant_id",
    "created_by_user_id",
    "decided_by_user_id",
    "decided_at",
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

function scopeColumns(scope: PluginPermissionGrantTargetScopeV1): Readonly<{
    scopeKind: string;
    projectId: string | null;
    workspaceId: string | null;
}> {
    if (scope.kind === "project") {
        return { scopeKind: scope.kind, projectId: scope.projectId, workspaceId: null };
    }
    if (scope.kind === "workspace") {
        return { scopeKind: scope.kind, projectId: null, workspaceId: scope.workspaceId };
    }
    return { scopeKind: scope.kind, projectId: null, workspaceId: null };
}

function authoritySourceColumns(source: PluginPermissionGrantAuthoritySourceV1): Readonly<{
    authorityKind: string;
    machineId: string | null;
    installationId: string | null;
}> {
    if (source.kind === "machine_installation") {
        return {
            authorityKind: source.kind,
            machineId: source.machineId,
            installationId: source.installationId,
        };
    }
    return {
        authorityKind: source.kind,
        machineId: null,
        installationId: null,
    };
}

function rowAuthoritySource(row: Readonly<{
    authority_kind: string;
    authority_machine_id: string | null;
    authority_installation_id: string | null;
}>): PluginPermissionGrantAuthoritySourceV1 {
    if (
        row.authority_kind === "machine_installation"
        && row.authority_machine_id
        && row.authority_installation_id
    ) {
        return {
            kind: "machine_installation",
            machineId: row.authority_machine_id,
            installationId: row.authority_installation_id,
        };
    }
    return { kind: "bundled" };
}

export function pluginPermissionGrantActiveIdentityKey(params: Readonly<{
    pluginId: string;
    capability: PluginPermissionCapabilityV1;
    targetScope: PluginPermissionGrantTargetScopeV1;
    authoritySource: PluginPermissionGrantAuthoritySourceV1;
}>): string {
    const scope = scopeColumns(params.targetScope);
    const authority = authoritySourceColumns(params.authoritySource);
    return computeCanonicalDomainSeparatedDigest(
        "happier.pluginPermissionGrant.activeIdentity.v1",
        [
            params.pluginId,
            params.capability,
            scope.scopeKind,
            scope.projectId ?? "",
            scope.workspaceId ?? "",
            authority.authorityKind,
            authority.machineId ?? "",
            authority.installationId ?? "",
        ],
    );
}

function assertTerminalTransitionWon(
    affectedRows: number,
    code: string,
    message: string,
): void {
    if (affectedRows === 1) return;
    throw new PluginPermissionGrantOperationError(code, message);
}

function rowTargetScope(row: Readonly<{
    scope_kind: string;
    scope_project_id: string | null;
    scope_workspace_id: string | null;
}>): PluginPermissionGrantTargetScopeV1 {
    if (row.scope_kind === "project" && row.scope_project_id) {
        return { kind: "project", projectId: row.scope_project_id };
    }
    if (row.scope_kind === "workspace" && row.scope_workspace_id) {
        return { kind: "workspace", workspaceId: row.scope_workspace_id };
    }
    return { kind: "account" };
}

function rowToGrant(row: GrantRow): PluginPermissionGrantV1 {
    return PluginPermissionGrantV1Schema.parse({
        v: 1,
        id: row.id,
        accountId: row.account_id,
        pluginId: row.plugin_id,
        capability: row.capability,
        targetScope: rowTargetScope(row),
        authoritySource: rowAuthoritySource(row),
        status: row.status,
        requestId: row.request_id ?? undefined,
        grantedByUserId: row.granted_by_user_id,
        grantedAt: toNumber(row.granted_at),
        revokedByUserId: row.revoked_by_user_id ?? undefined,
        revokedAt: row.revoked_at == null ? undefined : toNumber(row.revoked_at),
        createdAt: toNumber(row.created_at),
        updatedAt: toNumber(row.updated_at),
    });
}

function rowToRequest(row: RequestRow): PluginPermissionGrantRequestV1 {
    return PluginPermissionGrantRequestV1Schema.parse({
        v: 1,
        id: row.id,
        accountId: row.account_id,
        pluginId: row.plugin_id,
        capability: row.capability,
        targetScope: rowTargetScope(row),
        authoritySource: rowAuthoritySource(row),
        requester: parseJson(row.requester_json),
        reason: row.reason,
        status: row.status,
        grantId: row.grant_id ?? undefined,
        createdByUserId: row.created_by_user_id ?? undefined,
        decidedByUserId: row.decided_by_user_id ?? undefined,
        decidedAt: row.decided_at == null ? undefined : toNumber(row.decided_at),
        createdAt: toNumber(row.created_at),
        updatedAt: toNumber(row.updated_at),
    });
}

function appendTargetScopeWhere(where: PrismaTypes.Sql[], targetScope: PluginPermissionGrantTargetScopeV1): void {
    appendExactTargetScopeWhere(where, targetScope);
}

function appendExactTargetScopeWhere(where: PrismaTypes.Sql[], targetScope: PluginPermissionGrantTargetScopeV1): void {
    const scope = scopeColumns(targetScope);
    where.push(Prisma.sql`scope_kind = ${scope.scopeKind}`);
    if (scope.projectId === null) {
        where.push(Prisma.sql`scope_project_id IS NULL`);
    } else {
        where.push(Prisma.sql`scope_project_id = ${scope.projectId}`);
    }
    if (scope.workspaceId === null) {
        where.push(Prisma.sql`scope_workspace_id IS NULL`);
    } else {
        where.push(Prisma.sql`scope_workspace_id = ${scope.workspaceId}`);
    }
}

function appendExactAuthoritySourceWhere(where: PrismaTypes.Sql[], authoritySource: PluginPermissionGrantAuthoritySourceV1): void {
    const authority = authoritySourceColumns(authoritySource);
    where.push(Prisma.sql`authority_kind = ${authority.authorityKind}`);
    if (authority.machineId === null) {
        where.push(Prisma.sql`authority_machine_id IS NULL`);
    } else {
        where.push(Prisma.sql`authority_machine_id = ${authority.machineId}`);
    }
    if (authority.installationId === null) {
        where.push(Prisma.sql`authority_installation_id IS NULL`);
    } else {
        where.push(Prisma.sql`authority_installation_id = ${authority.installationId}`);
    }
}

function buildGrantWhere(params: PluginPermissionGrantListParams): PrismaTypes.Sql[] {
    const where = [Prisma.sql`account_id = ${params.accountId}`];
    if (params.pluginId) where.push(Prisma.sql`plugin_id = ${params.pluginId}`);
    if (params.capability) where.push(Prisma.sql`capability = ${params.capability}`);
    if (!params.includeRevoked) where.push(Prisma.sql`status = 'active'`);
    if (params.targetScope) appendTargetScopeWhere(where, params.targetScope);
    if (params.authoritySource) appendExactAuthoritySourceWhere(where, params.authoritySource);
    return where;
}

function buildRequestWhere(params: PluginPermissionGrantListParams): PrismaTypes.Sql[] {
    const where = [Prisma.sql`account_id = ${params.accountId}`];
    if (params.pluginId) where.push(Prisma.sql`plugin_id = ${params.pluginId}`);
    if (params.capability) where.push(Prisma.sql`capability = ${params.capability}`);
    if (!params.includeResolvedRequests) where.push(Prisma.sql`status = 'pending'`);
    if (params.targetScope) appendTargetScopeWhere(where, params.targetScope);
    if (params.authoritySource) appendExactAuthoritySourceWhere(where, params.authoritySource);
    return where;
}

export function createSqlPluginPermissionGrantStore(): PluginPermissionGrantStore {
    return {
        async list(params) {
            const grantWhere = buildGrantWhere(params);
            const requestWhere = buildRequestWhere(params);
            const grants = await db.$queryRaw<GrantRow[]>(Prisma.sql`
                SELECT ${GRANT_COLUMNS}
                FROM plugin_permission_grants
                WHERE ${Prisma.join(grantWhere, " AND ")}
                ORDER BY updated_at DESC, id DESC
                LIMIT ${params.limit}
            `);
            const pendingRequests = await db.$queryRaw<RequestRow[]>(Prisma.sql`
                SELECT ${REQUEST_COLUMNS}
                FROM plugin_permission_grant_requests
                WHERE ${Prisma.join(requestWhere, " AND ")}
                ORDER BY updated_at DESC, id DESC
                LIMIT ${params.limit}
            `);
            return {
                grants: grants.map(rowToGrant),
                pendingRequests: pendingRequests.map(rowToRequest),
            };
        },
        async getRequest(params) {
            const rows = await db.$queryRaw<RequestRow[]>(Prisma.sql`
                SELECT ${REQUEST_COLUMNS}
                FROM plugin_permission_grant_requests
                WHERE account_id = ${params.accountId} AND id = ${params.requestId}
                LIMIT 1
            `);
            const row = rows[0];
            return row ? rowToRequest(row) : null;
        },
        async getGrant(params) {
            const rows = await db.$queryRaw<GrantRow[]>(Prisma.sql`
                SELECT ${GRANT_COLUMNS}
                FROM plugin_permission_grants
                WHERE account_id = ${params.accountId} AND id = ${params.grantId}
                LIMIT 1
            `);
            const row = rows[0];
            return row ? rowToGrant(row) : null;
        },
        async createPendingRequest(params) {
            const pendingRequest = PluginPermissionGrantRequestV1Schema.parse(params.pendingRequest);
            const scope = scopeColumns(pendingRequest.targetScope);
            const authority = authoritySourceColumns(pendingRequest.authoritySource);
            await inTx(async (tx) => {
                await tx.$executeRaw(Prisma.sql`
                    INSERT INTO plugin_permission_grant_requests (
                        id, account_id, plugin_id, capability, scope_kind, scope_project_id, scope_workspace_id,
                        authority_kind, authority_machine_id, authority_installation_id,
                        requester_json, reason, status, active_identity_key, grant_id, created_by_user_id, decided_by_user_id,
                        decided_at, created_at, updated_at
                    ) VALUES (
                        ${pendingRequest.id}, ${pendingRequest.accountId}, ${pendingRequest.pluginId},
                        ${pendingRequest.capability}, ${scope.scopeKind}, ${scope.projectId}, ${scope.workspaceId},
                        ${authority.authorityKind}, ${authority.machineId}, ${authority.installationId},
                        ${stringifyJson(pendingRequest.requester)}, ${pendingRequest.reason}, ${pendingRequest.status},
                        ${pendingRequest.status === "pending" ? pluginPermissionGrantActiveIdentityKey({
                            pluginId: pendingRequest.pluginId,
                            capability: pendingRequest.capability,
                            targetScope: pendingRequest.targetScope,
                            authoritySource: pendingRequest.authoritySource,
                        }) : null},
                        ${pendingRequest.grantId ?? null}, ${pendingRequest.createdByUserId ?? null},
                        ${pendingRequest.decidedByUserId ?? null}, ${pendingRequest.decidedAt ?? null},
                        ${pendingRequest.createdAt}, ${pendingRequest.updatedAt}
                    )
                `);
                await appendPluginPermissionGrantAuditEvent(tx, params.event);
            });
        },
        async grantPendingRequest(params) {
            const pendingRequest = PluginPermissionGrantRequestV1Schema.parse(params.pendingRequest);
            const grant = PluginPermissionGrantV1Schema.parse(params.grant);
            const grantScope = scopeColumns(grant.targetScope);
            const requestScope = scopeColumns(pendingRequest.targetScope);
            const grantAuthority = authoritySourceColumns(grant.authoritySource);
            const requestAuthority = authoritySourceColumns(pendingRequest.authoritySource);
            await inTx(async (tx) => {
                await tx.$executeRaw(Prisma.sql`
                    INSERT INTO plugin_permission_grants (
                        id, account_id, plugin_id, capability, scope_kind, scope_project_id, scope_workspace_id,
                        authority_kind, authority_machine_id, authority_installation_id,
                        status, active_identity_key, request_id, granted_by_user_id, granted_at, revoked_by_user_id, revoked_at,
                        created_at, updated_at
                    ) VALUES (
                        ${grant.id}, ${grant.accountId}, ${grant.pluginId}, ${grant.capability},
                        ${grantScope.scopeKind}, ${grantScope.projectId}, ${grantScope.workspaceId},
                        ${grantAuthority.authorityKind}, ${grantAuthority.machineId}, ${grantAuthority.installationId}, ${grant.status},
                        ${grant.status === "active" ? pluginPermissionGrantActiveIdentityKey({
                            pluginId: grant.pluginId,
                            capability: grant.capability,
                            targetScope: grant.targetScope,
                            authoritySource: grant.authoritySource,
                        }) : null},
                        ${grant.requestId ?? null}, ${grant.grantedByUserId}, ${grant.grantedAt},
                        ${grant.revokedByUserId ?? null}, ${grant.revokedAt ?? null}, ${grant.createdAt}, ${grant.updatedAt}
                    )
                `);
                const affectedRequests = await tx.$executeRaw(Prisma.sql`
                    UPDATE plugin_permission_grant_requests
                    SET scope_kind = ${requestScope.scopeKind},
                        scope_project_id = ${requestScope.projectId},
                        scope_workspace_id = ${requestScope.workspaceId},
                        authority_kind = ${requestAuthority.authorityKind},
                        authority_machine_id = ${requestAuthority.machineId},
                        authority_installation_id = ${requestAuthority.installationId},
                        status = ${pendingRequest.status},
                        active_identity_key = NULL,
                        grant_id = ${pendingRequest.grantId ?? null},
                        decided_by_user_id = ${pendingRequest.decidedByUserId ?? null},
                        decided_at = ${pendingRequest.decidedAt ?? null},
                        updated_at = ${pendingRequest.updatedAt}
                    WHERE account_id = ${pendingRequest.accountId}
                      AND id = ${pendingRequest.id}
                      AND status = 'pending'
                `);
                assertTerminalTransitionWon(
                    affectedRequests,
                    "plugin_permission_grant_request_not_found",
                    "Plugin permission grant request was already resolved",
                );
                await appendPluginPermissionGrantAuditEvent(tx, params.event);
            });
        },
        async resolvePendingRequestWithExistingGrant(params) {
            const pendingRequest = PluginPermissionGrantRequestV1Schema.parse(params.pendingRequest);
            const requestScope = scopeColumns(pendingRequest.targetScope);
            const requestAuthority = authoritySourceColumns(pendingRequest.authoritySource);
            await inTx(async (tx) => {
                const affectedRequests = await tx.$executeRaw(Prisma.sql`
                    UPDATE plugin_permission_grant_requests
                    SET scope_kind = ${requestScope.scopeKind},
                        scope_project_id = ${requestScope.projectId},
                        scope_workspace_id = ${requestScope.workspaceId},
                        authority_kind = ${requestAuthority.authorityKind},
                        authority_machine_id = ${requestAuthority.machineId},
                        authority_installation_id = ${requestAuthority.installationId},
                        status = ${pendingRequest.status},
                        active_identity_key = NULL,
                        grant_id = ${pendingRequest.grantId ?? null},
                        decided_by_user_id = ${pendingRequest.decidedByUserId ?? null},
                        decided_at = ${pendingRequest.decidedAt ?? null},
                        updated_at = ${pendingRequest.updatedAt}
                    WHERE account_id = ${pendingRequest.accountId}
                      AND id = ${pendingRequest.id}
                      AND status = 'pending'
                `);
                assertTerminalTransitionWon(
                    affectedRequests,
                    "plugin_permission_grant_request_not_found",
                    "Plugin permission grant request was already resolved",
                );
                await appendPluginPermissionGrantAuditEvent(tx, params.event);
            });
        },
        async revokeGrant(params) {
            const grant = PluginPermissionGrantV1Schema.parse(params.grant);
            const identityWhere = [
                Prisma.sql`account_id = ${grant.accountId}`,
                Prisma.sql`id = ${grant.id}`,
                Prisma.sql`plugin_id = ${grant.pluginId}`,
                Prisma.sql`capability = ${grant.capability}`,
                Prisma.sql`status = 'active'`,
            ];
            appendExactTargetScopeWhere(identityWhere, grant.targetScope);
            appendExactAuthoritySourceWhere(identityWhere, grant.authoritySource);
            await inTx(async (tx) => {
                const affectedGrants = await tx.$executeRaw(Prisma.sql`
                    UPDATE plugin_permission_grants
                    SET status = ${grant.status},
                        active_identity_key = NULL,
                        revoked_by_user_id = ${grant.revokedByUserId ?? null},
                        revoked_at = ${grant.revokedAt ?? null},
                        updated_at = ${grant.updatedAt}
                    WHERE ${Prisma.join(identityWhere, " AND ")}
                `);
                assertTerminalTransitionWon(
                    affectedGrants,
                    "plugin_permission_grant_not_found",
                    "Plugin permission grant was already revoked",
                );
                await appendPluginPermissionGrantAuditEvent(tx, params.event);
            });
        },
        async dismissPendingRequest(params) {
            const pendingRequest = PluginPermissionGrantRequestV1Schema.parse(params.pendingRequest);
            await inTx(async (tx) => {
                const affectedRequests = await tx.$executeRaw(Prisma.sql`
                    UPDATE plugin_permission_grant_requests
                    SET status = ${pendingRequest.status},
                        active_identity_key = NULL,
                        decided_by_user_id = ${pendingRequest.decidedByUserId ?? null},
                        decided_at = ${pendingRequest.decidedAt ?? null},
                        updated_at = ${pendingRequest.updatedAt}
                    WHERE account_id = ${pendingRequest.accountId}
                      AND id = ${pendingRequest.id}
                      AND status = 'pending'
                `);
                assertTerminalTransitionWon(
                    affectedRequests,
                    "plugin_permission_grant_request_not_found",
                    "Plugin permission grant request was already resolved",
                );
                await appendPluginPermissionGrantAuditEvent(tx, params.event);
            });
        },
    };
}
