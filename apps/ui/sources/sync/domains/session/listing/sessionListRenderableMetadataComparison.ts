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

function isSessionListRenderableMetadataComparisonSnapshotEqual(
    snapshot: SessionListRenderableMetadataComparisonSnapshot,
    previous: SessionListRenderableMetadata,
    nextDirectSessionV1: SessionListRenderableMetadataComparison['directSessionV1'],
): boolean {
    return previous.name === snapshot.name
        && (previous.summaryText ?? null) === snapshot.summaryText
        && previous.path === snapshot.path
        && (previous.homeDir ?? null) === snapshot.homeDir
        && (previous.host ?? null) === snapshot.host
        && (previous.machineId ?? null) === snapshot.machineId
        && (previous.flavor ?? null) === snapshot.flavor
        && (previous.hiddenSystemSession === true) === snapshot.hiddenSystemSession
        && previous.directSessionV1 === nextDirectSessionV1;
}

export function normalizeSessionListRenderableMetadataComparison(
    snapshot: SessionListRenderableMetadataComparisonSnapshot,
    previous?: SessionListRenderableMetadata | null,
): SessionListRenderableMetadataComparison {
    const nextDirectSessionV1 = readDirectSessionRenderableMetadata(
        snapshot.directSessionV1,
        previous?.directSessionV1 ?? null,
    );

    if (previous && isSessionListRenderableMetadataComparisonSnapshotEqual(snapshot, previous, nextDirectSessionV1)) {
        return previous as SessionListRenderableMetadataComparison;
    }

    const next: SessionListRenderableMetadataComparison = {
        name: snapshot.name,
        summaryText: snapshot.summaryText,
        path: snapshot.path,
        homeDir: snapshot.homeDir,
        host: snapshot.host,
        machineId: snapshot.machineId,
        flavor: snapshot.flavor,
        directSessionV1: nextDirectSessionV1,
        hiddenSystemSession: snapshot.hiddenSystemSession,
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
        && (previous.directSessionV1?.providerId ?? null) === (next.directSessionV1?.providerId ?? null);
}
