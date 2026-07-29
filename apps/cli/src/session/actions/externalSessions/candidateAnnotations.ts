import {
    readExternalHistoryImportV1FromMetadata,
    readLinkedExternalSessionV1FromMetadata,
    type ExternalSessionCandidateV1,
    type ExternalSessionsAgentId,
    type ExternalSessionsSource,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import {
    fetchSessionsPage,
    type RawSessionListRow,
} from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveExternalSessionCandidateIdentityKey } from './candidateQuery';

const DEFAULT_ANNOTATION_SCAN_MAX_PAGES = 10;
const MAX_ANNOTATION_SCAN_MAX_PAGES = 50;
const ANNOTATION_SCAN_PAGE_SIZE = 200;

type CandidateAnnotation = Readonly<{
    linkedSessionId: string;
    imported?: true;
    materializedThrough?: number;
}>;

function resolveAnnotationScanMaxPages(explicitMaxPages?: number): number {
    if (explicitMaxPages !== undefined) {
        return Math.max(1, Math.min(MAX_ANNOTATION_SCAN_MAX_PAGES, Math.trunc(explicitMaxPages)));
    }
    const configured = Number.parseInt(
        (process.env.HAPPIER_EXTERNAL_SESSION_ANNOTATION_SCAN_MAX_PAGES ?? '').trim(),
        10,
    );
    return Number.isFinite(configured) && configured > 0
        ? Math.min(MAX_ANNOTATION_SCAN_MAX_PAGES, configured)
        : DEFAULT_ANNOTATION_SCAN_MAX_PAGES;
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

    const linked = readLinkedExternalSessionV1FromMetadata(params.metadata);
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

export async function annotateExternalSessionCandidates(
    params: Readonly<{
        credentials: Credentials;
        machineId: string;
        agentId: ExternalSessionsAgentId;
        source: ExternalSessionsSource;
        candidates: readonly ExternalSessionCandidateV1[];
        sourceKeyOwner: Readonly<{
            sourceKey: string;
            resolveSourceKey(source: ExternalSessionsSource): string | null;
        }>;
        maxPages?: number;
    }>,
    dependencies: Readonly<{
        fetchPage: typeof fetchSessionsPage;
        decryptMetadata: typeof tryDecryptSessionOwnerMetadataView;
    }> = {
        fetchPage: fetchSessionsPage,
        decryptMetadata: tryDecryptSessionOwnerMetadataView,
    },
): Promise<readonly ExternalSessionCandidateV1[]> {
    if (params.candidates.length === 0) return params.candidates;
    const candidateKeys = new Set(params.candidates.map((candidate) => (
        candidate.candidateKey ?? resolveExternalSessionCandidateIdentityKey(candidate)
    )));
    const annotations = new Map<string, CandidateAnnotation>();
    const expectedSourceKey = params.sourceKeyOwner.sourceKey;
    const maxPages = resolveAnnotationScanMaxPages(params.maxPages);

    for (const archivedOnly of [false, true]) {
        let cursor: string | undefined;
        for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
            const page = await dependencies.fetchPage({
                token: params.credentials.token,
                cursor,
                limit: ANNOTATION_SCAN_PAGE_SIZE,
                archivedOnly,
            });
            for (const row of page.sessions) {
                const metadata = dependencies.decryptMetadata({
                    credentials: params.credentials,
                    rawSession: row,
                });
                if (!metadata) continue;
                annotateFromRow({
                    row,
                    metadata,
                    candidateKeys,
                    expectedAgentId: params.agentId,
                    expectedMachineId: params.machineId,
                    expectedSourceKey,
                    resolveSourceKey: params.sourceKeyOwner.resolveSourceKey,
                    annotations,
                });
            }
            if (!page.hasNext || !page.nextCursor) break;
            cursor = page.nextCursor;
        }
    }

    if (annotations.size === 0) return params.candidates;
    return params.candidates.map((candidate) => {
        const annotation = annotations.get(
            candidate.candidateKey ?? resolveExternalSessionCandidateIdentityKey(candidate),
        );
        return annotation ? { ...candidate, ...annotation } : candidate;
    });
}
