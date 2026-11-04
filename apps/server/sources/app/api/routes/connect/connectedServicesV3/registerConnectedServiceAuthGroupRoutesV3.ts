import { z } from "zod";
import {
    isConnectedServiceAccountGroupConfigurationSupported,
    isConnectedServiceRuntimeFallbackSupported,
    resolveConnectedServiceRuntimeFallbackCapability,
} from "@happier-dev/agents";
import {
    ConnectedServiceIdSchema,
    CONNECTED_SERVICE_AUTO_QUOTA_RESET_HEADER,
    CONNECTED_SERVICE_AUTO_QUOTA_RESET_HEADER_VALUE,
    CONNECTED_SERVICE_AUTO_DISABLE_PLAN_INVALID_QUERY_KEY,
    CONNECTED_SERVICE_POOL_QUOTA_LIMIT_SELECTION_QUERY_KEY,
    CONNECTED_SERVICE_POOL_EXPIRY_FIRST_QUERY_KEY,
    CONNECTED_SERVICE_CLAUDE_AUTO_CONTINUE_QUERY_KEY,
    CONNECTED_SERVICE_AUTH_GROUP_READER_CAPABILITY_QUERY_VALUE,
    CONNECTED_SERVICE_AUTH_GROUP_SWITCH_REASON_HEADER,
    type ConnectedServiceAuthGroupV1,
    type ConnectedServiceAuthGroupReaderCapabilitiesQueryV1,
    readConnectedServiceManualActiveProfileRuntimeBlocker,
    type ConnectedServiceManualActiveProfileRuntimeBlocker,
} from "@happier-dev/protocol";

import type { Fastify } from "../../../types";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import { recordConnectedServiceAccountProfileChange } from "../connectedServicesAccountProfileChange";
import { deleteConnectedServiceUsageSourcesForGroup } from "../providerAccountUsage";
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
    ConnectedServiceAuthGroupMemberStateSchema,
    ConnectedServiceAuthGroupStateSchema,
    AuthGroupListResponseSchema,
    AuthGroupMemberInputSchema,
    AuthGroupMemberParamsSchema,
    AuthGroupParamsSchema,
    AuthGroupReaderCapabilitiesQuerySchema,
    AuthGroupServiceParamsSchema,
    AuthGroupSuccessResponseSchema,
    CreateAuthGroupBodySchema,
    DeleteAuthGroupMemberQuerySchema,
    RuntimeStatePatchBodySchema,
    UpdateAuthGroupBodySchema,
    UpdateAuthGroupMemberBodySchema,
} from "./authGroupSchemas";
import {
    createAuthGroupMemberAndBumpGenerationInTx,
    deleteAuthGroupMemberAndBumpGenerationInTx,
    encodePolicyForStorage,
    encodeAuthGroupStateForActiveProfile,
    findAuthGroupForAccount,
    findAuthGroupWithStoredActiveProfileForAccount,
    hasConnectedServiceProfile,
    listAuthGroupsForAccount,
    stringifyAuthGroupMemberState,
    stringifyAuthGroupState,
    updateAuthGroupMemberAndBumpGenerationInTx,
} from "./authGroupRepository";

const NotFoundResponseSchema = z.object({ error: z.literal("not_found") });
type AuthGroupEnvelopeResponse = z.infer<typeof AuthGroupEnvelopeResponseSchema>;
type ConnectedServiceAuthGroupState = z.infer<typeof ConnectedServiceAuthGroupStateSchema>;
type ConnectedServiceAuthGroupMemberState = z.infer<typeof ConnectedServiceAuthGroupMemberStateSchema>;
type ManualActiveProfileRuntimeBlocker = ConnectedServiceManualActiveProfileRuntimeBlocker;

function isUniqueConflict(error: unknown): boolean {
    return isPrismaErrorCode(error, "P2002");
}

function isForeignKeyConflict(error: unknown): boolean {
    return isPrismaErrorCode(error, "P2003");
}

function fallbackEnabled(): boolean {
    return isServerFeatureEnabledForRequest("connectedServices.accountFallback", process.env);
}

function requiresFallbackFeature(policy: { autoSwitch?: boolean } | undefined): boolean {
    return policy?.autoSwitch === true;
}

function groupConfigurationSupportedForService(serviceId: string): boolean {
    const parsed = ConnectedServiceIdSchema.safeParse(serviceId);
    return parsed.success && isConnectedServiceAccountGroupConfigurationSupported(parsed.data);
}

function runtimeFallbackSupportedForService(serviceId: string): boolean {
    const parsed = ConnectedServiceIdSchema.safeParse(serviceId);
    return parsed.success && isConnectedServiceRuntimeFallbackSupported(parsed.data);
}

function parsePolicyPatchForRequest(policy: unknown, serviceId: string): ConnectedServiceAuthGroupPolicyPatch | null | undefined {
    if (policy === undefined) return undefined;
    const parsed = ConnectedServiceAuthGroupPolicyPatchSchema.safeParse(policy);
    if (parsed.success && parsed.data.autoUseQuotaResetsWhenExhausted === true) {
        const service = ConnectedServiceIdSchema.safeParse(serviceId);
        if (!service.success
            || !resolveConnectedServiceRuntimeFallbackCapability(service.data).quotaResetSupported
            || !isServerFeatureEnabledForRequest("connectedServices.autoQuotaReset", process.env)) return null;
    }
    if (parsed.success && parsed.data.autoDisablePlanInvalidAccounts === true
        && !isServerFeatureEnabledForRequest("connectedServices.autoDisablePlanInvalid", process.env)) return null;
    if (parsed.success && parsed.data.quotaLimitSelection !== undefined
        && !isServerFeatureEnabledForRequest("connectedServices.poolQuotaLimitSelection", process.env)) return null;
    if (parsed.success && parsed.data.strategy === 'expiry_first'
        && !isServerFeatureEnabledForRequest("connectedServices.poolExpiryFirst", process.env)) return null;
    return parsed.success ? parsed.data : null;
}

function parseMemberRuntimeStateJson(stateJson: string | null): ConnectedServiceAuthGroupMemberState {
    if (!stateJson) return ConnectedServiceAuthGroupMemberStateSchema.parse({});
    try {
        const parsed = ConnectedServiceAuthGroupMemberStateSchema.safeParse(JSON.parse(stateJson));
        return parsed.success ? parsed.data : ConnectedServiceAuthGroupMemberStateSchema.parse({});
    } catch {
        return ConnectedServiceAuthGroupMemberStateSchema.parse({});
    }
}

function parseGroupRuntimeStateJson(stateJson: string | null): ConnectedServiceAuthGroupState {
    if (!stateJson) return ConnectedServiceAuthGroupStateSchema.parse({});
    try {
        const parsed = ConnectedServiceAuthGroupStateSchema.safeParse(JSON.parse(stateJson));
        return parsed.success ? parsed.data : ConnectedServiceAuthGroupStateSchema.parse({});
    } catch {
        return ConnectedServiceAuthGroupStateSchema.parse({});
    }
}

function hasRuntimeStateChanged<T>(current: T, next: T): boolean {
    return JSON.stringify(current) !== JSON.stringify(next);
}

function hasGroupRuntimeStateChanged(
    stateJson: string | null,
    nextState: ConnectedServiceAuthGroupState,
): boolean {
    return hasRuntimeStateChanged(
        parseGroupRuntimeStateJson(stateJson),
        ConnectedServiceAuthGroupStateSchema.parse(nextState),
    );
}

function hasMemberRuntimeStateChanged(
    stateJson: string | null,
    nextState: ConnectedServiceAuthGroupMemberState,
): boolean {
    return hasRuntimeStateChanged(
        parseMemberRuntimeStateJson(stateJson),
        ConnectedServiceAuthGroupMemberStateSchema.parse(nextState),
    );
}

function readManualActiveProfileRuntimeBlockerFromState(
    state: ConnectedServiceAuthGroupMemberState,
    nowMs: number,
): ManualActiveProfileRuntimeBlocker | null {
    return readConnectedServiceManualActiveProfileRuntimeBlocker(state, nowMs);
}

function readManualActiveProfileRuntimeBlocker(stateJson: string | null, nowMs: number): ManualActiveProfileRuntimeBlocker | null {
    return readManualActiveProfileRuntimeBlockerFromState(parseMemberRuntimeStateJson(stateJson), nowMs);
}

function buildManualActiveProfileRuntimeBlockerResponse(blocker: ManualActiveProfileRuntimeBlocker) {
    return {
        error: "connect_group_profile_runtime_cooldown" as const,
        ...(blocker.resetAtMs === undefined ? {} : { resetAtMs: blocker.resetAtMs }),
    };
}

async function allProfilesExist(params: {
    accountId: string;
    serviceId: string;
    profileIds: readonly string[];
}): Promise<boolean> {
    for (const profileId of params.profileIds) {
        const exists = await hasConnectedServiceProfile({ ...params, profileId });
        if (!exists) return false;
    }
    return true;
}

function hasDuplicateProfileIds(members: readonly { profileId: string }[]): boolean {
    return new Set(members.map((member) => member.profileId)).size !== members.length;
}

function resolveCreateActiveProfileId(params: {
    members: readonly { profileId: string; enabled?: boolean }[];
    requestedActiveProfileId: string | null | undefined;
}): string | null | "invalid" {
    if (params.requestedActiveProfileId !== undefined && params.requestedActiveProfileId !== null) {
        const requestedMember = params.members.find((member) => member.profileId === params.requestedActiveProfileId);
        return requestedMember?.enabled !== false ? params.requestedActiveProfileId : "invalid";
    }
    return params.members.find((member) => member.enabled !== false)?.profileId ?? null;
}

function resolveStoredActiveProfileMutation(params: {
    storedActiveProfileId: string | null;
    requestedActiveProfileId: string | null;
}): { nextActiveProfileId: string | null; changesActiveProfile: boolean } {
    return {
        nextActiveProfileId: params.requestedActiveProfileId,
        changesActiveProfile: params.storedActiveProfileId !== params.requestedActiveProfileId,
    };
}

function canReadAutomaticQuotaResetPolicy(headers: Record<string, string | string[] | undefined>): boolean {
    return headers[CONNECTED_SERVICE_AUTO_QUOTA_RESET_HEADER] === CONNECTED_SERVICE_AUTO_QUOTA_RESET_HEADER_VALUE
        && isServerFeatureEnabledForRequest("connectedServices.autoQuotaReset", process.env);
}

function canReadAutomaticPlanInvalidDisablePolicy(query: ConnectedServiceAuthGroupReaderCapabilitiesQueryV1): boolean {
    return query[CONNECTED_SERVICE_AUTO_DISABLE_PLAN_INVALID_QUERY_KEY] === CONNECTED_SERVICE_AUTH_GROUP_READER_CAPABILITY_QUERY_VALUE
        && isServerFeatureEnabledForRequest("connectedServices.autoDisablePlanInvalid", process.env);
}

function canReadPoolQuotaLimitSelection(query: ConnectedServiceAuthGroupReaderCapabilitiesQueryV1): boolean {
    return query[CONNECTED_SERVICE_POOL_QUOTA_LIMIT_SELECTION_QUERY_KEY] === CONNECTED_SERVICE_AUTH_GROUP_READER_CAPABILITY_QUERY_VALUE
        && isServerFeatureEnabledForRequest("connectedServices.poolQuotaLimitSelection", process.env);
}

function projectAuthGroupForReader(
    group: ConnectedServiceAuthGroupV1,
    reader: Readonly<{
        headers: Record<string, string | string[] | undefined>;
        query: ConnectedServiceAuthGroupReaderCapabilitiesQueryV1;
    }>,
): ConnectedServiceAuthGroupV1 {
    // Released V1 readers are strict. Preserve each negotiated response shape, not a second policy owner.
    let policy = group.policy;
    if (reader.query[CONNECTED_SERVICE_CLAUDE_AUTO_CONTINUE_QUERY_KEY] !== CONNECTED_SERVICE_AUTH_GROUP_READER_CAPABILITY_QUERY_VALUE) {
        const { claudeCodeAutoContinueAtUsageLimit: _claudeAutoContinue, ...projected } = policy;
        policy = projected;
    }
    if (policy.strategy === 'expiry_first'
        && reader.query[CONNECTED_SERVICE_POOL_EXPIRY_FIRST_QUERY_KEY] !== CONNECTED_SERVICE_AUTH_GROUP_READER_CAPABILITY_QUERY_VALUE) {
        policy = { ...policy, strategy: 'least_limited' };
    }
    if (!canReadAutomaticQuotaResetPolicy(reader.headers)) {
        const { autoUseQuotaResetsWhenExhausted: _quotaReset, ...projected } = policy;
        policy = projected;
    }
    if (!canReadAutomaticPlanInvalidDisablePolicy(reader.query)) {
        const { autoDisablePlanInvalidAccounts: _autoDisable, ...projected } = policy;
        policy = projected;
    }
    if (!canReadPoolQuotaLimitSelection(reader.query)) {
        const { quotaLimitSelection: _selection, ...projected } = policy;
        policy = projected;
    } else if (!policy.quotaLimitSelection) {
        policy = { ...policy, quotaLimitSelection: { mode: 'all', providerLimitIds: [] } };
    }
    return { ...group, policy };
}

async function loadGroupEnvelope(params: {
    accountId: string;
    serviceId: string;
    groupId: string;
    headers: Record<string, string | string[] | undefined>;
    query: ConnectedServiceAuthGroupReaderCapabilitiesQueryV1;
}): Promise<AuthGroupEnvelopeResponse | null> {
    const group = await findAuthGroupForAccount(params);
    return group ? { group: projectAuthGroupForReader(group, params) } : null;
}

export function registerConnectedServiceAuthGroupRoutesV3(app: Fastify): void {
    app.get("/v3/connect/:serviceId/groups", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupServiceParamsSchema,
            querystring: AuthGroupReaderCapabilitiesQuerySchema,
            response: { 200: AuthGroupListResponseSchema, 404: NotFoundResponseSchema },
        },
    }, async (request, reply) => {
        const groups = await listAuthGroupsForAccount({
            accountId: request.userId,
            serviceId: request.params.serviceId,
        });
        return reply.send({ groups: groups.map((group) => projectAuthGroupForReader(group, {
            headers: request.headers,
            query: request.query,
        })) });
    });

    app.post("/v3/connect/:serviceId/groups", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupServiceParamsSchema,
            querystring: AuthGroupReaderCapabilitiesQuerySchema,
            body: CreateAuthGroupBodySchema,
            response: { 200: AuthGroupEnvelopeResponseSchema, 400: AuthGroupErrorResponseSchema, 404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]), 409: AuthGroupErrorResponseSchema },
        },
    }, async (request, reply) => {
        const accountId = request.userId;
        const serviceId = request.params.serviceId;
        const body = request.body;
        const members = body.members;
        const policyPatch = parsePolicyPatchForRequest(body.policy, serviceId);

        if (policyPatch === null) {
            return reply.code(400).send({ error: "connect_group_invalid" });
        }

        if (hasDuplicateProfileIds(members)) {
            return reply.code(400).send({ error: "connect_group_duplicate_member" });
        }
        if (!groupConfigurationSupportedForService(serviceId)) {
            return reply.code(400).send({ error: "connect_group_runtime_fallback_unsupported" });
        }
        if (requiresFallbackFeature(policyPatch) && !fallbackEnabled()) {
            return reply.code(400).send({ error: "connect_group_fallback_disabled" });
        }
        if (requiresFallbackFeature(policyPatch) && !runtimeFallbackSupportedForService(serviceId)) {
            return reply.code(400).send({ error: "connect_group_runtime_fallback_unsupported" });
        }

        const memberProfileIds = members.map((member) => member.profileId);
        const activeProfileId = resolveCreateActiveProfileId({
            members,
            requestedActiveProfileId: body.activeProfileId,
        });
        if (activeProfileId === "invalid") {
            return reply.code(400).send({ error: "connect_group_active_profile_not_member" });
        }
        if (!(await allProfilesExist({ accountId, serviceId, profileIds: memberProfileIds }))) {
            return reply.code(400).send({ error: "connect_group_member_profile_not_found" });
        }

        // Default a newly created pool to automatic fallback ONLY when the account has the
        // runtime-fallback feature enabled and the service supports it. Fail closed otherwise so a
        // pool is never created with autoSwitch=true for an account that lacks the feature (which
        // the guards above would 400 on). An explicit autoSwitch in the request always wins.
        const autoSwitchCreateDefault = fallbackEnabled() && runtimeFallbackSupportedForService(serviceId);
        const effectivePolicyPatch: ConnectedServiceAuthGroupPolicyPatch = {
            ...policyPatch,
            autoSwitch: policyPatch?.autoSwitch ?? autoSwitchCreateDefault,
        };
        const policy = mergeConnectedServiceAuthGroupPolicyPatch(DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1, effectivePolicyPatch);
        try {
            await inTx(async (tx) => {
                await tx.connectedServiceAuthGroup.create({
                    data: {
                        accountId,
                        vendor: serviceId,
                        groupId: body.groupId,
                        displayName: body.displayName ?? null,
                        policyJson: encodePolicyForStorage(policy),
                        activeProfileId,
                        stateJson: null,
                        members: {
                            create: members.map((member) => ({
                                accountId,
                                vendor: serviceId,
                                groupId: body.groupId,
                                profileId: member.profileId,
                                priority: member.priority ?? 100,
                                enabled: member.enabled ?? true,
                                stateJson: null,
                            })),
                        },
                    },
                });
                await recordConnectedServiceAccountProfileChange(tx, { accountId });
            });
        } catch (error) {
            if (isUniqueConflict(error)) return reply.code(409).send({ error: "connect_group_already_exists" });
            if (isForeignKeyConflict(error)) {
                return reply.code(400).send({ error: "connect_group_member_profile_not_found" });
            }
            throw error;
        }

        const envelope = await loadGroupEnvelope({ headers: request.headers, query: request.query, accountId, serviceId, groupId: body.groupId });
        if (!envelope) return reply.code(404).send({ error: "connect_group_not_found" });
        return reply.send(envelope);
    });

    app.get("/v3/connect/:serviceId/groups/:groupId", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupParamsSchema,
            querystring: AuthGroupReaderCapabilitiesQuerySchema,
            response: { 200: AuthGroupEnvelopeResponseSchema, 404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]) },
        },
    }, async (request, reply) => {
        const envelope = await loadGroupEnvelope({
            headers: request.headers,
            query: request.query,
            accountId: request.userId,
            serviceId: request.params.serviceId,
            groupId: request.params.groupId,
        });
        if (!envelope) return reply.code(404).send({ error: "connect_group_not_found" });
        return reply.send(envelope);
    });

    app.patch("/v3/connect/:serviceId/groups/:groupId", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupParamsSchema,
            querystring: AuthGroupReaderCapabilitiesQuerySchema,
            body: UpdateAuthGroupBodySchema,
            response: { 200: AuthGroupEnvelopeResponseSchema, 400: AuthGroupErrorResponseSchema, 404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]), 409: AuthGroupErrorResponseSchema },
        },
    }, async (request, reply) => {
        const { serviceId, groupId } = request.params;
        const existingRecord = await findAuthGroupWithStoredActiveProfileForAccount({ accountId: request.userId, serviceId, groupId });
        if (!existingRecord) return reply.code(404).send({ error: "connect_group_not_found" });
        const existing = existingRecord.group;
        const policyPatch = parsePolicyPatchForRequest(request.body.policy, serviceId);
        if (policyPatch === null) {
            return reply.code(400).send({ error: "connect_group_invalid" });
        }
        const policy = mergeConnectedServiceAuthGroupPolicyPatch(existing.policy, policyPatch);
        const generationSensitivePatch = request.body.activeProfileId !== undefined || request.body.policy !== undefined;
        if (generationSensitivePatch && !runtimeFallbackSupportedForService(serviceId)) {
            return reply.code(400).send({ error: "connect_group_runtime_fallback_unsupported" });
        }
        if (requiresFallbackFeature(policyPatch) && !fallbackEnabled()) {
            return reply.code(400).send({ error: "connect_group_fallback_disabled" });
        }
        if (request.body.activeProfileId !== undefined && !fallbackEnabled()) {
            return reply.code(400).send({ error: "connect_group_fallback_disabled" });
        }
        if (generationSensitivePatch && request.body.expectedGeneration === undefined) {
            return reply.code(400).send({ error: "connect_group_generation_required" });
        }
        if (request.body.activeProfileId !== undefined && request.body.activeProfileId !== null) {
            const activeProfileMember = existing.members.find(
                (member) => member.profileId === request.body.activeProfileId && member.enabled,
            );
            if (!activeProfileMember) {
                return reply.code(400).send({ error: "connect_group_active_profile_not_member" });
            }
            if (request.body.overrideRuntimeCooldown !== true) {
                const blocker = readManualActiveProfileRuntimeBlockerFromState(activeProfileMember.state, Date.now());
                if (blocker !== null) {
                    return reply.code(409).send(buildManualActiveProfileRuntimeBlockerResponse(blocker));
                }
            }
        }
        const changesDisplayName = request.body.displayName !== undefined
            && existing.displayName !== request.body.displayName;
        const activeProfileMutation = request.body.activeProfileId !== undefined
            ? resolveStoredActiveProfileMutation({
                storedActiveProfileId: existingRecord.storedActiveProfileId,
                requestedActiveProfileId: request.body.activeProfileId,
            })
            : null;
        const changesActiveProfile = activeProfileMutation?.changesActiveProfile === true;
        const nextActiveStateJson = activeProfileMutation === null ? null : encodeAuthGroupStateForActiveProfile({
            currentStateJson: stringifyAuthGroupState(existing.state),
            previousActiveProfileId: existingRecord.storedActiveProfileId,
            nextActiveProfileId: activeProfileMutation.nextActiveProfileId,
            switchReason: "manual",
        });
        const changesSwitchProvenance = nextActiveStateJson !== null
            && activeProfileMutation?.nextActiveProfileId !== null
            && existing.state.lastSwitchReason !== "manual";
        const existingPolicyJson = encodePolicyForStorage(existing.policy);
        const nextPolicyJson = encodePolicyForStorage(policy);
        const changesPolicy = request.body.policy !== undefined
            && existingPolicyJson !== nextPolicyJson;
        const changesGeneration = changesActiveProfile || changesPolicy || changesSwitchProvenance;
        if (
            generationSensitivePatch
            && request.body.expectedGeneration !== existing.generation
        ) {
            return reply.code(409).send({ error: "connect_group_generation_conflict", generation: existing.generation });
        }
        const patchResult = await inTx(async (tx) => {
            const data = {
                ...(request.body.displayName !== undefined ? { displayName: request.body.displayName } : {}),
                ...(request.body.policy !== undefined ? { policyJson: nextPolicyJson } : {}),
                ...(changesActiveProfile && activeProfileMutation !== null ? { activeProfileId: activeProfileMutation.nextActiveProfileId } : {}),
                ...((changesActiveProfile || changesSwitchProvenance) && nextActiveStateJson !== null ? { stateJson: nextActiveStateJson } : {}),
                ...(changesGeneration ? { generation: { increment: 1 } } : {}),
            };
            if (changesGeneration) {
                const update = await tx.connectedServiceAuthGroup.updateMany({
                    where: {
                        accountId: request.userId,
                        vendor: serviceId,
                        groupId,
                        generation: request.body.expectedGeneration,
                    },
                    data,
                });
                if (update.count !== 1) {
                    const current = await tx.connectedServiceAuthGroup.findUnique({
                        where: { accountId_vendor_groupId: { accountId: request.userId, vendor: serviceId, groupId } },
                        select: { generation: true },
                    });
                    return { type: "generation-conflict" as const, generation: current?.generation ?? existing.generation };
                }
            } else if (request.body.displayName !== undefined || request.body.policy !== undefined) {
                await tx.connectedServiceAuthGroup.update({
                    where: { accountId_vendor_groupId: { accountId: request.userId, vendor: serviceId, groupId } },
                    data,
                });
            }
            if (changesDisplayName || changesGeneration) {
                await recordConnectedServiceAccountProfileChange(tx, { accountId: request.userId });
            }
            return { type: "success" as const };
        });
        if (patchResult.type === "generation-conflict") {
            return reply.code(409).send({ error: "connect_group_generation_conflict", generation: patchResult.generation });
        }
        const envelope = await loadGroupEnvelope({ headers: request.headers, query: request.query, accountId: request.userId, serviceId, groupId });
        if (!envelope) return reply.code(404).send({ error: "connect_group_not_found" });
        return reply.send(envelope);
    });

    app.delete("/v3/connect/:serviceId/groups/:groupId", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupParamsSchema,
            response: { 200: AuthGroupSuccessResponseSchema, 404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]) },
        },
    }, async (request, reply) => {
        const { serviceId, groupId } = request.params;
        const existing = await findAuthGroupForAccount({ accountId: request.userId, serviceId, groupId });
        if (!existing) return reply.code(404).send({ error: "connect_group_not_found" });
        await inTx(async (tx) => {
            await deleteConnectedServiceUsageSourcesForGroup({
                accountId: request.userId,
                serviceId,
                groupId,
            }, tx);
            await tx.connectedServiceAuthGroup.delete({
                where: { accountId_vendor_groupId: { accountId: request.userId, vendor: serviceId, groupId } },
            });
            await recordConnectedServiceAccountProfileChange(tx, { accountId: request.userId });
        });
        return reply.send({ success: true });
    });

    app.patch("/v3/connect/:serviceId/groups/:groupId/runtime-state", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupParamsSchema,
            querystring: AuthGroupReaderCapabilitiesQuerySchema,
            body: RuntimeStatePatchBodySchema,
            response: { 200: AuthGroupEnvelopeResponseSchema, 400: AuthGroupErrorResponseSchema, 404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]), 409: AuthGroupErrorResponseSchema },
        },
    }, async (request, reply) => {
        const { serviceId, groupId } = request.params;
        const result = await inTx(async (tx) => {
            const group = await tx.connectedServiceAuthGroup.findUnique({
                where: { accountId_vendor_groupId: { accountId: request.userId, vendor: serviceId, groupId } },
                select: { id: true, generation: true, runtimeStateRevision: true, stateJson: true },
            });
            if (!group) return { type: "not-found" as const };
            if (
                request.body.expectedGeneration !== undefined
                && request.body.expectedGeneration !== group.generation
            ) {
                return { type: "generation-conflict" as const, generation: group.generation };
            }
            const memberStates = request.body.memberStates;
            const requestedProfileIds = memberStates.map((member) => member.profileId);
            const members = memberStates.length === 0
                ? []
                : await tx.connectedServiceAuthGroupMember.findMany({
                    where: {
                        accountId: request.userId,
                        vendor: serviceId,
                        groupId,
                        profileId: { in: requestedProfileIds },
                    },
                    select: { profileId: true, stateJson: true },
                });
            if (members.length !== new Set(requestedProfileIds).size) {
                return { type: "member-not-found" as const };
            }
            const memberStateJsonByProfileId = new Map(members.map((member) => [member.profileId, member.stateJson]));
            const changedMemberStates = memberStates.filter((member) => (
                hasMemberRuntimeStateChanged(memberStateJsonByProfileId.get(member.profileId) ?? null, member.state)
            ));
            const nextGroupStateJson = request.body.state === undefined ? null : encodeAuthGroupStateForActiveProfile({
                currentStateJson: group.stateJson, nextState: request.body.state,
                previousActiveProfileId: null, nextActiveProfileId: null,
            });
            const groupStateChanged = nextGroupStateJson !== null
                && hasGroupRuntimeStateChanged(group.stateJson, JSON.parse(nextGroupStateJson));
            const runtimeStateChanged = groupStateChanged || changedMemberStates.length > 0;
            if (runtimeStateChanged && request.body.expectedGeneration === undefined) {
                return { type: "generation-required" as const };
            }
            if (runtimeStateChanged && request.body.expectedRuntimeStateRevision === undefined) {
                return { type: "runtime-state-revision-required" as const };
            }
            if (
                runtimeStateChanged
                && request.body.expectedRuntimeStateRevision !== group.runtimeStateRevision
            ) {
                return {
                    type: "runtime-state-revision-conflict" as const,
                    runtimeStateRevision: group.runtimeStateRevision,
                };
            }

            if (runtimeStateChanged) {
                const update = await tx.connectedServiceAuthGroup.updateMany({
                    where: {
                        id: group.id,
                        generation: request.body.expectedGeneration,
                        runtimeStateRevision: request.body.expectedRuntimeStateRevision,
                    },
                    data: {
                        updatedAt: new Date(),
                        runtimeStateRevision: { increment: 1 },
                        ...(groupStateChanged && nextGroupStateJson !== null
                            ? { stateJson: nextGroupStateJson }
                            : {}),
                    },
                });
                if (update.count !== 1) {
                    const current = await tx.connectedServiceAuthGroup.findUnique({
                        where: { id: group.id },
                        select: { generation: true, runtimeStateRevision: true },
                    });
                    if ((current?.generation ?? group.generation) !== request.body.expectedGeneration) {
                        return {
                            type: "generation-conflict" as const,
                            generation: current?.generation ?? group.generation,
                        };
                    }
                    return {
                        type: "runtime-state-revision-conflict" as const,
                        runtimeStateRevision: current?.runtimeStateRevision ?? group.runtimeStateRevision,
                    };
                }
                for (const member of changedMemberStates) {
                    await tx.connectedServiceAuthGroupMember.update({
                        where: {
                            accountId_vendor_groupId_profileId: {
                                accountId: request.userId,
                                vendor: serviceId,
                                groupId,
                                profileId: member.profileId,
                            },
                        },
                        data: { stateJson: stringifyAuthGroupMemberState(member.state) },
                    });
                }
                await recordConnectedServiceAccountProfileChange(tx, { accountId: request.userId });
            }

            return { type: "success" as const };
        });

        if (result.type === "not-found") return reply.code(404).send({ error: "connect_group_not_found" });
        if (result.type === "member-not-found") return reply.code(400).send({ error: "connect_group_member_not_found" });
        if (result.type === "generation-required") return reply.code(400).send({ error: "connect_group_generation_required" });
        if (result.type === "runtime-state-revision-required") {
            return reply.code(400).send({ error: "connect_group_runtime_state_revision_required" });
        }
        if (result.type === "generation-conflict") {
            return reply.code(409).send({
                error: "connect_group_generation_conflict",
                generation: result.generation,
            });
        }
        if (result.type === "runtime-state-revision-conflict") {
            return reply.code(409).send({
                error: "connect_group_runtime_state_revision_conflict",
                runtimeStateRevision: result.runtimeStateRevision,
            });
        }

        const envelope = await loadGroupEnvelope({ headers: request.headers, query: request.query, accountId: request.userId, serviceId, groupId });
        if (!envelope) return reply.code(404).send({ error: "connect_group_not_found" });
        return reply.send(envelope);
    });

    app.post("/v3/connect/:serviceId/groups/:groupId/members", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupParamsSchema,
            querystring: AuthGroupReaderCapabilitiesQuerySchema,
            body: AuthGroupMemberInputSchema,
            response: { 200: AuthGroupEnvelopeResponseSchema, 400: AuthGroupErrorResponseSchema, 404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]), 409: AuthGroupErrorResponseSchema },
        },
    }, async (request, reply) => {
        const { serviceId, groupId } = request.params;
        if (request.body.expectedGeneration === undefined) {
            return reply.code(400).send({ error: "connect_group_generation_required" });
        }
        const expectedGeneration = request.body.expectedGeneration;
        try {
            const result = await inTx(async (tx) => {
                const mutationResult = await createAuthGroupMemberAndBumpGenerationInTx(tx, {
                    accountId: request.userId,
                    serviceId,
                    groupId,
                    profileId: request.body.profileId,
                    priority: request.body.priority ?? 100,
                    enabled: request.body.enabled ?? true,
                    expectedGeneration,
                });
                if (mutationResult === "created") {
                    await recordConnectedServiceAccountProfileChange(tx, { accountId: request.userId });
                }
                return mutationResult;
            });
            if (result === "group_not_found") return reply.code(404).send({ error: "connect_group_not_found" });
            if (result === "profile_not_found") {
                return reply.code(400).send({ error: "connect_group_member_profile_not_found" });
            }
            if (typeof result === "object" && result.type === "generation_conflict") {
                return reply.code(409).send({ error: "connect_group_generation_conflict", generation: result.generation });
            }
        } catch (error) {
            if (isUniqueConflict(error)) return reply.code(409).send({ error: "connect_group_member_already_exists" });
            if (isForeignKeyConflict(error)) {
                const groupStillExists = await db.connectedServiceAuthGroup.findUnique({
                    where: { accountId_vendor_groupId: { accountId: request.userId, vendor: serviceId, groupId } },
                    select: { id: true },
                });
                if (!groupStillExists) return reply.code(404).send({ error: "connect_group_not_found" });
                return reply.code(400).send({ error: "connect_group_member_profile_not_found" });
            }
            throw error;
        }
        const envelope = await loadGroupEnvelope({ headers: request.headers, query: request.query, accountId: request.userId, serviceId, groupId });
        if (!envelope) return reply.code(404).send({ error: "connect_group_not_found" });
        return reply.send(envelope);
    });

    app.patch("/v3/connect/:serviceId/groups/:groupId/members/:profileId", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupMemberParamsSchema,
            querystring: AuthGroupReaderCapabilitiesQuerySchema,
            body: UpdateAuthGroupMemberBodySchema,
            response: { 200: AuthGroupEnvelopeResponseSchema, 400: AuthGroupErrorResponseSchema, 404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]), 409: AuthGroupErrorResponseSchema },
        },
    }, async (request, reply) => {
        const { serviceId, groupId, profileId } = request.params;
        if (request.body.expectedGeneration === undefined) {
            return reply.code(400).send({ error: "connect_group_generation_required" });
        }
        if (request.body.state !== undefined && request.body.expectedRuntimeStateRevision === undefined) {
            return reply.code(400).send({ error: "connect_group_runtime_state_revision_required" });
        }
        const expectedGeneration = request.body.expectedGeneration;
        const result = await inTx(async (tx) => {
            const mutationResult = await updateAuthGroupMemberAndBumpGenerationInTx(tx, {
                accountId: request.userId,
                serviceId,
                groupId,
                profileId,
                priority: request.body.priority,
                enabled: request.body.enabled,
                state: request.body.state,
                expectedGeneration,
                expectedRuntimeStateRevision: request.body.expectedRuntimeStateRevision,
            });
            if (mutationResult === "updated") {
                await recordConnectedServiceAccountProfileChange(tx, { accountId: request.userId });
            }
            return mutationResult;
        });
        if (result === "not_found") return reply.code(404).send({ error: "connect_group_member_not_found" });
        if (typeof result === "object" && result.type === "generation_conflict") {
            return reply.code(409).send({ error: "connect_group_generation_conflict", generation: result.generation });
        }
        if (typeof result === "object" && result.type === "runtime_state_revision_conflict") {
            return reply.code(409).send({
                error: "connect_group_runtime_state_revision_conflict",
                runtimeStateRevision: result.runtimeStateRevision,
            });
        }
        const envelope = await loadGroupEnvelope({ headers: request.headers, query: request.query, accountId: request.userId, serviceId, groupId });
        if (!envelope) return reply.code(404).send({ error: "connect_group_not_found" });
        return reply.send(envelope);
    });

    app.delete("/v3/connect/:serviceId/groups/:groupId/members/:profileId", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupMemberParamsSchema,
            querystring: DeleteAuthGroupMemberQuerySchema,
            response: { 200: AuthGroupEnvelopeResponseSchema, 400: AuthGroupErrorResponseSchema, 404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]), 409: AuthGroupErrorResponseSchema },
        },
    }, async (request, reply) => {
        const { serviceId, groupId, profileId } = request.params;
        if (request.query.expectedGeneration === undefined) {
            return reply.code(400).send({ error: "connect_group_generation_required" });
        }
        const expectedGeneration = request.query.expectedGeneration;
        const result = await inTx(async (tx) => {
            const mutationResult = await deleteAuthGroupMemberAndBumpGenerationInTx(tx, {
                accountId: request.userId,
                serviceId,
                groupId,
                profileId,
                expectedGeneration,
            });
            if (mutationResult === "deleted") {
                await recordConnectedServiceAccountProfileChange(tx, { accountId: request.userId });
            }
            return mutationResult;
        });
        if (result === "not_found") return reply.code(404).send({ error: "connect_group_member_not_found" });
        if (typeof result === "object" && result.type === "generation_conflict") {
            return reply.code(409).send({ error: "connect_group_generation_conflict", generation: result.generation });
        }
        const envelope = await loadGroupEnvelope({ headers: request.headers, query: request.query, accountId: request.userId, serviceId, groupId });
        if (!envelope) return reply.code(404).send({ error: "connect_group_not_found" });
        return reply.send(envelope);
    });

    app.post("/v3/connect/:serviceId/groups/:groupId/active-profile", {
        preHandler: app.authenticate,
        schema: {
            params: AuthGroupParamsSchema,
            querystring: AuthGroupReaderCapabilitiesQuerySchema,
            body: ActiveProfileBodySchema,
            response: { 200: AuthGroupEnvelopeResponseSchema, 400: AuthGroupErrorResponseSchema, 404: z.union([NotFoundResponseSchema, AuthGroupErrorResponseSchema]), 409: AuthGroupErrorResponseSchema },
        },
    }, async (request, reply) => {
        const { serviceId, groupId } = request.params;
        if (!runtimeFallbackSupportedForService(serviceId)) {
            return reply.code(400).send({ error: "connect_group_runtime_fallback_unsupported" });
        }
        if (!fallbackEnabled()) {
            return reply.code(400).send({ error: "connect_group_fallback_disabled" });
        }
        if (request.body.expectedGeneration === undefined) {
            return reply.code(400).send({ error: "connect_group_generation_required" });
        }
        const expectedGeneration = request.body.expectedGeneration;
        const result = await inTx(async (tx) => {
            const group = await tx.connectedServiceAuthGroup.findUnique({
                where: { accountId_vendor_groupId: { accountId: request.userId, vendor: serviceId, groupId } },
                select: { id: true, activeProfileId: true, generation: true, stateJson: true },
            });
            if (!group) return { type: "not-found" as const };
            const member = await tx.connectedServiceAuthGroupMember.findUnique({
                where: { accountId_vendor_groupId_profileId: { accountId: request.userId, vendor: serviceId, groupId, profileId: request.body.profileId } },
                select: { enabled: true, stateJson: true },
            });
            if (!member?.enabled) return { type: "invalid-active-member" as const };
            if (request.body.overrideRuntimeCooldown !== true) {
                const blocker = readManualActiveProfileRuntimeBlocker(member.stateJson, Date.now());
                if (blocker !== null) {
                    return { type: "runtime-cooldown" as const, blocker };
                }
            }
            if (expectedGeneration !== group.generation) {
                return { type: "generation-conflict" as const, generation: group.generation };
            }

            const activeProfileMutation = resolveStoredActiveProfileMutation({
                storedActiveProfileId: group.activeProfileId,
                requestedActiveProfileId: request.body.profileId,
            });
            const requestedReason = request.headers[CONNECTED_SERVICE_AUTH_GROUP_SWITCH_REASON_HEADER];
            const switchReason = typeof requestedReason === "string"
                && ["usage_limit", "rate_limit", "capacity", "temporary_throttle", "soft_threshold", "same_provider_account_exhausted", "auth_expired", "account_changed", "refresh_failed"].includes(requestedReason)
                ? requestedReason : "manual";
            const nextStateJson = encodeAuthGroupStateForActiveProfile({
                currentStateJson: group.stateJson,
                previousActiveProfileId: group.activeProfileId,
                nextActiveProfileId: activeProfileMutation.nextActiveProfileId,
                switchReason,
            });
            if (!activeProfileMutation.changesActiveProfile && group.stateJson === nextStateJson) {
                return { type: "success" as const };
            }

            const update = await tx.connectedServiceAuthGroup.updateMany({
                where: { id: group.id, generation: expectedGeneration },
                data: { activeProfileId: activeProfileMutation.nextActiveProfileId, stateJson: nextStateJson, generation: { increment: 1 } },
            });
            if (update.count !== 1) {
                const current = await tx.connectedServiceAuthGroup.findUnique({
                    where: { id: group.id },
                    select: { generation: true },
                });
                return {
                    type: "generation-conflict" as const,
                    generation: current?.generation ?? group.generation,
                };
            }
            await recordConnectedServiceAccountProfileChange(tx, { accountId: request.userId });
            return { type: "success" as const };
        });

        if (result.type === "not-found") return reply.code(404).send({ error: "connect_group_not_found" });
        if (result.type === "invalid-active-member") {
            return reply.code(400).send({ error: "connect_group_active_profile_not_member" });
        }
        if (result.type === "runtime-cooldown") {
            return reply.code(409).send(buildManualActiveProfileRuntimeBlockerResponse(result.blocker));
        }
        if (result.type === "generation-conflict") {
            return reply.code(409).send({ error: "connect_group_generation_conflict", generation: result.generation });
        }

        const envelope = await loadGroupEnvelope({ headers: request.headers, query: request.query, accountId: request.userId, serviceId, groupId });
        if (!envelope) return reply.code(404).send({ error: "connect_group_not_found" });
        return reply.send(envelope);
    });

}
