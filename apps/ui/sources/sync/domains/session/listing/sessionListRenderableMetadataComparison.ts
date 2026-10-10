import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import { readSessionBotV1, type SessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import type { Metadata } from '@happier-dev/session-core/state';
import {
    readExternalAgentObservationSessionState,
    type ExternalAgentObservationSnapshotV1,
} from '@happier-dev/agents';
import {
    readExternalSessionLink,
    type ExternalSessionLink,
} from '@/sync/domains/session/external/readExternalSessionLink';
import {
    serializeExternalSessionJsonForComparison,
    serializeExternalSessionSourceForComparison,
} from '@/sync/domains/session/external/serializeExternalSessionSourceForComparison';
import type { SessionListRenderableMetadata } from './sessionListRenderable';

export type SessionListRenderableExternalSessionIdentity = Readonly<{
    v: 1;
    agentId: string;
    machineId: string;
    remoteSessionId: string;
    linkedAtMs?: number;
    source: ExternalSessionLink['source'];
    runtimeDescriptorV1?: ExternalSessionLink['runtimeDescriptorV1'];
    linkData?: ExternalSessionLink['linkData'];
}>;

export type SessionListRenderableMetadataComparison = Readonly<{
    bot?: SessionBotV1;
    name: string | undefined;
    summaryText: string | null;
    path: string;
    homeDir: string | null;
    host: string | null;
    machineId: string | null;
    flavor: string | null;
    externalSessionV1: SessionListRenderableExternalSessionIdentity | null;
    externalAgentObservationV1: ExternalAgentObservationSnapshotV1 | null;
    readStateV1: Readonly<{
        v: 1;
        sessionSeq: number;
        pendingActivityAt: number;
        updatedAt: number;
    }> | null;
    hiddenSystemSession: boolean;
    sessionDirectoryV1: SessionListRenderableMetadata['sessionDirectoryV1'];
    terminalControlServiceabilityV1: SessionListRenderableMetadata['terminalControlServiceabilityV1'];
}>;

type SessionListRenderableMetadataComparisonSnapshot = Readonly<{
    bot?: unknown;
    name?: string;
    summaryText: string | null;
    path: string;
    homeDir: string | null;
    host: string | null;
    machineId: string | null;
    flavor: string | null;
    externalSessionV1: SessionListRenderableExternalSessionIdentity | null;
    externalAgentObservationV1?: unknown;
    readStateV1: unknown;
    hiddenSystemSession: boolean;
    sessionDirectoryV1?: SessionListRenderableMetadata['sessionDirectoryV1'];
    terminalControlServiceabilityV1?: unknown;
}>;

/** One shared value, so equal rows keep their identity wherever the marker is restated. */
export const MANAGED_SESSION_DIRECTORY_MARKER = Object.freeze({ v: 1 as const, kind: 'managed' as const });

function readExternalSessionRenderableMetadata(
    candidate: SessionListRenderableExternalSessionIdentity | null,
    previous?: SessionListRenderableMetadataComparison['externalSessionV1'],
): SessionListRenderableMetadataComparison['externalSessionV1'] {
    if (!candidate) return null;

    const next = {
        v: 1 as const,
        agentId: candidate.agentId,
        machineId: candidate.machineId,
        remoteSessionId: candidate.remoteSessionId,
        ...(typeof candidate.linkedAtMs === 'number' && Number.isFinite(candidate.linkedAtMs)
            ? { linkedAtMs: candidate.linkedAtMs }
            : {}),
        source: candidate.source,
        ...(candidate.runtimeDescriptorV1 ? { runtimeDescriptorV1: candidate.runtimeDescriptorV1 } : {}),
        ...(candidate.linkData ? { linkData: candidate.linkData } : {}),
    };

    if (previous && areSessionListRenderableExternalSessionIdentitiesEqual(previous, next)) {
        return previous;
    }

    return next;
}

export function areSessionListRenderableExternalSessionIdentitiesEqual(
    previous: SessionListRenderableExternalSessionIdentity | null | undefined,
    next: SessionListRenderableExternalSessionIdentity | null | undefined,
): boolean {
    if (previous === next) return true;
    if (!previous || !next) return (previous ?? null) === (next ?? null);
    return previous.v === next.v
        && previous.agentId === next.agentId
        && previous.machineId === next.machineId
        && previous.remoteSessionId === next.remoteSessionId
        && previous.linkedAtMs === next.linkedAtMs
        && serializeExternalSessionJsonForComparison(previous.runtimeDescriptorV1)
            === serializeExternalSessionJsonForComparison(next.runtimeDescriptorV1)
        && serializeExternalSessionJsonForComparison(previous.linkData)
            === serializeExternalSessionJsonForComparison(next.linkData)
        && serializeExternalSessionSourceForComparison(previous.source)
            === serializeExternalSessionSourceForComparison(next.source);
}

function readStateRenderableMetadata(
    candidate: unknown,
    previous?: SessionListRenderableMetadataComparison['readStateV1'],
): SessionListRenderableMetadataComparison['readStateV1'] {
    if (!candidate || typeof candidate !== 'object') return null;
    if (!('v' in candidate) || candidate.v !== 1) return null;

    const sessionSeq = (candidate as { sessionSeq?: unknown }).sessionSeq;
    const pendingActivityAt = (candidate as { pendingActivityAt?: unknown }).pendingActivityAt;
    const updatedAt = (candidate as { updatedAt?: unknown }).updatedAt;
    if (
        typeof sessionSeq !== 'number'
        || !Number.isFinite(sessionSeq)
        || typeof pendingActivityAt !== 'number'
        || !Number.isFinite(pendingActivityAt)
        || typeof updatedAt !== 'number'
        || !Number.isFinite(updatedAt)
    ) {
        return null;
    }

    const next = {
        v: 1 as const,
        sessionSeq: Math.max(0, Math.trunc(sessionSeq)),
        pendingActivityAt: Math.max(0, Math.trunc(pendingActivityAt)),
        updatedAt,
    };

    if (
        previous
        && previous.v === next.v
        && previous.sessionSeq === next.sessionSeq
        && previous.pendingActivityAt === next.pendingActivityAt
        && previous.updatedAt === next.updatedAt
    ) {
        return previous;
    }

    return next;
}

function readExternalAgentObservationRenderableMetadata(
    candidate: unknown,
    previous?: SessionListRenderableMetadataComparison['externalAgentObservationV1'],
): SessionListRenderableMetadataComparison['externalAgentObservationV1'] {
    const next = readExternalAgentObservationSessionState({
        externalAgentObservationV1: candidate,
    }).value;
    if (!next) return null;
    return previous && JSON.stringify(previous) === JSON.stringify(next)
        ? previous
        : next;
}

function readTerminalControlServiceability(
    candidate: unknown,
    previous?: SessionListRenderableMetadataComparison['terminalControlServiceabilityV1'],
): SessionListRenderableMetadataComparison['terminalControlServiceabilityV1'] {
    if (!candidate || typeof candidate !== 'object') return null;
    const value = candidate as { v?: unknown; state?: unknown; observedAt?: unknown; reason?: unknown };
    if (value.v !== 1 || !['servable', 'recoverable_unservable', 'unknown'].includes(String(value.state)) || typeof value.observedAt !== 'number') return null;
    const next = {
        v: 1 as const,
        state: value.state as 'servable' | 'recoverable_unservable' | 'unknown',
        observedAt: value.observedAt,
        ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    };
    return previous
        && previous.state === next.state
        && previous.observedAt === next.observedAt
        && previous.reason === next.reason
        ? previous
        : next;
}

function isSessionListRenderableMetadataComparisonSnapshotEqual(
    snapshot: SessionListRenderableMetadataComparisonSnapshot,
    previous: SessionListRenderableMetadata,
    nextExternalSessionV1: SessionListRenderableMetadataComparison['externalSessionV1'],
    nextExternalAgentObservationV1: SessionListRenderableMetadataComparison['externalAgentObservationV1'],
    nextReadStateV1: SessionListRenderableMetadataComparison['readStateV1'],
): boolean {
    return previous.name === snapshot.name
        && (readSessionBotV1(previous.bot)?.kind ?? null) === (readSessionBotV1(snapshot.bot)?.kind ?? null)
        && (previous.summaryText ?? null) === snapshot.summaryText
        && previous.path === snapshot.path
        && (previous.homeDir ?? null) === snapshot.homeDir
        && (previous.host ?? null) === snapshot.host
        && (previous.machineId ?? null) === snapshot.machineId
        && (previous.flavor ?? null) === snapshot.flavor
        && (previous.hiddenSystemSession === true) === snapshot.hiddenSystemSession
        && (previous.sessionDirectoryV1 ?? null) === (snapshot.sessionDirectoryV1 ?? null)
        && previous.externalSessionV1 === nextExternalSessionV1
        && previous.externalAgentObservationV1 === nextExternalAgentObservationV1
        && previous.readStateV1 === nextReadStateV1
        && previous.terminalControlServiceabilityV1 === snapshot.terminalControlServiceabilityV1;
}

function readRenderableSummaryText(metadata: Metadata): string | null {
    if (typeof metadata.summary?.text === 'string') {
        return metadata.summary.text;
    }

    const legacySummaryText = (metadata as Readonly<{ summaryText?: unknown }>).summaryText;
    return typeof legacySummaryText === 'string' ? legacySummaryText : null;
}

export function normalizeSessionListRenderableMetadataComparison(
    snapshot: SessionListRenderableMetadataComparisonSnapshot,
    previous?: SessionListRenderableMetadata | null,
): SessionListRenderableMetadataComparison {
    const normalizedSnapshot = {
        ...snapshot,
    };
    const nextExternalSessionV1 = readExternalSessionRenderableMetadata(
        normalizedSnapshot.externalSessionV1,
        previous?.externalSessionV1 ?? null,
    );
    const nextExternalAgentObservationV1 = readExternalAgentObservationRenderableMetadata(
        normalizedSnapshot.externalAgentObservationV1,
        previous?.externalAgentObservationV1 ?? null,
    );
    const nextReadStateV1 = readStateRenderableMetadata(
        normalizedSnapshot.readStateV1,
        previous?.readStateV1 ?? null,
    );
    normalizedSnapshot.terminalControlServiceabilityV1 = readTerminalControlServiceability(
        normalizedSnapshot.terminalControlServiceabilityV1,
        previous?.terminalControlServiceabilityV1 ?? null,
    );
    const nextBot = readSessionBotV1(normalizedSnapshot.bot);

    if (previous && isSessionListRenderableMetadataComparisonSnapshotEqual(
        normalizedSnapshot,
        previous,
        nextExternalSessionV1,
        nextExternalAgentObservationV1,
        nextReadStateV1,
    )) {
        return previous as SessionListRenderableMetadataComparison;
    }

    const next: SessionListRenderableMetadataComparison = {
        ...(nextBot ? { bot: previous?.bot ?? nextBot } : {}),
        name: normalizedSnapshot.name,
        summaryText: normalizedSnapshot.summaryText,
        path: normalizedSnapshot.path,
        homeDir: normalizedSnapshot.homeDir,
        host: normalizedSnapshot.host,
        machineId: normalizedSnapshot.machineId,
        flavor: normalizedSnapshot.flavor,
        externalSessionV1: nextExternalSessionV1,
        externalAgentObservationV1: nextExternalAgentObservationV1,
        readStateV1: nextReadStateV1,
        hiddenSystemSession: normalizedSnapshot.hiddenSystemSession,
        sessionDirectoryV1: normalizedSnapshot.sessionDirectoryV1 ?? null,
        terminalControlServiceabilityV1: normalizedSnapshot.terminalControlServiceabilityV1 as SessionListRenderableMetadataComparison['terminalControlServiceabilityV1'],
    };

    return previous && areSessionListRenderableMetadataComparisonsEqual(previous, next)
        ? (previous as SessionListRenderableMetadataComparison)
        : next;
}

export function readSessionListRenderableMetadataComparison(
    metadata: Metadata | null | undefined,
    previous?: SessionListRenderableMetadata | null,
): SessionListRenderableMetadataComparison | null {
    if (!metadata) return null;
    if (metadata.bot !== undefined && readSessionBotV1(metadata.bot) === null) return null;

    return normalizeSessionListRenderableMetadataComparison({
        bot: metadata.bot,
        name: typeof metadata.name === 'string' ? metadata.name : undefined,
        summaryText: readRenderableSummaryText(metadata),
        path: typeof metadata.path === 'string' ? metadata.path : '',
        homeDir: typeof metadata.homeDir === 'string' ? metadata.homeDir : null,
        host: typeof metadata.host === 'string' ? metadata.host : null,
        machineId: typeof metadata.machineId === 'string' ? metadata.machineId : null,
        flavor: typeof metadata.flavor === 'string' ? metadata.flavor : null,
        externalSessionV1: readExternalSessionLink(metadata),
        externalAgentObservationV1: metadata.externalAgentObservationV1,
        readStateV1: (metadata as Readonly<{ readStateV1?: unknown }>).readStateV1,
        hiddenSystemSession: metadata.systemSessionV1?.hidden === true,
        // One shared value, so equal rows keep their identity; see `readSessionDirectoryKind`.
        sessionDirectoryV1: readSessionDirectoryKind(metadata) === 'managed' ? MANAGED_SESSION_DIRECTORY_MARKER : null,
        terminalControlServiceabilityV1: metadata.terminal?.controlServiceabilityV1 ?? null,
    }, previous);
}

export function readSessionListRenderableMetadataComparisonFromRenderable(
    metadata: SessionListRenderableMetadata | null | undefined,
): SessionListRenderableMetadataComparison | null {
    if (!metadata) return null;

    return normalizeSessionListRenderableMetadataComparison({
        bot: metadata.bot,
        name: metadata.name,
        summaryText: metadata.summaryText ?? null,
        path: metadata.path,
        homeDir: metadata.homeDir ?? null,
        host: metadata.host ?? null,
        machineId: metadata.machineId ?? null,
        flavor: metadata.flavor ?? null,
        externalSessionV1: metadata.externalSessionV1 ?? null,
        externalAgentObservationV1: metadata.externalAgentObservationV1 ?? null,
        readStateV1: metadata.readStateV1 ?? null,
        hiddenSystemSession: metadata.hiddenSystemSession === true,
        sessionDirectoryV1: readSessionDirectoryKind(metadata) === 'managed' ? MANAGED_SESSION_DIRECTORY_MARKER : null,
        terminalControlServiceabilityV1: metadata.terminalControlServiceabilityV1 ?? null,
    });
}

export function buildSessionListRenderableMetadataComparison(
    metadata: Metadata | null | undefined,
    previous?: SessionListRenderableMetadata | null,
): SessionListRenderableMetadata | null {
    const next = readSessionListRenderableMetadataComparison(metadata, previous);
    if (previous && next && areSessionListRenderableMetadataComparisonsEqual(previous, next)) {
        return previous;
    }
    return next;
}

export function areSessionListRenderableMetadataComparisonsEqual(
    previous: SessionListRenderableMetadata | null,
    next: SessionListRenderableMetadata | null,
): boolean {
    if (previous === next) return true;
    if (!previous || !next) return previous === next;

    return previous.name === next.name
        && (previous.bot?.kind ?? null) === (next.bot?.kind ?? null)
        && (previous.summaryText ?? null) === (next.summaryText ?? null)
        && previous.path === next.path
        && (previous.homeDir ?? null) === (next.homeDir ?? null)
        && (previous.host ?? null) === (next.host ?? null)
        && (previous.machineId ?? null) === (next.machineId ?? null)
        && (previous.flavor ?? null) === (next.flavor ?? null)
        && (previous.hiddenSystemSession === true) === (next.hiddenSystemSession === true)
        && readSessionDirectoryKind(previous) === readSessionDirectoryKind(next)
        && areSessionListRenderableExternalSessionIdentitiesEqual(
            previous.externalSessionV1,
            next.externalSessionV1,
        )
        && JSON.stringify(previous.externalAgentObservationV1 ?? null)
            === JSON.stringify(next.externalAgentObservationV1 ?? null)
        && (previous.readStateV1?.v ?? null) === (next.readStateV1?.v ?? null)
        && (previous.readStateV1?.sessionSeq ?? null) === (next.readStateV1?.sessionSeq ?? null)
        && (previous.readStateV1?.pendingActivityAt ?? null) === (next.readStateV1?.pendingActivityAt ?? null)
        && (previous.readStateV1?.updatedAt ?? null) === (next.readStateV1?.updatedAt ?? null);
}
