import * as React from 'react';

import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { buildSessionMetadataStabilitySignatureValue } from '@/sync/domains/session/metadata/sessionMetadataStability';
import { resolveServerIdForSessionIdFromLocalState } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { areServerProfileIdentifiersEquivalent, getActiveServerId } from '@/sync/domains/server/serverProfiles';
import type { StorageState } from '@/sync/store/types';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readRollbackEligibleTurnStarts } from '@/sync/domains/session/rollback/rollbackEligibleTurnStarts';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { buildSessionFromListRenderable } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { readSessionDisplayTitleField } from '@/sync/state/selectors';

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

// Turn starts, agent state and metadata grow with the Session and keep their identity across the
// per-message Session updates of a streamed turn, while this signature is rebuilt on each of them:
// each part is serialized once per retained value.
function createShellSignaturePartSerializer<T>(project: (value: T) => unknown): (value: T) => string {
    const serializedByValue = new WeakMap<object, string>();
    return (value) => {
        if (value === null || typeof value !== 'object') return JSON.stringify(project(value)) ?? 'null';
        const cached = serializedByValue.get(value);
        if (cached !== undefined) return cached;
        const serialized = JSON.stringify(project(value)) ?? 'null';
        serializedByValue.set(value, serialized);
        return serialized;
    };
}

const serializeShellSequenceSetPart = createShellSignaturePartSerializer(buildShellVisibleSequenceSetSignatureValue);
const serializeShellAgentStateRequestsPart = createShellSignaturePartSerializer(buildShellVisibleAgentStateRequestSignatureValue);
const serializeShellMetadataPart = createShellSignaturePartSerializer(buildShellVisibleMetadataSignatureValue);

export function buildSessionViewShellSessionSignature(session: Session): string {
    return [JSON.stringify({
        id: session.id,
        serverId: normalizeServerId((session as { serverId?: unknown }).serverId),
        hasTranscriptHistory: (session.seq ?? 0) > 0,
        createdAt: session.createdAt ?? 0,
        active: session.active === true,
        archivedAt: session.archivedAt ?? null,
        agentStateVersion: session.agentStateVersion ?? null,
        encryptionMode: session.encryptionMode ?? null,
        encryptedContentAvailability: session.encryptedContentAvailability ?? null,
        currentStorageState: session.currentStorageState ?? null,
        acceptedThroughServerSeq: session.acceptedThroughServerSeq ?? null,
        publishedThroughServerSeq: session.publishedThroughServerSeq ?? null,
        materializedThroughSourceAt: session.materializedThroughSourceAt ?? null,
        transcriptShareable: session.transcriptShareable ?? null,
        presence: session.presence ?? null,
        thinking: session.thinking === true,
        optimisticThinkingAt: session.thinking ? null : session.optimisticThinkingAt ?? null,
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
        pendingActivationAuthorization: session.pendingActivationAuthorization ?? null,
        pendingActivationFailureDetails: session.pendingActivationFailureDetails ?? null,
        latestUsage: buildShellVisibleLatestUsageSignatureValue(session.latestUsage),
    }),
    serializeShellSequenceSetPart(session.rollbackEligibleTurnStarts),
    serializeShellAgentStateRequestsPart(session.agentState),
    serializeShellMetadataPart(session.metadata),
    serializeShellMetadataPart(readSessionOwnerMetadataView(session)),
    ].join('\u0000');
}

export function selectSessionViewShellSessionForRouteState(
    state: Pick<StorageState, 'sessions' | 'sessionListIndexByServerId' | 'sessionListRowsByServerId'>,
    sessionId: string,
    expectedServerId?: string | null,
): Session | null {
    const session = state.sessions[sessionId] ?? null;
    const normalizedExpectedServerId = normalizeServerId(expectedServerId);
    if (!session) {
        // An unopened report already has a qualified summary. The mounted Session owns its
        // ordinary detail/transcript hydration; Work must not fetch every report to name it.
        const row = normalizedExpectedServerId
            ? readSessionListRowForServerId(state.sessionListRowsByServerId, normalizedExpectedServerId, sessionId)
            : null;
        return row ? buildSessionFromListRenderable(row, { serverId: normalizedExpectedServerId }) : null;
    }
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
        let previousTitle: string | null = null;
        return (state: StorageState): Session | null => {
            const session = selectSessionViewShellSessionForRouteState(state, sessionId, expectedServerId);
            const row = session ? readSessionListRowForServerId(state.sessionListRowsByServerId,
                expectedServerId || session.serverId || getActiveServerId(), sessionId) : null;
            const title = readSessionDisplayTitleField(session, {
                fallbackTitle: readSessionDisplayTitleField(row).value,
            }).value;
            if (session === previousSource && title === previousTitle) return previousSession;
            previousSource = session;
            previousTitle = title;
            const signature = session ? JSON.stringify([buildSessionViewShellSessionSignature(session), title]) : 'null';
            // Seq/pending updates have leaf subscriptions. Structured turns instead travel on
            // this Session prop; ingestion retains their reference for equal hydration echoes.
            if (signature !== previousSignature
                || (session?.sessionTurns ?? null) !== (previousSession?.sessionTurns ?? null)) {
                previousSignature = signature;
                // A row-only title hydration must notify memoized header consumers even when
                // the full Session is unchanged. Other transcript changes retain its identity.
                previousSession = session && session === previousSession ? { ...session } : session;
            }
            return previousSession;
        };
    }, [sessionId, expectedServerId]);
    return storage(selectShellSession);
}

export function useSessionViewShellSessionSeq(sessionId: string): number {
    return storage((state) => state.sessions[sessionId]?.seq ?? 0);
}
