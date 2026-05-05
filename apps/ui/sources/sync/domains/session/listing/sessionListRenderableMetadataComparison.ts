import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableMetadata } from './sessionListRenderable';

export type SessionListRenderableMetadataComparison = Readonly<{
    name: string | undefined;
    summaryText: string | null;
    path: string;
    homeDir: string | null;
    host: string | null;
    machineId: string | null;
    flavor: string | null;
    directSessionV1: Readonly<{
        v: 1;
        providerId?: string;
    }> | null;
    readStateV1: Readonly<{
        v: 1;
        sessionSeq: number;
        pendingActivityAt: number;
        updatedAt: number;
    }> | null;
    hiddenSystemSession: boolean;
}>;

type SessionListRenderableMetadataComparisonSnapshot = Readonly<{
    name?: string;
    summaryText: string | null;
    path: string;
    homeDir: string | null;
    host: string | null;
    machineId: string | null;
    flavor: string | null;
    directSessionV1: unknown;
    readStateV1: unknown;
    hiddenSystemSession: boolean;
}>;

function readDirectSessionRenderableMetadata(
    candidate: unknown,
    previous?: SessionListRenderableMetadataComparison['directSessionV1'],
): SessionListRenderableMetadataComparison['directSessionV1'] {
    if (!candidate || typeof candidate !== 'object') return null;
    if (!('v' in candidate) || candidate.v !== 1) return null;

    const next = {
        v: 1 as const,
        ...('providerId' in candidate && typeof candidate.providerId === 'string'
            ? { providerId: candidate.providerId }
            : {}),
    };

    if (
        previous
        && previous.v === next.v
        && previous.providerId === next.providerId
    ) {
        return previous;
    }

    return next;
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

function isSessionListRenderableMetadataComparisonSnapshotEqual(
    snapshot: SessionListRenderableMetadataComparisonSnapshot,
    previous: SessionListRenderableMetadata,
    nextDirectSessionV1: SessionListRenderableMetadataComparison['directSessionV1'],
    nextReadStateV1: SessionListRenderableMetadataComparison['readStateV1'],
): boolean {
    return previous.name === snapshot.name
        && (previous.summaryText ?? null) === snapshot.summaryText
        && previous.path === snapshot.path
        && (previous.homeDir ?? null) === snapshot.homeDir
        && (previous.host ?? null) === snapshot.host
        && (previous.machineId ?? null) === snapshot.machineId
        && (previous.flavor ?? null) === snapshot.flavor
        && (previous.hiddenSystemSession === true) === snapshot.hiddenSystemSession
        && previous.directSessionV1 === nextDirectSessionV1
        && previous.readStateV1 === nextReadStateV1;
}

export function normalizeSessionListRenderableMetadataComparison(
    snapshot: SessionListRenderableMetadataComparisonSnapshot,
    previous?: SessionListRenderableMetadata | null,
): SessionListRenderableMetadataComparison {
    const normalizedSnapshot = {
        ...snapshot,
    };
    const nextDirectSessionV1 = readDirectSessionRenderableMetadata(
        normalizedSnapshot.directSessionV1,
        previous?.directSessionV1 ?? null,
    );
    const nextReadStateV1 = readStateRenderableMetadata(
        normalizedSnapshot.readStateV1,
        previous?.readStateV1 ?? null,
    );

    if (previous && isSessionListRenderableMetadataComparisonSnapshotEqual(normalizedSnapshot, previous, nextDirectSessionV1, nextReadStateV1)) {
        return previous as SessionListRenderableMetadataComparison;
    }

    const next: SessionListRenderableMetadataComparison = {
        name: normalizedSnapshot.name,
        summaryText: normalizedSnapshot.summaryText,
        path: normalizedSnapshot.path,
        homeDir: normalizedSnapshot.homeDir,
        host: normalizedSnapshot.host,
        machineId: normalizedSnapshot.machineId,
        flavor: normalizedSnapshot.flavor,
        directSessionV1: nextDirectSessionV1,
        readStateV1: nextReadStateV1,
        hiddenSystemSession: normalizedSnapshot.hiddenSystemSession,
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

    return normalizeSessionListRenderableMetadataComparison({
        name: typeof metadata.name === 'string' ? metadata.name : undefined,
        summaryText: typeof metadata.summary?.text === 'string' ? metadata.summary.text : null,
        path: typeof metadata.path === 'string' ? metadata.path : '',
        homeDir: typeof metadata.homeDir === 'string' ? metadata.homeDir : null,
        host: typeof metadata.host === 'string' ? metadata.host : null,
        machineId: typeof metadata.machineId === 'string' ? metadata.machineId : null,
        flavor: typeof metadata.flavor === 'string' ? metadata.flavor : null,
        directSessionV1: (metadata as Readonly<{ directSessionV1?: unknown }>).directSessionV1,
        readStateV1: (metadata as Readonly<{ readStateV1?: unknown }>).readStateV1,
        hiddenSystemSession: metadata.systemSessionV1?.hidden === true,
    }, previous);
}

export function readSessionListRenderableMetadataComparisonFromRenderable(
    metadata: SessionListRenderableMetadata | null | undefined,
): SessionListRenderableMetadataComparison | null {
    if (!metadata) return null;

    return normalizeSessionListRenderableMetadataComparison({
        name: metadata.name,
        summaryText: metadata.summaryText ?? null,
        path: metadata.path,
        homeDir: metadata.homeDir ?? null,
        host: metadata.host ?? null,
        machineId: metadata.machineId ?? null,
        flavor: metadata.flavor ?? null,
        directSessionV1: metadata.directSessionV1 ?? null,
        readStateV1: metadata.readStateV1 ?? null,
        hiddenSystemSession: metadata.hiddenSystemSession === true,
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
        && (previous.summaryText ?? null) === (next.summaryText ?? null)
        && previous.path === next.path
        && (previous.homeDir ?? null) === (next.homeDir ?? null)
        && (previous.host ?? null) === (next.host ?? null)
        && (previous.machineId ?? null) === (next.machineId ?? null)
        && (previous.flavor ?? null) === (next.flavor ?? null)
        && (previous.hiddenSystemSession === true) === (next.hiddenSystemSession === true)
        && (previous.directSessionV1?.v ?? null) === (next.directSessionV1?.v ?? null)
        && (previous.directSessionV1?.providerId ?? null) === (next.directSessionV1?.providerId ?? null)
        && (previous.readStateV1?.v ?? null) === (next.readStateV1?.v ?? null)
        && (previous.readStateV1?.sessionSeq ?? null) === (next.readStateV1?.sessionSeq ?? null)
        && (previous.readStateV1?.pendingActivityAt ?? null) === (next.readStateV1?.pendingActivityAt ?? null)
        && (previous.readStateV1?.updatedAt ?? null) === (next.readStateV1?.updatedAt ?? null);
}
