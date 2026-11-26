import { ManagedIdentityProviderCreateInputV1Schema, ManagedIdentityProviderErrorV1Schema, ManagedIdentityProviderLifecycleInputV1Schema, ManagedIdentityProviderRemovePreflightInputV1Schema, ManagedIdentityProviderRemovePreflightResultV1Schema, ManagedIdentityProviderRemoveResultV1Schema, ManagedIdentityProviderSecretReplaceInputV1Schema, ManagedIdentityProviderTestConsumeInputV1Schema, ManagedIdentityProviderTestConsumeResultV1Schema, ManagedIdentityProviderTestStartInputV1Schema, ManagedIdentityProviderTestStartResultV1Schema, ManagedIdentityProvidersListInputV1Schema, ManagedIdentityProvidersListResultV1Schema, ManagedIdentityProviderUpdateInputV1Schema, ManagedIdentityProviderV1Schema, ManagedOidcIdentityProviderV1Schema, type ManagedIdentityProviderErrorCodeV1, type ManagedIdentityProviderTeamConsumerV1, type ManagedIdentityProviderV1 } from '@happier-dev/protocol/identity/providers';
import {
    TeamIdentityErrorV1Schema,
    type TeamIdentityErrorCodeV1,
} from "@happier-dev/protocol/teams";
import type { FastifyReply } from "fastify";
import { z } from "zod/mini";

import { homeDomainActionPathForMethod } from "@/app/api/routes/actions/homeDomainActionRoute";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import {
    createHomeManagedOidcProvider,
    consumeHomeManagedIdentityProviderTest,
    deleteHomeManagedIdentityProvider,
    listHomeManagedIdentityProvidersInTx,
    preflightDeleteHomeManagedIdentityProvider,
    replaceHomeManagedIdentityProviderSecret,
    setHomeManagedIdentityProviderEnabled,
    startHomeManagedIdentityProviderTest,
    updateHomeManagedIdentityProvider,
    validateHomeManagedIdentityProvider,
} from "@/app/home/governance/homeManagedIdentityProviders";
import {
    type IdentityProviderInstanceView,
    type IdentityProviderSecretHealth,
} from "@/app/auth/providers/managed/identityProviderInstanceLifecycle";
import { OutboundIdentityEndpointError } from "@/app/net/outboundIdentityNetworkPolicy";
import { identityProviderCallbackUrl, readIdentityProviderRuntimeCurrentnessByIdsInTx } from "@/app/auth/providers/identityProviderCatalog";
import { resolveConfiguredPublicServerUrl } from "@/app/serverUrls/effectiveServerUrls";
import { readHomeConfigEnvInTx } from "@/app/home/settings/homeSettings";
import { inReadSnapshot, type Tx } from "@/storage/inTx";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import { readTeamOperationAuthenticationFromRequest } from "@/app/teams/actorContext";

import type { Fastify } from "../../types";

const ManagedProviderRouteErrorV1Schema = z.union([ManagedIdentityProviderErrorV1Schema, TeamIdentityErrorV1Schema]);
const ERROR_RESPONSES = {
    400: ManagedProviderRouteErrorV1Schema,
    403: ManagedProviderRouteErrorV1Schema,
    404: ManagedProviderRouteErrorV1Schema,
    409: ManagedProviderRouteErrorV1Schema,
    502: ManagedProviderRouteErrorV1Schema,
    503: ManagedProviderRouteErrorV1Schema,
} as const;

function rejectInvalidProviderInput(reply: FastifyReply): FastifyReply {
    return reply.code(400).send({ error: "identity_provider_invalid" as const });
}

function projectProvider(
    instance: IdentityProviderInstanceView,
    secretHealth: IdentityProviderSecretHealth,
    currentRuntimeFingerprint: string | null,
    teamConsumers: readonly ManagedIdentityProviderTeamConsumerV1[],
    publicServerUrl: string | undefined,
): ManagedIdentityProviderV1 {
    const callbackUrl = identityProviderCallbackUrl(publicServerUrl, instance);
    const common = {
        v: 1 as const,
        ...(callbackUrl ? { callbackUrl } : {}),
        owner: instance.owner,
        id: instance.id,
        displayName: instance.displayName,
        enabled: instance.enabled,
        firstEnabledAt: instance.firstEnabledAt?.getTime() ?? null,
        securityRevision: instance.securityRevision,
        revision: instance.revision,
        lastSuccessfulTest: instance.lastSuccessfulTest === null
            ? null
            : {
                at: instance.lastSuccessfulTest.testedAt.getTime(),
                testedSecurityRevision: instance.lastSuccessfulTest.securityRevision,
                current: instance.lastSuccessfulTest.securityRevision === instance.securityRevision
                    && instance.lastSuccessfulTest.runtimeFingerprint === currentRuntimeFingerprint,
            },
        createdByAccountId: instance.createdByAccountId,
        createdAt: instance.createdAt.getTime(),
        updatedAt: instance.updatedAt.getTime(),
        teamConsumers: [...teamConsumers],
    };
    if (instance.kind === "github_app_identity" && instance.config.kind === "github_app_identity") {
        if (instance.githubAppInstallationId === null) throw new Error("identity_provider_unreadable");
        return {
            ...common,
            kind: "github_app_identity" as const,
            config: instance.config,
            githubAppInstallationId: instance.githubAppInstallationId,
        };
    }
    if (instance.kind !== "oidc" || instance.config.kind !== "oidc") {
        throw new Error("identity_provider_unreadable");
    }
    return {
        ...common,
        kind: "oidc" as const,
        config: instance.config,
        secret: {
            configured: secretHealth === "configured",
            health: secretHealth === "not_configured" ? "missing" as const : secretHealth,
        },
        lastSuccessfulTest: instance.lastSuccessfulTest === null
            ? null
            : {
                at: instance.lastSuccessfulTest.testedAt.getTime(),
                testedSecurityRevision: instance.lastSuccessfulTest.securityRevision,
                current: instance.lastSuccessfulTest.securityRevision === instance.securityRevision
                    && instance.lastSuccessfulTest.runtimeFingerprint === currentRuntimeFingerprint,
            },
    };
}

async function projectProviders(instances: readonly IdentityProviderInstanceView[]) {
    if (instances.length === 0) return [];
    return await inReadSnapshot(tx => projectProvidersInTx(tx, instances));
}

async function projectProvidersInTx(tx: Tx, instances: readonly IdentityProviderInstanceView[]) {
    const owner = instances[0]?.owner;
    if (!owner) return [];
    const runtimeCurrentness = await readIdentityProviderRuntimeCurrentnessByIdsInTx(tx, {
        env: process.env, context: owner, providerIds: instances.map(instance => instance.id),
    });
    const teamConsumersByProviderId = new Map<string, ManagedIdentityProviderTeamConsumerV1[]>();
    if (owner.kind === "home") {
        const connections = (await Promise.all(portableQueryChunks({ values: instances.map(instance => instance.id), bindingsPerValue: 1, fixedBindings: 1 }).map(ids => tx.teamIdentityConnection.findMany({
            where: { providerInstanceId: { in: [...ids] } },
            orderBy: [{ team: { name: "asc" } }, { teamId: "asc" }, { id: "asc" }],
            select: {
                id: true,
                providerInstanceId: true,
                enabled: true,
                team: { select: { id: true, name: true } },
            },
        })))).flat();
        for (const connection of connections) {
            if (connection.team === null) continue;
            const consumers = teamConsumersByProviderId.get(connection.providerInstanceId) ?? [];
            consumers.push({
                team: connection.team,
                binding: {
                    kind: "identity_connection",
                    id: connection.id,
                    enabled: connection.enabled,
                },
            });
            teamConsumersByProviderId.set(connection.providerInstanceId, consumers);
        }
    }
    // The callback lives at the Home's effective public address, stored or inferred (plan §3.2).
    const publicServerUrl = resolveConfiguredPublicServerUrl(await readHomeConfigEnvInTx(tx));
    return instances.map((instance) => projectProvider(
        instance,
        runtimeCurrentness.get(instance.id)?.secretHealth ?? "unreadable",
        runtimeCurrentness.get(instance.id)?.runtimeFingerprint ?? null,
        teamConsumersByProviderId.get(instance.id) ?? [],
        publicServerUrl,
    ));
}

async function projectOneProvider(instance: IdentityProviderInstanceView) {
    return (await projectProviders([instance]))[0]!;
}

async function projectOneOidcProvider(instance: IdentityProviderInstanceView) {
    return ManagedOidcIdentityProviderV1Schema.parse(await projectOneProvider(instance));
}

function validationError(error: unknown): ManagedIdentityProviderErrorCodeV1 {
    if (error instanceof OutboundIdentityEndpointError) {
        switch (error.code) {
            case "outbound_dns_unresolved":
            case "outbound_timeout":
            case "outbound_canceled":
            case "outbound_transport_failed":
                return "oidc_discovery_failed";
            default:
                return "oidc_endpoint_forbidden";
        }
    }
    if (error instanceof Error && error.message === "oidc_issuer_mismatch") return "oidc_issuer_mismatch";
    if (
        error instanceof Error
        && (error.message === "oidc_authorization_code_unsupported" || error.message === "oidc_pkce_s256_unsupported")
    ) return "identity_provider_invalid";
    return "oidc_discovery_failed";
}

type ManagedProviderRouteErrorCode = ManagedIdentityProviderErrorCodeV1 | Extract<TeamIdentityErrorCodeV1,
    "team_authentication_required" | "team_authentication_unavailable">;

function errorStatus(code: ManagedProviderRouteErrorCode): 400 | 403 | 404 | 409 | 502 | 503 {
    if (code === "identity_provider_forbidden" || code === "team_authentication_required") return 403;
    if (code === "team_authentication_unavailable") return 503;
    if (code === "identity_provider_not_found") return 404;
    if (code === "identity_provider_invalid") return 400;
    if (code === "oidc_discovery_failed") return 502;
    return 409;
}

async function mutationError(result: Readonly<{ status: string; instance?: IdentityProviderInstanceView | null }>) {
    if (result.status === "team_authentication_required") {
        return {
            code: result.status,
            status: errorStatus(result.status),
            body: { error: result.status },
        } as const;
    }
    if (result.status === "team_authentication_unavailable") {
        return {
            code: result.status,
            status: errorStatus(result.status),
            body: { error: result.status },
        } as const;
    }
    const code: ManagedIdentityProviderErrorCodeV1 = result.status === "forbidden"
        ? "identity_provider_forbidden"
        : result.status === "not_found"
            ? "identity_provider_not_found"
            : result.status === "unreadable"
                ? "identity_provider_unreadable"
                : result.status === "revision_conflict"
                    ? "identity_provider_revision_conflict"
                    : result.status === "immutable_issuer"
                        ? "identity_provider_issuer_immutable"
                        : result.status === "in_use"
                            ? "identity_provider_in_use"
                        : result.status === "provider_unavailable"
                            ? "identity_provider_disabled"
                            : result.status === "validation_failed" && "error" in result
                                ? validationError(result.error)
                                : "identity_provider_invalid";
    return {
        code,
        status: errorStatus(code),
        body: {
            error: code,
            ...(result.instance ? { current: await projectOneProvider(result.instance) } : {}),
        },
    } as const;
}

/** Registers the owner-scoped managed identity-provider administration surface. */
export function registerHomeManagedIdentityProviderRoutes(app: Fastify): void {
    const RATE_LIMIT = { rateLimit: resolveApiHotEndpointRateLimit(process.env, "account.settings") };
    app.post(
        homeDomainActionPathForMethod("identity.providers.list", "POST"),
        {
            preHandler: [app.authenticate],
            attachValidation: true,
            schema: {
                body: ManagedIdentityProvidersListInputV1Schema,
                response: { 200: ManagedIdentityProvidersListResultV1Schema, ...ERROR_RESPONSES },
            },
            config: RATE_LIMIT,
        },
        async (request, reply) => {
            if (request.validationError) return await rejectInvalidProviderInput(reply);
            const result = await inReadSnapshot(async tx => {
                const listed = await listHomeManagedIdentityProvidersInTx(tx, {
                    actorAccountId: request.userId,
                    owner: request.body.owner,
                    ...readTeamOperationAuthenticationFromRequest(request),
                });
                if (listed.status !== "ready") return listed;
                const instances = listed.instances.flatMap((item) => item.status === "ready"
                    && (item.instance.kind === "oidc" || item.instance.kind === "github_app_identity")
                    ? [item.instance] : []);
                const items = await projectProvidersInTx(tx, instances);
                return { status: "ready" as const, items, unreadableCount: listed.instances.length - items.length };
            });
            if (result.status !== "ready") {
                const error = result.status === "team_authentication_required" || result.status === "team_authentication_unavailable"
                    ? result.status
                    : "identity_provider_forbidden" as const;
                return await reply.code(errorStatus(error)).send({ error });
            }
            return await reply.send({ items: result.items, unreadableCount: result.unreadableCount });
        },
    );

    app.post(
        homeDomainActionPathForMethod("identity.providers.create", "POST"),
        {
            preHandler: [app.authenticate],
            attachValidation: true,
            schema: {
                body: ManagedIdentityProviderCreateInputV1Schema,
                response: { 200: ManagedOidcIdentityProviderV1Schema, ...ERROR_RESPONSES },
            },
            config: RATE_LIMIT,
        },
        async (request, reply) => {
            if (request.validationError) return await rejectInvalidProviderInput(reply);
            const { v: _v, kind: _kind, ...config } = request.body.config;
            const result = await createHomeManagedOidcProvider({
                actorAccountId: request.userId,
                owner: request.body.owner,
                displayName: request.body.displayName,
                config,
                clientSecret: request.body.clientSecret,
                ...readTeamOperationAuthenticationFromRequest(request),
            });
            if (result.status !== "created") {
                const error = await mutationError(result);
                return await reply.code(error.status).send(error.body);
            }
            return await reply.send(await projectOneOidcProvider(result.instance));
        },
    );

    app.post(
        homeDomainActionPathForMethod("identity.providers.update", "POST"),
        {
            preHandler: [app.authenticate],
            attachValidation: true,
            schema: {
                body: ManagedIdentityProviderUpdateInputV1Schema,
                response: { 200: ManagedOidcIdentityProviderV1Schema, ...ERROR_RESPONSES },
            },
            config: RATE_LIMIT,
        },
        async (request, reply) => {
            if (request.validationError) return await rejectInvalidProviderInput(reply);
            const result = await updateHomeManagedIdentityProvider({
                actorAccountId: request.userId,
                owner: request.body.owner,
                id: request.body.id,
                expectedRevision: request.body.expectedRevision,
                ...(request.body.displayName === undefined ? {} : { displayName: request.body.displayName }),
                ...(request.body.config === undefined ? {} : { config: request.body.config }),
                ...readTeamOperationAuthenticationFromRequest(request),
            });
            if (result.status !== "applied") {
                const error = await mutationError(result);
                return await reply.code(error.status).send(error.body);
            }
            return await reply.send(await projectOneOidcProvider(result.instance));
        },
    );

    app.post(
        homeDomainActionPathForMethod("identity.providers.secret.replace", "POST"),
        {
            preHandler: [app.authenticate],
            attachValidation: true,
            schema: {
                body: ManagedIdentityProviderSecretReplaceInputV1Schema,
                response: { 200: ManagedOidcIdentityProviderV1Schema, ...ERROR_RESPONSES },
            },
            config: RATE_LIMIT,
        },
        async (request, reply) => {
            if (request.validationError) return await rejectInvalidProviderInput(reply);
            const result = await replaceHomeManagedIdentityProviderSecret({
                actorAccountId: request.userId,
                owner: request.body.owner,
                id: request.body.id,
                expectedRevision: request.body.expectedRevision,
                clientSecret: request.body.clientSecret,
                ...readTeamOperationAuthenticationFromRequest(request),
            });
            if (result.status !== "applied") {
                const error = await mutationError(result);
                return await reply.code(error.status).send(error.body);
            }
            return await reply.send(await projectOneOidcProvider(result.instance));
        },
    );

    app.post(
        homeDomainActionPathForMethod("identity.providers.validate", "POST"),
        {
            preHandler: [app.authenticate],
            attachValidation: true,
            schema: {
                body: ManagedIdentityProviderLifecycleInputV1Schema,
                response: { 200: ManagedOidcIdentityProviderV1Schema, ...ERROR_RESPONSES },
            },
            config: RATE_LIMIT,
        },
        async (request, reply) => {
            if (request.validationError) return await rejectInvalidProviderInput(reply);
            const result = await validateHomeManagedIdentityProvider({
                actorAccountId: request.userId,
                owner: request.body.owner,
                id: request.body.id,
                expectedRevision: request.body.expectedRevision,
                expectedSecurityRevision: request.body.expectedSecurityRevision,
                ...readTeamOperationAuthenticationFromRequest(request),
            });
            if (result.status !== "validated") {
                const error = await mutationError(result);
                return await reply.code(error.status).send(error.body);
            }
            return await reply.send(await projectOneOidcProvider(result.instance));
        },
    );

    app.post(
        homeDomainActionPathForMethod("identity.providers.test.start", "POST"),
        {
            preHandler: [app.authenticate],
            attachValidation: true,
            schema: {
                body: ManagedIdentityProviderTestStartInputV1Schema,
                response: { 200: ManagedIdentityProviderTestStartResultV1Schema, ...ERROR_RESPONSES },
            },
            config: {
                ...RATE_LIMIT,
            },
        },
        async (request, reply) => {
            if (request.validationError) return await rejectInvalidProviderInput(reply);
            const result = await startHomeManagedIdentityProviderTest({
                actorAccountId: request.userId,
                owner: request.body.owner,
                id: request.body.id,
                expectedRevision: request.body.expectedRevision,
                expectedSecurityRevision: request.body.expectedSecurityRevision,
                ...readTeamOperationAuthenticationFromRequest(request),
            });
            if (result.status !== "started") {
                const error = await mutationError(result);
                return await reply.code(error.status).send(error.body);
            }
            reply.header("Cache-Control", "no-store");
            return await reply.send({
                authorizeUrl: result.attempt.url,
                attemptId: result.attempt.attemptId,
            });
        },
    );

    app.post(
        homeDomainActionPathForMethod("identity.providers.test.consume", "POST"),
        {
            preHandler: [app.authenticate],
            attachValidation: true,
            schema: {
                body: ManagedIdentityProviderTestConsumeInputV1Schema,
                response: { 200: ManagedIdentityProviderTestConsumeResultV1Schema, ...ERROR_RESPONSES },
            },
            config: {
                ...RATE_LIMIT,
            },
        },
        async (request, reply) => {
            if (request.validationError) return await rejectInvalidProviderInput(reply);
            const result = await consumeHomeManagedIdentityProviderTest({
                actorAccountId: request.userId,
                owner: request.body.owner,
                id: request.body.id,
                resultHandle: request.body.resultHandle,
                ...readTeamOperationAuthenticationFromRequest(request),
            });
            if (result.status !== "consumed") {
                const error = await mutationError(result);
                return await reply.code(error.status).send(error.body);
            }
            reply.header("Cache-Control", "no-store");
            return await reply.send({
                provider: await projectOneOidcProvider(result.instance),
                testedAt: result.testedAt.getTime(),
                subjectPresent: true as const,
                ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
            });
        },
    );

    const registerEnabledRoute = (action: "identity.providers.enable" | "identity.providers.disable", enabled: boolean): void => {
        app.post(
            homeDomainActionPathForMethod(action, "POST"),
            {
                preHandler: [app.authenticate],
                attachValidation: true,
                schema: {
                    body: ManagedIdentityProviderLifecycleInputV1Schema,
                    response: { 200: ManagedIdentityProviderV1Schema, ...ERROR_RESPONSES },
                },
                config: RATE_LIMIT,
            },
            async (request, reply) => {
                if (request.validationError) return await rejectInvalidProviderInput(reply);
                const result = await setHomeManagedIdentityProviderEnabled({
                    actorAccountId: request.userId,
                    owner: request.body.owner,
                    id: request.body.id,
                    expectedRevision: request.body.expectedRevision,
                    expectedSecurityRevision: request.body.expectedSecurityRevision,
                    enabled,
                    ...readTeamOperationAuthenticationFromRequest(request),
                });
                if (result.status !== "applied") {
                    const error = await mutationError(result);
                    return await reply.code(error.status).send(error.body);
                }
                return await reply.send(await projectOneProvider(result.instance));
            },
        );
    };
    registerEnabledRoute("identity.providers.enable", true);
    registerEnabledRoute("identity.providers.disable", false);

    app.post(
        homeDomainActionPathForMethod("identity.providers.remove.preview", "POST"),
        {
            preHandler: [app.authenticate],
            attachValidation: true,
            schema: {
                body: ManagedIdentityProviderRemovePreflightInputV1Schema,
                response: { 200: ManagedIdentityProviderRemovePreflightResultV1Schema, ...ERROR_RESPONSES },
            },
            config: RATE_LIMIT,
        },
        async (request, reply) => {
            if (request.validationError) return await rejectInvalidProviderInput(reply);
            const result = await preflightDeleteHomeManagedIdentityProvider({
                actorAccountId: request.userId,
                owner: request.body.owner,
                id: request.body.id,
                expectedRevision: request.body.expectedRevision,
                ...readTeamOperationAuthenticationFromRequest(request),
            });
            if (result.status !== "ready") {
                const error = await mutationError(result);
                return await reply.code(error.status).send(error.body);
            }
            return await reply.send({
                provider: await projectOneProvider(result.instance),
                canRemove: result.identityCount === 0 && result.connectionCount === 0,
                blockers: {
                    identityCount: result.identityCount,
                    connectionCount: result.connectionCount,
                    affectedAccountIds: [...result.affectedAccountIds],
                },
            });
        },
    );

    app.post(
        homeDomainActionPathForMethod("identity.providers.remove", "POST"),
        {
            preHandler: [app.authenticate],
            attachValidation: true,
            schema: {
                body: ManagedIdentityProviderRemovePreflightInputV1Schema,
                response: { 200: ManagedIdentityProviderRemoveResultV1Schema, ...ERROR_RESPONSES },
            },
            config: RATE_LIMIT,
        },
        async (request, reply) => {
            if (request.validationError) return await rejectInvalidProviderInput(reply);
            const result = await deleteHomeManagedIdentityProvider({
                actorAccountId: request.userId,
                owner: request.body.owner,
                id: request.body.id,
                expectedRevision: request.body.expectedRevision,
                ...readTeamOperationAuthenticationFromRequest(request),
            });
            if (result.status !== "deleted") {
                if (result.status === "blocked") {
                    return await reply.code(409).send({
                        error: "identity_provider_in_use" as const,
                        blockers: { identityCount: result.identityCount, connectionCount: result.connectionCount },
                    });
                }
                const error = await mutationError(result);
                return await reply.code(error.status).send(error.body);
            }
            return await reply.send({ outcome: "removed" as const });
        },
    );
}
