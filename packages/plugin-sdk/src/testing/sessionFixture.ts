import type {
    PluginSessionGetParamsV1,
    PluginSessionsServiceV1,
    PluginSessionWatchEventV1,
} from '../sessions/index.js';
import type {
    SessionAgentStateWriteRequestV1,
    SessionMetadataWriteRequestV1,
    SessionPermissionDecisionRequestV1,
    SessionPermissionDecisionResultV1,
    SessionScopedServicesV1,
    SessionScopedSubscriptionEventV1,
    SessionStateFieldWriteRequestV1,
} from '../sessions/scoped.js';
import type {
    PluginContextFixtureOptionsV1,
    PluginContextFixtureRecordsV1,
} from './contextFixtureTypes.js';
import { notConfigured } from './fixtureRuntimeServices.js';
import { createSubscription } from './subscription.js';

export function createSessionServices(
    records: PluginContextFixtureRecordsV1,
    options: PluginContextFixtureOptionsV1,
): SessionScopedServicesV1 {
    const writeMetadata = async (request: SessionMetadataWriteRequestV1): Promise<void> => {
        records.sessionMetadataWrites.push(request);
        await options.onSessionMetadataWrite?.(request);
    };
    const writeAgentState = async (request: SessionAgentStateWriteRequestV1): Promise<void> => {
        records.sessionAgentStateWrites.push(request);
        await options.onSessionAgentStateWrite?.(request);
    };
    const writeStateField = async (request: SessionStateFieldWriteRequestV1): Promise<void> => {
        records.sessionStateFieldWrites.push(request);
        await options.onSessionStateFieldWrite?.(request);
    };
    const requestDecision = async (
        request: SessionPermissionDecisionRequestV1,
    ): Promise<SessionPermissionDecisionResultV1> => {
        if (options.onPermissionDecision) return options.onPermissionDecision(request);
        return { decision: 'approved' };
    };
    return {
        sessionId: options.sessionId,
        hasProviderAcceptedUserMessageDelivery: options.hasProviderAcceptedUserMessageDelivery,
        async send(request) {
            records.sessionSends.push(request);
            return { ok: true };
        },
        subscribe(_request, _onEvent: (event: SessionScopedSubscriptionEventV1) => void) {
            return createSubscription();
        },
        writeMetadata,
        writeAgentState,
        writeStateField,
        mcp: {
            async elicit() {
                return { status: 'unavailable', reason: 'fixture_unavailable' };
            },
        },
        auth: {
            services: {
                async refreshRuntimeAuth() {
                    return { status: 'unavailable', reason: 'fixture_unavailable' };
                },
            },
        },
        permissions: {
            requestDecision,
            getMode() {
                return 'default';
            },
        },
        subagents: {
            async list() {
                return [];
            },
            async get() {
                return null;
            },
            watch() {
                return createSubscription();
            },
            upsert: () => notConfigured('session.subagents.upsert'),
            async updateStatus(params) {
                return notConfigured(`session.subagents.updateStatus:${params.id}`);
            },
            async complete(params) {
                return notConfigured(`session.subagents.complete:${params.id}`);
            },
        },
        external: {
            async listCandidates() {
                return { candidates: [], nextCursor: null };
            },
            async attach() {
                return { ok: false, error: 'fixture_unavailable' };
            },
            async takeover() {
                return { ok: false, errorCode: 'capability_unsupported', error: 'fixture_unavailable' };
            },
            async pageTranscript() {
                return { ok: true, items: [], nextCursor: null, tailCursor: null, hasMore: false, truncated: false };
            },
            async readAfterTranscript() {
                return { ok: true, items: [], nextCursor: null, truncated: false };
            },
            followTranscript() {
                return createSubscription();
            },
        },
    };
}

export function createPluginSessionsService(
    session: SessionScopedServicesV1,
): PluginSessionsServiceV1 {
    return {
        ...session,
        current: session,
        permissions: {
            async forSession() {
                return session.permissions;
            },
        },
        async list() {
            return [];
        },
        async get(params: PluginSessionGetParamsV1) {
            const sessionId = typeof params === 'string' ? params : params.sessionId;
            return sessionId === session.sessionId || !session.sessionId ? session : null;
        },
        watch(_params, onEvent: (event: PluginSessionWatchEventV1) => void) {
            onEvent({ kind: 'snapshot', sessions: [] });
            return createSubscription();
        },
    };
}
