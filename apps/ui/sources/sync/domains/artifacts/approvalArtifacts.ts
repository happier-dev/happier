import { ApprovalRequestV1Schema, type ApprovalRequestV1 } from '@happier-dev/protocol';

import type { DecryptedArtifact } from './artifactTypes';

export type OpenApprovalArtifactForSession = Readonly<{
    artifact: DecryptedArtifact;
    approval: ApprovalRequestV1;
}>;

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readTimestampMs(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function parseApprovalRequestBody(body: string): ApprovalRequestV1 | null {
    try {
        const parsed = ApprovalRequestV1Schema.safeParse(JSON.parse(body));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function isApprovalLinkedToSession(artifact: DecryptedArtifact, sessionId: string): boolean {
    const headerSessionId = readString(artifact.header?.sessionId);
    if (headerSessionId === sessionId) return true;
    if (artifact.sessions?.includes(sessionId) === true) return true;
    if (artifact.header?.sessions?.includes(sessionId) === true) return true;
    return false;
}

function readCreatedBySurface(artifact: DecryptedArtifact): ApprovalRequestV1['createdBy']['surface'] {
    const surface = readString(artifact.header?.createdBySurface);
    if (
        surface === 'voice' ||
        surface === 'session_agent' ||
        surface === 'mcp' ||
        surface === 'cli' ||
        surface === 'system'
    ) {
        return surface;
    }
    return 'session_agent';
}

function createHeaderBackedApprovalRequest(
    artifact: DecryptedArtifact,
    sessionId: string,
): ApprovalRequestV1 | null {
    const actionId = readString(artifact.header?.actionId);
    if (!actionId) return null;

    const candidate = {
        v: 1,
        status: 'open',
        createdAtMs: readTimestampMs(artifact.createdAt),
        updatedAtMs: readTimestampMs(artifact.updatedAt),
        createdBy: {
            surface: readCreatedBySurface(artifact),
            sessionId,
        },
        requestedSurface: readString(artifact.header?.requestedSurface) ?? undefined,
        actionId,
        actionArgs: artifact.header?.actionArgs ?? {},
        summary: readString(artifact.header?.approvalSummary)
            ?? readString(artifact.header?.summary)
            ?? readString(artifact.title)
            ?? readString(artifact.header?.title)
            ?? actionId,
        preview: artifact.header?.approvalPreview,
    };

    const parsed = ApprovalRequestV1Schema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
}

export function listOpenApprovalArtifactsForSession(
    artifacts: readonly DecryptedArtifact[],
    sessionId: string,
): OpenApprovalArtifactForSession[] {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return [];

    return artifacts.flatMap((artifact) => {
        if (artifact.header?.kind !== 'approval_request.v1') return [];
        if (artifact.header?.approvalStatus !== 'open') return [];
        if (!isApprovalLinkedToSession(artifact, normalizedSessionId)) return [];

        const body = typeof artifact.body === 'string' ? artifact.body : null;
        const approval = body
            ? parseApprovalRequestBody(body)
            : createHeaderBackedApprovalRequest(artifact, normalizedSessionId);
        if (!approval) return [];
        if (approval.status !== 'open') return [];

        return [{ artifact, approval }];
    });
}
