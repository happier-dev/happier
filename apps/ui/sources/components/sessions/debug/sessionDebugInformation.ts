import {
    readNormalizedRuntimeDescriptor,
    resolveSessionArtifactPathFromMetadata,
} from '@happier-dev/agents';
import type { Metadata } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

type SessionDebugMetadata = unknown;

export type SessionDebugInformationSession = Readonly<{
    id: string;
    metadata?: unknown;
    metadataLayoutVersion?: number;
    ownerMetadataView?: unknown;
}>;

export type SessionDebugInformation = Readonly<{
    text: string;
    happierSessionLogPath: string | null;
    providerSessionArtifactPath: string | null;
}>;

export function isSessionDebugInformationEnabled(
    localDevModeEnabled: unknown,
    isDevBuild = __DEV__,
): boolean {
    return isDevBuild || localDevModeEnabled === true;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function normalizeString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

export function resolveProviderSessionIdForDebug(params: Readonly<{
    metadata: SessionDebugMetadata;
    vendorResumeIdField?: string | null;
}>): string | null {
    const metadata = asRecord(params.metadata);
    const field = normalizeString(params.vendorResumeIdField);
    return normalizeString(readNormalizedRuntimeDescriptor(params.metadata)?.providerSessionId)
        ?? (field ? normalizeString(metadata?.[field]) : null);
}

export function resolveProviderSessionArtifactPath(metadata: SessionDebugMetadata): string | null {
    const record = asRecord(metadata);
    return normalizeString(record?.claudeTranscriptPath)
        ?? resolveSessionArtifactPathFromMetadata(metadata);
}

export function buildSessionDebugInformation(params: Readonly<{
    session: SessionDebugInformationSession;
    providerDisplayName?: string | null;
    providerSessionId?: string | null;
}>): SessionDebugInformation {
    const providerDisplayName = normalizeString(params.providerDisplayName);
    const providerSessionId = normalizeString(params.providerSessionId);
    const ownerMetadata = readSessionOwnerMetadataView({
        metadataLayoutVersion: params.session.metadataLayoutVersion,
        metadata: params.session.metadata ?? null,
        ownerMetadataView: params.session.ownerMetadataView,
    });
    const metadata = asRecord(ownerMetadata);
    const happierSessionLogPath = normalizeString(metadata?.sessionLogPath);
    const providerSessionArtifactPath = resolveProviderSessionArtifactPath(ownerMetadata);
    const lines = [`Happier session ID: ${params.session.id}`];

    if (providerDisplayName && providerSessionId) {
        lines.push(`${providerDisplayName} session ID: ${providerSessionId}`);
    }
    if (happierSessionLogPath) {
        lines.push(`Happier logs: ${happierSessionLogPath}`);
    }
    if (providerDisplayName && providerSessionArtifactPath) {
        lines.push(`${providerDisplayName} session logs: ${providerSessionArtifactPath}`);
    }

    return {
        text: lines.join('\n'),
        happierSessionLogPath,
        providerSessionArtifactPath: providerSessionArtifactPath ?? null,
    };
}
