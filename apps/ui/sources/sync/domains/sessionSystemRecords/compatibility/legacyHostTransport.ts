import {
    LegacyHostSessionSystemRecordLookupResponseSchema,
} from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { SessionSystemRecordCompatibilityOpenInput } from '../codec';
import type { SessionSystemRecordFetchResult, SessionSystemRecordTransportOptions } from '../transport';

export type LegacyWorkflowRecordProjection = SessionSystemRecordCompatibilityOpenInput;

export type WorkflowSystemRecordQuerySelection =
    | Readonly<{
        status: 'ready';
        query:
            | Readonly<{ type: 'legacy_workflow'; localId: string }>
            | Readonly<{
                type: 'read';
                address: Readonly<{
                    owner: 'host';
                    namespace: 'activity';
                    kind: 'workflow_run.v1';
                    localId: string;
                }>;
            }>;
    }>
    | Readonly<{ status: 'protocol_unavailable' }>;

/**
 * Selects the released/predecessor reader before issuing any record request.
 * Absence selects the revisionless workflow seam; an explicit advertisement
 * that omits V1 is unsupported and must never be reinterpreted as legacy.
 */
export function selectWorkflowSystemRecordQuery(params: Readonly<{
    localId: string;
    protocolVersions: readonly number[] | null;
}>): WorkflowSystemRecordQuerySelection {
    if (params.protocolVersions === null) {
        return { status: 'ready', query: { type: 'legacy_workflow', localId: params.localId } };
    }
    if (!params.protocolVersions.includes(1)) return { status: 'protocol_unavailable' };
    return {
        status: 'ready',
        query: {
            type: 'read',
            address: {
                owner: 'host',
                namespace: 'activity',
                kind: 'workflow_run.v1',
                localId: params.localId,
            },
        },
    };
}

/**
 * Read-only server-v0.2.12 / prospective ../0.2 workflow seam.
 * Remove once neither the moving predecessor nor a supported released Home
 * needs the revisionless workflow route. Never select this after a strict read fails.
 */
export async function readLegacyWorkflowSystemRecord(
    options: SessionSystemRecordTransportOptions,
    session: SessionAddress,
    localId: string,
): Promise<SessionSystemRecordFetchResult<LegacyWorkflowRecordProjection>> {
    if (!areServerProfileIdentifiersEquivalent(session.serverId, options.scope.serverId)) return { status: 'forbidden' };
    try {
        const query = new URLSearchParams({ namespace: 'activity', localId });
        const response = await options.request(`/v2/sessions/${encodeURIComponent(session.sessionId)}/system-records/record?${query}`, { method: 'GET' });
        let json: unknown;
        try { json = await response.json(); } catch { return { status: 'invalid_response' }; }
        if (!response.ok) {
            // These exact legacy bodies come from the predecessor route owner.
            const error = json && typeof json === 'object' && 'error' in json ? json.error : null;
            if (response.status === 403 && error === 'Forbidden') return { status: 'forbidden' };
            if (response.status === 404 && error === 'Session not found') return { status: 'not_found' };
            if (response.status === 500 && error === 'Failed to fetch system record') return { status: 'server_error', retryable: true };
            return { status: 'invalid_response' };
        }
        const parsed = LegacyHostSessionSystemRecordLookupResponseSchema.safeParse(json);
        if (!parsed.success) return { status: 'invalid_response' };
        const record = parsed.data.record;
        if (!record) return { status: 'not_found' };
        if (record.sessionId !== session.sessionId || record.namespace !== 'activity' || record.kind !== 'workflow_run.v1' || record.localId !== localId) return { status: 'invalid_response' };
        return {
            status: 'ok',
            value: {
                source: 'legacy-host-compatibility',
                address: { owner: 'host', namespace: 'activity', kind: 'workflow_run.v1', localId },
                content: record.content,
            },
        };
    } catch { return { status: 'offline' }; }
}
