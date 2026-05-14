import * as React from 'react';

import type { Session } from '@/sync/domains/state/storageTypes';

function buildShellVisibleMetadataSignatureValue(metadata: Session['metadata']): Session['metadata'] {
    if (!metadata) return null;
    const { readStateV1: _readStateV1, ...shellVisibleMetadata } = metadata;
    return shellVisibleMetadata;
}

export function buildSessionViewShellSessionSignature(session: Session): string {
    return JSON.stringify({
        id: session.id,
        hasTranscriptHistory: (session.seq ?? 0) > 0,
        createdAt: session.createdAt ?? 0,
        active: session.active === true,
        archivedAt: session.archivedAt ?? null,
        pendingVersion: session.pendingVersion ?? null,
        pendingCount: session.pendingCount ?? null,
        agentStateVersion: session.agentStateVersion ?? null,
        encryptionMode: session.encryptionMode ?? null,
        presence: session.presence ?? null,
        thinking: session.thinking === true,
        optimisticThinkingAt: session.thinking ? null : session.optimisticThinkingAt ?? null,
        thinkingGraceUntil: session.thinking ? null : session.thinkingGraceUntil ?? null,
        latestTurnStatus: session.latestTurnStatus ?? null,
        lastRuntimeIssue: session.lastRuntimeIssue ?? null,
        owner: session.owner ?? null,
        accessLevel: session.accessLevel ?? null,
        canApprovePermissions: session.canApprovePermissions ?? null,
        pendingPermissionRequestCount: session.pendingPermissionRequestCount ?? null,
        pendingUserActionRequestCount: session.pendingUserActionRequestCount ?? null,
        metadata: buildShellVisibleMetadataSignatureValue(session.metadata),
    });
}

export function useStableSessionViewShellSession(session: Session | null): Session | null {
    const signature = React.useMemo(
        () => (session ? buildSessionViewShellSessionSignature(session) : 'null'),
        [session],
    );
    const ref = React.useRef<{ signature: string; session: Session | null }>({
        signature,
        session,
    });
    if (ref.current.signature !== signature) {
        ref.current = { signature, session };
    }
    return ref.current.session;
}
