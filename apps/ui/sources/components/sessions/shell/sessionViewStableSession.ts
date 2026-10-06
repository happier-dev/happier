import * as React from 'react';

import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { buildSessionMetadataStabilitySignatureValue } from '@/sync/domains/session/metadata/sessionMetadataStability';
import { resolveServerIdForSessionIdFromLocalState } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { StorageState } from '@/sync/store/types';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readRollbackEligibleTurnStarts } from '@/sync/domains/session/rollback/rollbackEligibleTurnStarts';

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

function buildShellVisibleSequenceSetSignatureValue(value: unknown): readonly number[] {
    const normalized = readRollbackEligibleTurnStarts(value);
    return normalized ? [...normalized].sort((left, right) => left - right) : [];
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
        currentStorageState: session.currentStorageState ?? null,
        acceptedThroughServerSeq: session.acceptedThroughServerSeq ?? null,
        publishedThroughServerSeq: session.publishedThroughServerSeq ?? null,
        materializedThroughSourceAt: session.materializedThroughSourceAt ?? null,
        transcriptShareable: session.transcriptShareable ?? null,
        presence: session.presence ?? null,
        thinking: session.thinking === true,
        optimisticThinkingAt: session.thinking ? null : session.optimisticThinkingAt ?? null,
        thinkingGraceUntil: session.thinking ? null : session.thinkingGraceUntil ?? null,
        latestTurnStatus: session.latestTurnStatus ?? null,
        latestReadyEventAt: session.latestReadyEventAt ?? null,
        meaningfulActivityAt: session.meaningfulActivityAt ?? null,
        lastRuntimeIssue: session.lastRuntimeIssue ?? null,
        owner: session.owner ?? null,
        access: session.access ?? null,
        canApprovePermissions: session.canApprovePermissions ?? null,
        pendingPermissionRequestCount: session.pendingPermissionRequestCount ?? null,
        pendingUserActionRequestCount: session.pendingUserActionRequestCount ?? null,
        pendingRequestObservedAt: session.pendingRequestObservedAt ?? null,
        rollbackEligibleTurnStarts: buildShellVisibleSequenceSetSignatureValue(
            session.rollbackEligibleTurnStarts,
        ),
        latestUsage: buildShellVisibleLatestUsageSignatureValue(session.latestUsage),
        agentStateRequests: buildShellVisibleAgentStateRequestSignatureValue(session.agentState),
        sharedMetadata: buildShellVisibleMetadataSignatureValue(session.metadata),
        ownerMetadata: buildShellVisibleMetadataSignatureValue(readSessionOwnerMetadataView(session)),
    });
}

export function selectSessionViewShellSessionForRouteState(
    state: Pick<StorageState, 'sessions' | 'sessionListIndexByServerId' | 'sessionListRowsByServerId'>,
    sessionId: string,
    expectedServerId?: string | null,
): Session | null {
    const session = state.sessions[sessionId] ?? null;
    if (!session) return null;

    const normalizedExpectedServerId = normalizeServerId(expectedServerId);
    let resolvedServerScopeId = normalizeServerId((session as { serverId?: unknown }).serverId);
    if (normalizedExpectedServerId) {
        const cachedServerId = resolvedServerScopeId ?? normalizeServerId(resolveServerIdForSessionIdFromLocalState({
            sessions: state.sessions as Record<string, { serverId?: unknown } | null>,
            sessionListIndexByServerId: state.sessionListIndexByServerId,
            sessionListRowsByServerId: state.sessionListRowsByServerId,
        }, sessionId));
        if (!cachedServerId || !areServerProfileIdentifiersEquivalent(cachedServerId, normalizedExpectedServerId)) {
            return null;
        }
        resolvedServerScopeId = cachedServerId;
    }

    return session;
}

export function useSessionViewShellSession(sessionId: string, expectedServerId?: string | null): Session | null {
    const selectShellSession = React.useMemo(() => {
        let previousSession: Session | null = null;
        let previousSignature = 'null';
        let previousSource: Session | null = null;
        return (state: StorageState): Session | null => {
            const session = selectSessionViewShellSessionForRouteState(state, sessionId, expectedServerId);
            if (session === previousSource) return previousSession;
            previousSource = session;
            const signature = session ? buildSessionViewShellSessionSignature(session) : 'null';
            // Apply the existing shell projection before Zustand notifies React. Transcript-only
            // fields have their own leaf subscriptions and must not invalidate the shell.
            if (signature !== previousSignature) {
                previousSignature = signature;
                previousSession = session;
            }
            return previousSession;
        };
    }, [sessionId, expectedServerId]);
    return storage(selectShellSession);
}

export function useSessionViewShellSessionSeq(sessionId: string): number {
    return storage((state) => state.sessions[sessionId]?.seq ?? 0);
}
