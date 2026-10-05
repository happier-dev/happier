import {
    PluginUiDisposeHostResourceRequestV1Schema,
    PluginUiReadSessionRequestV1Schema,
    PluginUiRespondToSessionPermissionRequestV1Schema,
    PluginUiSessionStateV1Schema,
    PluginUiWatchSessionRequestV1Schema,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiJsonValueV1,
    type PluginUiResourceSubscriptionEventV1,
    type PluginUiSessionPermissionAnswerV1,
    type PluginUiSessionStateV1,
} from '@happier-dev/protocol/plugins/ui';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import {
    answerSessionPermission,
    type SessionPermissionAnswerPolicy,
} from '@/sync/ops/sessionPermissionAnswers';
import { listSessionPendingPermissions } from '@/sync/ops/sessionPendingPermissions';
import { createAppSessionTranscriptActions } from '@/components/sessions/transcript/source/appSessionTranscriptActions';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { sessionWorkStatusFactsFromStatus } from '@/components/work/status/sessionWorkStatusFacts';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { getSessionStatus } from '@/utils/sessions/sessionUtils';

import {
    createPluginSurfaceHostApiError,
    type PluginSurfaceHostApiHandlers,
    type PluginSurfaceHostApiRequestOptions,
} from './createPluginSurfaceHostApi';

/**
 * The mounted plugin UI host's linked-Session capability (r0.42):
 * `readSession`, `watchSession` and `respondToSessionPermission`.
 *
 * It owns no Session state. Lifecycle, runtime and operational state come from
 * the canonical awareness projection (`getSessionStatus`), pending requests
 * from the canonical pending-request owner, the viewer's approval capability
 * from the transcript-interaction owner, and answers go through the one
 * permission-answer owner the Session footer uses. Scope is the mounted
 * Account's own Session store: a plugin reaches exactly the Sessions this
 * client can already open, and nothing else.
 *
 * A watch is the same bounded invalidation signal as a Resource watch; it is
 * delivered through the mount's existing invalidation fan-out, so no second
 * subscription channel or registry exists.
 */

type ProjectedPendingPermission = Readonly<{
    toolName: string;
    turnId?: string;
    policy: SessionPermissionAnswerPolicy;
    answers: readonly PluginUiSessionPermissionAnswerV1[];
}>;

type ProjectedSession = Readonly<{
    state: PluginUiSessionStateV1;
    requests: ReadonlyMap<string, ProjectedPendingPermission>;
}>;

function projectSession(session: Session, accountScope: ServerAccountScope | null): ProjectedSession {
    const status = getSessionStatus(session, Date.now(), { workingTextMode: 'static', vibingIndex: 0 });
    const { awareness } = status;
    const workStatus = resolveWorkStatusTone({
        kind: 'session',
        facts: sessionWorkStatusFactsFromStatus(session, status),
    }) satisfies PluginUiSessionStateV1['workStatus'];
    const requests = new Map<string, ProjectedPendingPermission>();
    const pendingPermissions: PluginUiSessionStateV1['pendingPermissions'][number][] = [];
    for (const pending of listSessionPendingPermissions(session, accountScope)) {
        requests.set(pending.requestId, {
            toolName: pending.toolName,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            policy: pending.policy,
            answers: pending.answers,
        });
        pendingPermissions.push({
            requestId: pending.requestId,
            toolName: pending.toolName,
            summary: pending.summary,
            ...(pending.command ? { command: pending.command } : {}),
            ...(pending.createdAtMs !== undefined ? { createdAtMs: pending.createdAtMs } : {}),
            answers: [...pending.answers],
        });
    }
    const state = PluginUiSessionStateV1Schema.parse({
        sessionId: session.id,
        ...(accountScope ? { serverId: accountScope.serverId } : {}),
        ...(awareness.title ? { title: awareness.title } : {}),
        lifecycle: awareness.lifecycle,
        runtime: awareness.runtime,
        operational: awareness.operational.primary,
        workStatus,
        ...(awareness.workspace ? { workspace: awareness.workspace } : {}),
        pendingPermissions,
    });
    return { state, requests };
}

function readProjectedSession(
    sessionId: string,
    accountScope: ServerAccountScope | null,
): ProjectedSession | null {
    const session = storage.getState().sessions[sessionId];
    return session ? projectSession(session, accountScope) : null;
}

function digestSessionState(state: PluginUiSessionStateV1): `sha256:${string}` {
    return `sha256:${bytesToHex(sha256(new TextEncoder().encode(stableJsonStringify(state))))}`;
}

function readPayloadRecord(payload: PluginUiJsonValueV1 | undefined): Readonly<Record<string, PluginUiJsonValueV1>> | null {
    return payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Readonly<Record<string, PluginUiJsonValueV1>>
        : null;
}

type ActiveSessionWatch = Readonly<{ release: () => void }>;

export type PluginSurfaceSessionHandlers = Readonly<{
    handlers: Required<Pick<
        PluginSurfaceHostApiHandlers,
        'readSession' | 'watchSession' | 'respondToSessionPermission' | 'disposeHostResource'
    >>;
    dispose: () => void;
}>;

export function createPluginSurfaceSessionHandlers(input: Readonly<{
    accountScope: ServerAccountScope | null;
    isCurrent: () => boolean;
    /** The mount's one invalidation fan-out, shared with Resource watches. */
    deliver: (event: PluginUiResourceSubscriptionEventV1) => void;
}>): PluginSurfaceSessionHandlers {
    const watches = new Map<string, ActiveSessionWatch>();
    let disposed = false;

    const refusal = (options?: PluginSurfaceHostApiRequestOptions): PluginUiJsonValueV1 | null => {
        if (disposed || !input.isCurrent()) return createPluginSurfaceHostApiError('stale_surface', ['plugin_surface_retired']);
        if (options?.signal?.aborted) return createPluginSurfaceHostApiError('unavailable', ['aborted']);
        return null;
    };

    const releaseWatch = (subscriptionId: string): void => {
        const watch = watches.get(subscriptionId);
        if (!watch) return;
        watches.delete(subscriptionId);
        watch.release();
    };

    const readSession = (
        request: PluginUiHostApiRequestEnvelopeV1,
        options?: PluginSurfaceHostApiRequestOptions,
    ): PluginUiJsonValueV1 => {
        const refused = refusal(options);
        if (refused) return refused;
        const parsed = PluginUiReadSessionRequestV1Schema.safeParse(request.payload);
        if (!parsed.success) return createPluginSurfaceHostApiError('invalid_payload', ['session_read_payload_invalid']);
        return readProjectedSession(parsed.data.sessionId, input.accountScope)?.state ?? null;
    };

    const watchSession = (
        request: PluginUiHostApiRequestEnvelopeV1,
        options?: PluginSurfaceHostApiRequestOptions,
    ): PluginUiJsonValueV1 => {
        const refused = refusal(options);
        if (refused) return refused;
        const record = readPayloadRecord(request.payload);
        const subscriptionId = typeof record?.subscriptionId === 'string' ? record.subscriptionId.trim() : '';
        const parsed = PluginUiWatchSessionRequestV1Schema.safeParse(
            record ? { sessionId: record.sessionId } : undefined,
        );
        if (!subscriptionId || !parsed.success) {
            return createPluginSurfaceHostApiError('invalid_payload', ['session_watch_payload_invalid']);
        }
        if (watches.has(subscriptionId)) {
            return createPluginSurfaceHostApiError('invalid_payload', ['session_watch_subscription_reused']);
        }
        const { sessionId } = parsed.data;
        const initial = readProjectedSession(sessionId, input.accountScope);
        if (!initial) return createPluginSurfaceHostApiError('unavailable', ['session_unavailable']);

        let lastDigest = digestSessionState(initial.state);
        const readInputs = (state: ReturnType<typeof storage.getState>) => ({
            session: state.sessions[sessionId],
            messages: state.sessionMessages?.[sessionId],
        });
        let lastInputs = readInputs(storage.getState());
        const unsubscribe = storage.subscribe((state) => {
            const nextInputs = readInputs(state);
            if (nextInputs.session === lastInputs.session && nextInputs.messages === lastInputs.messages) return;
            lastInputs = nextInputs;
            if (!input.isCurrent()) return;
            if (!nextInputs.session) {
                releaseWatch(subscriptionId);
                input.deliver({
                    version: 1,
                    subscriptionId,
                    kind: 'error',
                    code: 'unavailable',
                    diagnostics: ['session_unavailable'],
                });
                return;
            }
            const digest = digestSessionState(projectSession(nextInputs.session, input.accountScope).state);
            if (digest === lastDigest) return;
            lastDigest = digest;
            input.deliver({ version: 1, subscriptionId, kind: 'invalidated', digest });
        });
        watches.set(subscriptionId, { release: unsubscribe });
        return null;
    };

    const respondToSessionPermission = async (
        request: PluginUiHostApiRequestEnvelopeV1,
        options?: PluginSurfaceHostApiRequestOptions,
    ): Promise<PluginUiJsonValueV1> => {
        const refused = refusal(options);
        if (refused) return refused;
        const parsed = PluginUiRespondToSessionPermissionRequestV1Schema.safeParse(request.payload);
        if (!parsed.success) {
            return createPluginSurfaceHostApiError('invalid_payload', ['session_permission_payload_invalid']);
        }
        const { sessionId, requestId, answer } = parsed.data;
        const projected = readProjectedSession(sessionId, input.accountScope);
        if (!projected) return { status: 'refused', reason: 'sessionUnavailable' };
        const pending = projected.requests.get(requestId);
        if (!pending) return { status: 'refused', reason: 'requestNotPending' };
        if (!pending.answers.includes(answer)) return { status: 'refused', reason: 'answerUnavailable' };
        try {
            await answerSessionPermission({
                requestId,
                ...(pending.turnId ? { turnId: pending.turnId } : {}),
                toolName: pending.toolName,
                answer,
                policy: pending.policy,
                respondToPermission: createAppSessionTranscriptActions(sessionId, input.accountScope?.serverId ?? null).respondToPermission,
            });
        } catch {
            return createPluginSurfaceHostApiError('unavailable', ['session_permission_delivery_failed']);
        }
        return { status: 'answered' };
    };

    const disposeHostResource = (request: PluginUiHostApiRequestEnvelopeV1): PluginUiJsonValueV1 => {
        const parsed = PluginUiDisposeHostResourceRequestV1Schema.safeParse(request.payload);
        // Unknown ids belong to another installed disposer; generic disposal is idempotent.
        if (parsed.success) releaseWatch(parsed.data.subscriptionId);
        return null;
    };

    return Object.freeze({
        handlers: Object.freeze({ readSession, watchSession, respondToSessionPermission, disposeHostResource }),
        dispose: () => {
            if (disposed) return;
            disposed = true;
            for (const subscriptionId of [...watches.keys()]) releaseWatch(subscriptionId);
        },
    });
}
