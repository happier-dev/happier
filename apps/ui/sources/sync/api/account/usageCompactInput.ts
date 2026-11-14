import { openSessionStoredContent, sealSessionStoredContent } from '@happier-dev/sync-client';
import { UsageSessionFactRecordV1Schema, type UsageSessionFactRecordV1, createUsageSessionFactRecordsV1,
    readCurrentUsageSessionFactRecordV1, projectSessionUsageWorkEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
import { getUsageSessionFactRecordAddress, type UsageSessionFactKindV1 } from '@happier-dev/protocol/usage/usageSessionFactKinds';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { SESSION_SYSTEM_RECORDS_PROTOCOL_HTTP_HEADER, SESSION_SYSTEM_RECORDS_PROTOCOL_V1_HTTP_HEADER_VALUE,
    SessionSystemRecordStoredUpsertRequestSchema, SessionSystemRecordStoredUpsertResponseSchema,
    readSessionSystemRecordErrorCodeV1 } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import type { UsageSessionEvidenceResponse } from '@happier-dev/protocol/usage/usageSessionEvidence';
import type { AccountEncryptionIdentity } from '@happier-dev/sync-client';
import { resolveScopedSessionEncryption } from '@/sync/runtime/orchestration/serverScopedRpc/resolveScopedSessionDataKey';
import type { UsageQueryAccountContext } from './usageQueryResource';
import type { SessionInputEvidence } from './usageQuerySessionInputs';
import type { UsageSessionInput } from '@/sync/domains/usage/usageWorkEvidence';
import { SessionPartsInvalidResponseError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionBatchForAuthority';
import { normalizeSessionAccessProjection } from '@/sync/engine/sessions/normalizeSessionAccessProjection';

type OpeningContext = Parameters<typeof resolveScopedSessionEncryption>[0]['context'];

/** Opens the admitted fact envelope; null requests the ordinary summary projection. */
export async function openUsageCompactInput(input: Readonly<{
    context: UsageQueryAccountContext; opening: OpeningContext;
    row: UsageSessionEvidenceResponse['results'][number]; isCurrent(): boolean;
    /** This operation's Account currentness owner, for the remedy of an unopenable Session. */
    readAccountCurrentness?: () => Promise<AccountEncryptionIdentity>;
    recordKinds?: readonly UsageSessionFactKindV1[];
}>): Promise<SessionInputEvidence | null> {
    const compact = input.row.workFacts;
    if (!compact || compact.session.id !== input.row.sessionId) {
        throw new SessionPartsInvalidResponseError();
    }
    const identity = compact.session;
    const requested = input.recordKinds ?? ['work'];
    if (compact.records.length !== requested.length || requested.some(kind => compact.records.filter(record => record.kind === kind).length !== 1)) {
        throw new SessionPartsInvalidResponseError();
    }
    const contentContext = identity.encryptionMode === 'plain' ? { mode: 'plain' as const }
        : { mode: 'e2ee' as const, encryption: await resolveScopedSessionEncryption({ context: input.opening,
            sessionId: identity.id, admittedSession: { ...identity, isCurrent: input.isCurrent },
            ...(input.readAccountCurrentness ? { readAccountCurrentness: input.readAccountCurrentness } : {}) }) };
    const facts: UsageSessionFactRecordV1[] = [];
    for (const record of compact.records) {
        if (record.content === null) continue;
        const opened = await openSessionStoredContent(contentContext, record.content);
        if (opened.status !== 'ready') throw Object.assign(new Error('Usage Session fact cannot be opened'), {
            code: `usage_work_facts_${opened.status}`,
        });
        const parsed = UsageSessionFactRecordV1Schema.safeParse(opened.value);
        if (!parsed.success) return null;
        if (parsed.data.kind !== record.kind) throw new SessionPartsInvalidResponseError();
        const current = readCurrentUsageSessionFactRecordV1(identity, parsed.data);
        if (current) facts.push(current);
    }
    const work = facts.find(fact => fact.kind === 'work');
    const coach = facts.find(fact => fact.kind === 'coach');
    const needsCoach = requested.includes('coach');
    const current = work ? { ...work, evidence: { ...work.evidence, ...(needsCoach ? {
        coach: coach?.evidence ?? { compositionCoverage: 'unknown' as const,
            detail: { ...work.evidence.coach?.detail, coverage: 'unknown' as const } },
    } : {}) } } : null;
    if (!current && input.row.turns?.status !== 200) return null;
    const session: UsageSessionInput = {
        ...current?.session, id: identity.id, serverId: input.context.accountLifetime.scope.serverId,
        seq: identity.seq, createdAt: identity.createdAt, updatedAt: identity.updatedAt, active: identity.active,
        metadataVersion: identity.metadataVersion, agentStateVersion: identity.agentStateVersion,
        metadataLayoutVersion: identity.metadataLayoutVersion, encryptionMode: identity.encryptionMode,
        encryptedContentAvailability: 'ready', access: normalizeSessionAccessProjection({ effectiveAccess: identity.access }) ?? undefined,
        metadata: current?.session?.metadata ?? null, agentState: null,
        ownerMetadata: current?.session?.ownerMetadata ?? null, agentTarget: current?.session?.agentTarget ?? null,
        ...(input.row.turns?.status === 200 ? { sessionTurns: input.row.turns.body } : {}),
        ...(current ? { usageWorkFactsV1: current } : {}),
    };
    return { session, callerDataKeyEnvelope: identity.dataEncryptionKey,
        detail: projectSessionUsageWorkEvidence(session), completeMessageCoverage: current !== null && (!needsCoach || coach !== undefined),
        sessionContextComplete: current?.session !== undefined,
        ...(current ? { messageEvidence: { acceptedInputs: current.evidence.acceptedInputs,
            phaseEvents: current.evidence.phaseEvents, collaboration: current.evidence.collaboration,
            coach: current.evidence.coach } } : {}) };
}

/** The read-once boundary already holds opened bodies and the Session's existing encryption owner. */
export async function persistUsageCompactInput(input: Readonly<{
    context: UsageQueryAccountContext; opening: OpeningContext; value: SessionInputEvidence;
    signal?: AbortSignal; isCurrent(): boolean;
    readAccountCurrentness?: () => Promise<AccountEncryptionIdentity>;
}>): Promise<boolean> {
    if (!input.value.completeMessageCoverage) return false;
    const { session } = input.value;
    const facts = createUsageSessionFactRecordsV1(session, input.value.detail);
    if (!readCurrentUsageSessionFactRecordV1(session, facts[0])) return false;
    const contentContext = session.encryptionMode === 'plain' ? { mode: 'plain' as const }
        : { mode: 'e2ee' as const, encryption: await resolveScopedSessionEncryption({ context: input.opening,
            sessionId: session.id, admittedSession: { id: session.id, encryptionMode: 'e2ee',
                dataEncryptionKey: input.value.callerDataKeyEnvelope, viewerRole: session.access?.role ?? 'recipient',
                isCurrent: input.isCurrent },
            ...(input.readAccountCurrentness ? { readAccountCurrentness: input.readAccountCurrentness } : {}) }) };
    // Publish work last: it marks conversion complete only after its Coach sibling was saved.
    for (const fact of [...facts].reverse()) {
        const payload = projectNativeJsonValueForTransport(fact);
        const sealed = await sealSessionStoredContent(contentContext, payload);
        if (sealed.status !== 'ready') throw Object.assign(new Error('Usage Session fact cannot be sealed'), { code: 'encryption_material_unavailable' });
        const body = SessionSystemRecordStoredUpsertRequestSchema.parse({ address: getUsageSessionFactRecordAddress(fact.kind),
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
    }
    return true;
}
