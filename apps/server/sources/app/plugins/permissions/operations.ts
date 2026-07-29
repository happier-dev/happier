import { randomUUID } from "node:crypto";
import type {
    PluginPermissionGrantActorV1,
    PluginPermissionGrantAuditEventV1,
    PluginPermissionGrantAuthoritySourceV1,
    PluginPermissionGrantDismissRequestActionInputV1,
    PluginPermissionGrantDismissRequestActionOutputV1,
    PluginPermissionGrantGrantActionInputV1,
    PluginPermissionGrantGrantActionOutputV1,
    PluginPermissionGrantListActionInputV1,
    PluginPermissionGrantListActionOutputV1,
    PluginPermissionGrantRequestActionInputV1,
    PluginPermissionGrantRequestActionOutputV1,
    PluginPermissionGrantRequestV1,
    PluginPermissionGrantRevokeActionInputV1,
    PluginPermissionGrantRevokeActionOutputV1,
    PluginPermissionGrantV1,
} from "@happier-dev/protocol";
import {
    PluginPermissionGrantDismissRequestActionOutputV1Schema,
    PluginPermissionGrantGrantActionOutputV1Schema,
    PluginPermissionGrantListActionOutputV1Schema,
    PluginPermissionGrantRequestActionOutputV1Schema,
    PluginPermissionGrantRevokeActionOutputV1Schema,
} from "@happier-dev/protocol";
import { isPrismaUniqueConstraintError } from "@/storage/prisma";

import { PluginPermissionGrantOperationError } from "./errors";
import {
    createSqlPluginPermissionGrantStore,
    type PluginPermissionGrantStore,
} from "./storage";
import {
    resolveDefaultPluginPermissionGrantAuthority,
    type ResolvePluginPermissionGrantAuthority,
} from "./authority";

export type PluginPermissionGrantOperationsRuntime = Readonly<{
    now: () => number;
    createId: (prefix: string) => string;
}>;

export type PluginPermissionGrantOperations = Readonly<{
    list(params: Readonly<{
        accountId: string;
        input: PluginPermissionGrantListActionInputV1;
    }>): Promise<PluginPermissionGrantListActionOutputV1>;
    request(params: Readonly<{
        accountId: string;
        userId: string;
        publisher?: PluginPermissionGrantAuthoritySourceV1;
        input: PluginPermissionGrantRequestActionInputV1;
    }>): Promise<PluginPermissionGrantRequestActionOutputV1>;
    grant(params: Readonly<{
        accountId: string;
        userId: string;
        input: PluginPermissionGrantGrantActionInputV1;
    }>): Promise<PluginPermissionGrantGrantActionOutputV1>;
    revoke(params: Readonly<{
        accountId: string;
        userId: string;
        input: PluginPermissionGrantRevokeActionInputV1;
    }>): Promise<PluginPermissionGrantRevokeActionOutputV1>;
    dismissRequest(params: Readonly<{
        accountId: string;
        userId: string;
        input: PluginPermissionGrantDismissRequestActionInputV1;
    }>): Promise<PluginPermissionGrantDismissRequestActionOutputV1>;
}>;

function defaultRuntime(): PluginPermissionGrantOperationsRuntime {
    return {
        now: () => Date.now(),
        createId: (prefix) => `${prefix}-${randomUUID()}`,
    };
}

function userActor(userId: string): PluginPermissionGrantActorV1 {
    return { kind: "user", userId };
}

function buildEvent(params: Readonly<{
    runtime: PluginPermissionGrantOperationsRuntime;
    eventKind: PluginPermissionGrantAuditEventV1["eventKind"];
    accountId: string;
    pluginId: string;
    capability: PluginPermissionGrantAuditEventV1["capability"];
    targetScope: PluginPermissionGrantAuditEventV1["targetScope"];
    authoritySource: PluginPermissionGrantAuthoritySourceV1;
    actor: PluginPermissionGrantActorV1;
    requestId?: string;
    grantId?: string;
    previousState?: unknown;
    nextState?: unknown;
    reason?: string;
}>): PluginPermissionGrantAuditEventV1 {
    return {
        v: 1,
        eventId: params.runtime.createId("plugin-permission-grant-event"),
        accountId: params.accountId,
        pluginId: params.pluginId,
        capability: params.capability,
        targetScope: params.targetScope,
        authoritySource: params.authoritySource,
        eventKind: params.eventKind,
        actor: params.actor,
        requestId: params.requestId,
        grantId: params.grantId,
        previousState: params.previousState,
        nextState: params.nextState,
        reason: params.reason,
        createdAt: params.runtime.now(),
    };
}

function assertPendingRequest(request: PluginPermissionGrantRequestV1 | null): PluginPermissionGrantRequestV1 {
    if (!request || request.status !== "pending") {
        throw new PluginPermissionGrantOperationError(
            "plugin_permission_grant_request_not_found",
            "Plugin permission grant request was not found",
        );
    }
    return request;
}

function assertActiveGrant(grant: PluginPermissionGrantV1 | null): PluginPermissionGrantV1 {
    if (!grant || grant.status !== "active") {
        throw new PluginPermissionGrantOperationError(
            "plugin_permission_grant_not_found",
            "Plugin permission grant was not found",
        );
    }
    return grant;
}

function assertRequestIdentity(input: PluginPermissionGrantRequestActionInputV1): void {
    if (input.requester.kind !== "plugin" || input.requester.pluginId !== input.pluginId) {
        throw new PluginPermissionGrantOperationError(
            "plugin_permission_grant_requester_mismatch",
            "Plugin permission grant request identity does not match the requested plugin",
        );
    }
}

async function findActiveGrantForRequest(
    store: PluginPermissionGrantStore,
    request: PluginPermissionGrantRequestV1,
): Promise<PluginPermissionGrantV1 | null> {
    return (await store.list({
        accountId: request.accountId,
        pluginId: request.pluginId,
        capability: request.capability,
        targetScope: request.targetScope,
        authoritySource: request.authoritySource,
        includeRevoked: false,
        includeResolvedRequests: false,
        limit: 1,
    })).grants[0] ?? null;
}

async function findPendingRequestForIdentity(
    store: PluginPermissionGrantStore,
    params: Readonly<{
        accountId: string;
        pluginId: PluginPermissionGrantRequestV1["pluginId"];
        capability: PluginPermissionGrantRequestV1["capability"];
        targetScope: PluginPermissionGrantRequestV1["targetScope"];
        authoritySource: PluginPermissionGrantRequestV1["authoritySource"];
    }>,
): Promise<PluginPermissionGrantRequestV1 | null> {
    return (await store.list({
        accountId: params.accountId,
        pluginId: params.pluginId,
        capability: params.capability,
        targetScope: params.targetScope,
        authoritySource: params.authoritySource,
        includeRevoked: false,
        includeResolvedRequests: false,
        limit: 1,
    })).pendingRequests[0] ?? null;
}

async function readGrantedRequestOutcome(
    store: PluginPermissionGrantStore,
    request: PluginPermissionGrantRequestV1 | null,
): Promise<Readonly<{
    grant: PluginPermissionGrantV1;
    pendingRequest: PluginPermissionGrantRequestV1;
}> | null> {
    if (request?.status !== "granted" || !request.grantId) return null;
    const grant = await store.getGrant({
        accountId: request.accountId,
        grantId: request.grantId,
    });
    return grant ? { grant, pendingRequest: request } : null;
}

async function assertTrustedOptionalGrantAuthority(params: Readonly<{
    accountId: string;
    authoritySource?: PluginPermissionGrantAuthoritySourceV1;
    pluginId: string;
    capability: PluginPermissionGrantAuditEventV1["capability"];
    targetScope: PluginPermissionGrantAuditEventV1["targetScope"];
    resolveAuthority: ResolvePluginPermissionGrantAuthority;
}>): Promise<PluginPermissionGrantAuthoritySourceV1> {
    const expectedAuthoritySource = params.authoritySource;
    if (expectedAuthoritySource?.kind !== "machine_installation") {
        throw new PluginPermissionGrantOperationError(
            "plugin_permission_grant_publisher_proof_required",
            "Plugin permission grant requests require a trusted machine publisher proof",
        );
    }
    const authority = await params.resolveAuthority({
        accountId: params.accountId,
        machineId: expectedAuthoritySource.machineId,
        installationId: expectedAuthoritySource.installationId,
        pluginId: params.pluginId,
        capability: params.capability,
        targetScope: params.targetScope,
    });
    if (!authority || authority.pluginId !== params.pluginId) {
        throw new PluginPermissionGrantOperationError(
            "plugin_permission_grant_plugin_not_trusted",
            "Plugin is not trusted for optional permission grants",
        );
    }
    if (
        authority.source.kind !== "machine_installation"
        || authority.source.machineId !== expectedAuthoritySource.machineId
        || authority.source.installationId !== expectedAuthoritySource.installationId
    ) {
        throw new PluginPermissionGrantOperationError(
            "plugin_permission_grant_plugin_not_trusted",
            "Plugin permission grant authority source is no longer trusted",
        );
    }
    return authority.source;
}

export function createPluginPermissionGrantOperations(
    store: PluginPermissionGrantStore = createSqlPluginPermissionGrantStore(),
    runtime: PluginPermissionGrantOperationsRuntime = defaultRuntime(),
    resolveAuthority: ResolvePluginPermissionGrantAuthority = resolveDefaultPluginPermissionGrantAuthority,
): PluginPermissionGrantOperations {
    return {
        async list(params) {
            const result = await store.list({
                accountId: params.accountId,
                pluginId: params.input.pluginId,
                capability: params.input.capability,
                targetScope: params.input.targetScope,
                includeRevoked: params.input.includeRevoked,
                includeResolvedRequests: params.input.includeResolvedRequests,
                limit: params.input.limit,
            });
            return PluginPermissionGrantListActionOutputV1Schema.parse(result);
        },
        async request(params) {
            assertRequestIdentity(params.input);
            const authoritySource = await assertTrustedOptionalGrantAuthority({
                accountId: params.accountId,
                authoritySource: params.publisher,
                pluginId: params.input.pluginId,
                capability: params.input.capability,
                targetScope: params.input.targetScope,
                resolveAuthority,
            });
            const existingPendingRequest = await findPendingRequestForIdentity(store, {
                accountId: params.accountId,
                pluginId: params.input.pluginId,
                capability: params.input.capability,
                targetScope: params.input.targetScope,
                authoritySource,
            });
            if (existingPendingRequest) {
                return PluginPermissionGrantRequestActionOutputV1Schema.parse({
                    pendingRequest: existingPendingRequest,
                });
            }
            const now = runtime.now();
            const pendingRequest: PluginPermissionGrantRequestV1 = {
                v: 1,
                id: runtime.createId("plugin-permission-grant-request"),
                accountId: params.accountId,
                pluginId: params.input.pluginId,
                capability: params.input.capability,
                targetScope: params.input.targetScope,
                authoritySource,
                requester: params.input.requester,
                reason: params.input.reason,
                status: "pending",
                createdByUserId: params.userId,
                createdAt: now,
                updatedAt: now,
            };
            const event = buildEvent({
                runtime,
                eventKind: "requested",
                accountId: params.accountId,
                pluginId: pendingRequest.pluginId,
                capability: pendingRequest.capability,
                targetScope: pendingRequest.targetScope,
                authoritySource: pendingRequest.authoritySource,
                actor: pendingRequest.requester,
                requestId: pendingRequest.id,
                nextState: { status: pendingRequest.status },
                reason: pendingRequest.reason,
            });
            try {
                await store.createPendingRequest({ pendingRequest, event });
            } catch (error) {
                if (!isPrismaUniqueConstraintError(error)) {
                    throw error;
                }
                const racedPendingRequest = await findPendingRequestForIdentity(store, {
                    accountId: params.accountId,
                    pluginId: params.input.pluginId,
                    capability: params.input.capability,
                    targetScope: params.input.targetScope,
                    authoritySource,
                });
                if (!racedPendingRequest) {
                    throw error;
                }
                return PluginPermissionGrantRequestActionOutputV1Schema.parse({
                    pendingRequest: racedPendingRequest,
                });
            }
            return PluginPermissionGrantRequestActionOutputV1Schema.parse({ pendingRequest });
        },
        async grant(params) {
            const storedRequest = await store.getRequest({
                accountId: params.accountId,
                requestId: params.input.requestId,
            });
            const terminalOutcome = await readGrantedRequestOutcome(store, storedRequest);
            if (terminalOutcome) {
                return PluginPermissionGrantGrantActionOutputV1Schema.parse(terminalOutcome);
            }
            const existing = assertPendingRequest(storedRequest);
            await assertTrustedOptionalGrantAuthority({
                accountId: params.accountId,
                authoritySource: existing.authoritySource,
                pluginId: existing.pluginId,
                capability: existing.capability,
                targetScope: existing.targetScope,
                resolveAuthority,
            });
            const now = runtime.now();
            const existingActiveGrant = await findActiveGrantForRequest(store, existing);
            if (existingActiveGrant) {
                const pendingRequest: PluginPermissionGrantRequestV1 = {
                    ...existing,
                    status: "granted",
                    grantId: existingActiveGrant.id,
                    decidedByUserId: params.userId,
                    decidedAt: now,
                    updatedAt: now,
                };
                const event = buildEvent({
                    runtime,
                    eventKind: "granted",
                    accountId: params.accountId,
                    pluginId: existingActiveGrant.pluginId,
                    capability: existingActiveGrant.capability,
                    targetScope: existingActiveGrant.targetScope,
                    authoritySource: existingActiveGrant.authoritySource,
                    actor: userActor(params.userId),
                    requestId: existing.id,
                    grantId: existingActiveGrant.id,
                    previousState: { requestStatus: existing.status, grantStatus: existingActiveGrant.status },
                    nextState: { requestStatus: pendingRequest.status, grantStatus: existingActiveGrant.status },
                    reason: params.input.reason,
                });
                await store.resolvePendingRequestWithExistingGrant({ pendingRequest, event });
                return PluginPermissionGrantGrantActionOutputV1Schema.parse({
                    grant: existingActiveGrant,
                    pendingRequest,
                });
            }
            const grant: PluginPermissionGrantV1 = {
                v: 1,
                id: runtime.createId("plugin-permission-grant"),
                accountId: existing.accountId,
                pluginId: existing.pluginId,
                capability: existing.capability,
                targetScope: existing.targetScope,
                authoritySource: existing.authoritySource,
                status: "active",
                requestId: existing.id,
                grantedByUserId: params.userId,
                grantedAt: now,
                createdAt: now,
                updatedAt: now,
            };
            const pendingRequest: PluginPermissionGrantRequestV1 = {
                ...existing,
                status: "granted",
                grantId: grant.id,
                decidedByUserId: params.userId,
                decidedAt: now,
                updatedAt: now,
            };
            const event = buildEvent({
                runtime,
                eventKind: "granted",
                accountId: params.accountId,
                pluginId: grant.pluginId,
                capability: grant.capability,
                targetScope: grant.targetScope,
                authoritySource: grant.authoritySource,
                actor: userActor(params.userId),
                requestId: existing.id,
                grantId: grant.id,
                previousState: { requestStatus: existing.status },
                nextState: { requestStatus: pendingRequest.status, grantStatus: grant.status },
                reason: params.input.reason,
            });
            try {
                await store.grantPendingRequest({ pendingRequest, grant, event });
            } catch (error) {
                const currentOutcome = await readGrantedRequestOutcome(store, await store.getRequest({
                    accountId: params.accountId,
                    requestId: existing.id,
                }));
                if (currentOutcome) {
                    return PluginPermissionGrantGrantActionOutputV1Schema.parse(currentOutcome);
                }
                if (!isPrismaUniqueConstraintError(error)) {
                    throw error;
                }
                const racedActiveGrant = await findActiveGrantForRequest(store, existing);
                if (!racedActiveGrant) {
                    throw error;
                }
                const racedPendingRequest: PluginPermissionGrantRequestV1 = {
                    ...existing,
                    status: "granted",
                    grantId: racedActiveGrant.id,
                    decidedByUserId: params.userId,
                    decidedAt: now,
                    updatedAt: now,
                };
                const racedEvent = buildEvent({
                    runtime,
                    eventKind: "granted",
                    accountId: params.accountId,
                    pluginId: racedActiveGrant.pluginId,
                    capability: racedActiveGrant.capability,
                    targetScope: racedActiveGrant.targetScope,
                    authoritySource: racedActiveGrant.authoritySource,
                    actor: userActor(params.userId),
                    requestId: existing.id,
                    grantId: racedActiveGrant.id,
                    previousState: { requestStatus: existing.status, grantStatus: racedActiveGrant.status },
                    nextState: { requestStatus: racedPendingRequest.status, grantStatus: racedActiveGrant.status },
                    reason: params.input.reason,
                });
                try {
                    await store.resolvePendingRequestWithExistingGrant({
                        pendingRequest: racedPendingRequest,
                        event: racedEvent,
                    });
                } catch (resolveError) {
                    const resolvedOutcome = await readGrantedRequestOutcome(store, await store.getRequest({
                        accountId: params.accountId,
                        requestId: existing.id,
                    }));
                    if (resolvedOutcome) {
                        return PluginPermissionGrantGrantActionOutputV1Schema.parse(resolvedOutcome);
                    }
                    throw resolveError;
                }
                return PluginPermissionGrantGrantActionOutputV1Schema.parse({
                    grant: racedActiveGrant,
                    pendingRequest: racedPendingRequest,
                });
            }
            return PluginPermissionGrantGrantActionOutputV1Schema.parse({ grant, pendingRequest });
        },
        async revoke(params) {
            const storedGrant = await store.getGrant({
                accountId: params.accountId,
                grantId: params.input.grantId,
            });
            if (storedGrant?.status === "revoked") {
                return PluginPermissionGrantRevokeActionOutputV1Schema.parse({
                    grant: storedGrant,
                });
            }
            const existing = assertActiveGrant(storedGrant);
            const now = runtime.now();
            const grant: PluginPermissionGrantV1 = {
                ...existing,
                status: "revoked",
                revokedByUserId: params.userId,
                revokedAt: now,
                updatedAt: now,
            };
            const event = buildEvent({
                runtime,
                eventKind: "revoked",
                accountId: params.accountId,
                pluginId: grant.pluginId,
                capability: grant.capability,
                targetScope: grant.targetScope,
                authoritySource: grant.authoritySource,
                actor: userActor(params.userId),
                requestId: grant.requestId,
                grantId: grant.id,
                previousState: { grantStatus: existing.status },
                nextState: { grantStatus: grant.status },
                reason: params.input.reason,
            });
            try {
                await store.revokeGrant({ grant, event });
            } catch (error) {
                const current = await store.getGrant({
                    accountId: params.accountId,
                    grantId: existing.id,
                });
                if (current?.status === "revoked") {
                    return PluginPermissionGrantRevokeActionOutputV1Schema.parse({
                        grant: current,
                    });
                }
                throw error;
            }
            return PluginPermissionGrantRevokeActionOutputV1Schema.parse({ grant });
        },
        async dismissRequest(params) {
            const storedRequest = await store.getRequest({
                accountId: params.accountId,
                requestId: params.input.requestId,
            });
            if (storedRequest?.status === "dismissed") {
                return PluginPermissionGrantDismissRequestActionOutputV1Schema.parse({
                    pendingRequest: storedRequest,
                });
            }
            const existing = assertPendingRequest(storedRequest);
            const now = runtime.now();
            const pendingRequest: PluginPermissionGrantRequestV1 = {
                ...existing,
                status: "dismissed",
                decidedByUserId: params.userId,
                decidedAt: now,
                updatedAt: now,
            };
            const event = buildEvent({
                runtime,
                eventKind: "dismissed",
                accountId: params.accountId,
                pluginId: pendingRequest.pluginId,
                capability: pendingRequest.capability,
                targetScope: pendingRequest.targetScope,
                authoritySource: pendingRequest.authoritySource,
                actor: userActor(params.userId),
                requestId: pendingRequest.id,
                previousState: { requestStatus: existing.status },
                nextState: { requestStatus: pendingRequest.status },
                reason: params.input.reason,
            });
            try {
                await store.dismissPendingRequest({ pendingRequest, event });
            } catch (error) {
                const current = await store.getRequest({
                    accountId: params.accountId,
                    requestId: existing.id,
                });
                if (current?.status === "dismissed") {
                    return PluginPermissionGrantDismissRequestActionOutputV1Schema.parse({
                        pendingRequest: current,
                    });
                }
                throw error;
            }
            return PluginPermissionGrantDismissRequestActionOutputV1Schema.parse({ pendingRequest });
        },
    };
}
