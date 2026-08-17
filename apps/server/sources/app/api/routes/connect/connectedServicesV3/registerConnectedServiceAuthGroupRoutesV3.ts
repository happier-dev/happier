import { z } from "zod";
import {
    isConnectedServiceAccountGroupConfigurationSupported,
    isConnectedServiceRuntimeFallbackSupported,
} from "@happier-dev/agents";
import {
    ConnectedServiceIdSchema,
    readConnectedServiceManualActiveProfileRuntimeBlocker,
    type ConnectedServiceId,
    type QualifiedConnectedAccountGroupV4,
} from "@happier-dev/protocol";

import type { Fastify } from "../../../types";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import {
    createQualifiedConnectedAccountGroup,
    createQualifiedConnectedAccountGroupMember,
    deleteQualifiedConnectedAccountGroup,
    deleteQualifiedConnectedAccountGroupMember,
    listQualifiedConnectedAccountGroups,
    patchQualifiedConnectedAccountGroup,
    patchQualifiedConnectedAccountGroupRuntimeState,
    readQualifiedConnectedAccountGroupForLegacyV3Mutation,
    readQualifiedConnectedAccountGroupForLegacyProjection,
    setQualifiedConnectedAccountGroupActiveAccount,
    updateQualifiedConnectedAccountGroupMember,
    type QualifiedConnectedAccountGroupMutationResult,
} from "../qualifiedConnectedAccounts/groupRepository";
import {
    resolveLegacyQualifiedConnectedAccountService,
} from "../qualifiedConnectedAccounts/identity";
import {
    DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
    ConnectedServiceAuthGroupPolicyPatchSchema,
    mergeConnectedServiceAuthGroupPolicyPatch,
    type ConnectedServiceAuthGroupPolicyPatch,
} from "./authGroupPolicy";
import {
    ActiveProfileBodySchema,
    AuthGroupEnvelopeResponseSchema,
    AuthGroupErrorResponseSchema,
    AuthGroupListResponseSchema,
    AuthGroupMemberInputSchema,
    AuthGroupMemberParamsSchema,
    AuthGroupParamsSchema,
    AuthGroupResponseSchema,
    AuthGroupServiceParamsSchema,
    AuthGroupSuccessResponseSchema,
    CreateAuthGroupBodySchema,
    DeleteAuthGroupMemberQuerySchema,
    RuntimeStatePatchBodySchema,
    UpdateAuthGroupBodySchema,
    UpdateAuthGroupMemberBodySchema,
} from "./authGroupSchemas";

const NotFoundResponseSchema = z.object({ error: z.literal("not_found") });

function fallbackEnabled(): boolean {
    return isServerFeatureEnabledForRequest(
        "connectedServices.accountFallback",
        process.env,
    );
}

function runtimeFallbackSupportedForService(
    serviceId: ConnectedServiceId,
): boolean {
    return isConnectedServiceRuntimeFallbackSupported(serviceId);
}

function groupConfigurationSupportedForService(
    serviceId: ConnectedServiceId,
): boolean {
    return isConnectedServiceAccountGroupConfigurationSupported(serviceId);
}

function requiresFallbackFeature(
    policy: { autoSwitch?: boolean } | undefined,
): boolean {
    return policy?.autoSwitch === true;
}

function parsePolicyPatchForRequest(
    policy: unknown,
): ConnectedServiceAuthGroupPolicyPatch | null | undefined {
    if (policy === undefined) return undefined;
    const parsed = ConnectedServiceAuthGroupPolicyPatchSchema.safeParse(policy);
    return parsed.success ? parsed.data : null;
}

function hasDuplicateProfileIds(
    members: readonly { profileId: string }[],
): boolean {
    return new Set(members.map((member) => member.profileId)).size
        !== members.length;
}

function resolveCreateActiveProfileId(params: Readonly<{
    members: readonly { profileId: string; enabled?: boolean }[];
    requestedActiveProfileId: string | null | undefined;
}>): string | null | "invalid" {
    if (params.requestedActiveProfileId !== undefined) {
        if (params.requestedActiveProfileId === null) return null;
        const member = params.members.find((candidate) =>
            candidate.profileId === params.requestedActiveProfileId);
        return member?.enabled !== false
            ? params.requestedActiveProfileId
            : "invalid";
    }
    return params.members.find((member) => member.enabled !== false)
        ?.profileId ?? null;
}

function projectLegacyGroup(
    group: QualifiedConnectedAccountGroupV4,
    serviceId: ConnectedServiceId,
    activeProfileId: string | null = group.activeConnectedAccountId,
) {
    const service = resolveLegacyQualifiedConnectedAccountService(serviceId);
    if (
        group.ref.service.pluginId !== service.pluginId
        || group.ref.service.localId !== service.localId
    ) {
        throw new Error(
            "Qualified Connected Account group cannot be projected through this legacy service",
        );
    }
    return AuthGroupResponseSchema.parse({
        v: 1,
        serviceId,
        groupId: group.ref.groupId,
        displayName: group.displayName,
        policy: group.policy,
        activeProfileId,
        generation: group.generation,
        runtimeStateRevision: group.runtimeStateRevision,
        state: group.state,
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
        members: group.members.map((member) => ({
            v: 1,
            serviceId,
            groupId: group.ref.groupId,
            profileId: member.connectedAccountId,
            priority: member.priority,
            enabled: member.enabled,
            state: member.state,
            createdAt: member.createdAt,
            updatedAt: member.updatedAt,
        })),
    });
}

async function readLegacyGroup(params: Readonly<{
    accountId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
}>) {
    const projection =
        await readQualifiedConnectedAccountGroupForLegacyProjection({
        accountId: params.accountId,
        service: resolveLegacyQualifiedConnectedAccountService(
            params.serviceId,
        ),
        groupId: params.groupId,
    });
    return projection
        ? projectLegacyGroup(
            projection.group,
            params.serviceId,
            projection.activeProfileId,
        )
        : null;
}

async function readLegacyGroupForMutation(params: Readonly<{
    accountId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
}>) {
    const result =
        await readQualifiedConnectedAccountGroupForLegacyV3Mutation({
            accountId: params.accountId,
            service: resolveLegacyQualifiedConnectedAccountService(
                params.serviceId,
            ),
            groupId: params.groupId,
        });
    if (result.status !== "current") return result;
    return {
        status: "current" as const,
        group: projectLegacyGroup(
            result.group,
            params.serviceId,
            result.activeProfileId,
        ),
    };
}

function generationConflict(
    result: QualifiedConnectedAccountGroupMutationResult,
): number | null {
    return result.status === "generation_superseded"
        ? result.generation
        : null;
}

function runtimeRevisionConflict(
    result: QualifiedConnectedAccountGroupMutationResult,
): number | null {
    return result.status === "superseded"
        ? result.runtimeStateRevision
        : null;
}

export function registerConnectedServiceAuthGroupRoutesV3(app: Fastify): void {
    app.get("/v3/connect/:serviceId/groups", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupServiceParamsSchema,
            response: {
                200: AuthGroupListResponseSchema,
                404: NotFoundResponseSchema,
            },
        },
    }, async (request, reply) => {
        const serviceId =
            ConnectedServiceIdSchema.parse(request.params.serviceId);
        const groups = await listQualifiedConnectedAccountGroups({
            accountId: request.userId,
            service:
                resolveLegacyQualifiedConnectedAccountService(serviceId),
        });
        return reply.send({
            groups: groups.map((group) =>
                projectLegacyGroup(group, serviceId)),
        });
    });

    app.post("/v3/connect/:serviceId/groups", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupServiceParamsSchema,
            body: CreateAuthGroupBodySchema,
            response: {
                200: AuthGroupEnvelopeResponseSchema,
                400: AuthGroupErrorResponseSchema,
                404: z.union([
                    NotFoundResponseSchema,
                    AuthGroupErrorResponseSchema,
                ]),
                409: AuthGroupErrorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const accountId = request.userId;
        const serviceId =
            ConnectedServiceIdSchema.parse(request.params.serviceId);
        const body = request.body;
        const policyPatch = parsePolicyPatchForRequest(body.policy);
        if (policyPatch === null) {
            return reply.code(400).send({
                error: "connect_group_invalid",
            });
        }
        if (hasDuplicateProfileIds(body.members)) {
            return reply.code(400).send({
                error: "connect_group_duplicate_member",
            });
        }
        if (!groupConfigurationSupportedForService(serviceId)) {
            return reply.code(400).send({
                error: "connect_group_runtime_fallback_unsupported",
            });
        }
        if (requiresFallbackFeature(policyPatch) && !fallbackEnabled()) {
            return reply.code(400).send({
                error: "connect_group_fallback_disabled",
            });
        }
        if (
            policyPatch?.autoSwitch === true
            && !runtimeFallbackSupportedForService(serviceId)
        ) {
            return reply.code(400).send({
                error: "connect_group_runtime_fallback_unsupported",
            });
        }
        const activeProfileId = resolveCreateActiveProfileId({
            members: body.members,
            requestedActiveProfileId: body.activeProfileId,
        });
        if (activeProfileId === "invalid") {
            return reply.code(400).send({
                error: "connect_group_active_profile_not_member",
            });
        }
        const effectivePolicyPatch: ConnectedServiceAuthGroupPolicyPatch = {
            ...policyPatch,
            autoSwitch:
                policyPatch?.autoSwitch
                ?? (
                    fallbackEnabled()
                    && runtimeFallbackSupportedForService(serviceId)
                ),
        };
        const policy = mergeConnectedServiceAuthGroupPolicyPatch(
            DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1,
            effectivePolicyPatch,
        );
        const service =
            resolveLegacyQualifiedConnectedAccountService(serviceId);
        const result = await createQualifiedConnectedAccountGroup({
            accountId,
            service,
            group: {
                groupId: body.groupId,
                displayName: body.displayName,
                policy,
            },
            initialMembers: body.members.map((member) => ({
                connectedAccountId: member.profileId,
                priority: member.priority,
                enabled: member.enabled,
            })),
            activeConnectedAccountId: activeProfileId,
            legacyV3Mutation: true,
        });
        if (result.status === "incarnation_superseded") {
            return reply.code(409).send({
                error: "connect_group_incarnation_conflict",
            });
        }
        if (result.status === "already_exists") {
            return reply.code(409).send({
                error: "connect_group_already_exists",
            });
        }
        if (result.status === "member_not_found") {
            return reply.code(400).send({
                error: "connect_group_member_profile_not_found",
            });
        }
        if (result.status === "member_disabled") {
            return reply.code(400).send({
                error: "connect_group_active_profile_not_member",
            });
        }
        if (result.status !== "written") {
            throw new Error(
                `Unexpected qualified group create result: ${result.status}`,
            );
        }
        return reply.send({
            group: projectLegacyGroup(result.group, serviceId),
        });
    });

    app.get("/v3/connect/:serviceId/groups/:groupId", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupParamsSchema,
            response: {
                200: AuthGroupEnvelopeResponseSchema,
                404: z.union([
                    NotFoundResponseSchema,
                    AuthGroupErrorResponseSchema,
                ]),
            },
        },
    }, async (request, reply) => {
        const serviceId =
            ConnectedServiceIdSchema.parse(request.params.serviceId);
        const group = await readLegacyGroup({
            accountId: request.userId,
            serviceId,
            groupId: request.params.groupId,
        });
        if (!group) {
            return reply.code(404).send({
                error: "connect_group_not_found",
            });
        }
        return reply.send({ group });
    });

    app.patch("/v3/connect/:serviceId/groups/:groupId", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupParamsSchema,
            body: UpdateAuthGroupBodySchema,
            response: {
                200: AuthGroupEnvelopeResponseSchema,
                400: AuthGroupErrorResponseSchema,
                404: z.union([
                    NotFoundResponseSchema,
                    AuthGroupErrorResponseSchema,
                ]),
                409: AuthGroupErrorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const serviceId =
            ConnectedServiceIdSchema.parse(request.params.serviceId);
        const groupId = request.params.groupId;
        const legacyMutation = await readLegacyGroupForMutation({
            accountId: request.userId,
            serviceId,
            groupId,
        });
        if (legacyMutation.status === "incarnation_superseded") {
            return reply.code(409).send({
                error: "connect_group_incarnation_conflict",
            });
        }
        if (legacyMutation.status === "not_found") {
            return reply.code(404).send({
                error: "connect_group_not_found",
            });
        }
        const current = legacyMutation.group;
        const policyPatch = parsePolicyPatchForRequest(request.body.policy);
        if (policyPatch === null) {
            return reply.code(400).send({
                error: "connect_group_invalid",
            });
        }
        const policy = mergeConnectedServiceAuthGroupPolicyPatch(
            current.policy,
            policyPatch,
        );
        if (
            (
                request.body.activeProfileId !== undefined
                || policyPatch?.autoSwitch !== undefined
            )
            && !runtimeFallbackSupportedForService(serviceId)
        ) {
            return reply.code(400).send({
                error: "connect_group_runtime_fallback_unsupported",
            });
        }
        if (requiresFallbackFeature(policyPatch) && !fallbackEnabled()) {
            return reply.code(400).send({
                error: "connect_group_fallback_disabled",
            });
        }
        if (
            request.body.activeProfileId !== undefined
            && !fallbackEnabled()
        ) {
            return reply.code(400).send({
                error: "connect_group_fallback_disabled",
            });
        }
        const generationSensitive =
            request.body.activeProfileId !== undefined
            || request.body.policy !== undefined;
        if (
            generationSensitive
            && request.body.expectedGeneration === undefined
        ) {
            return reply.code(400).send({
                error: "connect_group_generation_required",
            });
        }
        if (
            request.body.activeProfileId !== undefined
            && request.body.activeProfileId !== null
        ) {
            const member = current.members.find((candidate) =>
                candidate.profileId === request.body.activeProfileId
                && candidate.enabled);
            if (!member) {
                return reply.code(400).send({
                    error: "connect_group_active_profile_not_member",
                });
            }
            const blocker =
                readConnectedServiceManualActiveProfileRuntimeBlocker(
                    member.state,
                    Date.now(),
                );
            if (
                blocker !== null
                && request.body.overrideRuntimeCooldown !== true
            ) {
                return reply.code(409).send({
                    error: "connect_group_profile_runtime_cooldown",
                    ...blocker,
                });
            }
        }
        if (
            generationSensitive
            && request.body.expectedGeneration !== current.generation
        ) {
            return reply.code(409).send({
                error: "connect_group_generation_conflict",
                generation: current.generation,
            });
        }
        const result = await patchQualifiedConnectedAccountGroup({
            accountId: request.userId,
            patch: {
                service:
                    resolveLegacyQualifiedConnectedAccountService(
                        serviceId,
                    ),
                groupId,
                ...(request.body.displayName !== undefined
                    ? { displayName: request.body.displayName }
                    : {}),
                ...(request.body.policy !== undefined ? { policy } : {}),
                ...(request.body.overrideRuntimeCooldown !== undefined
                    ? {
                        overrideRuntimeCooldown:
                            request.body.overrideRuntimeCooldown,
                    }
                    : {}),
            },
            ...(request.body.expectedGeneration !== undefined
                ? {
                    expectedGeneration:
                        request.body.expectedGeneration,
                }
                : {}),
            ...(request.body.activeProfileId !== undefined
                ? {
                    activeConnectedAccountId:
                        request.body.activeProfileId,
                }
                : {}),
            preserveLegacyNoopSemantics: true,
        });
        if (result.status === "not_found") {
            return reply.code(404).send({
                error: "connect_group_not_found",
            });
        }
        if (result.status === "incarnation_superseded") {
            return reply.code(409).send({
                error: "connect_group_incarnation_conflict",
            });
        }
        if (
            result.status === "member_not_found"
            || result.status === "member_disabled"
        ) {
            return reply.code(400).send({
                error: "connect_group_active_profile_not_member",
            });
        }
        if (result.status === "runtime_cooldown") {
            return reply.code(409).send({
                error: "connect_group_profile_runtime_cooldown",
                ...(result.resetAtMs !== undefined
                    ? { resetAtMs: result.resetAtMs }
                    : {}),
            });
        }
        const generation = generationConflict(result);
        if (generation !== null) {
            return reply.code(409).send({
                error: "connect_group_generation_conflict",
                generation,
            });
        }
        const runtimeStateRevision = runtimeRevisionConflict(result);
        if (runtimeStateRevision !== null) {
            return reply.code(409).send({
                error: "connect_group_runtime_state_revision_conflict",
                runtimeStateRevision,
            });
        }
        if (result.status !== "written") {
            throw new Error(
                `Unexpected qualified group patch result: ${result.status}`,
            );
        }
        const projected = await readLegacyGroup({
            accountId: request.userId,
            serviceId,
            groupId,
        });
        if (!projected) {
            return reply.code(404).send({
                error: "connect_group_not_found",
            });
        }
        return reply.send({ group: projected });
    });

    app.delete("/v3/connect/:serviceId/groups/:groupId", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupParamsSchema,
            response: {
                200: AuthGroupSuccessResponseSchema,
                404: z.union([
                    NotFoundResponseSchema,
                    AuthGroupErrorResponseSchema,
                ]),
                409: AuthGroupErrorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const serviceId =
            ConnectedServiceIdSchema.parse(request.params.serviceId);
        const result = await deleteQualifiedConnectedAccountGroup({
            accountId: request.userId,
            service:
                resolveLegacyQualifiedConnectedAccountService(serviceId),
            groupId: request.params.groupId,
        });
        if (result.status === "not_found") {
            return reply.code(404).send({
                error: "connect_group_not_found",
            });
        }
        if (result.status === "incarnation_superseded") {
            return reply.code(409).send({
                error: "connect_group_incarnation_conflict",
            });
        }
        const generation = generationConflict(result);
        if (generation !== null) {
            return reply.code(409).send({
                error: "connect_group_generation_conflict",
                generation,
            });
        }
        const runtimeStateRevision = runtimeRevisionConflict(result);
        if (runtimeStateRevision !== null) {
            return reply.code(409).send({
                error: "connect_group_runtime_state_revision_conflict",
                runtimeStateRevision,
            });
        }
        if (result.status !== "deleted") {
            throw new Error(
                `Unexpected qualified group delete result: ${result.status}`,
            );
        }
        return reply.send({ success: true });
    });

    app.patch("/v3/connect/:serviceId/groups/:groupId/runtime-state", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupParamsSchema,
            body: RuntimeStatePatchBodySchema,
            response: {
                200: AuthGroupEnvelopeResponseSchema,
                400: AuthGroupErrorResponseSchema,
                404: z.union([
                    NotFoundResponseSchema,
                    AuthGroupErrorResponseSchema,
                ]),
                409: AuthGroupErrorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const serviceId =
            ConnectedServiceIdSchema.parse(request.params.serviceId);
        const groupId = request.params.groupId;
        const legacyMutation = await readLegacyGroupForMutation({
            accountId: request.userId,
            serviceId,
            groupId,
        });
        if (legacyMutation.status === "incarnation_superseded") {
            return reply.code(409).send({
                error: "connect_group_incarnation_conflict",
            });
        }
        if (legacyMutation.status === "not_found") {
            return reply.code(404).send({
                error: "connect_group_not_found",
            });
        }
        const current = legacyMutation.group;
        if (
            request.body.expectedGeneration !== undefined
            && request.body.expectedGeneration !== current.generation
        ) {
            return reply.code(409).send({
                error: "connect_group_generation_conflict",
                generation: current.generation,
            });
        }
        const membersByProfileId = new Map(
            current.members.map((member) => [member.profileId, member]),
        );
        if (request.body.memberStates.some((member) =>
            !membersByProfileId.has(member.profileId))) {
            return reply.code(400).send({
                error: "connect_group_member_not_found",
            });
        }
        const changedMemberStates = request.body.memberStates.filter(
            (member) =>
                JSON.stringify(
                    membersByProfileId.get(member.profileId)?.state,
                ) !== JSON.stringify(member.state),
        );
        const groupStateChanged =
            request.body.state !== undefined
            && JSON.stringify(current.state)
                !== JSON.stringify(request.body.state);
        const runtimeStateChanged =
            groupStateChanged || changedMemberStates.length > 0;
        if (
            runtimeStateChanged
            && request.body.expectedGeneration === undefined
        ) {
            return reply.code(400).send({
                error: "connect_group_generation_required",
            });
        }
        if (
            runtimeStateChanged
            && request.body.expectedRuntimeStateRevision === undefined
        ) {
            return reply.code(400).send({
                error: "connect_group_runtime_state_revision_required",
            });
        }
        if (!runtimeStateChanged) {
            return reply.send({ group: current });
        }
        const result =
            await patchQualifiedConnectedAccountGroupRuntimeState({
                accountId: request.userId,
                patch: {
                    service:
                        resolveLegacyQualifiedConnectedAccountService(
                            serviceId,
                        ),
                    groupId,
                    expectedRuntimeStateRevision:
                        request.body.expectedRuntimeStateRevision,
                    runtimeState: {
                        ...(groupStateChanged
                            ? { state: request.body.state }
                            : {}),
                        memberStates: changedMemberStates.map((member) => ({
                            connectedAccountId: member.profileId,
                            state: member.state,
                        })),
                    },
                },
                expectedGeneration: request.body.expectedGeneration,
            });
        if (result.status === "not_found") {
            return reply.code(404).send({
                error: "connect_group_not_found",
            });
        }
        if (result.status === "incarnation_superseded") {
            return reply.code(409).send({
                error: "connect_group_incarnation_conflict",
            });
        }
        if (result.status === "member_not_found") {
            return reply.code(400).send({
                error: "connect_group_member_not_found",
            });
        }
        const generation = generationConflict(result);
        if (generation !== null) {
            return reply.code(409).send({
                error: "connect_group_generation_conflict",
                generation,
            });
        }
        const runtimeStateRevision = runtimeRevisionConflict(result);
        if (runtimeStateRevision !== null) {
            return reply.code(409).send({
                error: "connect_group_runtime_state_revision_conflict",
                runtimeStateRevision,
            });
        }
        if (result.status !== "written") {
            throw new Error(
                `Unexpected qualified group runtime result: ${result.status}`,
            );
        }
        return reply.send({
            group: projectLegacyGroup(result.group, serviceId),
        });
    });

    app.post("/v3/connect/:serviceId/groups/:groupId/members", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupParamsSchema,
            body: AuthGroupMemberInputSchema,
            response: {
                200: AuthGroupEnvelopeResponseSchema,
                400: AuthGroupErrorResponseSchema,
                404: z.union([
                    NotFoundResponseSchema,
                    AuthGroupErrorResponseSchema,
                ]),
                409: AuthGroupErrorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const serviceId =
            ConnectedServiceIdSchema.parse(request.params.serviceId);
        if (request.body.expectedGeneration === undefined) {
            return reply.code(400).send({
                error: "connect_group_generation_required",
            });
        }
        const result = await createQualifiedConnectedAccountGroupMember({
            accountId: request.userId,
            mutation: {
                group: {
                    service:
                        resolveLegacyQualifiedConnectedAccountService(
                            serviceId,
                        ),
                    groupId: request.params.groupId,
                },
                connectedAccountId: request.body.profileId,
                priority: request.body.priority ?? 100,
                enabled: request.body.enabled ?? true,
            },
            expectedGeneration: request.body.expectedGeneration,
            activateWhenGroupHasNoLegacyActiveAccount: true,
        });
        if (result.status === "not_found") {
            return reply.code(404).send({
                error: "connect_group_not_found",
            });
        }
        if (result.status === "incarnation_superseded") {
            return reply.code(409).send({
                error: "connect_group_incarnation_conflict",
            });
        }
        if (result.status === "member_not_found") {
            return reply.code(400).send({
                error: "connect_group_member_profile_not_found",
            });
        }
        if (result.status === "already_exists") {
            return reply.code(409).send({
                error: "connect_group_member_already_exists",
            });
        }
        const generation = generationConflict(result);
        if (generation !== null) {
            return reply.code(409).send({
                error: "connect_group_generation_conflict",
                generation,
            });
        }
        if (result.status !== "written") {
            throw new Error(
                `Unexpected qualified member create result: ${result.status}`,
            );
        }
        return reply.send({
            group: projectLegacyGroup(result.group, serviceId),
        });
    });

    app.patch(
        "/v3/connect/:serviceId/groups/:groupId/members/:profileId",
        {
            preHandler: app.authenticate,
            schema: {
                params: AuthGroupMemberParamsSchema,
                body: UpdateAuthGroupMemberBodySchema,
                response: {
                    200: AuthGroupEnvelopeResponseSchema,
                    400: AuthGroupErrorResponseSchema,
                    404: z.union([
                        NotFoundResponseSchema,
                        AuthGroupErrorResponseSchema,
                    ]),
                    409: AuthGroupErrorResponseSchema,
                },
            },
        },
        async (request, reply) => {
            const serviceId =
                ConnectedServiceIdSchema.parse(request.params.serviceId);
            if (request.body.expectedGeneration === undefined) {
                return reply.code(400).send({
                    error: "connect_group_generation_required",
                });
            }
            const legacyMutation = await readLegacyGroupForMutation({
                accountId: request.userId,
                serviceId,
                groupId: request.params.groupId,
            });
            if (legacyMutation.status === "incarnation_superseded") {
                return reply.code(409).send({
                    error: "connect_group_incarnation_conflict",
                });
            }
            if (legacyMutation.status === "not_found") {
                return reply.code(404).send({
                    error: "connect_group_member_not_found",
                });
            }
            const current = legacyMutation.group;
            if (
                request.body.expectedGeneration !== current.generation
            ) {
                return reply.code(409).send({
                    error: "connect_group_generation_conflict",
                    generation: current.generation,
                });
            }
            const member = current.members.find((candidate) =>
                candidate.profileId === request.params.profileId);
            if (!member) {
                return reply.code(404).send({
                    error: "connect_group_member_not_found",
                });
            }
            const changed =
                (
                    request.body.priority !== undefined
                    && request.body.priority !== member.priority
                )
                || (
                    request.body.enabled !== undefined
                    && request.body.enabled !== member.enabled
                );
            if (!changed) return reply.send({ group: current });
            const result =
                await updateQualifiedConnectedAccountGroupMember({
                    accountId: request.userId,
                    mutation: {
                        group: {
                            service:
                                resolveLegacyQualifiedConnectedAccountService(
                                    serviceId,
                                ),
                            groupId: request.params.groupId,
                        },
                        connectedAccountId: request.params.profileId,
                        ...(request.body.priority !== undefined
                            ? { priority: request.body.priority }
                            : {}),
                        ...(request.body.enabled !== undefined
                            ? { enabled: request.body.enabled }
                            : {}),
                    },
                    expectedGeneration:
                        request.body.expectedGeneration,
                });
            if (
                result.status === "not_found"
                || result.status === "member_not_found"
            ) {
                return reply.code(404).send({
                    error: "connect_group_member_not_found",
                });
            }
            if (result.status === "incarnation_superseded") {
                return reply.code(409).send({
                    error: "connect_group_incarnation_conflict",
                });
            }
            const generation = generationConflict(result);
            if (generation !== null) {
                return reply.code(409).send({
                    error: "connect_group_generation_conflict",
                    generation,
                });
            }
            if (result.status !== "written") {
                throw new Error(
                    `Unexpected qualified member patch result: ${result.status}`,
                );
            }
            return reply.send({
                group: projectLegacyGroup(result.group, serviceId),
            });
        },
    );

    app.delete(
        "/v3/connect/:serviceId/groups/:groupId/members/:profileId",
        {
            preHandler: app.authenticate,
            schema: {
                params: AuthGroupMemberParamsSchema,
                querystring: DeleteAuthGroupMemberQuerySchema,
                response: {
                    200: AuthGroupEnvelopeResponseSchema,
                    400: AuthGroupErrorResponseSchema,
                    404: z.union([
                        NotFoundResponseSchema,
                        AuthGroupErrorResponseSchema,
                    ]),
                    409: AuthGroupErrorResponseSchema,
                },
            },
        },
        async (request, reply) => {
            const serviceId =
                ConnectedServiceIdSchema.parse(request.params.serviceId);
            if (request.query.expectedGeneration === undefined) {
                return reply.code(400).send({
                    error: "connect_group_generation_required",
                });
            }
            const result =
                await deleteQualifiedConnectedAccountGroupMember({
                    accountId: request.userId,
                    mutation: {
                        group: {
                            service:
                                resolveLegacyQualifiedConnectedAccountService(
                                    serviceId,
                                ),
                            groupId: request.params.groupId,
                        },
                        connectedAccountId: request.params.profileId,
                    },
                    expectedGeneration:
                        request.query.expectedGeneration,
                });
            if (
                result.status === "not_found"
                || result.status === "member_not_found"
            ) {
                return reply.code(404).send({
                    error: "connect_group_member_not_found",
                });
            }
            if (result.status === "incarnation_superseded") {
                return reply.code(409).send({
                    error: "connect_group_incarnation_conflict",
                });
            }
            const generation = generationConflict(result);
            if (generation !== null) {
                return reply.code(409).send({
                    error: "connect_group_generation_conflict",
                    generation,
                });
            }
            if (result.status !== "written") {
                throw new Error(
                    `Unexpected qualified member delete result: ${result.status}`,
                );
            }
            return reply.send({
                group: projectLegacyGroup(result.group, serviceId),
            });
        },
    );

    app.post("/v3/connect/:serviceId/groups/:groupId/active-profile", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupParamsSchema,
            body: ActiveProfileBodySchema,
            response: {
                200: AuthGroupEnvelopeResponseSchema,
                400: AuthGroupErrorResponseSchema,
                404: z.union([
                    NotFoundResponseSchema,
                    AuthGroupErrorResponseSchema,
                ]),
                409: AuthGroupErrorResponseSchema,
            },
        },
    }, async (request, reply) => {
        const serviceId =
            ConnectedServiceIdSchema.parse(request.params.serviceId);
        if (!runtimeFallbackSupportedForService(serviceId)) {
            return reply.code(400).send({
                error: "connect_group_runtime_fallback_unsupported",
            });
        }
        if (!fallbackEnabled()) {
            return reply.code(400).send({
                error: "connect_group_fallback_disabled",
            });
        }
        if (request.body.expectedGeneration === undefined) {
            return reply.code(400).send({
                error: "connect_group_generation_required",
            });
        }
        const legacyMutation = await readLegacyGroupForMutation({
            accountId: request.userId,
            serviceId,
            groupId: request.params.groupId,
        });
        if (legacyMutation.status === "incarnation_superseded") {
            return reply.code(409).send({
                error: "connect_group_incarnation_conflict",
            });
        }
        if (legacyMutation.status === "not_found") {
            return reply.code(404).send({
                error: "connect_group_not_found",
            });
        }
        const current = legacyMutation.group;
        const member = current.members.find((candidate) =>
            candidate.profileId === request.body.profileId
            && candidate.enabled);
        if (!member) {
            return reply.code(400).send({
                error: "connect_group_active_profile_not_member",
            });
        }
        const blocker =
            readConnectedServiceManualActiveProfileRuntimeBlocker(
                member.state,
                Date.now(),
            );
        if (
            blocker !== null
            && request.body.overrideRuntimeCooldown !== true
        ) {
            return reply.code(409).send({
                error: "connect_group_profile_runtime_cooldown",
                ...blocker,
            });
        }
        if (request.body.expectedGeneration !== current.generation) {
            return reply.code(409).send({
                error: "connect_group_generation_conflict",
                generation: current.generation,
            });
        }
        if (current.activeProfileId === request.body.profileId) {
            return reply.send({ group: current });
        }
        const result =
            await setQualifiedConnectedAccountGroupActiveAccount({
                accountId: request.userId,
                mutation: {
                    group: {
                        service:
                            resolveLegacyQualifiedConnectedAccountService(
                                serviceId,
                            ),
                        groupId: request.params.groupId,
                    },
                    connectedAccountId: request.body.profileId,
                    expectedGeneration:
                        request.body.expectedGeneration,
                    overrideRuntimeCooldown:
                        request.body.overrideRuntimeCooldown,
                },
            });
        if (result.status === "not_found") {
            return reply.code(404).send({
                error: "connect_group_not_found",
            });
        }
        if (result.status === "incarnation_superseded") {
            return reply.code(409).send({
                error: "connect_group_incarnation_conflict",
            });
        }
        if (
            result.status === "member_not_found"
            || result.status === "member_disabled"
        ) {
            return reply.code(400).send({
                error: "connect_group_active_profile_not_member",
            });
        }
        if (result.status === "runtime_cooldown") {
            return reply.code(409).send({
                error: "connect_group_profile_runtime_cooldown",
                ...(result.resetAtMs !== undefined
                    ? { resetAtMs: result.resetAtMs }
                    : {}),
            });
        }
        const generation = generationConflict(result);
        if (generation !== null) {
            return reply.code(409).send({
                error: "connect_group_generation_conflict",
                generation,
            });
        }
        if (result.status !== "written") {
            throw new Error(
                `Unexpected qualified active-account result: ${result.status}`,
            );
        }
        return reply.send({
            group: projectLegacyGroup(result.group, serviceId),
        });
    });
}
