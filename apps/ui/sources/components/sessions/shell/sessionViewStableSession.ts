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
        // thinking, optimisticThinkingAt and latestTurnStatus move several times per turn. Their readers take them
        // from the live runtime source (useSessionRuntimeStatusSource, useSessionStatus, a store selector), so a
        // turn's status writes draw only the indicators that show them, not every Session view consumer.
        latestReadyEventAt: session.latestReadyEventAt ?? null,
        // meaningfulActivityAt moves with every arriving message; its readers take it from the live runtime source
        // (useSessionRuntimeStatusSource), so it is not a shell fact and must not re-render the whole Session view.
        lastRuntimeIssue: session.lastRuntimeIssue ?? null,
        owner: session.owner ?? null,
        access: session.access ?? null,
        canApprovePermissions: session.canApprovePermissions ?? null,
        pendingPermissionRequestCount: session.pendingPermissionRequestCount ?? null,
        pendingUserActionRequestCount: session.pendingUserActionRequestCount ?? null,
        pendingRequestObservedAt: session.pendingRequestObservedAt ?? null,
        pendingActivationAuthorization: session.pendingActivationAuthorization ?? null,
        pendingActivationFailureDetails: session.pendingActivationFailureDetails ?? null,
        // latestUsage moves with each usage report of a turn; its readers subscribe to the usage owner
        // (useSessionUsage), so it is not a shell fact either.
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

/** The Session's turn status, for the leaf that reads it; the shell Session does not carry it live. */
export function useSessionViewLatestTurnStatus(sessionId: string): Session['latestTurnStatus'] | null {
    return storage((state) => state.sessions[sessionId]?.latestTurnStatus ?? null);
}
