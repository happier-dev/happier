import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRecordV1Schema, PromptLibraryRowMutationV1Schema,
    type PromptLibraryCatalogKeyV1, type PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { createPlainArtifactHomeFixture } from './artifactStoreBoundary';

/** Plain Home HTTP/persistence boundary. Real client catalog, crypto, Actions and mutations run above it. */
export function createPromptLibraryCatalogBoundary(options: Readonly<{
    records?: readonly PromptLibraryRecordV1[];
    revision?: number;
    tombstones?: readonly PromptLibraryCatalogKeyV1[];
    mutationOutcome?: 'updated' | 'conflict';
    settingsVersion?: number;
}> = {}) {
    const records = new Map(PromptLibraryCatalogKeyV1Schema.options.map(key => [key, emptyPromptLibraryRecordV1(key)]));
    const revisions = new Map(PromptLibraryCatalogKeyV1Schema.options.map(key => [key, options.revision ?? 1]));
    const tombstones = new Set(options.tombstones ?? []);
    for (const record of options.records ?? []) records.set(record.key, PromptLibraryRecordV1Schema.parse(record));
    const requests: Readonly<{ key: PromptLibraryCatalogKeyV1; expectedRevision: number | 'absent' }>[] = [];
    return {
        read(key: PromptLibraryCatalogKeyV1) { return records.get(key)!; },
        revision(key: PromptLibraryCatalogKeyV1) { return revisions.get(key)!; },
        requests,
        async handle(path: string, init?: RequestInit): Promise<Response | null> {
            const root = '/v1/account/entity-rows/prompt-library';
            if (path === '/v2/account/settings') return Response.json({ version: options.settingsVersion ?? 2, content: { t: 'plain', v: {} } });
            if (path === root && (init?.method ?? 'GET') === 'GET') return Response.json({ status: 'listed',
                rows: [...records.values()].map(record => ({ key: record.key, revision: revisions.get(record.key),
                    content: tombstones.has(record.key) ? null : { t: 'plain', v: record } })) });
            if (!path.startsWith(`${root}/`) || init?.method !== 'POST') return null;
            const key = PromptLibraryCatalogKeyV1Schema.parse(decodeURIComponent(path.slice(root.length + 1)));
            const mutation = PromptLibraryRowMutationV1Schema.parse(JSON.parse(String(init.body)));
            requests.push({ key, expectedRevision: mutation.expectedRevision });
            if (options.mutationOutcome === 'conflict' || mutation.expectedRevision !== revisions.get(key))
                return Response.json({ status: 'conflict', revision: revisions.get(key) });
            if (mutation.content?.t !== 'plain') return Response.json({ status: 'account-mode-mismatch' });
            const record = PromptLibraryRecordV1Schema.parse(mutation.content.v);
            if (record.key !== key) return Response.json({ error: 'record_identity_mismatch' }, { status: 400 });
            records.set(key, record);
            tombstones.delete(key);
            const revision = revisions.get(key)! + 1;
            revisions.set(key, revision);
            return Response.json({ status: 'updated', revision, cursor: revision });
        },
    };
}

/** Admitted Home facade over the same row HTTP/CAS boundary for screen and hook tests. */
export async function createPlainPromptLibraryCatalogHomeFixture(serverUrl: string, initial: PromptLibraryRecordV1,
    outcome: 'updated' | 'conflict' = 'updated', options?: Readonly<{
        handleRequest?: (path: string, init?: RequestInit) => Promise<Response | null>;
    }>) {
    const tombstoneKeys = PromptLibraryCatalogKeyV1Schema.options.filter(key => key !== initial.key);
    const catalog = createPromptLibraryCatalogBoundary({ records: [initial], revision: 4,
        tombstones: tombstoneKeys, mutationOutcome: outcome, settingsVersion: 7 });
    let settingsWrites = 0;
    const fixture = await createPlainArtifactHomeFixture(serverUrl, { handleRequest: async (path, init) => {
        if (path === '/v2/account/settings' && init?.method === 'POST') {
            settingsWrites += 1;
            return Response.json({ success: true, version: 8 });
        }
        return await catalog.handle(path, init) ?? await options?.handleRequest?.(path, init) ?? null;
    } });
    return { ...fixture, mutations: catalog.requests,
        tombstones: tombstoneKeys.map(key => ({ key, revision: catalog.revision(key) })),
        read: () => ({ record: catalog.read(initial.key), revision: catalog.revision(initial.key) }),
        settingsWrites: () => settingsWrites };
}
