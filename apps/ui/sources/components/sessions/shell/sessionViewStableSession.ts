import * as React from 'react';

import type { Session } from '@/sync/domains/state/storageTypes';

type ShellVisibleAgentStateRequestSignature = ReadonlyArray<readonly [
    string,
    {
        tool: string | null;
        kind: string | null;
        source: string | null;
        arguments: unknown;
        createdAt: number | null;
        permissionSuggestions: unknown;
        completedAt: number | null;
        completedStatus: string | null;
        completedDecision: string | null;
    },
]>;

function buildShellVisibleMetadataSignatureValue(metadata: Session['metadata']): Session['metadata'] {
    if (!metadata) return null;
    const { readStateV1: _readStateV1, ...shellVisibleMetadata } = metadata;
    return shellVisibleMetadata;
}

function buildShellVisibleAgentStateRequestSignatureValue(
    agentState: Session['agentState'],
): ShellVisibleAgentStateRequestSignature | null {
    const requests = agentState?.requests;
    if (!requests || typeof requests !== 'object') return null;

    const completedRequests = agentState?.completedRequests ?? null;
    const signature = Object.entries(requests)
        .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
        .flatMap(([requestId, request]) => {
            if (!request || typeof request !== 'object') return [];

            const completed = completedRequests?.[requestId] ?? null;
            return [[
                requestId,
                {
                    tool: typeof request.tool === 'string' ? request.tool : null,
                    kind: typeof request.kind === 'string' ? request.kind : null,
                    source: typeof request.source === 'string' ? request.source : null,
                    arguments: typeof request.arguments === 'undefined' ? null : request.arguments,
                    createdAt: typeof request.createdAt === 'number' ? request.createdAt : null,
                    permissionSuggestions: typeof request.permissionSuggestions === 'undefined'
                        ? null
                        : request.permissionSuggestions,
                    completedAt: typeof completed?.completedAt === 'number' ? completed.completedAt : null,
                    completedStatus: typeof completed?.status === 'string' ? completed.status : null,
                    completedDecision: typeof completed?.decision === 'string' ? completed.decision : null,
                },
            ] as const];
        });

    return signature.length > 0 ? signature : null;
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
        agentStateRequests: buildShellVisibleAgentStateRequestSignatureValue(session.agentState),
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
