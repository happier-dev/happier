import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    PluginAgentExternalSessionLinkDataSchema,
    type PluginAgentExternalSessionLinkData,
} from '@happier-dev/protocol';

import type { ExternalSessionCandidatesPage } from '@/session/external/providerOps';

import { executeExternalSessionCandidateQuery } from './candidateQuery';

type Candidate = Readonly<{
    remoteSessionId: string;
    updatedAtMs: number;
    linkData?: PluginAgentExternalSessionLinkData;
}>;

const roots: string[] = [];

async function findCandidateIndexPath(activeServerDir: string): Promise<string> {
    const root = join(activeServerDir, 'external-sessions', 'candidate-indexes', 'v1');
    const found: string[] = [];
    const walk = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await walk(path);
            else if (entry.name === 'index.json') found.push(path);
        }
    };
    await walk(root);
    expect(found).toHaveLength(1);
    return found[0]!;
}

describe('External Sessions candidate identity persistence', () => {
    afterEach(async () => {
        await Promise.all(roots.splice(0).map(async (root) => {
            await rm(root, { recursive: true, force: true });
        }));
    });

    it('persists, pages, and hydrates candidates distinguished only by own __proto__ link data', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-proto-key-'));
        roots.push(activeServerDir);
        const corpus: Candidate[] = ['project-a', 'project-b'].map((projectId) => ({
            remoteSessionId: 'shared-session',
            updatedAtMs: 10,
            linkData: PluginAgentExternalSessionLinkDataSchema.parse(
                JSON.parse(`{"__proto__":{"projectId":"${projectId}"}}`),
            ),
        }));
        const listCandidates = vi.fn(async ({ cursor, limit }: Readonly<{ cursor?: string; limit: number }>) => {
            const offset = cursor ? Number.parseInt(cursor.slice('scan:'.length), 10) : 0;
            const candidates = corpus.slice(offset, offset + limit);
            const nextOffset = offset + candidates.length;
            return {
                candidates,
                nextCursor: nextOffset < corpus.length ? `scan:${nextOffset}` : null,
                preparation: {
                    kind: 'building_candidate_index' as const,
                    scanned: nextOffset,
                    total: corpus.length,
                },
            } satisfies ExternalSessionCandidatesPage;
        });
        const hydrateCandidate = vi.fn(async (candidate: Candidate) => candidate);
        const query = (cursor?: string) => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.fixture', localId: 'fixture' },
            source: { kind: 'fixture' },
            ...(cursor ? { cursor } : {}),
            limit: 1,
            listCandidates,
            hydrateCandidate,
        });

        let firstPage: Awaited<ReturnType<typeof query>> | null = null;
        for (let attempt = 0; attempt < 10 && !firstPage; attempt += 1) {
            const result = await query();
            if (!result.preparation) firstPage = result;
        }
        expect(firstPage?.candidates).toHaveLength(1);
        expect(firstPage?.nextCursor).toEqual(expect.any(String));

        const secondPage = await query(firstPage!.nextCursor ?? undefined);
        expect(secondPage.candidates).toHaveLength(1);
        expect(secondPage.nextCursor).toBeNull();
        expect(hydrateCandidate).toHaveBeenCalledTimes(2);

        const persisted = await readFile(await findCandidateIndexPath(activeServerDir), 'utf8');
        expect(persisted.match(/"__proto__"/gu)).toHaveLength(2);
    });
});
