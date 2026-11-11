import { approvalArtifactBodyMatchesHeaderV1, readApprovalArtifactHeaderListFactsV1, readApprovalRequestArtifactSubjectKeyV1,
    readOpenWorkflowPublicationApprovalTargetV1, readWorkflowPublicationApprovalHeaderRunIdV1,
    readApprovalArtifactAdmissionV1, type ParsedApprovalArtifactBodyV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ApprovalRequestV2Schema, type ApprovalRequest, type ApprovalRequesterConfirmationV1, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';

import type { DecryptedArtifact } from './artifactTypes';
import type { SessionAddress } from '../session/sessionAddress';

export type OpenApprovalSessionReference = Readonly<
    | { kind: 'exact'; address: SessionAddress }
    | { kind: 'legacy_unscoped'; sessionId: string }
>;
export type SessionReferenceFact = Readonly<{
    reference: OpenApprovalSessionReference;
    sortKey: string;
}> & { addressKey?: string };
type SessionReferenceIndex = Map<string | null, Map<string, SessionReferenceFact>>;

/** Undefined needs legacy discovery; null has no Run relation. Only this owner interprets old bodies. */
export function readWorkflowPublicationApprovalRunId(artifact: DecryptedArtifact | undefined): string | null | undefined {
    if (!artifact?.isDecrypted || artifact.draft
        || (artifact.header?.kind !== APPROVAL_ARTIFACT_KINDS_V1.builtIn && artifact.header?.kind !== APPROVAL_ARTIFACT_KINDS_V1.targetAction)
        || artifact.header.approvalStatus !== 'open') return null;
    const indexed = readWorkflowPublicationApprovalHeaderRunIdV1(artifact.header);
    if (indexed !== undefined) return indexed;
    if (typeof artifact.body !== 'string') return undefined;
    return readOpenWorkflowPublicationApprovalTargetV1(readOpenApprovalInboxArtifact(artifact))?.runId ?? null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function addSessionReference(references: SessionReferenceIndex, value: unknown, serverId?: unknown): void {
    const sessionId = readString(value);
    if (!sessionId) return;
    const normalizedServerId = readString(serverId);
    const sessions = references.get(normalizedServerId) ?? new Map<string, SessionReferenceFact>();
    if (sessions.has(sessionId)) return;
    const reference: OpenApprovalSessionReference = normalizedServerId
        ? { kind: 'exact', address: { serverId: normalizedServerId, sessionId } }
        : { kind: 'legacy_unscoped', sessionId };
    sessions.set(sessionId, { reference, sortKey: JSON.stringify(reference) });
    references.set(normalizedServerId, sessions);
}

/** Raw relationship facts only; Home aliases and membership remain live reader decisions. */
export function readApprovalArtifactHeaderReferenceFacts(artifact: DecryptedArtifact): readonly SessionReferenceFact[] {
    const header = artifact.header;
    if (!header) return [];
    const references: SessionReferenceIndex = new Map();
    const serverId = readString(artifact.sourceServerId) ?? readString(header.serverIdentityId) ?? readString(header.serverId);
    for (const sessionId of readApprovalArtifactHeaderSessionIds(artifact)) addSessionReference(references, sessionId, serverId);
    return [...references.values()].flatMap(sessions => [...sessions.values()]);
}

export function collectApprovalLinkedSessionReferences(
    snapshot: Readonly<{ header: NonNullable<DecryptedArtifact['header']>; headerReferences: readonly SessionReferenceFact[] }>,
    parsed?: ParsedApprovalArtifactBodyV1 | null,
): readonly SessionReferenceFact[] {
    const references: SessionReferenceIndex = new Map();
    for (const fact of snapshot.headerReferences) {
        const reference = fact.reference;
        const serverId = reference.kind === 'exact' ? reference.address.serverId : null;
        const sessionId = reference.kind === 'exact' ? reference.address.sessionId : reference.sessionId;
        const sessions = references.get(serverId) ?? new Map<string, SessionReferenceFact>();
        sessions.set(sessionId, fact);
        references.set(serverId, sessions);
    }
    if (parsed?.family === 'target_action') {
        const approval = parsed.request;
        addSessionReference(references,
            approval.executionOriginV1?.sessionId ?? approval.replayPlacement?.defaultSessionId ?? approval.createdBy.sessionId,
            approval.executionOriginV1?.serverIdentityId ?? approval.executionOriginV1?.serverId
                ?? approval.replayPlacement?.serverId ?? readString(snapshot.header.serverId));
    } else if (parsed?.family === 'built_in' && parsed.request.v === 2) {
        const approval = parsed.request;
        addSessionReference(references, approval.executionOriginV1.sessionId ?? approval.createdBy.sessionId,
            approval.executionOriginV1.serverIdentityId ?? approval.executionOriginV1.serverId);
    } else {
        addSessionReference(references, parsed?.family === 'built_in' ? parsed.request.createdBy.sessionId : null,
            readString(snapshot.header.serverIdentityId) ?? readString(snapshot.header.serverId));
    }
    return [...references.values()].flatMap(sessions => [...sessions.values()]);
}

/** Header relationships are discovery facts, never approval or Home authority. */
export function readApprovalArtifactHeaderSessionIds(artifact: DecryptedArtifact): readonly string[] {
    if (!artifact.header) return [];
    const values: unknown[] = [artifact.header.sessionId,
        ...(Array.isArray(artifact.sessions) ? artifact.sessions : []),
        ...(Array.isArray(artifact.header.sessions) ? artifact.header.sessions : [])];
    return [...new Set(values.flatMap(value => typeof value === 'string' && value.trim() ? [value.trim()] : []))];
}

export type ApprovalDiscussionAddress = Readonly<{ serverId: string; discussionId: string }>;
export type DiscussionRequesterApproval = Readonly<{
    artifact: DecryptedArtifact;
    parsed: Extract<ParsedApprovalArtifactBodyV1, { family: 'built_in' | 'target_action' }>;
    requestRef: string;
    originMessageId: string;
}> & Readonly<
    | { kind: 'requester_confirmation'; subject: ApprovalRequesterConfirmationV1 }
    | { kind: 'request'; subject: null }
>;

/** The admitted body owns the requester cause for discovery and presentation alike. */
export function readDiscussionRequesterApprovalFact(artifact: DecryptedArtifact):
    (DiscussionRequesterApproval & Readonly<{ discussion: ApprovalDiscussionAddress }>) | null {
    if (artifact.draft === true || typeof artifact.body !== 'string') return null;
    const parsed = readAdmittedApprovalArtifactBody(artifact)?.parsed;
    if (!parsed || parsed.family === 'execution_run_host_action') return null;
    const request = parsed.family === 'target_action' ? parsed.request : parsed.request.v === 2 ? parsed.request : null;
    if (!request) return null;
    const subject = request.requesterConfirmation;
    const cause = request.executionOriginV1?.actionRequestAttributionV1;
    const origin = cause?.origin;
    if (!cause || origin?.kind !== 'discussion'
        || (!subject && request.status !== 'open' && request.status !== 'outcome_unknown')) return null;
    const waiting = !subject ? readOpenApprovalDiscussionAttention(artifact) : null;
    const executionOrigin = request.executionOriginV1;
    if (waiting?.discussionId === origin.discussion.discussionId
        && (origin.discussion.serverId === executionOrigin?.serverId
            || origin.discussion.serverId === executionOrigin?.serverIdentityId)) return null;
    // The immutable ask links ordinary own-agent requests too. Only the request's
    // explicit confirmation subject establishes cross-person consent.
    return { artifact, parsed, ...(subject ? { kind: 'requester_confirmation' as const, subject } : { kind: 'request' as const, subject: null }),
        requestRef: cause.requestRef, originMessageId: origin.messageId,
        discussion: origin.discussion };
}

export type OpenApprovalArtifactForSession<
    TApproval extends ApprovalRequest | TargetActionApprovalRequestV1 = ApprovalRequest,
> = Readonly<{
    /** Routing facts only; current grants and detail content stay with the Artifact owner. */
    artifact: Pick<DecryptedArtifact, 'id' | 'header'>;
    approval: TApproval;
}>;

export type OpenApprovalAttentionArtifactForSession = OpenApprovalArtifactForSession<ApprovalRequest | TargetActionApprovalRequestV1>;

type AdmittedApprovalBody = Readonly<{
    body: string | null;
    parsed: ParsedApprovalArtifactBodyV1 | null;
    disposition: 'presented' | 'not_presented' | 'unreadable';
    subjectKey: string | null;
    sessionEntry: OpenApprovalAttentionArtifactForSession | null;
}>;

// The producer retains immutable header/body slices. Each weak header key holds
// only its current body admission, including refusals, shared by every surface.
const admittedApprovalBodies = new WeakMap<NonNullable<DecryptedArtifact['header']>, AdmittedApprovalBody>();

/** Pure admission: safe during store construction, without Home/profile/runtime imports. */
export function readAdmittedApprovalArtifactBody(artifact: DecryptedArtifact): AdmittedApprovalBody | null {
    const header = artifact.header;
    if (!header) return null;
    const body = typeof artifact.body === 'string' ? artifact.body : null;
    const admitted = admittedApprovalBodies.get(header);
    if (admitted?.body === body && (!admitted.sessionEntry || admitted.sessionEntry.artifact.id === artifact.id)) return admitted;
    const strict = admitted?.body === body ? admitted.parsed : approvalArtifactBodyMatchesHeaderV1(header, body);
    const admission = admitted?.body === body ? null : strict
        ? { kind: 'presented' as const, parsed: strict }
        : readApprovalArtifactAdmissionV1(header, body);
    const parsed = strict ?? (admission?.kind === 'presented' ? admission.parsed : null);
    const subjectKey = admitted?.parsed === parsed ? admitted.subjectKey
        : parsed?.family === 'built_in' ? readApprovalRequestArtifactSubjectKeyV1(parsed.request) : null;
    const sessionEntry = parsed?.family === 'built_in' || parsed?.family === 'target_action'
        ? { artifact: { id: artifact.id, header }, approval: parsed.request } : null;
    const value = { body, parsed, disposition: admission?.kind ?? admitted?.disposition ?? 'unreadable', subjectKey, sessionEntry };
    admittedApprovalBodies.set(header, value);
    return value;
}

export type OpenApprovalInboxAdmission = Readonly<
    | { kind: 'presented'; parsed: ParsedApprovalArtifactBodyV1 }
    | { kind: 'not_presented'; reason: 'superseded_header_facts' }
    | { kind: 'unreadable' }
>;

export function readOpenApprovalInboxAdmission(artifact: DecryptedArtifact): OpenApprovalInboxAdmission {
    if (artifact.draft === true || artifact.header?.approvalStatus !== 'open'
        || !Object.values(APPROVAL_ARTIFACT_KINDS_V1).some(kind => kind === artifact.header?.kind)) {
        return { kind: 'unreadable' };
    }
    const admitted = readAdmittedApprovalArtifactBody(artifact);
    if (admitted?.disposition === 'not_presented') return { kind: 'not_presented', reason: 'superseded_header_facts' };
    return admitted?.parsed?.request.status === 'open'
        ? { kind: 'presented', parsed: admitted.parsed }
        : { kind: 'unreadable' };
}

export function readOpenApprovalInboxArtifact(artifact: DecryptedArtifact): ParsedApprovalArtifactBodyV1 | null {
    const admission = readOpenApprovalInboxAdmission(artifact);
    return admission.kind === 'presented' ? admission.parsed : null;
}

export function isOpenApprovalInboxArtifact(artifact: DecryptedArtifact): boolean {
    return readOpenApprovalInboxArtifact(artifact) !== null;
}

export type OpenApprovalDiscussionAttention = ApprovalDiscussionAddress & Readonly<{
    reason: 'approval_pending' | 'draft_waiting';
    sessionId: string | null;
}>;

/**
 * The Discussion link of an open request, read from the header's list facts (set by the writer and
 * verified against the body whenever the body is read), so a Discussion list never opens bodies.
 */
export function readOpenApprovalDiscussionAttention(artifact: DecryptedArtifact): OpenApprovalDiscussionAttention | null {
    const header = artifact.header;
    if (artifact.draft === true || header?.approvalStatus !== 'open') return null;
    // A read body must still agree with the header that carries the facts.
    if (typeof artifact.body === 'string' && !readOpenApprovalInboxArtifact(artifact)) return null;
    const facts = readApprovalArtifactHeaderListFactsV1(header);
    const serverId = readString(header.serverIdentityId) ?? readString(header.serverId);
    if (!facts?.discussionId || !serverId) return null;
    return { serverId, discussionId: facts.discussionId,
        reason: facts.discussionDraftReview === true ? 'draft_waiting' : 'approval_pending',
        sessionId: readString(header.sessionId) };
}

/** Immutable admission/routing facts published with the changed Artifact, never a resolved Home authority. */
export type OpenApprovalInboxEntry = Readonly<{
    artifact: DecryptedArtifact;
    parsed: ParsedApprovalArtifactBodyV1;
    /** Unlike tolerant stored admission, compact private review rejects unknown input. */
    strictReviewRequest: ApprovalRequestV2 | null;
    source: Readonly<{ serverId: unknown; serverIdentityId: unknown; sessionId: string | null }>;
    references: readonly SessionReferenceFact[];
    discussionAttention: OpenApprovalDiscussionAttention | null;
}>;

export function readOpenApprovalInboxEntry(artifact: DecryptedArtifact): OpenApprovalInboxEntry | null {
    const parsed = readOpenApprovalInboxArtifact(artifact);
    if (!parsed) return null;
    const header = artifact.header!;
    let strictReviewRequest: ApprovalRequestV2 | null = null;
    if (parsed.family === 'built_in' && parsed.request.v === 2 && typeof artifact.body === 'string') {
        try {
            const strict = ApprovalRequestV2Schema.safeParse(JSON.parse(artifact.body));
            if (strict.success) strictReviewRequest = strict.data;
        } catch { /* Malformed content cannot offer a compact private review. */ }
    }
    return { artifact, parsed, strictReviewRequest,
        source: { serverId: header.serverId, serverIdentityId: header.serverIdentityId, sessionId: readString(header.sessionId) },
        references: collectApprovalLinkedSessionReferences({ header, headerReferences: readApprovalArtifactHeaderReferenceFacts(artifact) }, parsed),
        discussionAttention: readOpenApprovalDiscussionAttention(artifact) };
}

/**
 * An open request as list surfaces present it: header facts only (title, Home, Session, list facts).
 * `admitted` is the strict body admission once a presenting row has read the body. A row whose read
 * body disagrees with its header is not listed.
 */
export type ListedOpenApproval = Readonly<{
    artifact: DecryptedArtifact;
    admitted: OpenApprovalInboxEntry | null;
    source: OpenApprovalInboxEntry['source'];
    discussionAttention: OpenApprovalDiscussionAttention | null;
}>;

/** The Automation whose Run asked: the header list fact, with the header's `runId`. */
export function readApprovalArtifactAutomationOrigin(artifact: Pick<DecryptedArtifact, 'header'>):
    Readonly<{ automationId: string; runId: string }> | null {
    const automationId = readApprovalArtifactHeaderListFactsV1(artifact.header)?.automationId;
    const runId = readString(artifact.header?.runId);
    return automationId && runId ? { automationId, runId } : null;
}

export function readListedOpenApproval(artifact: DecryptedArtifact, admitted: OpenApprovalInboxEntry | null): ListedOpenApproval | null {
    const header = artifact.header;
    if (!admitted && !(artifact.isDecrypted && artifact.draft !== true && artifact.body === undefined
        && header?.approvalStatus === 'open' && Object.values(APPROVAL_ARTIFACT_KINDS_V1).some(kind => kind === header.kind))) return null;
    return { artifact, admitted,
        source: admitted?.source ?? { serverId: header!.serverId, serverIdentityId: header!.serverIdentityId, sessionId: readString(header!.sessionId) },
        discussionAttention: admitted?.discussionAttention ?? readOpenApprovalDiscussionAttention(artifact) };
}

/** The bound Home owns body reads; portable header identities supply only a legacy fallback. */
export function listOpenApprovalInboxArtifactHydrationRequests(artifacts: Iterable<DecryptedArtifact>, fallbackServerId?: string | null):
    readonly Readonly<{ artifactId: string; serverId: string }>[] {
    const requests = new Map<string, Readonly<{ artifactId: string; serverId: string }>>();
    const readString = (value: unknown) => typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
    for (const artifact of artifacts) {
        if (artifact.draft === true || artifact.isDecrypted !== true || artifact.body !== undefined
            || !Object.values(APPROVAL_ARTIFACT_KINDS_V1).some(kind => kind === artifact.header?.kind)
            || artifact.header?.approvalStatus !== 'open') continue;
        const serverId = readString(fallbackServerId) ?? readString(artifact.header.serverIdentityId) ?? readString(artifact.header.serverId);
        if (!serverId || requests.has(artifact.id)) continue;
        requests.set(artifact.id, { artifactId: artifact.id, serverId });
    }
    return [...requests.values()];
}
