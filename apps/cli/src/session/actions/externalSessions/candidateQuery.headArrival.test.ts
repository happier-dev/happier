import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    ExternalSessionProviderFailureError,
    type ExternalSessionCandidatesPage,
} from '@/session/external/providerOps';

import { executeExternalSessionCandidateQuery } from './candidateQuery';

const roots: string[] = [];

type CorpusRow = {
    remoteSessionId: string;
    updatedAtMs: number;
    linkData: { projectId: string };
};

async function findCandidateIndexPath(activeServerDir: string): Promise<string> {
    const indexRoot = join(activeServerDir, 'external-sessions', 'candidate-indexes', 'v1');
    const indexPaths: string[] = [];
    const walk = async (directory: string): Promise<void> => {
        const { readdir } = await import('node:fs/promises');
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await walk(path);
            else if (entry.name === 'index.json') indexPaths.push(path);
        }
    };
    await walk(indexRoot);
    expect(indexPaths).toHaveLength(1);
    return indexPaths[0]!;
}

async function readBuildingRecord(activeServerDir: string): Promise<Readonly<{
    state: string;
    scanned: number;
    validation?: unknown;
    candidates: readonly Readonly<{ remoteSessionId: string }>[];
}>> {
    return JSON.parse(
        await readFile(await findCandidateIndexPath(activeServerDir), 'utf8'),
    ) as Readonly<{
        state: string;
        scanned: number;
        validation?: unknown;
        candidates: readonly Readonly<{ remoteSessionId: string }>[];
    }>;
}

/**
 * A source whose continuation cursor names the last row it consumed, the way a
 * real Agent rollout/traversal cursor names the last file it consumed. A row
 * created ahead of the traversal head therefore does NOT invalidate an
 * outstanding cursor — exactly the shape both shipping Agents produce.
 */
function createHeadAnchoredSource(corpus: CorpusRow[]) {
    return async (request: Readonly<{ cursor?: string; limit: number }>) => {
        const start = request.cursor
            ? corpus.findIndex(
                (row) => row.remoteSessionId === request.cursor!.slice('scan:'.length),
            ) + 1
            : 0;
        if (start === 0 && request.cursor) {
            throw new ExternalSessionProviderFailureError({
                code: 'source_invalid',
                operation: 'listCandidates',
                message: 'Head-anchored candidate cursor no longer resolves',
                retryable: true,
            });
        }
        const page = corpus.slice(start, start + request.limit).map((row) => ({ ...row }));
        const nextIndex = start + page.length;
        return {
            candidates: page,
            nextCursor: nextIndex < corpus.length
                ? `scan:${page.at(-1)!.remoteSessionId}`
                : null,
            preparation: {
                kind: 'building_candidate_index' as const,
                scanned: nextIndex,
            },
        };
    };
}

function createCorpus(size: number): CorpusRow[] {
    return Array.from({ length: size }, (_, index) => ({
        remoteSessionId: `row-${String(index).padStart(5, '0')}`,
        updatedAtMs: size - index,
        linkData: { projectId: 'project-a' },
    }));
}

const CHUNK_LIMIT = 6;

describe('External Sessions candidate index head arrivals', () => {
    afterEach(async () => {
        await Promise.all(roots.splice(0).map(async (root) => {
            await rm(root, { recursive: true, force: true });
        }));
    });

    it('keeps an in-progress build advancing when a row arrives at the traversal head', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-head-arrival-'));
        roots.push(activeServerDir);
        const corpus = createCorpus(30_000);
        const listCandidates = createHeadAnchoredSource(corpus);
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: CHUNK_LIMIT,
            listCandidates,
        });

        await query();
        const warmed = await query();
        expect(warmed.preparation?.kind).toBe('building_candidate_index');
        const beforeArrival = await readBuildingRecord(activeServerDir);
        expect(beforeArrival.state).toBe('building');
        expect(beforeArrival.validation).toBeUndefined();
        expect(beforeArrival.candidates.length).toBeGreaterThan(CHUNK_LIMIT);

        // A brand-new session lands ahead of the whole traversal: newest-first
        // ordering puts it in the first chunk, and it pushes the chunk's last row
        // out of the head window. Nothing already crawled changed.
        corpus.unshift({
            remoteSessionId: 'row-arrival',
            updatedAtMs: 10_000_000,
            linkData: { projectId: 'project-a' },
        });

        const afterArrival = await query();

        expect(afterArrival.preparation?.kind).toBe('building_candidate_index');
        expect(afterArrival.preparation?.scanned ?? 0)
            .toBeGreaterThan(warmed.preparation?.scanned ?? 0);
        const afterRecord = await readBuildingRecord(activeServerDir);
        expect(afterRecord.state).toBe('building');
        expect(afterRecord.validation).toBeUndefined();
        expect(afterRecord.candidates.length)
            .toBeGreaterThan(beforeArrival.candidates.length);
        expect(afterRecord.candidates[0]?.remoteSessionId).toBe('row-00000');
    });

    it('completes a generation whose crawl absorbed a head arrival, and serves the arrival next', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-head-completes-'));
        roots.push(activeServerDir);
        const corpus = createCorpus(15_000);
        const listCandidates = createHeadAnchoredSource(corpus);
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: CHUNK_LIMIT,
            listCandidates,
        });

        /**
         * Drives root browse rounds until the generation publishes, asserting the
         * reported scan never goes backwards on the way there.
         */
        const driveToCompletion = async (
            onRound?: (round: number) => Promise<void>,
        ): Promise<ExternalSessionCandidatesPage> => {
            let previousScanned: number | null = null;
            for (let round = 0; round < 60; round += 1) {
                const page = await query();
                if (!page.preparation) return page;
                const scanned = page.preparation.scanned;
                if (previousScanned !== null && scanned < previousScanned) {
                    throw new Error(
                        `Candidate index scan regressed at round ${round}: ${previousScanned} -> ${scanned}`,
                    );
                }
                previousScanned = scanned;
                await onRound?.(round);
            }
            throw new Error('Candidate index never published a generation');
        };

        const published = await driveToCompletion(async (round) => {
            if (round !== 1) return;
            // The crawl is still in progress: this is an arrival mid-build.
            const building = await readBuildingRecord(activeServerDir);
            expect(building.state).toBe('building');
            expect(building.validation).toBeUndefined();
            corpus.unshift({
                remoteSessionId: 'row-arrival',
                updatedAtMs: 10_000_000,
                linkData: { projectId: 'project-a' },
            });
        });

        // The generation the crawl actually made is what publishes: the absorbed
        // arrival is not in it, and it is ordered exactly as the crawl saw it.
        expect(published.candidates[0]?.remoteSessionId).toBe('row-00000');
        expect(published.candidates.map((candidate) => candidate.remoteSessionId))
            .not.toContain('row-arrival');
        const completed = await readBuildingRecord(activeServerDir);
        expect(completed.state).toBe('complete');

        // A completed generation absorbs nothing, so the arrival ahead of its
        // published head opens the next generation, which serves it in order.
        const superseded = await query();
        expect(superseded.preparation?.kind).toBe('building_candidate_index');
        const republished = await driveToCompletion();
        expect(republished.candidates[0]?.remoteSessionId).toBe('row-arrival');
    }, 120_000);

    it('restarts an in-progress build when an already-scanned head row mutates', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-head-mutation-'));
        roots.push(activeServerDir);
        const corpus = createCorpus(30_000);
        const listCandidates = createHeadAnchoredSource(corpus);
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: CHUNK_LIMIT,
            listCandidates,
        });

        await query();
        const warmed = await query();
        const beforeMutation = await readBuildingRecord(activeServerDir);
        expect(beforeMutation.candidates.length).toBeGreaterThan(CHUNK_LIMIT);

        // The row itself changed, inside the region the build already crawled.
        corpus[0]!.updatedAtMs = 20_000_000;

        const afterMutation = await query();

        expect(afterMutation.preparation?.kind).toBe('building_candidate_index');
        expect(afterMutation.preparation?.scanned ?? 0)
            .toBeLessThan(warmed.preparation?.scanned ?? 0);
        const afterRecord = await readBuildingRecord(activeServerDir);
        expect(afterRecord.state).toBe('building');
        expect(afterRecord.candidates).toHaveLength(CHUNK_LIMIT);
        expect(afterRecord.scanned).toBe(CHUNK_LIMIT);
    });

    it('rejects a persisted anchor that no longer derives its published token', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-head-forged-'));
        roots.push(activeServerDir);
        const corpus = createCorpus(30_000);
        const listCandidates = createHeadAnchoredSource(corpus);
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: CHUNK_LIMIT,
            listCandidates,
        });

        await query();
        const warmed = await query();
        const indexPath = await findCandidateIndexPath(activeServerDir);
        const persisted = JSON.parse(await readFile(indexPath, 'utf8')) as Record<string, unknown>;
        const anchor = persisted.head as readonly string[];
        expect(anchor).toHaveLength(CHUNK_LIMIT);

        // Forge the anchor so the crawl's own newest row is no longer anchored:
        // a mutation to that row would then read as an arrival ahead of the crawl.
        await writeFile(
            indexPath,
            JSON.stringify({ ...persisted, head: anchor.slice(1) }),
            'utf8',
        );
        corpus[0]!.updatedAtMs = 20_000_000;

        const afterForgery = await query();

        expect(afterForgery.preparation?.scanned ?? 0)
            .toBeLessThan(warmed.preparation?.scanned ?? 0);
        const afterRecord = await readBuildingRecord(activeServerDir);
        expect(afterRecord.candidates).toHaveLength(CHUNK_LIMIT);
        expect(afterRecord.scanned).toBe(CHUNK_LIMIT);
    });
});
