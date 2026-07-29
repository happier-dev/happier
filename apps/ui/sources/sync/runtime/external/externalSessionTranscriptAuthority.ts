import type { ExternalSessionOperationProgressV1 } from '@happier-dev/protocol';

export type ExternalSessionTranscriptStorageState =
    | 'machine_only'
    | 'server_partial'
    | 'snapshot_complete'
    | 'hosted'
    | 'legacy_external_unknown';

export type ExternalSessionTranscriptAuthority =
    | Readonly<{ kind: 'live_agent'; sourceKey: string }>
    | Readonly<{ kind: 'server_partial'; maxServerSeq: number }>
    | Readonly<{
        kind: 'server_snapshot';
        maxServerSeq: number;
        materializedThroughSourceAt: number;
    }>
    | Readonly<{ kind: 'hosted' }>
    | Readonly<{
        kind: 'unavailable';
        reason:
            | 'machine_offline'
            | 'initial_partial_not_permitted'
            | 'invalid_publication'
            | 'legacy_external_unknown'
            | 'invalid_authority_state';
    }>;

export type ExternalSessionTranscriptSharingDecision =
    | Readonly<{ kind: 'hosted' }>
    | Readonly<{ kind: 'requires_persisted_import' }>
    | Readonly<{ kind: 'import_incomplete' }>
    | Readonly<{
        kind: 'published_snapshot';
        materializedThroughSourceAt: number;
    }>
    | Readonly<{
        kind: 'unavailable';
        reason:
            | 'invalid_authority_state'
            | 'invalid_publication'
            | 'legacy_external_unknown';
    }>;

export type ExternalSessionTranscriptAuthorityState = Readonly<{
    authority: ExternalSessionTranscriptAuthority;
    sharing: ExternalSessionTranscriptSharingDecision;
}>;

export type ExternalSessionTranscriptAuthorityInput = Readonly<{
    linked: boolean;
    /** `null` means reachability is not yet known and keeps the live read authoritative. */
    agentReachable: boolean | null;
    liveSourceKey: string | null;
    currentStorageState: ExternalSessionTranscriptStorageState;
    acceptedThroughServerSeq: number | null;
    publishedThroughServerSeq: number | null;
    materializedThroughSourceAt: number | null;
    /**
     * Initial partial rows are admitted only when the pushed public operation
     * projection agrees with the session's current storage facts and accepted bound.
     */
    operationProgress: ExternalSessionOperationProgressV1 | null;
}>;

type ExternalSessionTranscriptLiveSourceIdentity = Readonly<{
    machineId: string;
    agentId: string;
    remoteSessionId: string;
    linkGeneration: string;
    pluginId: string | null;
    pluginAgentLocalId: string | null;
    sourceKind: string;
    sourceContractVersion: number | null;
    sourceIdentity?: unknown;
    linkData?: unknown;
}>;

type ExternalSessionTranscriptLiveLink = Readonly<{
    machineId: string;
    agentId: string;
    remoteSessionId: string;
    linkedAtMs?: number;
    source: Readonly<{ kind: string }>;
    qualifiedIdentity?: Readonly<{
        agent: Readonly<{ pluginId: string; localId: string }>;
        source: Readonly<{ kind: string; contractVersion: number }>;
    }>;
    linkData?: unknown;
}>;

function readServerSequence(value: number | null): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
}

function readObservedAt(value: number | null): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
}

function readNonEmptyString(value: string | null): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function stableJson(value: unknown, seen: Set<object> = new Set()): string {
    if (value === null) return 'null';
    if (typeof value === 'string' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('External-session source identity must be finite JSON');
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        if (seen.has(value)) throw new Error('External-session source identity must be acyclic JSON');
        seen.add(value);
        try {
            return `[${value.map((entry) => stableJson(entry, seen)).join(',')}]`;
        } finally {
            seen.delete(value);
        }
    }
    if (typeof value === 'object') {
        if (seen.has(value)) throw new Error('External-session source identity must be acyclic JSON');
        seen.add(value);
        try {
            const record = value as Record<string, unknown>;
            return `{${Object.keys(record)
                .sort()
                .map((key) => `${JSON.stringify(key)}:${stableJson(record[key], seen)}`)
                .join(',')}}`;
        } finally {
            seen.delete(value);
        }
    }
    throw new Error('External-session source identity must contain only JSON values');
}

export function createExternalSessionTranscriptLiveSourceKey(
    identity: ExternalSessionTranscriptLiveSourceIdentity,
): string | null {
    const machineId = readNonEmptyString(identity.machineId);
    const agentId = readNonEmptyString(identity.agentId);
    const remoteSessionId = readNonEmptyString(identity.remoteSessionId);
    const linkGeneration = readNonEmptyString(identity.linkGeneration);
    const sourceKind = readNonEmptyString(identity.sourceKind);
    if (!machineId || !agentId || !remoteSessionId || !linkGeneration || !sourceKind) {
        return null;
    }
    try {
        return JSON.stringify([
            machineId,
            agentId,
            remoteSessionId,
            linkGeneration,
            readNonEmptyString(identity.pluginId),
            readNonEmptyString(identity.pluginAgentLocalId),
            sourceKind,
            readServerSequence(identity.sourceContractVersion),
            stableJson(identity.sourceIdentity ?? null),
            stableJson(identity.linkData ?? null),
        ]);
    } catch {
        return null;
    }
}

export function createExternalSessionTranscriptLiveSourceKeyFromLink(
    link: ExternalSessionTranscriptLiveLink,
): string | null {
    if (
        typeof link.linkedAtMs !== 'number'
        || !Number.isSafeInteger(link.linkedAtMs)
        || link.linkedAtMs < 0
    ) {
        return null;
    }
    const qualifiedIdentity = link.qualifiedIdentity ?? null;
    return createExternalSessionTranscriptLiveSourceKey({
        machineId: link.machineId,
        agentId: link.agentId,
        remoteSessionId: link.remoteSessionId,
        linkGeneration: String(link.linkedAtMs),
        pluginId: qualifiedIdentity?.agent.pluginId ?? null,
        pluginAgentLocalId: qualifiedIdentity?.agent.localId ?? null,
        sourceKind: qualifiedIdentity?.source.kind ?? link.source.kind,
        sourceContractVersion: qualifiedIdentity?.source.contractVersion ?? null,
        sourceIdentity: link.source,
        linkData: link.linkData ?? null,
    });
}

/**
 * Stable identity for the UI-owned transcript viewer lease.
 *
 * Current links use the full generation-qualified live-source identity. Legacy
 * links without `linkedAtMs` still need a stable lease scope, but mutable policy
 * metadata must not tear down and reacquire the viewer.
 */
export function createExternalSessionTranscriptLeaseScopeKeyFromLink(
    link: ExternalSessionTranscriptLiveLink,
): string | null {
    const liveSourceKey = createExternalSessionTranscriptLiveSourceKeyFromLink(link);
    if (liveSourceKey) return liveSourceKey;
    if (link.linkedAtMs !== undefined) return null;

    const machineId = readNonEmptyString(link.machineId);
    const agentId = readNonEmptyString(link.agentId);
    const remoteSessionId = readNonEmptyString(link.remoteSessionId);
    const sourceKind = readNonEmptyString(link.source.kind);
    if (!machineId || !agentId || !remoteSessionId || !sourceKind) {
        return null;
    }

    const qualifiedIdentity = link.qualifiedIdentity ?? null;
    try {
        return JSON.stringify([
            'legacy_without_link_generation',
            machineId,
            agentId,
            remoteSessionId,
            readNonEmptyString(qualifiedIdentity?.agent.pluginId ?? null),
            readNonEmptyString(qualifiedIdentity?.agent.localId ?? null),
            sourceKind,
            readServerSequence(qualifiedIdentity?.source.contractVersion ?? null),
            stableJson(link.source),
            stableJson(link.linkData ?? null),
        ]);
    } catch {
        return null;
    }
}

export function externalSessionTranscriptAuthorityKey(
    authority: ExternalSessionTranscriptAuthority,
): string {
    switch (authority.kind) {
        case 'live_agent':
            return `${authority.kind}:${authority.sourceKey}`;
        case 'server_snapshot':
            return `${authority.kind}:${authority.maxServerSeq}:${authority.materializedThroughSourceAt}`;
        case 'server_partial':
            return `${authority.kind}:${authority.maxServerSeq}`;
        case 'unavailable':
            return `${authority.kind}:${authority.reason}`;
        case 'hosted':
            return authority.kind;
    }
}

/**
 * The single authority decision for external-session transcript reads.
 *
 * Link metadata owns managed-runtime identity, not transcript authority. Persisted
 * storage state chooses which existing transcript reader may run, and this decision
 * is made before either reader can emit rows.
 */
function resolveAuthority(
    input: ExternalSessionTranscriptAuthorityInput,
): ExternalSessionTranscriptAuthority {
    if (input.currentStorageState === 'hosted') {
        return { kind: 'hosted' };
    }
    if (input.currentStorageState === 'legacy_external_unknown') {
        return { kind: 'unavailable', reason: 'legacy_external_unknown' };
    }
    if (!input.linked) {
        return { kind: 'unavailable', reason: 'invalid_authority_state' };
    }
    if (input.agentReachable !== false) {
        const sourceKey = readNonEmptyString(input.liveSourceKey);
        return sourceKey
            ? { kind: 'live_agent', sourceKey }
            : { kind: 'unavailable', reason: 'invalid_authority_state' };
    }

    if (input.currentStorageState === 'machine_only') {
        return { kind: 'unavailable', reason: 'machine_offline' };
    }
    if (input.currentStorageState === 'server_partial') {
        const maxServerSeq = readServerSequence(input.acceptedThroughServerSeq);
        if (maxServerSeq === null) {
            return { kind: 'unavailable', reason: 'invalid_publication' };
        }
        const progress = input.operationProgress;
        if (
            progress?.currentStorageState !== 'server_partial'
            || progress.checkpoint.acceptedThroughServerSeq !== maxServerSeq
            || progress.fence.kind !== 'initial_server_partial'
            || progress.fence.acceptedThroughServerSeq !== maxServerSeq
        ) {
            return { kind: 'unavailable', reason: 'initial_partial_not_permitted' };
        }
        return { kind: 'server_partial', maxServerSeq };
    }

    const maxServerSeq = readServerSequence(input.publishedThroughServerSeq);
    const materializedThroughSourceAt = readObservedAt(input.materializedThroughSourceAt);
    if (maxServerSeq === null || materializedThroughSourceAt === null) {
        return { kind: 'unavailable', reason: 'invalid_publication' };
    }
    return {
        kind: 'server_snapshot',
        maxServerSeq,
        materializedThroughSourceAt,
    };
}

function resolveSharingDecision(
    input: ExternalSessionTranscriptAuthorityInput,
): ExternalSessionTranscriptSharingDecision {
    if (input.currentStorageState === 'hosted') {
        return { kind: 'hosted' };
    }
    if (input.currentStorageState === 'legacy_external_unknown') {
        return { kind: 'unavailable', reason: 'legacy_external_unknown' };
    }
    if (!input.linked) {
        return { kind: 'unavailable', reason: 'invalid_authority_state' };
    }
    if (input.currentStorageState === 'machine_only') {
        return { kind: 'requires_persisted_import' };
    }
    if (input.currentStorageState === 'server_partial') {
        return { kind: 'import_incomplete' };
    }

    const publishedThroughServerSeq = readServerSequence(input.publishedThroughServerSeq);
    const materializedThroughSourceAt = readObservedAt(input.materializedThroughSourceAt);
    if (publishedThroughServerSeq === null || materializedThroughSourceAt === null) {
        return { kind: 'unavailable', reason: 'invalid_publication' };
    }
    return {
        kind: 'published_snapshot',
        materializedThroughSourceAt,
    };
}

/**
 * Resolves transcript read authority and its sharing projection from the same
 * server-owned storage facts. Runtime/link reachability may select a live read
 * without making an incomplete transcript shareable.
 */
export function resolveExternalSessionTranscriptAuthorityState(
    input: ExternalSessionTranscriptAuthorityInput,
): ExternalSessionTranscriptAuthorityState {
    return {
        authority: resolveAuthority(input),
        sharing: resolveSharingDecision(input),
    };
}

export function resolveExternalSessionTranscriptAuthority(
    input: ExternalSessionTranscriptAuthorityInput,
): ExternalSessionTranscriptAuthority {
    return resolveExternalSessionTranscriptAuthorityState(input).authority;
}
