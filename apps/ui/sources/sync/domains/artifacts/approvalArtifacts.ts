import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';

import type { DecryptedArtifact } from './artifactTypes';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';

export type OpenApprovalArtifactForSession = Readonly<{
    artifact: DecryptedArtifact;
    approval: ApprovalRequest;
}>;

export type OpenApprovalSessionReference = Readonly<
    | { kind: 'exact'; address: SessionAddress }
    | { kind: 'legacy_unscoped'; sessionId: string }
>;

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function addSessionReference(
    referencesByKey: Map<string, OpenApprovalSessionReference>,
    value: unknown,
    serverId?: unknown,
): void {
    const sessionId = readString(value);
    if (!sessionId) return;
    const normalizedServerId = readString(serverId);
    const reference: OpenApprovalSessionReference = normalizedServerId
        ? { kind: 'exact', address: { serverId: normalizedServerId, sessionId } }
        : { kind: 'legacy_unscoped', sessionId };
    referencesByKey.set(JSON.stringify(reference), reference);
}

function collectSessionReferencesFromUnknownArray(
    referencesByKey: Map<string, OpenApprovalSessionReference>,
    value: unknown,
    serverId?: unknown,
): void {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
        addSessionReference(referencesByKey, entry, serverId);
    }
}

function parseApprovalRequestArtifact(artifact: DecryptedArtifact): ApprovalRequest | null {
    const parsed = approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, typeof artifact.body === 'string' ? artifact.body : null);
    return parsed?.family === 'built_in' ? parsed.request : null;
}

export function isOpenApprovalInboxArtifact(artifact: DecryptedArtifact): boolean {
    if (artifact.draft === true) return false;
    const parsed = approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, typeof artifact.body === 'string' ? artifact.body : null);
    return parsed?.request.status === 'open';
}

function collectApprovalLinkedSessionReferences(
    artifact: DecryptedArtifact,
    approval?: ApprovalRequest | null,
): readonly OpenApprovalSessionReference[] {
    const referencesByKey = new Map<string, OpenApprovalSessionReference>();
    const serverId = readString(artifact.header?.serverId);
    addSessionReference(referencesByKey, artifact.header?.sessionId, serverId);
    collectSessionReferencesFromUnknownArray(referencesByKey, artifact.sessions, serverId);
    collectSessionReferencesFromUnknownArray(referencesByKey, artifact.header?.sessions, serverId);
    if (approval?.v === 2) {
        addSessionReference(
            referencesByKey,
            approval.executionOriginV1.sessionId ?? approval.createdBy.sessionId,
            approval.executionOriginV1.serverId,
        );
    } else {
        addSessionReference(referencesByKey, approval?.createdBy.sessionId, serverId);
    }
    return [...referencesByKey.values()];
}

function referenceMatchesTarget(
    reference: OpenApprovalSessionReference,
    target: SessionAddress | string,
    knownSessionAddresses: readonly SessionAddress[],
): boolean {
    if (reference.kind === 'exact') {
        const key = sessionAddressKey(reference.address);
        return typeof target === 'string'
            ? key === target.trim()
            : key === sessionAddressKey(target);
    }
    if (typeof target === 'string') return false;
    const candidates = new Map(
        knownSessionAddresses
            .filter((address) => address.sessionId === reference.sessionId)
            .map((address) => [sessionAddressKey(address), address] as const),
    );
    return candidates.size === 1 && candidates.has(sessionAddressKey(target));
}

export function listOpenApprovalArtifactsForSession(
    artifacts: readonly DecryptedArtifact[],
    target: SessionAddress | string,
    options?: Readonly<{ knownSessionAddresses?: readonly SessionAddress[] }>,
): OpenApprovalArtifactForSession[] {
    if (typeof target === 'string' && !target.trim()) return [];

    return artifacts.flatMap((artifact) => {
        if (artifact.header?.kind !== 'approval_request.v1') return [];
        if (artifact.header?.approvalStatus !== 'open') return [];
        const approval = parseApprovalRequestArtifact(artifact);
        if (!approval) return [];
        if (approval.status !== 'open') return [];
        if (!collectApprovalLinkedSessionReferences(artifact, approval).some((reference) => (
            referenceMatchesTarget(reference, target, options?.knownSessionAddresses ?? [])
        ))) return [];

        return [{ artifact, approval }];
    });
}

export function collectOpenApprovalSessionReferences(
    artifacts: readonly DecryptedArtifact[],
): readonly OpenApprovalSessionReference[] {
    const referencesByKey = new Map<string, OpenApprovalSessionReference>();

    for (const artifact of artifacts) {
        if (artifact.header?.kind !== 'approval_request.v1') continue;
        if (artifact.header?.approvalStatus !== 'open') continue;

        const approval = parseApprovalRequestArtifact(artifact);
        // The list badge is an index projection and must survive the normal
        // header-before-body hydration window. Once a body is present it must
        // validate and remain open; malformed or closed bodies fail closed.
        if (artifact.body != null && approval?.status !== 'open') continue;

        for (const reference of collectApprovalLinkedSessionReferences(artifact, approval)) {
            referencesByKey.set(JSON.stringify(reference), reference);
        }
    }

    return [...referencesByKey.values()].sort((left, right) => (
        JSON.stringify(left).localeCompare(JSON.stringify(right))
    ));
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
            keys.add(sessionAddressKey(reference.address));
            continue;
        }
        const candidates = addressesBySessionId.get(reference.sessionId);
        if (candidates?.size === 1) keys.add(candidates.keys().next().value!);
    }
    return keys;
}
