import { openSessionStoredContent, sealSessionStoredContent } from '@happier-dev/sync-client';
import { UsageSessionWorkFactsV1Schema, type UsageSessionWorkFactsV1, createUsageSessionWorkFactsV1, readCurrentUsageSessionWorkFactsV1,
    projectSessionUsageWorkEvidence, USAGE_SESSION_WORK_FACTS_SYSTEM_RECORD_ADDRESS } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER, SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE,
    SessionSystemRecordStoredUpsertRequestSchema, SessionSystemRecordStoredUpsertResponseSchema,
    readSessionSystemRecordErrorCodeV1 } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import type { UsageSessionEvidenceResponse } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { resolveScopedSessionEncryption } from '@/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey';
import type { UsageQueryAccountContext } from './usageQueryResource';
import type { SessionInputEvidence } from './usageQuerySessionInputs';
import type { UsageSessionInput } from '@/sync/domains/usage/usageWorkEvidence';
import { SessionPartsInvalidResponseError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionBatchForAuthority';
import { normalizeSessionAccessProjection } from '@/sync/engine/sessions/normalizeSessionAccessProjection';

type OpeningContext = Parameters<typeof resolveScopedSessionEncryption>[0]['context'];

/** Opens only the Session's small fact envelope, using its already-admitted key tuple. */
export async function openUsageCompactInput(input: Readonly<{
    context: UsageQueryAccountContext; opening: OpeningContext;
    row: UsageSessionEvidenceResponse['results'][number]; isCurrent(): boolean;
}>): Promise<SessionInputEvidence> {
    const compact = input.row.workFacts;
    if (!compact || compact.session.id !== input.row.sessionId || input.row.turns?.status !== 200) {
        throw new SessionPartsInvalidResponseError();
    }
    const identity = compact.session;
    const contentContext = identity.encryptionMode === 'plain' ? { mode: 'plain' as const }
        : { mode: 'e2ee' as const, encryption: await resolveScopedSessionEncryption({ context: input.opening,
            sessionId: identity.id, admittedSession: { ...identity, isCurrent: input.isCurrent } }) };
    let fact: UsageSessionWorkFactsV1 | undefined;
    if (compact.content !== null) {
        const opened = await openSessionStoredContent(contentContext, compact.content);
        if (opened.status !== 'ready') throw Object.assign(new Error('Usage Session fact cannot be opened'), {
            code: `usage_work_facts_${opened.status}`,
        });
        const parsed = UsageSessionWorkFactsV1Schema.safeParse(opened.value);
        if (!parsed.success) throw Object.assign(new Error('Usage Session fact is invalid'), { code: 'usage_work_facts_invalid' });
        fact = parsed.data;
    }
    const current = readCurrentUsageSessionWorkFactsV1({ ...identity, usageWorkFactsV1: fact });
    const session: UsageSessionInput = {
        ...current?.session, id: identity.id, serverId: input.context.accountLifetime.scope.serverId,
        seq: identity.seq, createdAt: identity.createdAt, updatedAt: identity.updatedAt, active: identity.active,
        metadataVersion: identity.metadataVersion, agentStateVersion: identity.agentStateVersion,
        metadataLayoutVersion: identity.metadataLayoutVersion, encryptionMode: identity.encryptionMode,
        encryptedContentAvailability: 'ready', access: normalizeSessionAccessProjection({ effectiveAccess: identity.access }) ?? undefined,
        metadata: current?.session?.metadata ?? null, agentState: null,
        ownerMetadata: current?.session?.ownerMetadata ?? null, agentTarget: current?.session?.agentTarget ?? null,
        sessionTurns: input.row.turns.body, ...(current ? { usageWorkFactsV1: current } : {}),
    };
    return { session, callerDataKeyEnvelope: identity.dataEncryptionKey,
        detail: projectSessionUsageWorkEvidence(session), completeMessageCoverage: current !== null,
        sessionContextComplete: current?.session !== undefined,
        ...(current ? { messageEvidence: { acceptedInputs: current.evidence.acceptedInputs,
            phaseEvents: current.evidence.phaseEvents, collaboration: current.evidence.collaboration,
            coach: current.evidence.coach } } : {}) };
}

/** The read-once boundary already holds opened bodies and the Session's existing encryption owner. */
export async function persistUsageCompactInput(input: Readonly<{
    context: UsageQueryAccountContext; opening: OpeningContext; value: SessionInputEvidence;
    signal?: AbortSignal; isCurrent(): boolean;
}>): Promise<boolean> {
    if (!input.value.completeMessageCoverage) return false;
    const { session } = input.value;
    const fact = createUsageSessionWorkFactsV1(session, input.value.detail);
    if (!readCurrentUsageSessionWorkFactsV1({ ...session, usageWorkFactsV1: fact })) return false;
    const contentContext = session.encryptionMode === 'plain' ? { mode: 'plain' as const }
        : { mode: 'e2ee' as const, encryption: await resolveScopedSessionEncryption({ context: input.opening,
            sessionId: session.id, admittedSession: { id: session.id, encryptionMode: 'e2ee',
                dataEncryptionKey: input.value.callerDataKeyEnvelope, viewerRole: session.access?.role ?? 'recipient',
                isCurrent: input.isCurrent } }) };
    const payload = projectNativeJsonValueForTransport(fact);
    const sealed = await sealSessionStoredContent(contentContext, payload);
    if (sealed.status !== 'ready') throw Object.assign(new Error('Usage Session fact cannot be sealed'), { code: 'encryption_material_unavailable' });
    const body = SessionSystemRecordStoredUpsertRequestSchema.parse({ address: USAGE_SESSION_WORK_FACTS_SYSTEM_RECORD_ADDRESS,
        content: sealed.content });
    const response = await input.context.request(`/v2/sessions/${encodeURIComponent(session.id)}/system-records`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json',
            [SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER]: SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE },
        body: JSON.stringify(body), signal: input.signal,
    });
    const result: unknown = await response.json();
    if (!response.ok) throw Object.assign(new Error('Usage Session fact was not saved'), {
        code: readSessionSystemRecordErrorCodeV1(result) ?? 'usage_work_facts_write_failed',
    });
    if (!SessionSystemRecordStoredUpsertResponseSchema.safeParse(result).success) throw new SessionPartsInvalidResponseError();
    return true;
}
