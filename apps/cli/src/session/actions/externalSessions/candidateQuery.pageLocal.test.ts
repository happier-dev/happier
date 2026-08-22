import { createHash as createHashActual } from 'node:crypto';
import * as fsPromisesActual from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExternalSessionCandidatesPage } from '@/session/external/providerOps';

const indexReadMetrics = vi.hoisted(() => ({
    enabled: false,
    bytesRead: 0,
    readFileBytes: 0,
    readFileCalls: 0,
    fileHandleReadCalls: 0,
    bytesWritten: 0,
    writeFileCalls: 0,
    buildingCheckpointWrites: 0,
    validationCheckpointWrites: 0,
    completeIndexWrites: 0,
    maximumCheckpointBytes: 0,
    maximumCheckpointCandidates: 0,
    peakObservedHeapUsed: 0,
    peakObservedRss: 0,
    largeHashUpdates: 0,
    maximumHashUpdateBytes: 0,
    readObserver: null as null | ((bytes: Buffer) => void),
}));

vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const isCandidateIndexPath = (value: unknown): boolean => {
        const path = String(value);
        return path.includes('external-sessions')
            && path.endsWith('index.json');
    };
    return {
        ...actual,
        readFile: async (...args: Parameters<typeof actual.readFile>) => {
            const value = await actual.readFile(...args);
            if (indexReadMetrics.enabled && isCandidateIndexPath(args[0])) {
                indexReadMetrics.readFileCalls += 1;
                const bytes = typeof value === 'string'
                    ? Buffer.byteLength(value, 'utf8')
                    : value.byteLength;
                indexReadMetrics.bytesRead += bytes;
                indexReadMetrics.readFileBytes += bytes;
            }
            return value;
        },
        writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
            const value = await actual.writeFile(...args);
            const path = String(args[0]);
            if (
                indexReadMetrics.enabled
                && path.includes('external-sessions')
                && path.includes('candidate-indexes')
            ) {
                const data = args[1];
                if (typeof data !== 'string' && !ArrayBuffer.isView(data)) return value;
                const bytes = typeof data === 'string'
                    ? Buffer.byteLength(data, 'utf8')
                    : data.byteLength;
                const raw = typeof data === 'string'
                    ? data
                    : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
                const candidatesMarker = raw.indexOf('"candidates"');
                if (candidatesMarker < 0) return value;
                const header = raw.slice(0, candidatesMarker);
                const isBuilding = /"state"\s*:\s*"building"/.test(header);
                const isComplete = /"state"\s*:\s*"complete"/.test(header);
                if (!isBuilding && !isComplete) return value;
                indexReadMetrics.bytesWritten += bytes;
                indexReadMetrics.writeFileCalls += 1;
                indexReadMetrics.maximumCheckpointBytes = Math.max(
                    indexReadMetrics.maximumCheckpointBytes,
                    bytes,
                );
                if (isComplete) indexReadMetrics.completeIndexWrites += 1;
                else if (!/"validation"\s*:/.test(header)) indexReadMetrics.buildingCheckpointWrites += 1;
                else indexReadMetrics.validationCheckpointWrites += 1;
                const memory = process.memoryUsage();
                indexReadMetrics.peakObservedHeapUsed = Math.max(
                    indexReadMetrics.peakObservedHeapUsed,
                    memory.heapUsed,
                );
                indexReadMetrics.peakObservedRss = Math.max(
                    indexReadMetrics.peakObservedRss,
                    memory.rss,
                );
            }
            return value;
        },
        open: async (...args: Parameters<typeof actual.open>) => {
            const handle = await actual.open(...args);
            const measureReads = isCandidateIndexPath(args[0]);
            return new Proxy(handle, {
                get(target, property) {
                    if (property === 'read') {
                        return async (...readArgs: Parameters<typeof target.read>) => {
                            const result = await target.read(...readArgs);
                            if (indexReadMetrics.enabled && measureReads) {
                                indexReadMetrics.fileHandleReadCalls += 1;
                                indexReadMetrics.bytesRead += result.bytesRead;
                            }
                            if (measureReads && indexReadMetrics.readObserver) {
                                const observedBuffer = result.buffer;
                                if (Buffer.isBuffer(observedBuffer)) {
                                    indexReadMetrics.readObserver(
                                        observedBuffer.subarray(0, result.bytesRead),
                                    );
                                }
                            }
                            return result;
                        };
                    }
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        },
    };
});

vi.mock('node:crypto', async () => {
    const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
    return {
        ...actual,
        createHash: (...args: Parameters<typeof createHashActual>) => {
            const hash = actual.createHash(...args);
            return new Proxy(hash, {
                get(target, property) {
                    if (property === 'update') {
                        return (
                            data: Parameters<typeof target.update>[0],
                            inputEncoding?: Parameters<typeof target.update>[1],
                        ) => {
                            if (indexReadMetrics.enabled) {
                                const bytes = typeof data === 'string'
                                    ? Buffer.byteLength(data, inputEncoding)
                                    : (data as unknown as { byteLength: number }).byteLength;
                                indexReadMetrics.maximumHashUpdateBytes = Math.max(
                                    indexReadMetrics.maximumHashUpdateBytes,
                                    bytes,
                                );
                                if (bytes > 256 * 1024) indexReadMetrics.largeHashUpdates += 1;
                            }
                            return inputEncoding === undefined
                                ? target.update(data)
                                : target.update(data, inputEncoding);
                        };
                    }
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        },
    };
});

import { executeExternalSessionCandidateQuery } from './candidateQuery';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { writeBytesAtomic } from '@/utils/fs/writeJsonAtomic';

type MutableCandidate = {
    remoteSessionId: string;
    updatedAtMs: number;
    linkData: { projectId: string };
};

const roots: string[] = [];

function createBoundedCandidateSource(corpus: MutableCandidate[]) {
    return vi.fn(async ({ cursor, limit }: Readonly<{ cursor?: string; limit: number }>) => {
        const offset = cursor ? Number.parseInt(cursor.slice('scan:'.length), 10) : 0;
        const candidates = corpus.slice(offset, offset + limit).map((candidate) => ({ ...candidate }));
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
}

function resetIndexReadMetrics(): void {
    indexReadMetrics.bytesRead = 0;
    indexReadMetrics.readFileBytes = 0;
    indexReadMetrics.readFileCalls = 0;
    indexReadMetrics.fileHandleReadCalls = 0;
    indexReadMetrics.bytesWritten = 0;
    indexReadMetrics.writeFileCalls = 0;
    indexReadMetrics.buildingCheckpointWrites = 0;
    indexReadMetrics.validationCheckpointWrites = 0;
    indexReadMetrics.completeIndexWrites = 0;
    indexReadMetrics.maximumCheckpointBytes = 0;
    indexReadMetrics.maximumCheckpointCandidates = 0;
    indexReadMetrics.peakObservedHeapUsed = 0;
    indexReadMetrics.peakObservedRss = 0;
    indexReadMetrics.largeHashUpdates = 0;
    indexReadMetrics.maximumHashUpdateBytes = 0;
}

async function findCandidateIndexPath(activeServerDir: string): Promise<string> {
    const indexRoot = join(activeServerDir, 'external-sessions', 'candidate-indexes', 'v1');
    const indexPaths: string[] = [];
    const walk = async (directory: string): Promise<void> => {
        const entries = await fsPromisesActual.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await walk(path);
            else if (entry.name === 'index.json') indexPaths.push(path);
        }
    };
    await walk(indexRoot);
    expect(indexPaths).toHaveLength(1);
    return indexPaths[0]!;
}

describe('External Sessions persisted candidate-index page locality', () => {
    afterEach(async () => {
        indexReadMetrics.enabled = false;
        indexReadMetrics.readObserver = null;
        vi.restoreAllMocks();
        await Promise.all(roots.splice(0).map(async (root) => {
            await rm(root, { recursive: true, force: true });
        }));
    });

    it.each([1_000, 10_000])(
        'reads and validates only bounded page-local index work for a deep page in a %i-candidate corpus',
        async (corpusSize) => {
            const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-page-local-'));
            roots.push(activeServerDir);
            const corpus = Array.from({ length: corpusSize }, (_, index): MutableCandidate => ({
                remoteSessionId: `session-${String(index).padStart(5, '0')}`,
                updatedAtMs: index,
                linkData: {
                    projectId: `project-${String(Math.floor(index / 100)).padStart(3, '0')}`,
                },
            }));
            const listCandidates = createBoundedCandidateSource(corpus);
            const hydrateCandidate = vi.fn(async (candidate: MutableCandidate) => ({
                ...candidate,
                title: `title:${candidate.remoteSessionId}`,
            }));
            const query = (cursor?: string) => executeExternalSessionCandidateQuery({
                activeServerDir,
                agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
                source: { kind: 'claudeConfig', configDir: '/private/source' },
                ...(cursor ? { cursor } : {}),
                limit: 50,
                listCandidates,
                hydrateCandidate,
            });

            let firstPage: Awaited<ReturnType<typeof query>> | null = null;
            const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(0);
            try {
                for (let rootCall = 0; rootCall < 10 && !firstPage; rootCall += 1) {
                    const result = await query();
                    if (!result.preparation) firstPage = result;
                }
            } finally {
                nowSpy.mockRestore();
            }
            expect(firstPage).not.toBeNull();

            const targetPage = Math.floor(corpusSize / 100);
            let cursor = firstPage!.nextCursor;
            for (let page = 1; page < targetPage; page += 1) {
                expect(cursor).not.toBeNull();
                cursor = (await query(cursor ?? undefined)).nextCursor;
            }

            listCandidates.mockClear();
            hydrateCandidate.mockClear();
            let corpusScaleSorts = 0;
            const arraySort = Array.prototype.sort;
            const sortSpy = vi.spyOn(Array.prototype, 'sort').mockImplementation(function (
                this: unknown[],
                compareFn?: (left: unknown, right: unknown) => number,
            ) {
                if (indexReadMetrics.enabled && this.length >= corpusSize) corpusScaleSorts += 1;
                return arraySort.call(this, compareFn);
            });
            resetIndexReadMetrics();
            indexReadMetrics.enabled = true;
            let deepPage: Awaited<ReturnType<typeof query>>;
            try {
                deepPage = await query(cursor ?? undefined);
            } finally {
                indexReadMetrics.enabled = false;
                sortSpy.mockRestore();
            }

            expect(deepPage.candidates).toHaveLength(50);
            expect(deepPage.candidates.map((candidate) => candidate.remoteSessionId)).toEqual(
                Array.from({ length: 50 }, (_, pageIndex) => (
                    `session-${String(
                        corpusSize - (targetPage * 50) - 1 - pageIndex,
                    ).padStart(5, '0')}`
                )),
            );
            expect(new Set(
                deepPage.candidates.map((candidate) => candidate.remoteSessionId),
            ).size).toBe(50);
            expect(listCandidates).not.toHaveBeenCalled();
            expect(hydrateCandidate).toHaveBeenCalledTimes(50);
            expect(indexReadMetrics.readFileCalls).toBe(0);
            expect(indexReadMetrics.fileHandleReadCalls).toBeGreaterThan(0);
            expect(indexReadMetrics.bytesRead).toBeLessThanOrEqual(256 * 1024);
            expect(corpusScaleSorts).toBe(0);
            expect(indexReadMetrics.largeHashUpdates).toBe(0);
            expect(indexReadMetrics.maximumHashUpdateBytes).toBeLessThanOrEqual(256 * 1024);
        },
        120_000,
    );

    it('scans a near-capacity corrupt candidate tail without repeatedly copying prior chunks', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-linear-scan-'));
        roots.push(activeServerDir);
        const corpus = Array.from({ length: 2 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${String(index).padStart(3, '0')}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
        }));
        const listCandidates = createBoundedCandidateSource(corpus);
        const query = (cursor?: string) => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            ...(cursor ? { cursor } : {}),
            limit: 1,
            listCandidates,
        });

        let firstPage: Awaited<ReturnType<typeof query>> | null = null;
        const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(0);
        try {
            for (let rootCall = 0; rootCall < 10 && !firstPage; rootCall += 1) {
                const result = await query();
                if (!result.preparation) firstPage = result;
            }
        } finally {
            nowSpy.mockRestore();
        }
        expect(firstPage?.nextCursor).toEqual(expect.any(String));

        const cursor = firstPage!.nextCursor!;
        const cursorSeparator = cursor.indexOf(':');
        const decodedCursor = JSON.parse(
            Buffer.from(cursor.slice(cursorSeparator + 1), 'base64url').toString('utf8'),
        ) as { byteOffset: number };
        const indexPath = await findCandidateIndexPath(activeServerDir);
        const validBytes = await fsPromisesActual.readFile(indexPath);
        const nearCapacityBytes = (64 * 1024 * 1024) - 1_024;
        const corruptPrefix = Buffer.from(
            '{"remoteSessionId":"unterminated","updatedAtMs":0,"indexOrdinal":1,'
            + `"contentAddressDigest":"${'0'.repeat(64)}","linkData":{"padding":"`,
            'utf8',
        );
        const retainedPrefix = validBytes.subarray(0, decodedCursor.byteOffset);
        const paddingBytes = nearCapacityBytes - retainedPrefix.byteLength - corruptPrefix.byteLength;
        expect(paddingBytes).toBeGreaterThan(60 * 1024 * 1024);
        await fsPromisesActual.writeFile(indexPath, [
            retainedPrefix,
            corruptPrefix,
            Buffer.alloc(paddingBytes, 0x61),
        ]);

        let concatenatedInputBytes = 0;
        const maximumLinearCopyBytes = nearCapacityBytes * 2;
        const actualConcat = Buffer.concat;
        const concatSpy = vi.spyOn(Buffer, 'concat').mockImplementation((list, totalLength) => {
            concatenatedInputBytes += list.reduce((total, chunk) => total + chunk.byteLength, 0);
            if (concatenatedInputBytes > maximumLinearCopyBytes) {
                throw new Error('Candidate page scan exceeded its linear copy budget');
            }
            return actualConcat(list, totalLength);
        });
        try {
            await expect(query(cursor)).rejects.toMatchObject({
                code: 'invalid_request',
                operation: 'listCandidates',
                retryable: false,
            });
        } finally {
            concatSpy.mockRestore();
        }
        expect(concatenatedInputBytes).toBeLessThanOrEqual(maximumLinearCopyBytes);
    }, 120_000);

    it('does not delete a valid same-generation replacement after rejecting an older corrupt inode', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-stale-cleanup-'));
        roots.push(activeServerDir);
        const corpus = Array.from({ length: 150 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${String(index).padStart(3, '0')}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
        }));
        const listCandidates = createBoundedCandidateSource(corpus);
        const query = (cursor?: string) => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            ...(cursor ? { cursor } : {}),
            limit: 50,
            listCandidates,
        });

        let firstPage: Awaited<ReturnType<typeof query>> | null = null;
        const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(0);
        try {
            for (let rootCall = 0; rootCall < 10 && !firstPage; rootCall += 1) {
                const result = await query();
                if (!result.preparation) firstPage = result;
            }
        } finally {
            nowSpy.mockRestore();
        }
        expect(firstPage?.nextCursor).toEqual(expect.any(String));

        const indexPath = await findCandidateIndexPath(activeServerDir);
        const validBytes = await fsPromisesActual.readFile(indexPath);
        const validRaw = validBytes.toString('utf8');
        const corruptNeedle = '"remoteSessionId":"session-149","updatedAtMs":49';
        expect(validRaw).toContain('"remoteSessionId":"session-049","updatedAtMs":49');
        expect(validRaw).not.toContain(corruptNeedle);
        const corruptRaw = validRaw.replace(
            '"remoteSessionId":"session-049","updatedAtMs":49',
            corruptNeedle,
        );
        expect(JSON.parse(corruptRaw)).toMatchObject({
            indexGeneration: JSON.parse(validRaw).indexGeneration as string,
        });
        await fsPromisesActual.writeFile(indexPath, corruptRaw, 'utf8');

        let observedCorruptReadResolve!: () => void;
        const observedCorruptRead = new Promise<void>((resolve) => {
            observedCorruptReadResolve = resolve;
        });
        indexReadMetrics.readObserver = (bytes) => {
            if (!bytes.includes(Buffer.from(corruptNeedle, 'utf8'))) return;
            indexReadMetrics.readObserver = null;
            observedCorruptReadResolve();
        };

        let staleQuery!: ReturnType<typeof query>;
        await withJsonOwnerFileLock({
            lockPath: join(dirname(indexPath), 'index.lock'),
            timeoutMs: 15_000,
            staleAfterMs: 30_000,
            errorCode: 'external_session_candidate_index_lock_timeout',
            pollIntervalMs: 10,
        }, async () => {
            staleQuery = query(firstPage!.nextCursor ?? undefined);
            await Promise.race([
                observedCorruptRead,
                delay(5_000).then(() => {
                    throw new Error('Timed out waiting for stale reader to observe corrupt index bytes');
                }),
            ]);
            await writeBytesAtomic(indexPath, validBytes);
        });

        await expect(staleQuery).rejects.toMatchObject({
            code: 'invalid_request',
            operation: 'listCandidates',
            retryable: false,
        });
        await expect(fsPromisesActual.readFile(indexPath)).resolves.toEqual(validBytes);
    });

    it('rejects an oversized corrupt index without reading it into memory', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-oversized-index-'));
        roots.push(activeServerDir);
        const corpus: MutableCandidate[] = [{
            remoteSessionId: 'session-001',
            updatedAtMs: 1,
            linkData: { projectId: 'project-a' },
        }];
        const listCandidates = createBoundedCandidateSource(corpus);
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 1,
            listCandidates,
        });

        let published: Awaited<ReturnType<typeof query>> | null = null;
        const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(0);
        try {
            for (let rootCall = 0; rootCall < 10 && !published; rootCall += 1) {
                const result = await query();
                if (!result.preparation) published = result;
            }
        } finally {
            nowSpy.mockRestore();
        }
        expect(published?.candidates).toHaveLength(1);

        const indexPath = await findCandidateIndexPath(activeServerDir);
        await fsPromisesActual.truncate(
            indexPath,
            (64 * 1024 * 1024) + (16 * 1024) + 1,
        );

        resetIndexReadMetrics();
        indexReadMetrics.enabled = true;
        try {
            await expect(query()).resolves.toMatchObject({
                candidates: [],
                preparation: { kind: 'building_candidate_index' },
            });
        } finally {
            indexReadMetrics.enabled = false;
        }
        expect(indexReadMetrics.readFileCalls).toBe(0);
        expect(indexReadMetrics.fileHandleReadCalls).toBe(0);
        expect(indexReadMetrics.readFileBytes).toBe(0);
    });
});

describe.runIf(process.env.HAPPIER_RUN_EXTERNAL_SESSION_BENCHMARK === '1')(
    'External Sessions sliced candidate-index checkpoint I/O benchmark',
    () => {
        let benchmarkRoot: string | null = null;

        afterEach(async () => {
            indexReadMetrics.enabled = false;
            if (!benchmarkRoot) return;
            await rm(benchmarkRoot, { recursive: true, force: true });
            benchmarkRoot = null;
        });

        it('measures repeated full-state checkpoints across slow bounded 10,000-candidate slices', async () => {
            benchmarkRoot = await mkdtemp(join(tmpdir(), 'happier-candidate-sliced-io-benchmark-'));
            const activeServerDir = benchmarkRoot;
            const corpus = Array.from({ length: 10_000 }, (_, index): MutableCandidate => ({
                remoteSessionId: `session-${String(index).padStart(5, '0')}`,
                updatedAtMs: index,
                linkData: {
                    projectId: `project-${String(Math.floor(index / 100)).padStart(3, '0')}`,
                },
            }));
            const boundedSource = createBoundedCandidateSource(corpus);
            const continuationDelayMs = 6;
            let leafCalls = 0;
            const listCandidates = async (request: Readonly<{ cursor?: string; limit: number }>) => {
                leafCalls += 1;
                if (request.cursor) await delay(continuationDelayMs);
                return await boundedSource(request);
            };
            const query = () => executeExternalSessionCandidateQuery({
                activeServerDir,
                agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
                source: { kind: 'claudeConfig', configDir: '/private/source' },
                limit: 50,
                listCandidates,
            });

            resetIndexReadMetrics();
            const baselineMemory = process.memoryUsage();
            indexReadMetrics.peakObservedHeapUsed = baselineMemory.heapUsed;
            indexReadMetrics.peakObservedRss = baselineMemory.rss;
            indexReadMetrics.enabled = true;
            const startedAt = performance.now();
            let rootCalls = 0;
            let published: Awaited<ReturnType<typeof query>> | null = null;
            try {
                while (rootCalls < 100 && !published) {
                    rootCalls += 1;
                    const page = await query();
                    const memory = process.memoryUsage();
                    indexReadMetrics.peakObservedHeapUsed = Math.max(
                        indexReadMetrics.peakObservedHeapUsed,
                        memory.heapUsed,
                    );
                    indexReadMetrics.peakObservedRss = Math.max(
                        indexReadMetrics.peakObservedRss,
                        memory.rss,
                    );
                    if (!page.preparation) published = page;
                }
            } finally {
                indexReadMetrics.enabled = false;
            }
            const elapsedMs = performance.now() - startedAt;
            const indexPath = await findCandidateIndexPath(activeServerDir);
            const finalIndexRaw = await fsPromisesActual.readFile(indexPath, 'utf8');
            const finalIndex = JSON.parse(finalIndexRaw) as Readonly<{ candidateCount?: unknown }>;
            const finalIndexBytes = Buffer.byteLength(finalIndexRaw, 'utf8');
            if (typeof finalIndex.candidateCount === 'number') {
                indexReadMetrics.maximumCheckpointCandidates = finalIndex.candidateCount;
            }
            const measurement = {
                schema: 'external-candidate-index-sliced-io-j14-v1',
                environment: {
                    node: process.version,
                    platform: process.platform,
                    arch: process.arch,
                    runner: 'vitest over the candidate-query owner with a deterministic 6ms continuation boundary',
                },
                corpus: {
                    candidates: corpus.length,
                    pageSize: 50,
                    continuationDelayMs,
                },
                elapsedMs: Math.round(elapsedMs * 100) / 100,
                rootCalls,
                leafCalls,
                fullStateReads: {
                    count: indexReadMetrics.readFileCalls + indexReadMetrics.fileHandleReadCalls,
                    bytes: indexReadMetrics.bytesRead,
                    amplificationOverFinalIndex: Math.round(
                        (indexReadMetrics.bytesRead / finalIndexBytes) * 100,
                    ) / 100,
                },
                fullStateWrites: {
                    count: indexReadMetrics.writeFileCalls,
                    bytes: indexReadMetrics.bytesWritten,
                    buildCheckpoints: indexReadMetrics.buildingCheckpointWrites,
                    validationCheckpoints: indexReadMetrics.validationCheckpointWrites,
                    completedIndexes: indexReadMetrics.completeIndexWrites,
                    amplificationOverFinalIndex: Math.round(
                        (indexReadMetrics.bytesWritten / finalIndexBytes) * 100,
                    ) / 100,
                },
                observedPeakCandidateState: {
                    checkpointCandidates: indexReadMetrics.maximumCheckpointCandidates,
                    checkpointBytes: indexReadMetrics.maximumCheckpointBytes,
                    heapDeltaBytes: indexReadMetrics.peakObservedHeapUsed - baselineMemory.heapUsed,
                    rssDeltaBytes: indexReadMetrics.peakObservedRss - baselineMemory.rss,
                },
                finalIndexBytes,
            };
            process.stdout.write(`EXTERNAL_CANDIDATE_INDEX_SLICED_IO_J14 ${JSON.stringify(measurement)}\n`);

            expect(published?.candidates).toHaveLength(50);
            expect(published?.candidates[0]?.remoteSessionId).toBe('session-09999');
            expect(rootCalls).toBeGreaterThan(6);
            expect(indexReadMetrics.buildingCheckpointWrites).toBeGreaterThan(2);
            expect(indexReadMetrics.validationCheckpointWrites).toBeGreaterThan(2);
            expect(indexReadMetrics.completeIndexWrites).toBe(1);
            expect(indexReadMetrics.maximumCheckpointCandidates).toBe(corpus.length);
        }, 120_000);
    },
);
