import { buildAccountStoredContentUpgradeRequired, type AccountStoredContentCompatibilityEvaluation } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { z } from "zod/mini";

import { AnyClientUpgradeRequiredV1Schema } from '@happier-dev/protocol/clientCompatibility/upgradeRequiredV1';
import { OperationUpdateRequiredV1Schema } from '@happier-dev/protocol/compat/operationUpdateRequiredV1';
import { SESSION_METADATA_LAYOUT_VERSION_V1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SESSION_LIST_PAGE_DEFAULT_LIMIT, SESSION_LIST_PAGE_MAX_LIMIT } from '@happier-dev/protocol/sessions/listing/query';
import { V2SessionByIdNotFoundSchema, V2SessionByIdResponseSchema, V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { inReadSnapshot, type Tx } from "@/storage/inTx";
import { captureReadSnapshot } from "@/storage/captureReadSnapshot";
import { prismaRuntime } from '@/storage/prisma';
import { sessionEvidenceSql } from '@/app/usage/query/sessionEvidenceSql';
import { readSessionObservationCursorInTx } from '@/app/session/access/readObservation';
import { type Fastify } from "../../types";
import {
    createV2SessionListRowSelect,
    createV2SessionListLegacyRowSelect,
    mapV2SessionListRow,
} from "@/app/session/listing/rows";
import { readSessionListOtherNamedCollaboratorFacts, readSessionListViewerDiscussionFacts } from "@/app/session/listing/page";
import {
    runWithSessionListProjectionFallback,
    V2_ACTIVE_SESSION_LIST_ROW_LIMIT,
} from "@/app/session/listing/page";
import { listSessionsForAccount, SessionListInvalidCursorError } from "@/app/session/listing/service";
import { loadSessionLatestFailureSequencesInTx } from "@/app/session/personal/projection";
import { loadSessionRuleReadStatesInTx } from "@/app/session/personal/readState";
import { readAccountFollowRuleProjectionRowsInTx, projectAccountFollowRuleReceiverCounts } from "@/app/session/follow/accountFollowRuleService";
import { createV2SessionListServerTiming } from "@/app/session/listing/timing";
import { registerSessionFilteredListingRoute } from "./registerSessionFilteredListingRoute";
import { parseProjectedSessionByIdResponse } from './sessionRecordResponse';
import {
    createSessionMetadataListRepresentabilityWhere,
    createSessionMetadataPrivacyUpgradeRequiredResponse,
    isSessionMetadataPrivacyUpgradeRequiredError,
    deriveSessionMetadataOwnerAccountMode,
    sessionMetadataOwnerAccountCurrentnessSelect,
    requiresSessionMetadataOwnerAccountMode,
    listSessionMetadataPrivacyUpgradeIdsInTx,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";
import {
    enforceCurrentAccountStoredContentCompatibilityForHttpRequest,
    readAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { resolveSessionAccessForRowsInTx, SESSION_ACCESS_SESSION_BATCH_SIZE, type SessionAccessOperationDecision } from "@/app/session/access/sessionAccess";
import { readSessionAccessAuthenticationFromRequest, type SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { listQueuedExecutionRunPendingTargetsForSessions } from "@/app/session/pending/pendingMessageService";
import { loadPendingActivationPublicationsInTx } from '@/app/session/pending/publishPendingMutation';
import { PRESENT_USER_REQUIRED_ERROR } from "@/app/api/utils/apiTokenRouteAdmission";
import { projectSessionManagerForRowsInTx } from "@/app/session/awareness/sessionManagerProjection";
import { projectSessionTurnWaitingHttpResponse } from '@/app/clientCompatibility/sessionTurnWaitingCompatibility';
import { readAcceptedSessionTeamCredentialProviderModelBindingsInTx } from '@/app/teams/credentials/sessionBinding';
import { readSessionManagedSubtreeSessionIdsInTx, projectSessionRuntimeManagedSubtreeAccess } from '@/app/session/follow/sessionManagerSubtree';
import { SessionRuntimeManagedSubtreeSnapshotRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';

const SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_RESPONSE_SCHEMA = z.strictObject({
    error: z.literal("Session metadata privacy upgrade required"),
    code: z.literal("metadata_privacy_upgrade_required"),
});

const V2_ACTIVE_SESSION_LIST_QUERYSTRING_SCHEMA = z.optional(z.object({
    limit: z._default(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(V2_ACTIVE_SESSION_LIST_ROW_LIMIT)), V2_ACTIVE_SESSION_LIST_ROW_LIMIT),
}));

const OPTIONAL_BOOLEAN_QUERY_PARAM_SCHEMA = z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => {
    if (value === true || value === "true" || value === "1") return true;
    if (value === false || value === "false" || value === "0") return false;
    return value;
}), z.boolean()));

const V2_PAGED_SESSION_LIST_QUERYSTRING_SCHEMA = z.optional(z.object({
    cursor: z.optional(z.string()),
    limit: z._default(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(SESSION_LIST_PAGE_MAX_LIMIT)), SESSION_LIST_PAGE_DEFAULT_LIMIT),
}));

const V2_SESSION_LIST_QUERYSTRING_SCHEMA = z.optional(z.object({
    cursor: z.optional(z.string()),
    attentionCursor: z.optional(z.string()),
    limit: z._default(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(SESSION_LIST_PAGE_MAX_LIMIT)), SESSION_LIST_PAGE_DEFAULT_LIMIT),
    includeAttention: OPTIONAL_BOOLEAN_QUERY_PARAM_SCHEMA,
    includeActive: OPTIONAL_BOOLEAN_QUERY_PARAM_SCHEMA,
}).check(z.refine((value) => !(value.cursor && value.attentionCursor), { message: "cursor and attentionCursor cannot be combined" })));

async function findV2SessionDetailRowsInTx(tx: Tx, params: Readonly<{
    userId: string;
    sessionIds: readonly string[];
    accessProjectionVersion?: number;
    usageProjection?: boolean;
}>) {
    const current = createV2SessionListRowSelect(params);
    const legacy = createV2SessionListLegacyRowSelect(params);
    const readCurrentRows = async () => {
        const select = { ...current, account: { select: { ...current.account.select, ...sessionMetadataOwnerAccountCurrentnessSelect } } };
        if (params.usageProjection) {
            const rows = await tx.session.findMany({ where: { id: { in: [...params.sessionIds] } }, select: { ...select, ownerMetadata: false, metadata: false, agentState: false } });
            return rows.map(row => ({ ...row, ownerMetadata: null, metadata: '', agentState: null }));
        }
        return tx.session.findMany({ where: { id: { in: [...params.sessionIds] } }, select });
    };
    const readLegacyRows = async () => {
        const select = { ...legacy, account: { select: { ...legacy.account.select, ...sessionMetadataOwnerAccountCurrentnessSelect } } };
        if (params.usageProjection) {
            const rows = await tx.session.findMany({ where: { id: { in: [...params.sessionIds] } }, select: { ...select, ownerMetadata: false, metadata: false, agentState: false } });
            return rows.map(row => ({ ...row, ownerMetadata: null, metadata: '', agentState: null }));
        }
        return tx.session.findMany({ where: { id: { in: [...params.sessionIds] } }, select });
    };
    type Row = Awaited<ReturnType<typeof readCurrentRows>>[number] | Awaited<ReturnType<typeof readLegacyRows>>[number];
    // Only the released adapter permits migration-skew fallback. Current detail
    // must load its complete projection, including the canonical access facts.
    return params.accessProjectionVersion === 1 ? readCurrentRows()
        : runWithSessionListProjectionFallback<Row[]>(readCurrentRows, readLegacyRows);
}

/** Project admitted plain documents at storage; encrypted content remains opaque. */
async function readUsageDetailDocumentsInTx(tx: Tx, sessionIds: readonly string[]) {
    const sql = sessionEvidenceSql();
    const owner = sql.column('ownerMetadata');
    const document = `(${sql.parseText(owner)})`;
    const withoutCursors = sql.remove(document, 'v', 'cursors');
    const projected = `CASE WHEN ${sql.text(document, 't')} = 'plain' AND ${sql.type(sql.json(document, 'v'))} = 'object'
        THEN CAST(${withoutCursors} AS ${sql.dialect === 'mysql' ? 'CHAR' : 'TEXT'}) ELSE ${owner} END`;
    const metadata = sql.column('metadata');
    const plain = `${sql.column('encryptionMode')} = 'plain'`;
    const shared = `CASE WHEN ${plain} AND ${sql.isObjectText(metadata)} THEN CAST(${sql.remove(`(${sql.parseText(metadata)})`, 'actionConfirmationsV1')} AS ${sql.dialect === 'mysql' ? 'CHAR' : 'TEXT'}) ELSE ${metadata} END`;
    const agentState = `CASE WHEN ${plain} THEN NULL ELSE ${sql.column('agentState')} END`;
    const rows = await tx.$queryRaw<{ id: string; ownerMetadata: string | null; metadata: string; agentState: string | null }[]>(prismaRuntime.sql`
        SELECT ${prismaRuntime.raw(sql.column('id'))}, ${prismaRuntime.raw(projected)} AS ${prismaRuntime.raw(owner)},
            ${prismaRuntime.raw(shared)} AS ${prismaRuntime.raw(metadata)}, ${prismaRuntime.raw(agentState)} AS ${prismaRuntime.raw(sql.column('agentState'))}
        FROM ${prismaRuntime.raw(sql.column('Session'))} WHERE ${prismaRuntime.raw(sql.column('id'))} IN (${prismaRuntime.join([...sessionIds])})`);
    return new Map(rows.map(row => [row.id, row]));
}

type SessionDetailInput = Readonly<{ userId: string; authentication: SessionAccessAuthentication; accessProjectionVersion?: number; storedContentCompatibility: AccountStoredContentCompatibilityEvaluation;
    /** The batch owner adds these from one request-local rule snapshot after detail admission. */
    includePrivateRuleProjection?: boolean;
    /** Usage consumes projected state facts separately; encrypted documents stay opaque. */
    usageProjection?: boolean;
    /** Internal evidence authority from the existing recipient projector, never a wire field. */
    onUsageStateAdmission?: (sessionId: string, admitted: boolean) => void;
}>;
export type SessionDetailResponse =
    | { status: 200; body: z.infer<typeof V2SessionByIdResponseSchema> }
    | { status: 403; body: { error: 'team_authentication_required' } }
    | { status: 404; body: { error: 'Session not found' } }
    | { status: 409; body: ReturnType<typeof createSessionMetadataPrivacyUpgradeRequiredResponse> }
    | { status: 426; body: z.infer<typeof OperationUpdateRequiredV1Schema> | z.infer<typeof AnyClientUpgradeRequiredV1Schema> }
    | { status: 503; body: { error: 'team_authentication_unavailable' } };

type SessionDetailCapture =
    | { kind: 'found'; session: z.infer<typeof V2SessionByIdResponseSchema>['session']; observationCursor?: number }
    | { kind: 'response'; response: SessionDetailResponse }
    | { kind: 'error'; error: unknown };

function sessionDetailDenial(status: Exclude<SessionAccessOperationDecision['status'], 'allowed'>): SessionDetailResponse {
    if (status === 'authentication_required') return { status: 403, body: { error: 'team_authentication_required' } };
    if (status === 'authentication_unavailable') return { status: 503, body: { error: 'team_authentication_unavailable' } };
    return { status: 404, body: { error: 'Session not found' } };
}

function sessionDetailFailure(error: unknown): SessionDetailCapture {
    return isSessionMetadataPrivacyUpgradeRequiredError(error)
        ? { kind: 'response', response: { status: 409, body: createSessionMetadataPrivacyUpgradeRequiredResponse() } }
        : { kind: 'error', error };
}

/** One canonical detail owner: fact families are loaded per transport batch, never per Session. */
export async function readSessionDetails(input: SessionDetailInput & Readonly<{ sessionIds: readonly string[]; underSessionId?: string }>):
    Promise<ReadonlyMap<string, PromiseSettledResult<SessionDetailResponse>>> {
    const results = new Map<string, PromiseSettledResult<SessionDetailResponse>>();
    const ids = [...new Set(input.sessionIds)];
    if (ids.length === 0) return results;
    if (input.accessProjectionVersion !== undefined && input.accessProjectionVersion !== 1) {
        for (const id of ids) results.set(id, { status: 'fulfilled', value: { status: 426, body: {
            kind: 'update_required', operation: 'session.detail', component: 'client', reason: 'access_projection_version_unsupported',
        } } });
        return results;
    }
    const { userId, authentication } = input;
    const accessMode = input.accessProjectionVersion === 1 ? 'effective_access_v1' : 'legacy_owner_or_direct';
    const admissionInput = { accountId: userId, authentication, accessMode } as const;
    const runtimeManagedSubtree = input.underSessionId !== undefined && authentication.sessionRuntimePrincipal !== undefined;
    const viewAccess = (sessionId: string) => projectSessionRuntimeManagedSubtreeAccess({ accountId: userId, sessionId });
    // The graph/access owner supplies the corpus, including current runtime proof.
    // This never changes the exact-detail authority of a runtime credential.
    const readManagedIds = async (tx: Tx) => input.underSessionId === undefined ? null : new Set(
        await readSessionManagedSubtreeSessionIdsInTx(tx, { accountId: userId, rootSessionId: input.underSessionId,
            authentication, sessionIds: ids, ...(runtimeManagedSubtree ? { allowSessionRuntimeManagedSubtreeRead: true as const } : {}) }));
    try {
        await captureReadSnapshot(async tx => {
            const observationCursor = await readSessionObservationCursorInTx(tx, userId, authentication);
            const managedIds = await readManagedIds(tx);
            const verifiedSessionRuntimePrincipal = authentication.sessionRuntimePrincipal !== undefined;
            const ruleRows = verifiedSessionRuntimePrincipal || input.includePrivateRuleProjection === false ? null
                : await readAccountFollowRuleProjectionRowsInTx(tx, { accountId: userId, authentication });
            // Portable SQL chunks share this request's admitted snapshot and corpus.
            for (let offset = 0; offset < ids.length; offset += SESSION_ACCESS_SESSION_BATCH_SIZE) {
                const batch = ids.slice(offset, offset + SESSION_ACCESS_SESSION_BATCH_SIZE);
                let captured: Map<string, SessionDetailCapture>;
                try {
                    captured = await (async (): Promise<Map<string, SessionDetailCapture>> => {
                        const result = new Map<string, SessionDetailCapture>();
                        const rows = await findV2SessionDetailRowsInTx(tx, { ...input,
                            sessionIds: managedIds ? batch.filter(id => managedIds.has(id)) : batch });
                        const admissions = runtimeManagedSubtree
                            ? new Map<string, SessionAccessOperationDecision>(rows.map(row => [row.id, { status: 'allowed', access: viewAccess(row.id) }]))
                            : await resolveSessionAccessForRowsInTx(tx, admissionInput, rows);
                        let candidates = rows.filter(session => admissions.get(session.id)?.status === 'allowed'
                            && (session.metadataLayoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1 || input.storedContentCompatibility.supportsCurrentProtocol));
                        for (const id of batch) {
                            const admission = admissions.get(id);
                            result.set(id, { kind: 'response', response: !admission || admission.status !== 'allowed'
                                ? sessionDetailDenial(admission?.status ?? 'unavailable')
                                : { status: 426, body: input.storedContentCompatibility.upgradeRequired ?? buildAccountStoredContentUpgradeRequired() } });
                        }
                        if (!candidates.length) return result;
                        if (input.usageProjection) {
                            const documents = await readUsageDetailDocumentsInTx(tx, candidates.map(session => session.id));
                            candidates = candidates.map(session => ({ ...session, ...documents.get(session.id) }));
                        }
                        // Runtime credentials never acquire their hosting Account's private facts.
                        const discussionFacts = verifiedSessionRuntimePrincipal ? undefined : await readSessionListViewerDiscussionFacts(candidates, userId, tx);
                        const latestFailureSequences = verifiedSessionRuntimePrincipal ? undefined : await loadSessionLatestFailureSequencesInTx(tx, candidates);
                        const ruleReadStates = verifiedSessionRuntimePrincipal || input.includePrivateRuleProjection === false ? undefined
                            : await loadSessionRuleReadStatesInTx(tx, { accountId: userId, authentication, rows: candidates, ruleRows });
                        const otherNamed = runtimeManagedSubtree ? undefined : await readSessionListOtherNamedCollaboratorFacts(candidates, userId, tx);
                        const ownerModes = new Map<string, ReturnType<typeof deriveSessionMetadataOwnerAccountMode>>();
                        const mapped = candidates.flatMap(session => {
                            try {
                                const admission = admissions.get(session.id)!;
                                if (admission.status !== 'allowed') return [];
                                if (requiresSessionMetadataOwnerAccountMode({ session }) && !ownerModes.has(session.accountId)) {
                                    ownerModes.set(session.accountId, deriveSessionMetadataOwnerAccountMode(session.account));
                                }
                                return [mapV2SessionListRow({ row: session, userId,
                                    ownerAccountMode: ownerModes.get(session.accountId),
                                    discussionFacts, latestFailureSequences, ruleReadStates,
                                    hasOtherNamedCollaborator: otherNamed?.get(session.id), effectiveAccess: admission.access, verifiedSessionRuntimePrincipal,
                                    ...(input.usageProjection ? { onMetadataDocumentProjection: descriptor =>
                                        input.onUsageStateAdmission?.(session.id, descriptor.agentStateDocument === 'omitted') } : {}) })];
                            } catch (error) { result.set(session.id, sessionDetailFailure(error)); return []; }
                        });
                        const projected = runtimeManagedSubtree ? mapped : await projectSessionManagerForRowsInTx(tx, { ...admissionInput, sessions: mapped,
                            ruleReceiverCounts: projectAccountFollowRuleReceiverCounts(ruleRows), nowMs: Date.now() });
                        const ownerIds = projected.filter(session => {
                            const admission = admissions.get(session.id);
                            return admission?.status === 'allowed' && admission.access.level === 'owner';
                        }).map(session => session.id);
                        const targets = await listQueuedExecutionRunPendingTargetsForSessions({ accountId: userId, sessionIds: ownerIds, reader: tx });
                        const pendingRuns = new Map<string, string[]>();
                        for (const target of targets) {
                            const runs = pendingRuns.get(target.sessionId) ?? [];
                            runs.push(target.runId);
                            pendingRuns.set(target.sessionId, runs);
                        }
                        const bindings = await readAcceptedSessionTeamCredentialProviderModelBindingsInTx(tx, ownerIds);
                        const activations = await loadPendingActivationPublicationsInTx(tx, ownerIds);
                        const owners = new Set(ownerIds);
                        for (const session of projected) {
                            try {
                                const binding = bindings.get(session.id);
                                if (binding?.status === 'rejected') throw binding.reason;
                                const payload = parseProjectedSessionByIdResponse({ session: runtimeManagedSubtree
                                    ? SessionRuntimeManagedSubtreeSnapshotRecordV1Schema.parse(session)
                                    : owners.has(session.id) ? { ...session,
                                    acceptedTeamCredentialBinding: binding?.status === 'fulfilled' ? binding.value : null,
                                    pendingActivationAuthorization: activations.get(session.id), pendingExecutionRunIds: pendingRuns.get(session.id) ?? [],
                                } : session });
                                result.set(session.id, { kind: 'found', session: payload.session, observationCursor });
                            } catch (error) { result.set(session.id, sessionDetailFailure(error)); }
                        }
                        return result;
                    })();
                } catch (reason) {
                    // A failed shared DB fact read affects this chunk, not completed or
                    // subsequent chunks. Scalar callers still throw their own result.
                    for (const id of batch) results.set(id, { status: 'rejected', reason });
                    continue;
                }
                for (const [id, row] of captured) results.set(id, row.kind === 'error' ? { status: 'rejected', reason: row.error }
                    : { status: 'fulfilled', value: row.kind === 'found' ? { status: 200, body: {
                        session: row.session, ...(row.observationCursor !== undefined ? { observationCursor: row.observationCursor } : {}),
                    } } : row.response });
            }
        });
    } catch (reason) {
        for (const id of ids) results.set(id, { status: 'rejected', reason });
    }
    return results;
}

/** Scalar consumers use the same admitted fact loader as batches. */
export async function readSessionDetail(input: SessionDetailInput & Readonly<{ sessionId: string }>): Promise<SessionDetailResponse> {
    const result = (await readSessionDetails({ ...input, sessionIds: [input.sessionId] })).get(input.sessionId)!;
    if (result.status === 'rejected') throw result.reason;
    return result.value;
}
export function registerSessionListingRoutes(app: Fastify) {
    registerSessionFilteredListingRoute(app);

    app.get('/v2/sessions/metadata-upgrades', {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "sessions.list") },
        schema: { response: { 200: z.strictObject({ sessionIds: z.array(z.string()) }) } },
    }, async (request, reply) => {
        const sessionIds = await inReadSnapshot(tx => listSessionMetadataPrivacyUpgradeIdsInTx(tx, request.userId));
        return reply.header("Cache-Control", "no-store").send({ sessionIds });
    });

    app.get('/v2/sessions/active', {
        preSerialization: projectSessionTurnWaitingHttpResponse,
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "sessions.list"),
        },
        schema: {
            response: {
                200: V2SessionListResponseSchema,
                409: SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_RESPONSE_SCHEMA,
            },
            querystring: V2_ACTIVE_SESSION_LIST_QUERYSTRING_SCHEMA,
        },
    }, async (request, reply) => {
        const timing = createV2SessionListServerTiming(request);
        try {
            const payload = await listSessionsForAccount({
                userId: request.userId,
                authentication: readSessionAccessAuthenticationFromRequest(request),
                source: {
                    kind: "legacy",
                    storage: "active",
                    activeOnly: true,
                    limit: request.query?.limit ?? V2_ACTIVE_SESSION_LIST_ROW_LIMIT,
                },
                timing,
                rowRepresentabilityWhere: createSessionMetadataListRepresentabilityWhere(
                    readAccountStoredContentCompatibilityForHttpRequest(request),
                ),
            });
            if (!payload) return;
            timing.apply(reply);
            return reply.send(payload);
        } catch (error) {
            if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
            }
            throw error;
        }
    });

    app.get('/v2/sessions', {
        preSerialization: projectSessionTurnWaitingHttpResponse,
        preHandler: app.authenticate,
        schema: {
            response: {
                200: V2SessionListResponseSchema,
                400: z.object({ error: z.literal('Invalid cursor format') }),
                409: SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_RESPONSE_SCHEMA,
            },
            querystring: V2_SESSION_LIST_QUERYSTRING_SCHEMA,
        },
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "sessions.list"),
        },
    }, async (request, reply) => {
        const timing = createV2SessionListServerTiming(request);
        try {
            const payload = await listSessionsForAccount({
                userId: request.userId,
                authentication: readSessionAccessAuthenticationFromRequest(request),
                source: { kind: "legacy", storage: "active", ...request.query },
                timing,
                rowRepresentabilityWhere: createSessionMetadataListRepresentabilityWhere(
                    readAccountStoredContentCompatibilityForHttpRequest(request),
                ),
            });
            if (!payload) return;
            timing.apply(reply);
            return reply.send(payload);
        } catch (error) {
            if (error instanceof SessionListInvalidCursorError) {
                return reply.code(400).send({ error: "Invalid cursor format" });
            }
            if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
            }
            throw error;
        }
    });

    app.get('/v2/sessions/archived', {
        preSerialization: projectSessionTurnWaitingHttpResponse,
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "sessions.list"),
        },
        schema: {
            response: {
                200: V2SessionListResponseSchema,
                400: z.object({ error: z.literal('Invalid cursor format') }),
                409: SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_RESPONSE_SCHEMA,
            },
            querystring: V2_PAGED_SESSION_LIST_QUERYSTRING_SCHEMA,
        },
    }, async (request, reply) => {
        const timing = createV2SessionListServerTiming(request);
        try {
            const payload = await listSessionsForAccount({
                userId: request.userId,
                authentication: readSessionAccessAuthenticationFromRequest(request),
                source: { kind: "legacy", storage: "archived", ...request.query },
                timing,
                rowRepresentabilityWhere: createSessionMetadataListRepresentabilityWhere(
                    readAccountStoredContentCompatibilityForHttpRequest(request),
                ),
            });
            if (!payload) return;
            timing.apply(reply);
            return reply.send(payload);
        } catch (error) {
            if (error instanceof SessionListInvalidCursorError) {
                return reply.code(400).send({ error: "Invalid cursor format" });
            }
            if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
            }
            throw error;
        }
    });

    app.get('/v2/sessions/:sessionId', {
        preSerialization: projectSessionTurnWaitingHttpResponse,
        preHandler: app.authenticate,
        config: {
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.detail"),
            apiTokenSessionAction: "session.transcript.get",
        },
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            querystring: z.optional(z.object({
                accessProjectionVersion: z.optional(z.coerce.number().check(z.int(), z.positive())),
            })),
            response: {
                200: V2SessionByIdResponseSchema,
                403: z.union([
                    z.strictObject({ error: z.literal("team_authentication_required") }),
                    z.strictObject({ error: z.literal(PRESENT_USER_REQUIRED_ERROR) }),
                    z.strictObject({ error: z.literal("credential_scope_denied") }),
                ]),
                404: V2SessionByIdNotFoundSchema,
                409: SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_RESPONSE_SCHEMA,
                426: z.union([
                    OperationUpdateRequiredV1Schema,
                    AnyClientUpgradeRequiredV1Schema,
                ]),
                503: z.strictObject({ error: z.literal("team_authentication_unavailable") }),
            },
        },
    }, async (request, reply) => {
        const result = await readSessionDetail({ userId: request.userId, sessionId: request.params.sessionId, authentication: readSessionAccessAuthenticationFromRequest(request), accessProjectionVersion: request.query?.accessProjectionVersion, storedContentCompatibility: readAccountStoredContentCompatibilityForHttpRequest(request) });
        if (result.status === 200) return reply.serializer(JSON.stringify).code(200).send(parseProjectedSessionByIdResponse(result.body));
        return reply.code(result.status).send(result.body);
    });
}
