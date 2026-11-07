import { deriveProjectServiceStartApprovalSubjectKeyV1,
    readOpenWorkflowPublicationApprovalTargetV1,
    type ParsedApprovalArtifactBodyV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { isPluginDevLoopActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import { APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';

import type { DecryptedArtifact } from './artifactTypes';
import { readAdmittedApprovalArtifactBody, readOpenApprovalInboxArtifact,
    readApprovalArtifactHeaderReferenceFacts, collectApprovalLinkedSessionReferences,
    type SessionReferenceFact, type OpenApprovalSessionReference, type OpenApprovalInboxEntry,
    readDiscussionRequesterApprovalFact, type ApprovalDiscussionAddress, type DiscussionRequesterApproval,
    type OpenApprovalArtifactForSession, type OpenApprovalAttentionArtifactForSession } from './approvalArtifactAdmission';
export { isOpenApprovalInboxArtifact, listOpenApprovalInboxArtifactHydrationRequests,
    readOpenApprovalDiscussionAttention, type OpenApprovalDiscussionAttention, type OpenApprovalSessionReference,
    type OpenApprovalArtifactForSession, type OpenApprovalAttentionArtifactForSession,
    type ApprovalDiscussionAddress, type DiscussionRequesterApproval } from './approvalArtifactAdmission';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerProfileIdentifiersEquivalent, getServerProfilesGeneration, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

export function isBuiltInOpenApprovalArtifactForSession(
    entry: OpenApprovalAttentionArtifactForSession,
): entry is OpenApprovalArtifactForSession {
    return entry.artifact.header?.kind === APPROVAL_ARTIFACT_KINDS_V1.builtIn;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

type AdmittedApprovalArtifactSnapshot = Readonly<{
    parsed: ParsedApprovalArtifactBodyV1 | null;
    subjectKey: string | null;
    sessionEntry: OpenApprovalAttentionArtifactForSession | null;
    references: readonly SessionReferenceFact[];
}>;

type ApprovalArtifactSnapshot = {
    sourceServerId: DecryptedArtifact['sourceServerId'];
    header: NonNullable<DecryptedArtifact['header']>;
    sessions: DecryptedArtifact['sessions'];
    body: string | null;
    headerReferences: readonly SessionReferenceFact[];
    admitted?: AdmittedApprovalArtifactSnapshot;
};

const approvalArtifactSnapshots = new WeakMap<DecryptedArtifact, ApprovalArtifactSnapshot>();

function readApprovalArtifactProjection(artifact: DecryptedArtifact): ApprovalArtifactSnapshot | null {
    const header = artifact.header;
    if (!header) return null;
    const body = typeof artifact.body === 'string' ? artifact.body : null;
    const previous = approvalArtifactSnapshots.get(artifact);
    if (previous?.header === header && previous.sessions === artifact.sessions && previous.body === body
        && previous.sourceServerId === artifact.sourceServerId) return previous;
    // These are facts, not authorization: portable Home aliases/membership stay in the live matcher.
    // The authenticated read Home owns the inventory relationship. A daemon-local
    // profile name inside the unchanged request is not a browser routing alias.
    // Older projections without that read fact retain their existing Home matcher.
    const snapshot: ApprovalArtifactSnapshot = { sourceServerId: artifact.sourceServerId, header, sessions: artifact.sessions, body,
        headerReferences: readApprovalArtifactHeaderReferenceFacts(artifact) };
    approvalArtifactSnapshots.set(artifact, snapshot);
    return snapshot;
}

function readApprovalArtifactSnapshot(artifact: DecryptedArtifact): AdmittedApprovalArtifactSnapshot | null {
    const snapshot = readApprovalArtifactProjection(artifact);
    if (!snapshot) return null;
    if (snapshot.admitted) return snapshot.admitted;
    const { parsed, subjectKey, sessionEntry } = readAdmittedApprovalArtifactBody(artifact)!;
    snapshot.admitted = { parsed, subjectKey, sessionEntry,
        references: collectApprovalLinkedSessionReferences(snapshot, parsed) };
    return snapshot.admitted;
}

/** Select pending identities before mounting body readers. Older private headers
 * can reuse an already-admitted body; missing identity never demands unrelated bodies. */
export function listProjectServiceStartApprovalArtifactIds(
    artifacts: Iterable<DecryptedArtifact>,
    source: Readonly<{ serverId: string; refId: string; machineId: string }>,
): readonly string[] {
    const subjectKey = deriveProjectServiceStartApprovalSubjectKeyV1(source);
    const selected: DecryptedArtifact[] = [];
    for (const artifact of artifacts) {
        const header = artifact.header;
        if (artifact.draft || !artifact.isDecrypted || header?.kind !== APPROVAL_ARTIFACT_KINDS_V1.builtIn
            || header.actionId !== 'localServices.launcher.start'
            || (header.approvalStatus !== 'approved' && header.approvalStatus !== 'executing')) continue;
        const homeId = readString(header.serverIdentityId) ?? readString(header.serverId);
        if (!homeId || !areServerProfileIdentifiersEquivalent(homeId, source.serverId)) continue;
        const indexed = header.approvalSubjectKey === undefined ? readApprovalArtifactSnapshot(artifact)?.subjectKey : header.approvalSubjectKey;
        if (indexed === subjectKey) selected.push(artifact);
    }
    return selected.sort((left, right) => right.updatedAt - left.updatedAt).map(artifact => artifact.id);
}

/** Unrelated store domains cannot restart the private-header selection work. */
export function createProjectServiceStartApprovalArtifactIdsSelector(
    source: Parameters<typeof listProjectServiceStartApprovalArtifactIds>[1],
): (artifacts: Readonly<Record<string, DecryptedArtifact>>) => readonly string[] {
    let previous: Readonly<Record<string, DecryptedArtifact>> | undefined;
    let profilesGeneration = -1;
    let ids: readonly string[] = [];
    return artifacts => {
        const currentProfilesGeneration = getServerProfilesGeneration();
        if (artifacts !== previous || profilesGeneration !== currentProfilesGeneration) {
            ids = listProjectServiceStartApprovalArtifactIds(Object.values(artifacts), source);
            previous = artifacts;
            profilesGeneration = currentProfilesGeneration;
        }
        return ids;
    };
}

/**
 * The open Ask already filed for one managed resource's Action (a Delete waiting in Inbox).
 * Consume the Inbox owner's admitted requests, never the retained Artifact corpus or private bodies again.
 */
export function readOpenManagedMachineApprovalId(
    entries: Iterable<OpenApprovalInboxEntry>,
    target: Readonly<{ homeId: string; managedId: string; actionId: string }>,
): string | null {
    let found: { id: string; createdAtMs: number } | null = null;
    for (const { artifact, parsed } of entries) {
        if (parsed.family !== 'built_in' || parsed.request.actionId !== target.actionId) continue;
        const args = parsed.request.actionArgs;
        if (!args || typeof args !== 'object' || !('managedId' in args) || args.managedId !== target.managedId
            || !('homeId' in args) || args.homeId !== target.homeId) continue;
        if (!found || parsed.request.createdAtMs > found.createdAtMs) found = { id: artifact.id, createdAtMs: parsed.request.createdAtMs };
    }
    return found?.id ?? null;
}

/** Management links to the ordinary request; its captured operands and Inbox retain decision authority. */
export function listOpenPluginApprovalArtifactsForMachine(
    artifacts: Iterable<DecryptedArtifact>,
    target: Readonly<{ serverId: string; accountId: string; machineId: string }>,
): readonly OpenApprovalArtifactForSession[] {
    const selected: OpenApprovalArtifactForSession[] = [];
    for (const artifact of artifacts) {
        if (typeof artifact.header?.actionId !== 'string' || !isPluginDevLoopActionIdV1(artifact.header.actionId)) continue;
        const parsed = readOpenApprovalInboxArtifact(artifact);
        if (parsed?.family !== 'built_in' || parsed.request.v !== 2) continue;
        const origin = parsed.request.executionOriginV1;
        if (origin.machineId !== target.machineId || origin.accountId !== target.accountId
            || !areServerProfileIdentifiersEquivalent(origin.serverIdentityId ?? origin.serverId, target.serverId)) continue;
        const input = getActionSpec(artifact.header.actionId).inputSchema.safeParse(parsed.request.actionArgs);
        if (!input.success) continue;
        const args = input.data;
        if (args && typeof args === 'object' && 'machineId' in args
            && args.machineId !== undefined && args.machineId !== target.machineId) continue;
        selected.push({ artifact: { id: artifact.id, header: artifact.header }, approval: parsed.request });
    }
    return selected;
}

/**
 * A pending Agent request joined to the Discussion message that asked it. The admitted cause
 * (`executionOriginV1.actionRequestAttributionV1`) is the only source of the link. Shared requester
 * confirmations also retain their decided receipt; ordinary requests use the existing approval UI.
 */
function readDiscussionRequesterApproval(
    artifact: DecryptedArtifact,
    discussion: ApprovalDiscussionAddress,
): DiscussionRequesterApproval | null {
    const fact = readDiscussionRequesterApprovalFact(artifact);
    if (!fact || fact.discussion.discussionId !== discussion.discussionId
        || !areServerProfileIdentifiersEquivalent(fact.discussion.serverId, discussion.serverId)) return null;
    return fact;
}

export function listDiscussionRequesterApprovals(
    artifacts: readonly DecryptedArtifact[],
    discussion: ApprovalDiscussionAddress,
): DiscussionRequesterApproval[] {
    return artifacts.flatMap((artifact) => {
        const entry = readDiscussionRequesterApproval(artifact, discussion);
        return entry ? [entry] : [];
    }).sort((left, right) => left.parsed.request.createdAtMs - right.parsed.request.createdAtMs
        || left.artifact.id.localeCompare(right.artifact.id));
}

/** Exact Run requests, admitted by the same body/header owner as Inbox. */
export function readOpenWorkflowPublicationApprovalId(
    artifact: DecryptedArtifact,
    target: Readonly<{ serverId: string; runId: string }>,
): string | null {
    const publication = readOpenWorkflowPublicationApprovalTargetV1(readOpenApprovalInboxArtifact(artifact));
    return publication?.runId === target.runId && areServerProfileIdentifiersEquivalent(publication.serverId, target.serverId)
        ? artifact.id : null;
}

function referenceMatchesTarget(
    fact: SessionReferenceFact,
    target: SessionAddress | string,
    knownSessionAddresses: readonly SessionAddress[],
): boolean {
    const reference = fact.reference;
    if (reference.kind === 'exact') {
        return typeof target === 'string'
            ? (fact.addressKey ??= sessionAddressKey(reference.address)) === target.trim()
            : reference.address.sessionId === target.sessionId
                && areServerProfileIdentifiersEquivalent(reference.address.serverId, target.serverId);
    }
    if (typeof target === 'string' || reference.sessionId !== target.sessionId) return false;
    const candidates = new Map(
        knownSessionAddresses
            .filter((address) => address.sessionId === reference.sessionId)
            .map((address) => [resolveServerProfileScopeIdForIdentifier(address.serverId), address] as const),
    );
    return candidates.size === 1 && candidates.has(resolveServerProfileScopeIdForIdentifier(target.serverId));
}

/** Read demand only; admission still requires the strict body/header reader. */
export function listApprovalArtifactIdsNeedingHydrationForSession(
    artifacts: readonly DecryptedArtifact[],
    target: SessionAddress,
    knownSessionAddresses: readonly SessionAddress[],
    actionIds?: readonly string[],
): string[] {
    return artifacts.filter(artifact => artifact.draft !== true && artifact.isDecrypted
        && (!actionIds || typeof artifact.header?.actionId === 'string' && actionIds.includes(artifact.header.actionId))
        && artifact.header?.kind === 'approval_request.v1' && artifact.body === undefined
        && readApprovalArtifactProjection(artifact)?.headerReferences.some(reference => referenceMatchesTarget(reference, target, knownSessionAddresses)))
        .map(artifact => artifact.id);
}

/**
 * An approval body's declaration that its request keeps rendering in the transcript after it is
 * decided (its receipt, or its declined line). Contributed by the body owner; the projection never
 * reads Action ids.
 */
export type ApprovalSettledPresentation = (approval: ApprovalRequest) => boolean;

export function listOpenApprovalArtifactsForSession(
    artifacts: readonly DecryptedArtifact[],
    target: SessionAddress | string,
    options?: Readonly<{ knownSessionAddresses?: readonly SessionAddress[] }>,
): OpenApprovalAttentionArtifactForSession[] {
    return listSessionApprovalArtifacts(artifacts, target, options?.knownSessionAddresses ?? [], null);
}

export function listComposerApprovalArtifactsForSession(
    artifacts: readonly DecryptedArtifact[],
    target: SessionAddress | string,
    options?: Readonly<{
        knownSessionAddresses?: readonly SessionAddress[];
        settledPresentations?: readonly ApprovalSettledPresentation[];
    }>,
): OpenApprovalAttentionArtifactForSession[] {
    const presentations = options?.settledPresentations ?? [];
    return listSessionApprovalArtifacts(artifacts, target, options?.knownSessionAddresses ?? [],
        presentations.length > 0 ? (approval) => presentations.some((presents) => presents(approval)) : null);
}

/**
 * The transcript's approvals: every open request, plus settled requests whose body declares a
 * settled presentation. Counts, badges and the composer keep the open projection above.
 */
export function listTranscriptApprovalArtifactsForSession(
    artifacts: readonly DecryptedArtifact[],
    target: SessionAddress | string,
    options?: Readonly<{
        knownSessionAddresses?: readonly SessionAddress[];
        settledPresentations?: readonly ApprovalSettledPresentation[];
    }>,
): OpenApprovalArtifactForSession[] {
    const presentations = options?.settledPresentations ?? [];
    return listSessionApprovalArtifacts(artifacts, target, options?.knownSessionAddresses ?? [],
        presentations.length > 0 ? (approval) => presentations.some((presents) => presents(approval)) : null)
        .filter(isBuiltInOpenApprovalArtifactForSession);
}

function listSessionApprovalArtifacts(
    artifacts: readonly DecryptedArtifact[],
    target: SessionAddress | string,
    knownSessionAddresses: readonly SessionAddress[],
    keepsSettled: ApprovalSettledPresentation | null,
): OpenApprovalAttentionArtifactForSession[] {
    if (typeof target === 'string' && !target.trim()) return [];

    return artifacts.flatMap((artifact) => {
        if (artifact.header?.kind !== APPROVAL_ARTIFACT_KINDS_V1.builtIn
            && artifact.header?.kind !== APPROVAL_ARTIFACT_KINDS_V1.targetAction) return [];
        if (artifact.header.approvalStatus !== 'open' && !keepsSettled) return [];
        // The strict reader requires the body's Session binding to match this
        // index. Unrelated headers cannot admit a body for this Session; avoid
        // reparsing every Account approval when its inventory changes.
        const snapshot = readApprovalArtifactProjection(artifact);
        if (!snapshot?.headerReferences.some(reference => (
            referenceMatchesTarget(reference, target, knownSessionAddresses)
        ))) return [];
        const open = readOpenApprovalInboxArtifact(artifact);
        if (!open && !keepsSettled) return [];
        const admitted = readApprovalArtifactSnapshot(artifact);
        if (!admitted?.sessionEntry) return [];
        const entry = admitted.sessionEntry;
        const { approval } = entry;
        if (approval.status === 'open' ? open === null : 'kind' in approval || !keepsSettled?.(approval)) return [];
        return [entry];
    });
}

export function collectOpenApprovalSessionReferences(
    artifacts: readonly DecryptedArtifact[],
    previousReferences: readonly OpenApprovalSessionReference[] = [],
): readonly OpenApprovalSessionReference[] {
    return collectOpenApprovalSessionReferenceFacts(artifacts.flatMap(artifact =>
        readOpenApprovalInboxArtifact(artifact) ? readApprovalArtifactSnapshot(artifact)?.references ?? [] : []), previousReferences);
}

/** Aggregate the changed-row admission facts without reopening retained Artifact content. */
export function collectOpenApprovalSessionReferenceFacts(
    facts: Iterable<SessionReferenceFact>,
    previousReferences: readonly OpenApprovalSessionReference[] = [],
): readonly OpenApprovalSessionReference[] {
    const referencesByKey = new Map<string, SessionReferenceFact>();
    // Reconcile the output facts at their producer, including removal of the first of several
    // approvals for one Session. This baseline contains references only, never Artifact inventory
    // or resolved Home authorization. It replaces the hook's whole-output signature comparison.
    const previousByHome = new Map<string | null, Map<string, OpenApprovalSessionReference>>();
    for (const reference of previousReferences) {
        const home = reference.kind === 'exact' ? reference.address.serverId : null;
        const sessionId = reference.kind === 'exact' ? reference.address.sessionId : reference.sessionId;
        const sessions = previousByHome.get(home) ?? new Map<string, OpenApprovalSessionReference>();
        sessions.set(sessionId, reference);
        previousByHome.set(home, sessions);
    }

    for (const fact of facts) if (!referencesByKey.has(fact.sortKey)) referencesByKey.set(fact.sortKey, fact);

    return [...referencesByKey.values()].sort((left, right) => left.sortKey.localeCompare(right.sortKey))
        .map(({ reference }) => {
            const home = reference.kind === 'exact' ? reference.address.serverId : null;
            const sessionId = reference.kind === 'exact' ? reference.address.sessionId : reference.sessionId;
            return previousByHome.get(home)?.get(sessionId) ?? reference;
        });
}

export function resolveOpenApprovalSessionKeys(
    references: readonly OpenApprovalSessionReference[],
    knownSessionAddresses: readonly SessionAddress[],
): ReadonlySet<string> {
    const keys = new Set<string>();
    const addressesBySessionId = new Map<string, Map<string, SessionAddress>>();
    for (const address of knownSessionAddresses) {
        const candidates = addressesBySessionId.get(address.sessionId) ?? new Map<string, SessionAddress>();
        candidates.set(sessionAddressKey(address), address);
        addressesBySessionId.set(address.sessionId, candidates);
    }
    for (const reference of references) {
        if (reference.kind === 'exact') {
            const matching = knownSessionAddresses.filter(address => address.sessionId === reference.address.sessionId
                && areServerProfileIdentifiersEquivalent(address.serverId, reference.address.serverId));
            if (matching.length > 0) for (const address of matching) keys.add(sessionAddressKey(address));
            else keys.add(sessionAddressKey(reference.address));
            continue;
        }
        const candidates = addressesBySessionId.get(reference.sessionId);
        if (candidates?.size === 1) keys.add(candidates.keys().next().value!);
    }
    return keys;
}
