import {
    SessionMetadataActiveConflictV1Schema,
    SessionMetadataInactiveModelIntentOwnerPatchV1Schema,
    SessionMetadataInactiveModelIntentPatchV1Schema,
    SessionMetadataInactiveModelIntentPatchSuccessV1Schema,
    SessionMetadataInactiveModelIntentVersionConflictV1Schema,
    SessionMetadataTuplePatchV1Schema,
    SessionMetadataTuplePatchSuccessV1Schema,
    SessionMetadataVersionConflictV1Schema,
    type SessionMetadataInactiveModelIntentExpectationV1,
    type SessionMetadataInactiveModelIntentOwnerPatchV1,
    type SessionMetadataTuplePatchV1,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { apiSocket } from '@/sync/api/session/apiSocket';
import type { UpdateMetadataAck } from '@/sync/domains/session/metadata/updateSessionMetadataWithRetry';

import { createEphemeralServerSocketClient } from './createEphemeralServerSocketClient';
import { createScopedSocketConnectParams } from './createScopedSocketConnectParams';
import {
    createServerRequestForResolvedServerScope,
    type ServerAccountRequestAuthority,
} from './createServerRequestWithServerScope';
import { resolvePreferredServerIdForSessionId } from './resolvePreferredServerIdForSessionId';
import { resolveServerAccountRequestContext } from './resolveServerAccountRequestContext';

type SessionMetadataUpdateScope = Readonly<{
    sessionId: string;
    serverId?: string | null;
    timeoutMs?: number;
    authority?: ServerAccountRequestAuthority;
    isCurrent?: () => boolean;
}>;

type SessionMetadataUpdateParams =
    SessionMetadataUpdateScope & (
        | Readonly<{
            patch:
                | SessionMetadataTuplePatchV1
                | SessionMetadataInactiveModelIntentOwnerPatchV1;
        }>
        | Readonly<{
            expectedVersion: number;
            metadata: string;
            sessionExpectation?:
                SessionMetadataInactiveModelIntentExpectationV1;
        }>
    );

const INVALID_TUPLE_RESPONSE: UpdateMetadataAck = {
    result: 'error',
    message: 'Invalid Session metadata tuple response',
};

function parseSessionMetadataTuplePatch(
    value:
        | SessionMetadataTuplePatchV1
        | SessionMetadataInactiveModelIntentOwnerPatchV1,
):
    | SessionMetadataTuplePatchV1
    | SessionMetadataInactiveModelIntentOwnerPatchV1
    | null {
    const conditioned =
        SessionMetadataInactiveModelIntentOwnerPatchV1Schema.safeParse(
            value,
        );
    if (conditioned.success) {
        return conditioned.data;
    }
    const parsed = SessionMetadataTuplePatchV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function isMetadataPrivacyUpgradeRequiredResponse(
    value: unknown,
): value is Readonly<{
    error: 'Session metadata privacy upgrade required';
    code: 'metadata_privacy_upgrade_required';
}> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return (
        Object.keys(record).length === 2
        && record.error === 'Session metadata privacy upgrade required'
        && record.code === 'metadata_privacy_upgrade_required'
    );
}

async function emitSessionMetadataTuplePatch(params: Readonly<{
    sessionId: string;
    patch:
        | SessionMetadataTuplePatchV1
        | SessionMetadataInactiveModelIntentOwnerPatchV1;
    context: Awaited<ReturnType<typeof resolveServerAccountRequestContext>>;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    assertCurrent: () => void;
}>): Promise<UpdateMetadataAck> {
    const patch = parseSessionMetadataTuplePatch(params.patch);
    if (!patch) {
        return INVALID_TUPLE_RESPONSE;
    }
    params.assertCurrent();
    const response = await params.request(
        `/v2/sessions/${encodeURIComponent(params.sessionId)}`,
        {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        },
    );
    params.assertCurrent();
    const body: unknown = await response.json().catch(() => null);
    params.assertCurrent();

    if (patch.mode === 'owner_migration') {
        if (
            response.status === 409
            && isMetadataPrivacyUpgradeRequiredResponse(body)
        ) {
            return {
                result: 'metadata_privacy_upgrade_required',
                message: body.error,
            };
        }
        if (
            response.status === 409
            && body
            && typeof body === 'object'
            && !Array.isArray(body)
            && (body as Record<string, unknown>).code
                === 'metadata_privacy_upgrade_required'
        ) {
            return INVALID_TUPLE_RESPONSE;
        }
    }

    if (response.status === 200) {
        const parsed = SessionMetadataTuplePatchSuccessV1Schema.safeParse(body);
        if (!parsed.success) {
            return INVALID_TUPLE_RESPONSE;
        }
        return {
            result: 'success',
            metadataLayoutVersion: parsed.data.metadataLayoutVersion,
            version: parsed.data.sharedMetadata.version,
            ...(parsed.data.agentState
                ? { agentStateVersion: parsed.data.agentState.version }
                : {}),
        };
    }

    if (response.status === 409) {
        const activeConflict =
            SessionMetadataActiveConflictV1Schema.safeParse(body);
        if (activeConflict.success) {
            return { result: 'session-active' };
        }
        if (isMetadataPrivacyUpgradeRequiredResponse(body)) {
            return {
                result: 'metadata_privacy_upgrade_required',
                message: body.error,
            };
        }
        const current = SessionMetadataVersionConflictV1Schema.safeParse(body);
        if (!current.success) {
            return INVALID_TUPLE_RESPONSE;
        }
        return {
            result: 'version-mismatch',
            metadataLayoutVersion: current.data.metadataLayoutVersion,
            version: current.data.sharedMetadata.version,
            ...(current.data.agentState
                ? { agentStateVersion: current.data.agentState.version }
                : {}),
        };
    }

    if (
        response.status === 403
        && body
        && typeof body === 'object'
        && !Array.isArray(body)
        && Object.keys(body).length === 1
        && (body as Record<string, unknown>).error === 'Forbidden'
    ) {
        return { result: 'forbidden' };
    }

    return INVALID_TUPLE_RESPONSE;
}

async function emitInactiveModelIntentLegacyPatch(params: Readonly<{
    sessionId: string;
    expectedVersion: number;
    metadata: string;
    sessionExpectation:
        SessionMetadataInactiveModelIntentExpectationV1;
    context: Awaited<ReturnType<typeof resolveServerAccountRequestContext>>;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    assertCurrent: () => void;
}>): Promise<UpdateMetadataAck> {
    const parsed =
        SessionMetadataInactiveModelIntentPatchV1Schema.safeParse({
            inactiveModelIntent: {
                metadata: {
                    ciphertext: params.metadata,
                    expectedVersion: params.expectedVersion,
                },
                sessionExpectation: params.sessionExpectation,
            },
        });
    if (!parsed.success) {
        return INVALID_TUPLE_RESPONSE;
    }
    params.assertCurrent();
    const response = await params.request(
        `/v2/sessions/${encodeURIComponent(params.sessionId)}`,
        {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsed.data),
        },
    );
    params.assertCurrent();
    const body: unknown = await response.json().catch(() => null);
    params.assertCurrent();

    if (response.status === 200) {
        const success =
            SessionMetadataInactiveModelIntentPatchSuccessV1Schema.safeParse(
                body,
            );
        if (success.success) {
            return {
                result: 'success',
                version: success.data.metadata.version,
            };
        }
        const conflict =
            SessionMetadataInactiveModelIntentVersionConflictV1Schema.safeParse(
                body,
            );
        return conflict.success
            ? {
                result: 'version-mismatch',
                version: conflict.data.metadata.version,
                metadata: conflict.data.metadata.value,
            }
            : INVALID_TUPLE_RESPONSE;
    }
    if (response.status === 409) {
        const activeConflict =
            SessionMetadataActiveConflictV1Schema.safeParse(body);
        if (activeConflict.success) {
            return { result: 'session-active' };
        }
        if (isMetadataPrivacyUpgradeRequiredResponse(body)) {
            return {
                result: 'metadata_privacy_upgrade_required',
                message: body.error,
            };
        }
        return INVALID_TUPLE_RESPONSE;
    }
    if (
        response.status === 403
        && body
        && typeof body === 'object'
        && !Array.isArray(body)
        && Object.keys(body).length === 1
        && (body as Record<string, unknown>).error === 'Forbidden'
    ) {
        return { result: 'forbidden' };
    }
    return INVALID_TUPLE_RESPONSE;
}

async function emitLegacySessionMetadataUpdate(params: Readonly<{
    sessionId: string;
    expectedVersion: number;
    metadata: string;
    context: Awaited<ReturnType<typeof resolveServerAccountRequestContext>>;
    assertCurrent: () => void;
    transferCarrierCustody: () => (() => Promise<void>) | undefined;
}>): Promise<UpdateMetadataAck> {
    const payload = {
        sid: params.sessionId,
        expectedVersion: params.expectedVersion,
        metadata: params.metadata,
    };
    params.assertCurrent();
    if (params.context.scope === 'active') {
        const result = await apiSocket.emitWithAck<UpdateMetadataAck>(
            'update-metadata',
            payload,
            { timeoutMs: params.context.timeoutMs },
        );
        params.assertCurrent();
        return result;
    }
    const socket = await createEphemeralServerSocketClient(
        createScopedSocketConnectParams(
            params.context,
            params.transferCarrierCustody,
        ),
    );
    try {
        params.assertCurrent();
        const result = await socket
            .timeout(params.context.timeoutMs)
            .emitWithAck(
                'update-metadata',
                payload,
            ) as UpdateMetadataAck;
        params.assertCurrent();
        return result;
    } finally {
        socket.disconnect();
    }
}

/**
 * Server-scoped transport adapter for the canonical UI metadata writer.
 *
 * Ordinary layout-0 writes retain the compatible active/scoped socket RPC.
 * Conditioned layout-0 model intents and layout-1 tuple writes use the
 * authenticated Session PATCH route. This transport performs no retry and
 * never downgrades a conditioned mutation to the legacy socket.
 */
export async function emitSessionMetadataUpdateWithServerScope(
    params: SessionMetadataUpdateParams,
): Promise<UpdateMetadataAck> {
    const context = params.authority?.context ?? await resolveServerAccountRequestContext({
        serverId:
            typeof params.serverId === 'string'
            && params.serverId.trim().length > 0
                ? params.serverId.trim()
                : resolvePreferredServerIdForSessionId(params.sessionId),
        timeoutMs: params.timeoutMs,
    });
    const ownsContext = !params.authority;
    let ownsCarrierRelease = ownsContext;
    const assertCurrent = (): void => {
        if (params.isCurrent?.() === false) {
            throw Object.assign(new Error('Session Account authority retired during metadata update'), {
                code: 'session_account_scope_retired',
            });
        }
    };
    const request = params.authority?.request ?? createServerRequestForResolvedServerScope({
        context,
        activeRequest: (path, init) => apiSocket.request(path, init),
    });
    try {
    assertCurrent();
    if ('patch' in params) {
        return await emitSessionMetadataTuplePatch({
            sessionId: params.sessionId,
            patch: params.patch,
            context,
            request,
            assertCurrent,
        });
    }
    if (params.sessionExpectation) {
        return await emitInactiveModelIntentLegacyPatch({
            sessionId: params.sessionId,
            expectedVersion: params.expectedVersion,
            metadata: params.metadata,
            sessionExpectation: params.sessionExpectation,
            context,
            request,
            assertCurrent,
        });
    }
    return await emitLegacySessionMetadataUpdate({
        sessionId: params.sessionId,
        expectedVersion: params.expectedVersion,
        metadata: params.metadata,
        context,
        assertCurrent,
        transferCarrierCustody: () => {
            if (params.authority) {
                const transferCarrierCustody = params.authority.transferCarrierCustody;
                if (!transferCarrierCustody) {
                    throw new Error('Server Account authority cannot transfer scoped socket carrier custody');
                }
                return transferCarrierCustody();
            }
            ownsCarrierRelease = false;
            return context.scope === 'scoped' ? context.release : undefined;
        },
    });
    } finally {
        if (ownsCarrierRelease && context.scope === 'scoped') await context.release?.();
    }
}
