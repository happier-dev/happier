import { GetOtherAccountFollowResponseV1Schema, SetOtherAccountFollowRequestV1Schema, SetOtherAccountFollowResponseV1Schema, GetSessionFollowResponseSchema, SetSessionFollowRequestSchema, SetSessionFollowResponseSchema, RemoveSessionFollowResponseSchema, SessionFollowErrorResponseSchema, ReplaceSessionVoiceInclusionsRequestSchema, ReplaceSessionVoiceInclusionsResponseSchema, SESSION_FOLLOW_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/api';
import { FollowPolicyV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { parseOtherFollowSourceRefV1 } from '@happier-dev/protocol/sessions/follow/followSourceRefTransportV1';
import { SessionAutoFollowPreferencesV1Schema } from '@happier-dev/protocol/sessions/follow/accountFollow';
import {
    ChangeDeliveryMuteRequestV1Schema,
    ChangeDeliveryMuteResponseV1Schema,
    DeliveryMuteErrorResponseV1Schema,
    ListDeliveryMutesResponseV1Schema,
} from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { z } from "zod/mini";

import { createServerFeatureGatePreHandler } from "@/app/features/catalog/serverFeatureGate";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import {
    getAccountSessionFollow, setAccountSessionFollow, removeAccountSessionFollow,
    getOtherAccountFollow, setOtherAccountFollow, removeOtherAccountFollow,
    getSessionAutoFollowPreferences, setSessionAutoFollowPreferences,
    replaceAccountSessionVoiceInclusions,
    type AccountFollowFailure,
} from "@/app/session/follow/accountFollowService";
import type { Fastify } from "../../types";
import { AccountRouteAuthenticationForbiddenResponseSchema } from "@/app/api/utils/enableAuthentication";
import { changeDeliveryMute, listDeliveryMutes, type DeliveryMuteFailure } from '@/app/session/follow/sessionDeliveryMuteService';
import { SESSION_FOLLOW_RULES_ROUTE_V1, SessionFollowRuleIdV1Schema, SessionFollowRuleErrorResponseV1Schema,
    ListSessionFollowRulesResponseV1Schema, ListSessionFollowRulesRequestV1Schema, GetSessionFollowRuleResponseV1Schema,
    SetSessionFollowRuleRequestV1Schema, SetSessionFollowRuleResponseV1Schema,
    RemoveSessionFollowRuleRequestV1Schema, RemoveSessionFollowRuleResponseV1Schema, type SessionFollowRuleFailureV1,
} from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { getAccountFollowRule, listAccountFollowRules, setAccountFollowRule, removeAccountFollowRule } from '@/app/session/follow/accountFollowRuleService';
import { ListAccountSessionFollowsResponseV1Schema } from '@happier-dev/protocol/sessions/follow/api';
import { FollowListQueryV1Schema, parseFollowListQueryV1, type FollowListRequestV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowListV1';
import { listAccountSessionFollows } from '@/app/session/follow/accountFollowService';
import { SESSION_FOLLOW_PERSONAL_PROGRESS_ROUTE_V1, SessionFollowPersonalProgressRequestV1Schema,
    SessionFollowPersonalProgressResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { acceptAccountFollowPersonalProgress } from '@/app/session/follow/accountFollowPersonalProgress';
import { readCurrentExecutionRunFollowSource } from '@/app/session/follow/executionRunFollowSource';

const paramsSchema = z.strictObject({ sessionId: z.string().check(z.minLength(1)) });
const otherSourceQuerySchema = z.strictObject({ sourceRef: z.string().check(z.minLength(1)) });
const FAILURE_STATUS: Readonly<Record<AccountFollowFailure, 400 | 403 | 404 | 409>> = {
    invalid_parameters: 400, account_inactive: 403, session_not_found: 404, session_archived: 409,
    source_not_found: 404, source_unavailable: 409,
};
const errorResponses = {
    400: SessionFollowErrorResponseSchema,
    403: z.union([SessionFollowErrorResponseSchema, AccountRouteAuthenticationForbiddenResponseSchema]),
    404: SessionFollowErrorResponseSchema, 409: SessionFollowErrorResponseSchema,
};
const MUTE_FAILURE_STATUS: Readonly<Record<DeliveryMuteFailure, 400 | 403 | 404 | 409>> = {
    invalid_parameters: 400, account_inactive: 403, session_not_found: 404, mute_state_unavailable: 409,
};
const muteErrorResponses = {
    400: DeliveryMuteErrorResponseV1Schema,
    403: z.union([DeliveryMuteErrorResponseV1Schema, AccountRouteAuthenticationForbiddenResponseSchema]),
    404: DeliveryMuteErrorResponseV1Schema,
    409: DeliveryMuteErrorResponseV1Schema,
};

/** Authenticated human preference transport; domain admission and writes stay in the Follow owner. */
export function registerSessionFollowRoutes(app: Fastify) {
    const ruleFailureStatus: Readonly<Record<SessionFollowRuleFailureV1, 400 | 403 | 404 | 409>> = {
        invalid_parameters: 400, account_inactive: 403, account_inconsistent: 409, account_mode_mismatch: 409,
        invalid_stored_content: 409, version_conflict: 409, session_not_found: 404, session_archived: 409, credential_scope_denied: 403,
        feature_unavailable: 404,
    };
    const ruleErrors = { 400: SessionFollowRuleErrorResponseV1Schema,
        403: z.union([SessionFollowRuleErrorResponseV1Schema, AccountRouteAuthenticationForbiddenResponseSchema]),
        404: SessionFollowRuleErrorResponseV1Schema, 409: SessionFollowRuleErrorResponseV1Schema };
    const ruleConfig = { allowApiToken: true as const,
        restrictedCredentialBinding: { scope: 'account' as const, allowSessionRuntime: false } };
    const ruleFeature = createServerFeatureGatePreHandler('sessions.following', process.env, { error: 'feature_unavailable' });
    app.get(SESSION_FOLLOW_HTTP_PATHS_V1.otherSource, { preHandler: [app.authenticate, ruleFeature],
        config: { ...ruleConfig, apiTokenSessionAction: 'follow.get' },
        schema: { querystring: otherSourceQuerySchema, response: { 200: GetOtherAccountFollowResponseV1Schema, ...errorResponses } },
    }, async (request, reply) => {
        const query = otherSourceQuerySchema.safeParse(request.query);
        const source = query.success ? parseOtherFollowSourceRefV1(query.data.sourceRef) : null;
        if (!source) return reply.code(400).send({ error: 'invalid_parameters' });
        const result = await getOtherAccountFollow({ accountId: request.userId, source,
            authentication: readSessionAccessAuthenticationFromRequest(request) });
        return result.ok ? reply.send(result.value) : reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
    });
    app.put(SESSION_FOLLOW_HTTP_PATHS_V1.otherSource, { preHandler: [app.authenticate, ruleFeature],
        config: { ...ruleConfig, apiTokenSessionAction: 'follow.set' },
        schema: { querystring: otherSourceQuerySchema, response: { 200: SetOtherAccountFollowResponseV1Schema, ...errorResponses } },
    }, async (request, reply) => {
        const query = otherSourceQuerySchema.safeParse(request.query);
        const source = query.success ? parseOtherFollowSourceRefV1(query.data.sourceRef) : null;
        const body = SetOtherAccountFollowRequestV1Schema.safeParse(request.body);
        if (!source || !body.success) return reply.code(400).send({ error: 'invalid_parameters' });
        const authentication = readSessionAccessAuthenticationFromRequest(request);
        const executionRunFrontier = source.kind === 'execution_run'
            ? await readCurrentExecutionRunFollowSource({ app, accountId: request.userId,
                ...source, authentication,
                outputRefs: body.data.once?.flatMap(once => once.kind === 'output_ready' ? [once.outputRef] : []) }) : null;
        const result = await setOtherAccountFollow({ accountId: request.userId, source, ...body.data,
            authentication, ...(executionRunFrontier?.ok ? { executionRunFrontier: executionRunFrontier.value } : {}) });
        return result.ok ? reply.send(result.value) : reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
    });
    app.delete(SESSION_FOLLOW_HTTP_PATHS_V1.otherSource, { preHandler: [app.authenticate, ruleFeature],
        config: { ...ruleConfig, apiTokenSessionAction: 'follow.remove' },
        schema: { querystring: otherSourceQuerySchema, response: { 200: RemoveSessionFollowResponseSchema, ...errorResponses } },
    }, async (request, reply) => {
        const query = otherSourceQuerySchema.safeParse(request.query);
        const source = query.success ? parseOtherFollowSourceRefV1(query.data.sourceRef) : null;
        if (!source) return reply.code(400).send({ error: 'invalid_parameters' });
        const result = await removeOtherAccountFollow({ accountId: request.userId, source,
            authentication: readSessionAccessAuthenticationFromRequest(request) });
        return result.ok ? reply.send(result.value) : reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
    });
    app.post(SESSION_FOLLOW_PERSONAL_PROGRESS_ROUTE_V1, { preHandler: [app.authenticate, ruleFeature],
        config: { ...ruleConfig, apiTokenSessionAction: 'follow.set' },
        schema: { body: SessionFollowPersonalProgressRequestV1Schema,
            response: { 200: SessionFollowPersonalProgressResponseV1Schema, ...ruleErrors } },
    }, async (request, reply) => {
        const authentication = readSessionAccessAuthenticationFromRequest(request);
        const source = 'original' in request.body ? request.body.original.source : null;
        const frontier = source?.kind === 'execution_run' ? await readCurrentExecutionRunFollowSource({ app,
            accountId: request.userId, authentication, ...source,
            ...('original' in request.body && 'output' in request.body.original
                ? { outputRefs: [request.body.original.output.outputRef] } : {}) }) : null;
        const result = await acceptAccountFollowPersonalProgress({ accountId: request.userId,
            authentication, occurrence: request.body, ...(frontier?.ok ? { executionRunFrontier: frontier.value } : {}) });
        return result.ok ? reply.send(result.value) : reply.code(ruleFailureStatus[result.error]).send({ error: result.error });
    });
    app.get('/v2/account/session-follows', { preHandler: [app.authenticate, ruleFeature], config: { ...ruleConfig, apiTokenSessionAction: 'follow.list' },
        schema: { querystring: FollowListQueryV1Schema, response: { 200: ListAccountSessionFollowsResponseV1Schema, ...errorResponses } },
    }, async (request, reply) => {
        let query: FollowListRequestV1;
        try { query = parseFollowListQueryV1(request.query); }
        catch { return reply.code(400).send({ error: 'invalid_parameters' }); }
        const result = await listAccountSessionFollows({ accountId: request.userId, authentication: readSessionAccessAuthenticationFromRequest(request), ...query });
        return result.ok ? reply.send(result.value) : reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
    });
    app.get(SESSION_FOLLOW_RULES_ROUTE_V1, { preHandler: [app.authenticate, ruleFeature], config: { ...ruleConfig, apiTokenSessionAction: 'follow.list' },
        schema: { response: { 200: ListSessionFollowRulesResponseV1Schema, ...ruleErrors } },
    }, async (request, reply) => {
        const query = ListSessionFollowRulesRequestV1Schema.safeParse(request.query);
        if (!query.success) return reply.code(400).send({ error: 'invalid_parameters' });
        const result = await listAccountFollowRules({ accountId: request.userId, authentication: readSessionAccessAuthenticationFromRequest(request),
            ...(query.data.destinationSessionId ? { destinationSessionId: query.data.destinationSessionId } : {}),
            ...(query.data.sourceSessionId ? { sourceSessionId: query.data.sourceSessionId } : {}) });
        return result.ok ? reply.send(result.value) : reply.code(ruleFailureStatus[result.error]).send({ error: result.error });
    });
    const ruleParams = z.strictObject({ ruleId: SessionFollowRuleIdV1Schema });
    app.get(`${SESSION_FOLLOW_RULES_ROUTE_V1}/:ruleId`, { preHandler: [app.authenticate, ruleFeature], config: { ...ruleConfig, apiTokenSessionAction: 'follow.get' },
        schema: { params: ruleParams, response: { 200: GetSessionFollowRuleResponseV1Schema, ...ruleErrors } },
    }, async (request, reply) => {
        const result = await getAccountFollowRule({ accountId: request.userId, ruleId: request.params.ruleId,
            authentication: readSessionAccessAuthenticationFromRequest(request) });
        return result.ok ? reply.send(result.value) : reply.code(ruleFailureStatus[result.error]).send({ error: result.error });
    });
    app.put(`${SESSION_FOLLOW_RULES_ROUTE_V1}/:ruleId`, { preHandler: [app.authenticate, ruleFeature], config: { ...ruleConfig, apiTokenSessionAction: 'follow.set' },
        schema: { params: ruleParams, response: { 200: SetSessionFollowRuleResponseV1Schema, ...ruleErrors } },
    }, async (request, reply) => {
        const body = SetSessionFollowRuleRequestV1Schema.safeParse(request.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_parameters' });
        const result = await setAccountFollowRule({ accountId: request.userId, ruleId: request.params.ruleId, mutation: body.data,
            authentication: readSessionAccessAuthenticationFromRequest(request) });
        return result.ok ? reply.send(result.value) : reply.code(ruleFailureStatus[result.error]).send({ error: result.error });
    });
    app.delete(`${SESSION_FOLLOW_RULES_ROUTE_V1}/:ruleId`, { preHandler: [app.authenticate, ruleFeature], config: { ...ruleConfig, apiTokenSessionAction: 'follow.remove' },
        schema: { params: ruleParams, response: { 200: RemoveSessionFollowRuleResponseV1Schema, ...ruleErrors } },
    }, async (request, reply) => {
        const body = RemoveSessionFollowRuleRequestV1Schema.safeParse(request.body);
        if (!body.success) return reply.code(400).send({ error: 'invalid_parameters' });
        const result = await removeAccountFollowRule({ accountId: request.userId, ruleId: request.params.ruleId, receiver: body.data.receiver, expectedVersion: body.data.expectedVersion,
            authentication: readSessionAccessAuthenticationFromRequest(request) });
        return result.ok ? reply.send(result.value) : reply.code(ruleFailureStatus[result.error]).send({ error: result.error });
    });
    app.get('/v2/account/session-delivery-mutes', {
        preHandler: app.authenticate,
        config: { allowApiToken: true, apiTokenSessionAction: 'session.delivery.mute.list',
            restrictedCredentialBinding: { scope: 'account', allowSessionRuntime: false } },
        schema: { response: { 200: ListDeliveryMutesResponseV1Schema, ...muteErrorResponses } },
    }, async (request, reply) => {
        const result = await listDeliveryMutes({ accountId: request.userId, receiver: { kind: 'account' },
            authentication: readSessionAccessAuthenticationFromRequest(request) });
        return result.ok ? reply.send(result.value) : reply.code(MUTE_FAILURE_STATUS[result.error]).send({ error: result.error });
    });
    app.put('/v2/account/session-delivery-mutes', {
        preHandler: app.authenticate,
        config: { allowApiToken: true, apiTokenSessionAction: 'session.delivery.mute.set',
            restrictedCredentialBinding: { scope: 'account', allowSessionRuntime: false } },
        schema: { body: ChangeDeliveryMuteRequestV1Schema,
            response: { 200: ChangeDeliveryMuteResponseV1Schema, ...muteErrorResponses } },
    }, async (request, reply) => {
        const result = await changeDeliveryMute({ accountId: request.userId, receiver: { kind: 'account' },
            scope: request.body.scope, operation: 'set', authentication: readSessionAccessAuthenticationFromRequest(request) });
        return result.ok ? reply.send(result.value) : reply.code(MUTE_FAILURE_STATUS[result.error]).send({ error: result.error });
    });
    app.delete('/v2/account/session-delivery-mutes', {
        preHandler: app.authenticate,
        config: { allowApiToken: true, apiTokenSessionAction: 'session.delivery.mute.remove',
            restrictedCredentialBinding: { scope: 'account', allowSessionRuntime: false } },
        schema: { body: ChangeDeliveryMuteRequestV1Schema,
            response: { 200: ChangeDeliveryMuteResponseV1Schema, ...muteErrorResponses } },
    }, async (request, reply) => {
        const result = await changeDeliveryMute({ accountId: request.userId, receiver: { kind: 'account' },
            scope: request.body.scope, operation: 'remove', authentication: readSessionAccessAuthenticationFromRequest(request) });
        return result.ok ? reply.send(result.value) : reply.code(MUTE_FAILURE_STATUS[result.error]).send({ error: result.error });
    });
    app.get('/v2/sessions/:sessionId/delivery-mutes', {
        preHandler: app.authenticate,
        config: { allowApiToken: true, apiTokenSessionAction: 'session.delivery.mute.list',
            restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId' } },
        schema: { params: paramsSchema,
            response: { 200: ListDeliveryMutesResponseV1Schema, ...muteErrorResponses } },
    }, async (request, reply) => {
        const result = await listDeliveryMutes({ accountId: request.userId,
            receiver: { kind: 'session', sessionId: request.params.sessionId },
            authentication: readSessionAccessAuthenticationFromRequest(request) });
        return result.ok ? reply.send(result.value) : reply.code(MUTE_FAILURE_STATUS[result.error]).send({ error: result.error });
    });
    app.put('/v2/sessions/:sessionId/delivery-mutes', {
        preHandler: app.authenticate,
        config: { allowApiToken: true, apiTokenSessionAction: 'session.delivery.mute.set',
            restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId', allowSessionRuntime: false } },
        schema: { params: paramsSchema, body: ChangeDeliveryMuteRequestV1Schema,
            response: { 200: ChangeDeliveryMuteResponseV1Schema, ...muteErrorResponses } },
    }, async (request, reply) => {
        const result = await changeDeliveryMute({ accountId: request.userId,
            receiver: { kind: 'session', sessionId: request.params.sessionId },
            scope: request.body.scope, operation: 'set', authentication: readSessionAccessAuthenticationFromRequest(request) });
        return result.ok ? reply.send(result.value) : reply.code(MUTE_FAILURE_STATUS[result.error]).send({ error: result.error });
    });
    app.delete('/v2/sessions/:sessionId/delivery-mutes', {
        preHandler: app.authenticate,
        config: { allowApiToken: true, apiTokenSessionAction: 'session.delivery.mute.remove',
            restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId', allowSessionRuntime: false } },
        schema: { params: paramsSchema, body: ChangeDeliveryMuteRequestV1Schema,
            response: { 200: ChangeDeliveryMuteResponseV1Schema, ...muteErrorResponses } },
    }, async (request, reply) => {
        const result = await changeDeliveryMute({ accountId: request.userId,
            receiver: { kind: 'session', sessionId: request.params.sessionId },
            scope: request.body.scope, operation: 'remove', authentication: readSessionAccessAuthenticationFromRequest(request) });
        return result.ok ? reply.send(result.value) : reply.code(MUTE_FAILURE_STATUS[result.error]).send({ error: result.error });
    });
    const requireFeature = createServerFeatureGatePreHandler(
        "sessions.following",
        process.env,
        { error: "feature_unavailable" },
    );
    app.get("/v2/sessions/:sessionId/follow", { preHandler: [app.authenticate, requireFeature],
        config: { allowApiToken: true, apiTokenSessionAction: 'follow.get',
            restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId', allowSessionRuntime: false } },
        schema: { params: paramsSchema, response: { 200: GetSessionFollowResponseSchema, ...errorResponses } },
    }, async (request, reply) => {
        const result = await getAccountSessionFollow({ accountId: request.userId, sessionId: request.params.sessionId, authentication: readSessionAccessAuthenticationFromRequest(request) });
        return result.ok ? reply.send(result.value) : reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
    });
    app.put("/v2/sessions/:sessionId/follow", { preHandler: [app.authenticate, requireFeature],
        config: { allowApiToken: true, apiTokenSessionAction: 'follow.set',
            restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId', allowSessionRuntime: false } },
        schema: { params: paramsSchema, response: { 200: SetSessionFollowResponseSchema, ...errorResponses } },
    }, async (request, reply) => {
        const body = SetSessionFollowRequestSchema.safeParse(request.body);
        if (!body.success) return reply.code(400).send({ error: "invalid_parameters" });
        const result = await setAccountSessionFollow({ accountId: request.userId, sessionId: request.params.sessionId, preferences: body.data, authentication: readSessionAccessAuthenticationFromRequest(request) });
        return result.ok ? reply.send(result.value) : reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
    });
    app.delete("/v2/sessions/:sessionId/follow", { preHandler: [app.authenticate, requireFeature],
        config: { allowApiToken: true, apiTokenSessionAction: 'follow.remove',
            restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId', allowSessionRuntime: false } },
        schema: { params: paramsSchema, response: { 200: RemoveSessionFollowResponseSchema, ...errorResponses } },
    }, async (request, reply) => {
        const result = await removeAccountSessionFollow({ accountId: request.userId, sessionId: request.params.sessionId, authentication: readSessionAccessAuthenticationFromRequest(request) });
        return result.ok ? reply.send(result.value) : reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
    });
    app.get("/v2/account/session-follow-preferences", { preHandler: [app.authenticate, requireFeature],
        config: { allowApiToken: true, apiTokenSessionAction: 'follow.preferences.get' },
        schema: { response: { 200: SessionAutoFollowPreferencesV1Schema, ...errorResponses } },
    }, async (request, reply) => {
        const result = await getSessionAutoFollowPreferences({ accountId: request.userId });
        return result.ok ? reply.send(result.value) : reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
    });
    app.put("/v2/account/session-follow-preferences", { preHandler: [app.authenticate, requireFeature],
        config: { allowApiToken: true, apiTokenSessionAction: 'follow.preferences.set' },
        schema: { response: { 200: SessionAutoFollowPreferencesV1Schema, ...errorResponses } },
    }, async (request, reply) => {
        const body = SessionAutoFollowPreferencesV1Schema.safeParse(request.body);
        if (!body.success) return reply.code(400).send({ error: "invalid_parameters" });
        const result = await setSessionAutoFollowPreferences({ accountId: request.userId, preferences: body.data });
        return result.ok ? reply.send(result.value) : reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
    });
    app.put("/v2/account/session-follow-voice-inclusions", { preHandler: [app.authenticate, requireFeature],
        config: { allowApiToken: true },
        schema: { response: { 200: ReplaceSessionVoiceInclusionsResponseSchema, ...errorResponses } },
    }, async (request, reply) => {
        const body = ReplaceSessionVoiceInclusionsRequestSchema.safeParse(request.body);
        if (!body.success) return reply.code(400).send({ error: "invalid_parameters" });
        const result = await replaceAccountSessionVoiceInclusions({
            accountId: request.userId,
            sessionIds: body.data.sessionIds,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        return result.ok ? reply.send(result.value) : reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
    });
}
