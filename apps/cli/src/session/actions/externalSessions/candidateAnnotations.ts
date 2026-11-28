import { readExternalHistoryImportV1FromMetadata, readNonAuthoritativeLinkedExternalSessionV1FromMetadata } from '@happier-dev/protocol/sessions/external/linked-metadata';
import { SESSION_LOOKUP_BY_TAGS_MAX_TAGS_V2 } from '@happier-dev/protocol/sessions/control/contract';
import type { ExternalSessionCandidateV1, ExternalSessionsAgentId, ExternalSessionsSource } from '@happier-dev/protocol';

import { resolveExternalSessionTagLookupCandidates } from '@/api/session/external/linking/externalSessionTagLookupCandidates';
import type { StoredCredentials } from '@/persistence';
import {
    lookupSessionsByTags,
    type RawSessionListRow,
} from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { resolveExternalSessionCandidateIdentityKey } from './candidateQuery';

type CandidateAnnotation = Readonly<{
    linkedSessionId: string;
    imported?: true;
    materializedThrough?: number;
}>;

type CandidateAnnotationResult = Readonly<{
    candidates: readonly ExternalSessionCandidateV1[];
    /**
     * Indexed annotation was unavailable or cancelled before completion.
     * Positive annotations remain authoritative; omission is not a negative fact.
     */
    annotationsIncomplete: boolean;
}>;

type CandidateAnnotationSourceKeyOwner = Readonly<{
    sourceKey: string;
    resolveSourceKey(source: ExternalSessionsSource): string | null;
    resolvePersistedSourceKeys?(
        source: ExternalSessionsSource,
    ): readonly [string, ...string[]] | null;
}>;

function throwIfAnnotationCancelled(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    const error = new Error('External-session candidate annotation was cancelled');
    error.name = 'AbortError';
    throw error;
}

function readMaterializedThrough(row: RawSessionListRow): number | undefined {
    const raw = (row as Readonly<Record<string, unknown>>).materializedThroughSourceAt;
    const value = typeof raw === 'bigint' ? Number(raw) : raw;
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
}

function identityMatches(params: Readonly<{
    expectedAgentId: ExternalSessionsAgentId;
    expectedMachineId: string;
    expectedSourceKey: string;
    resolveSourceKey(source: ExternalSessionsSource): string | null;
    agentId: string;
    machineId: string;
    source: ExternalSessionsSource;
}>): boolean {
    return params.agentId === params.expectedAgentId
        && params.machineId === params.expectedMachineId
        && params.resolveSourceKey(params.source) === params.expectedSourceKey;
}

function annotateFromRow(params: Readonly<{
    row: RawSessionListRow;
    metadata: Readonly<Record<string, unknown>>;
    candidateKeys: ReadonlySet<string>;
    expectedAgentId: ExternalSessionsAgentId;
    expectedMachineId: string;
    expectedSourceKey: string;
    resolveSourceKey(source: ExternalSessionsSource): string | null;
    annotations: Map<string, CandidateAnnotation>;
}>): void {
    const materializedThrough = readMaterializedThrough(params.row);
    const imported = readExternalHistoryImportV1FromMetadata(params.metadata);
    const importedMachineId = typeof params.metadata.machineId === 'string'
        ? params.metadata.machineId.trim()
        : '';
    if (
        imported
        && importedMachineId
        && params.candidateKeys.has(resolveExternalSessionCandidateIdentityKey(imported))
        && identityMatches({
            expectedAgentId: params.expectedAgentId,
            expectedMachineId: params.expectedMachineId,
            expectedSourceKey: params.expectedSourceKey,
            resolveSourceKey: params.resolveSourceKey,
            agentId: imported.agentId,
            machineId: importedMachineId,
            source: imported.source,
        })
    ) {
        params.annotations.set(resolveExternalSessionCandidateIdentityKey(imported), {
            linkedSessionId: params.row.id,
            imported: true,
            ...(materializedThrough === undefined ? {} : { materializedThrough }),
        });
        return;
    }

    const linked = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(params.metadata);
    if (
        !linked
        || !params.candidateKeys.has(resolveExternalSessionCandidateIdentityKey(linked))
        || !identityMatches({
            expectedAgentId: params.expectedAgentId,
            expectedMachineId: params.expectedMachineId,
            expectedSourceKey: params.expectedSourceKey,
            resolveSourceKey: params.resolveSourceKey,
            agentId: linked.agentId,
            machineId: linked.machineId,
            source: linked.source,
        })
    ) {
        return;
    }
    const candidateKey = resolveExternalSessionCandidateIdentityKey(linked);
    if (params.annotations.get(candidateKey)?.imported) return;
    params.annotations.set(candidateKey, {
        linkedSessionId: params.row.id,
        ...(materializedThrough === undefined ? {} : { materializedThrough }),
    });
}

/**
 * The single place a retrieved owner row becomes (or fails to become) a
 * candidate annotation. Both row sources below feed it, so the indexed lookup
 * and the compatibility scan can never disagree about what a row means.
 */
type CandidateAnnotationAbsorber = Readonly<{
    credentials: StoredCredentials;
    accountEncryptionMode: Parameters<
        typeof tryDecryptSessionOwnerMetadataView
    >[0]['accountEncryptionMode'];
    decryptMetadata: typeof tryDecryptSessionOwnerMetadataView;
    candidateKeys: ReadonlySet<string>;
    expectedAgentId: ExternalSessionsAgentId;
    expectedMachineId: string;
    expectedSourceKey: string;
    resolveSourceKey(source: ExternalSessionsSource): string | null;
    annotations: Map<string, CandidateAnnotation>;
}>;

function absorbAnnotationRows(
    absorber: CandidateAnnotationAbsorber,
    rows: readonly RawSessionListRow[],
): void {
    for (const row of rows) {
        const metadata = absorber.decryptMetadata({
            credentials: absorber.credentials,
            rawSession: row,
            accountEncryptionMode: absorber.accountEncryptionMode,
        });
        if (!metadata) continue;
        annotateFromRow({
            row,
            metadata,
            candidateKeys: absorber.candidateKeys,
            expectedAgentId: absorber.expectedAgentId,
            expectedMachineId: absorber.expectedMachineId,
            expectedSourceKey: absorber.expectedSourceKey,
            resolveSourceKey: absorber.resolveSourceKey,
            annotations: absorber.annotations,
        });
    }
}

/**
 * The account-unique lookup tags every served candidate would own if it were
 * already linked or imported, derived through the same owner the link path uses
 * so a browse annotation and a `link.ensure` can never disagree about identity.
 */
function resolveCandidateAnnotationLookupTags(params: Readonly<{
    machineId: string;
    agentId: ExternalSessionsAgentId;
    source: ExternalSessionsSource;
    sourceKeyOwner: CandidateAnnotationSourceKeyOwner;
    candidates: readonly ExternalSessionCandidateV1[];
}>): readonly string[] {
    const releasedSourceKeys = params.sourceKeyOwner.resolvePersistedSourceKeys?.(params.source)
        ?? [params.sourceKeyOwner.sourceKey] as const;
    const tags = new Set<string>();
    for (const candidate of params.candidates) {
        for (const lookupCandidate of resolveExternalSessionTagLookupCandidates({
            machineId: params.machineId,
            agentId: params.agentId,
            remoteSessionId: candidate.remoteSessionId,
            source: params.source,
            releasedPersistedSource: params.source,
            sourceKey: params.sourceKeyOwner.sourceKey,
            releasedSourceKeys,
        })) {
            tags.add(lookupCandidate.tag);
        }
    }
    return [...tags];
}

/**
 * Retrieve the owner rows for exactly the served page through the account's
 * indexed tag column. Returns `null` when the server does not serve the indexed
 * route at all, which is the only case the bounded page scan below still owns.
 */
async function absorbAnnotationRowsThroughIndexedTagLookup(params: Readonly<{
    absorber: CandidateAnnotationAbsorber;
    token: string;
    tags: readonly string[];
    lookupByTags: typeof lookupSessionsByTags;
    signal?: AbortSignal;
}>): Promise<boolean> {
    for (
        let offset = 0;
        offset < params.tags.length;
        offset += SESSION_LOOKUP_BY_TAGS_MAX_TAGS_V2
    ) {
        throwIfAnnotationCancelled(params.signal);
        const lookup = await params.lookupByTags({
            token: params.token,
            tags: params.tags.slice(offset, offset + SESSION_LOOKUP_BY_TAGS_MAX_TAGS_V2),
            ...(params.signal === undefined ? {} : { signal: params.signal }),
        });
        if (lookup.state === 'unavailable') return false;
        absorbAnnotationRows(params.absorber, lookup.sessions);
    }
    return true;
}

export async function annotateExternalSessionCandidates(
    params: Readonly<{
        credentials: StoredCredentials;
        machineId: string;
        agentId: ExternalSessionsAgentId;
        source: ExternalSessionsSource;
        candidates: readonly ExternalSessionCandidateV1[];
        sourceKeyOwner: CandidateAnnotationSourceKeyOwner;
        signal?: AbortSignal;
    }>,
    dependencies: Readonly<{
        decryptMetadata: typeof tryDecryptSessionOwnerMetadataView;
        getAccountEncryptionCurrentness?: typeof fetchAccountEncryptionCurrentness;
        lookupByTags?: typeof lookupSessionsByTags;
    }> = {
        decryptMetadata: tryDecryptSessionOwnerMetadataView,
        getAccountEncryptionCurrentness: fetchAccountEncryptionCurrentness,
    },
): Promise<CandidateAnnotationResult> {
    if (params.candidates.length === 0) {
        return { candidates: params.candidates, annotationsIncomplete: false };
    }
    const candidateKeys = new Set(params.candidates.map((candidate) => (
        candidate.candidateKey ?? resolveExternalSessionCandidateIdentityKey(candidate)
    )));
    const annotations = new Map<string, CandidateAnnotation>();
    let annotationsIncomplete = true;
    try {
        throwIfAnnotationCancelled(params.signal);
        const accountEncryptionCurrentness = await (
            dependencies.getAccountEncryptionCurrentness
            ?? fetchAccountEncryptionCurrentness
        )({
            token: params.credentials.token,
            ...(params.signal === undefined ? {} : { signal: params.signal }),
        });
        const absorber: CandidateAnnotationAbsorber = {
            credentials: params.credentials,
            accountEncryptionMode: accountEncryptionCurrentness.mode,
            decryptMetadata: dependencies.decryptMetadata,
            candidateKeys,
            expectedAgentId: params.agentId,
            expectedMachineId: params.machineId,
            expectedSourceKey: params.sourceKeyOwner.sourceKey,
            resolveSourceKey: params.sourceKeyOwner.resolveSourceKey,
            annotations,
        };
        const indexedLookupServed = await absorbAnnotationRowsThroughIndexedTagLookup({
            absorber,
            token: params.credentials.token,
            tags: resolveCandidateAnnotationLookupTags({
                machineId: params.machineId,
                agentId: params.agentId,
                source: params.source,
                sourceKeyOwner: params.sourceKeyOwner,
                candidates: params.candidates,
            }),
            lookupByTags: dependencies.lookupByTags ?? lookupSessionsByTags,
            ...(params.signal === undefined ? {} : { signal: params.signal }),
        });
        annotationsIncomplete = !indexedLookupServed;
        throwIfAnnotationCancelled(params.signal);
    } catch (error) {
        if (!params.signal?.aborted) throw error;
        // Annotation enriches an already-found native page. Cancellation stops
        // further Account reads without discarding its hits or positive facts.
        annotationsIncomplete = true;
    }
    if (annotations.size === 0) {
        return { candidates: params.candidates, annotationsIncomplete };
    }
    return {
        candidates: params.candidates.map((candidate) => {
            const annotation = annotations.get(
                candidate.candidateKey ?? resolveExternalSessionCandidateIdentityKey(candidate),
            );
            return annotation ? { ...candidate, ...annotation } : candidate;
        }),
        annotationsIncomplete,
    };
}
