import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { DEFAULT_AGENT_ID, getAgentCore } from '@/agents/catalog/catalog';
import { t } from '@/text';

type SessionDebugMetadata = unknown;

export type SessionDebugInformationSession = Readonly<{
    id: string;
    metadata?: SessionDebugMetadata;
}>;

export type SessionDebugInformation = Readonly<{
    text: string;
    happierSessionId: string;
    providerDisplayName: string | null;
    providerSessionId: string | null;
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

function readRuntimeDescriptorPiSessionFile(metadata: SessionDebugMetadata): string | null {
    const record = asRecord(metadata);
    const descriptor = asRecord(record?.agentRuntimeDescriptorV1);
    if (descriptor?.providerId !== 'pi') return null;
    const provider = asRecord(descriptor.provider);
    return normalizeString(provider?.sessionFile);
}

function readRuntimeDescriptorVendorSessionId(metadata: SessionDebugMetadata): string | null {
    const record = asRecord(metadata);
    const descriptor = asRecord(record?.agentRuntimeDescriptorV1);
    const provider = asRecord(descriptor?.provider);
    return normalizeString(provider?.vendorSessionId);
}

export function resolveProviderSessionIdForDebug(params: Readonly<{
    metadata: SessionDebugMetadata;
    vendorResumeIdField?: string | null;
}>): string | null {
    const record = asRecord(params.metadata);
    const field = normalizeString(params.vendorResumeIdField);
    return readRuntimeDescriptorVendorSessionId(params.metadata)
        ?? (field ? normalizeString(record?.[field]) : null);
}

export function resolveProviderSessionArtifactPath(metadata: SessionDebugMetadata): string | null {
    const record = asRecord(metadata);
    return normalizeString(record?.claudeTranscriptPath)
        ?? normalizeString(record?.piSessionFile)
        ?? readRuntimeDescriptorPiSessionFile(metadata);
}

export function buildSessionDebugInformation(params: Readonly<{
    session: SessionDebugInformationSession;
    providerDisplayName?: string | null;
    providerSessionId?: string | null;
}>): SessionDebugInformation {
    const providerDisplayName = normalizeString(params.providerDisplayName);
    const providerSessionId = normalizeString(params.providerSessionId);
    const metadata = asRecord(params.session.metadata);
    const happierSessionLogPath = normalizeString(metadata?.sessionLogPath);
    const providerSessionArtifactPath = resolveProviderSessionArtifactPath(params.session.metadata);
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
        happierSessionId: params.session.id,
        providerDisplayName,
        providerSessionId,
        happierSessionLogPath,
        providerSessionArtifactPath: providerSessionArtifactPath ?? null,
    };
}

/** Menu entrypoints share the same agent identity and information formatter. */
export function buildSessionDebugInformationForSession(session: SessionDebugInformationSession): SessionDebugInformation {
    const agentId = resolveAgentIdFromSessionMetadata(session.metadata) ?? DEFAULT_AGENT_ID;
    const agentCore = getAgentCore(agentId);
    return buildSessionDebugInformation({
        session,
        providerDisplayName: t(agentCore.displayNameKey),
        providerSessionId: resolveProviderSessionIdForDebug({
            metadata: session.metadata,
            vendorResumeIdField: agentCore.resume.vendorResumeIdField,
        }),
    });
}
