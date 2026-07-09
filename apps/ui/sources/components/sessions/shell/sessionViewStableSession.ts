import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { buildSessionMetadataStabilitySignatureValue } from '@/sync/domains/session/metadata/sessionMetadataStability';
import { resolveServerIdForSessionIdFromLocalState } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { StorageState } from '@/sync/store/types';

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

type ShellVisibleLatestUsageSignature = Readonly<{
    inputTokens: number | null;
    outputTokens: number | null;
    cacheCreation: number | null;
    cacheRead: number | null;
    contextSize: number | null;
    contextWindowTokens: number | null;
}>;

function buildShellVisibleMetadataSignatureValue(metadata: Session['metadata']): unknown {
    return buildSessionMetadataStabilitySignatureValue(metadata);
}

function normalizeServerId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function buildShellVisibleLatestUsageSignatureValue(
    latestUsage: Session['latestUsage'],
): ShellVisibleLatestUsageSignature | null {
    if (!latestUsage || typeof latestUsage !== 'object') return null;
    const usageWithContextWindowTokens = latestUsage as (typeof latestUsage & { contextWindowTokens?: number });

    return {
        inputTokens: typeof latestUsage.inputTokens === 'number' ? latestUsage.inputTokens : null,
        outputTokens: typeof latestUsage.outputTokens === 'number' ? latestUsage.outputTokens : null,
        cacheCreation: typeof latestUsage.cacheCreation === 'number' ? latestUsage.cacheCreation : null,
        cacheRead: typeof latestUsage.cacheRead === 'number' ? latestUsage.cacheRead : null,
        contextSize: typeof latestUsage.contextSize === 'number' ? latestUsage.contextSize : null,
        contextWindowTokens: typeof usageWithContextWindowTokens.contextWindowTokens === 'number'
            ? usageWithContextWindowTokens.contextWindowTokens
            : null,
    };
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
        serverId: normalizeServerId((session as { serverId?: unknown }).serverId),
        hasTranscriptHistory: (session.seq ?? 0) > 0,
        createdAt: session.createdAt ?? 0,
        active: session.active === true,
        archivedAt: session.archivedAt ?? null,
        agentStateVersion: session.agentStateVersion ?? null,
        encryptionMode: session.encryptionMode ?? null,
        presence: session.presence ?? null,
        thinking: session.thinking === true,
        optimisticThinkingAt: session.thinking ? null : session.optimisticThinkingAt ?? null,
        thinkingGraceUntil: session.thinking ? null : session.thinkingGraceUntil ?? null,
        latestTurnStatus: session.latestTurnStatus ?? null,
        latestReadyEventAt: session.latestReadyEventAt ?? null,
        meaningfulActivityAt: session.meaningfulActivityAt ?? null,
        lastRuntimeIssue: session.lastRuntimeIssue ?? null,
        owner: session.owner ?? null,
        accessLevel: session.accessLevel ?? null,
        canApprovePermissions: session.canApprovePermissions ?? null,
        pendingPermissionRequestCount: session.pendingPermissionRequestCount ?? null,
        pendingUserActionRequestCount: session.pendingUserActionRequestCount ?? null,
        pendingRequestObservedAt: session.pendingRequestObservedAt ?? null,
        latestUsage: buildShellVisibleLatestUsageSignatureValue(session.latestUsage),
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

const sessionViewShellSessionCache = new Map<string, { signature: string; session: Session }>();

function buildSessionViewShellSessionCacheKey(sessionId: string, serverScopeId: string | null): string {
    return `${serverScopeId ?? 'unscoped'}\u0000${sessionId}`;
}

function getStableSessionViewShellSession(session: Session, serverScopeId: string | null): Session {
    const signature = buildSessionViewShellSessionSignature(session);
    const cacheKey = buildSessionViewShellSessionCacheKey(session.id, serverScopeId);
    const cached = sessionViewShellSessionCache.get(cacheKey);
    if (cached?.signature === signature) {
        return cached.session;
    }
    sessionViewShellSessionCache.set(cacheKey, { signature, session });
    return session;
}

export function selectSessionViewShellSessionForRouteState(
    state: Pick<StorageState, 'sessions' | 'sessionListIndexByServerId' | 'concurrentSessionListCacheByServerId'>,
    sessionId: string,
    expectedServerId?: string | null,
): Session | null {
    const session = state.sessions[sessionId] ?? null;
    if (!session) return null;

    const normalizedExpectedServerId = normalizeServerId(expectedServerId);
    let resolvedServerScopeId = normalizeServerId((session as { serverId?: unknown }).serverId);
    if (normalizedExpectedServerId) {
        const cachedServerId = normalizeServerId(resolveServerIdForSessionIdFromLocalState({
            sessions: state.sessions as Record<string, { serverId?: unknown } | null>,
            sessionListIndexByServerId: state.sessionListIndexByServerId,
            concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId,
        }, sessionId));
        if (!cachedServerId || !areServerProfileIdentifiersEquivalent(cachedServerId, normalizedExpectedServerId)) {
            return null;
        }
        resolvedServerScopeId = cachedServerId;
    }

    return getStableSessionViewShellSession(session, resolvedServerScopeId);
}

export function useSessionViewShellSession(sessionId: string, expectedServerId?: string | null): Session | null {
    return storage(
        useShallow((state) => {
            return selectSessionViewShellSessionForRouteState(
                {
                    sessions: state.sessions,
                    sessionListIndexByServerId: state.sessionListIndexByServerId,
                    concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId,
                },
                sessionId,
                expectedServerId,
            );
        }),
    );
}

export function useSessionViewShellSessionSeq(sessionId: string): number {
    return storage((state) => state.sessions[sessionId]?.seq ?? 0);
}
