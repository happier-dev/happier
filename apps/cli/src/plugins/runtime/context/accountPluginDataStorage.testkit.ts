import {
    PLUGIN_COLLECTION_GET_HTTP_PATH_V1,
    PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1,
    PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1,
    PluginCollectionGetRequestV1Schema,
    PluginCollectionMutationRequestV1Schema,
    PluginCollectionQueryRequestV1Schema,
    type PluginCollectionMutationRequestV1,
    type PluginCollectionQueryRequestV1,
    type PluginCollectionRowV1,
} from '@happier-dev/protocol';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';

/** Opaque server HTTP storage: logical codecs and encryption remain in the real host. */
function currentRevision(row: PluginCollectionRowV1 | undefined): number | null {
    return row?.revision ?? null;
}

function matchesExpectedRevision(
    row: PluginCollectionRowV1 | undefined,
    expectedRevision: number | 'absent',
): boolean {
    return expectedRevision === 'absent'
        ? row === undefined
        : row?.revision === expectedRevision;
}

export function createHttpCollectionBoundary(indexes: PluginAccountCollectionDefinition['indexes'], mode: 'plain' | 'e2ee' = 'e2ee') {
    const rows = new Map<string, PluginCollectionRowV1>();
    const capturedMutationRequests: PluginCollectionMutationRequestV1[] = [];
    const capturedReadPaths: string[] = [];
    const capturedQueryRequests: PluginCollectionQueryRequestV1[] = [];
    let changeCursor = 0;

    return {
        capturedMutationRequests,
        capturedReadPaths,
        capturedQueryRequests,
        retainedRowCount: () => rows.size,
        http: {
            async get(url: string) {
                if (!url.endsWith('/v1/account/encryption')) {
                    throw new Error(`Unexpected Account Data GET ${url}`);
                }
                return { status: 200, data: { mode, updatedAt: 1 } };
            },
            async post(url: string, body: string) {
                if (url.endsWith(PLUGIN_COLLECTION_GET_HTTP_PATH_V1)) {
                    capturedReadPaths.push(PLUGIN_COLLECTION_GET_HTTP_PATH_V1);
                    const request = PluginCollectionGetRequestV1Schema.parse(JSON.parse(body));
                    return { status: 200, data: { row: rows.get(request.rowId) ?? null, absenceEpoch: 0 } };
                }
                if (url.endsWith(PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1)) {
                    capturedReadPaths.push(PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1);
                    const request = PluginCollectionQueryRequestV1Schema.parse(JSON.parse(body));
                    capturedQueryRequests.push(request);
                    const index = indexes.find(index => index.id === request.indexId);
                    if (!index) {
                        throw new Error(`Unexpected Collection query index ${request.indexId}`);
                    }
                    const matched = [...rows.values()]
                        .filter((row) => (request.prefixes ?? [request.prefix]).some(prefix => prefix.every((value, position) => {
                            const field = index.fields[position];
                            return field !== undefined && row.projection[field.field] === value;
                        })))
                        .sort((left, right) => left.rowId.localeCompare(right.rowId));
                    const offset = request.cursor === undefined ? 0 : Number.parseInt(request.cursor, 10);
                    if (!Number.isSafeInteger(offset) || offset < 0) {
                        throw new Error('Invalid test Collection cursor.');
                    }
                    const page = matched.slice(offset, offset + request.limit);
                    const nextOffset = offset + page.length;
                    return {
                        status: 200,
                        data: {
                            rows: page,
                            ...(nextOffset < matched.length ? { nextCursor: String(nextOffset) } : {}),
                            changeCursor,
                        },
                    };
                }
                if (!url.endsWith(PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1)) {
                    throw new Error(`Unexpected Account Data POST ${url}`);
                }
                const request = PluginCollectionMutationRequestV1Schema.parse(JSON.parse(body));
                capturedMutationRequests.push(request);
                const nextRows = new Map(rows);
                const results: Array<Readonly<{ rowId: string; revision: number; deleted: boolean }>> = [];
                for (const operation of request.operations) {
                    const existing = nextRows.get(operation.rowId);
                    if (!matchesExpectedRevision(existing, operation.expectedRevision)) {
                        return {
                            status: 200,
                            data: {
                                status: 'conflict' as const,
                                conflicts: [{
                                    rowId: operation.rowId,
                                    revision: currentRevision(existing),
                                    deleted: false,
                                }],
                            },
                        };
                    }
                    if (operation.kind === 'assert') continue;
                    if (operation.kind === 'delete') {
                        nextRows.delete(operation.rowId);
                        results.push({
                            rowId: operation.rowId,
                            revision: (existing?.revision ?? 0) + 1,
                            deleted: true,
                        });
                        continue;
                    }
                    const row: PluginCollectionRowV1 = {
                        rowId: operation.rowId,
                        revision: (existing?.revision ?? 0) + 1,
                        content: operation.content,
                        projection: operation.projection,
                    };
                    nextRows.set(row.rowId, row);
                    results.push({ rowId: row.rowId, revision: row.revision, deleted: false });
                }
                rows.clear();
                for (const [rowId, row] of nextRows) rows.set(rowId, row);
                changeCursor += 1;
                return {
                    status: 200,
                    data: { status: 'updated' as const, results, changeCursor },
                };
            },
        },
    };
}

