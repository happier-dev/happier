import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type {
    AgentExternalSessionsManagedEndpointRead,
} from '@happier-dev/plugin-sdk/sessions/external';
import {
    activate as activateClaudePlugin,
    PLUGIN_MANIFEST as CLAUDE_PLUGIN_MANIFEST,
} from '@happier-dev/plugins-claude';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    ExternalSessionProviderFailureError,
    type ExternalSessionCandidatesPage,
} from '@/session/external/providerOps';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

import {
    executeExternalSessionCandidateQuery,
    ExternalSessionCandidateIndexCursorResetError,
    hydrateExternalSessionCandidateThroughAgentSource,
    isExternalSessionCandidateIndexContinuationStepCountWithinCapacity,
    isExternalSessionCandidateIndexSourceWorkWithinCapacity,
    isExternalSessionCandidateIndexStateWithinByteCapacity,
    resolveExternalSessionCandidateIdentityKey,
} from './candidateQuery';

const roots: string[] = [];
const unavailableManagedEndpointRead: AgentExternalSessionsManagedEndpointRead =
    async () => {
        throw new Error('Managed endpoint read is unavailable in this file-backed fixture');
    };
const unavailableInvocationExec = createUnavailablePluginServices().exec;

type MutableCandidate = {
    remoteSessionId: string;
    updatedAtMs: number;
    linkData: { projectId: string };
    title?: string;
};

function candidateFixture(
    candidate: ExternalSessionCandidatesPage['candidates'][number],
): ExternalSessionCandidatesPage['candidates'][number] {
    return candidate;
}

async function findCandidateIndexPath(activeServerDir: string): Promise<string> {
    const indexRoot = join(activeServerDir, 'external-sessions', 'candidate-indexes', 'v1');
    const indexPaths: string[] = [];
    const walk = async (directory: string): Promise<void> => {
        const entries = await import('node:fs/promises').then(({ readdir }) => readdir(directory, { withFileTypes: true }));
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

async function countCandidateIndexFiles(activeServerDir: string): Promise<number> {
    const { readdir } = await import('node:fs/promises');
    let found = 0;
    const walk = async (directory: string): Promise<void> => {
        const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (entry.isDirectory()) await walk(join(directory, entry.name));
            else if (entry.name === 'index.json') found += 1;
        }
    };
    await walk(join(activeServerDir, 'external-sessions', 'candidate-indexes', 'v1'));
    return found;
}

function createBoundedCandidateSource(corpus: MutableCandidate[]) {
    return vi.fn(async ({ cursor, limit }: Readonly<{ cursor?: string; limit: number }>) => {
        const offset = cursor ? Number.parseInt(cursor.slice('scan:'.length), 10) : 0;
        const page = corpus.slice(offset, offset + limit).map((candidate) => ({ ...candidate }));
        const nextOffset = offset + page.length;
        return {
            candidates: page,
            nextCursor: nextOffset < corpus.length ? `scan:${nextOffset}` : null,
            preparation: {
                kind: 'building_candidate_index' as const,
                scanned: nextOffset,
                total: corpus.length,
            },
        };
    });
}

async function readUntilPublished(
    query: () => ReturnType<typeof executeExternalSessionCandidateQuery>,
    maxAttempts = 20,
): Promise<Readonly<{
    result: Awaited<ReturnType<typeof executeExternalSessionCandidateQuery>>;
    sourceInvalidCount: number;
}>> {
    let sourceInvalidCount = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            // A building index now serves the rows it already holds, so publication is
            // the absence of preparation state rather than the presence of candidates.
            const result = await query();
            if (!result.preparation) return { result, sourceInvalidCount };
        } catch (error) {
            if (
                error
                && typeof error === 'object'
                && Reflect.get(error, 'code') === 'source_invalid'
                && Reflect.get(error, 'retryable') === true
            ) {
                sourceInvalidCount += 1;
                continue;
            }
            throw error;
        }
    }
    throw new Error('Candidate index did not publish within the bounded test attempts');
}

describe('External Sessions candidate query owner', () => {
    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(roots.splice(0).map(async (root) => {
            await rm(root, { recursive: true, force: true });
        }));
    });

    it('passes caller cancellation through indexed candidate identity hydration', async () => {
        const caller = new AbortController();
        caller.abort();
        const resolveLinkIdentity = vi.fn(async (request: Readonly<{
            signal?: AbortSignal;
        }>) => {
            if (request.signal?.aborted !== true) {
                throw new Error('resolveLinkIdentity did not receive caller cancellation');
            }
            throw new ExternalSessionProviderFailureError({
                code: 'cancelled',
                operation: 'resolveLinkIdentity',
                message: 'Candidate identity hydration was cancelled',
                retryable: false,
            });
        });

        await expect(hydrateExternalSessionCandidateThroughAgentSource({
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            candidate: {
                remoteSessionId: 'session-1',
                updatedAtMs: 1,
                linkData: { projectId: 'project-a' },
            },
            providerOps: {
                resolveLinkIdentity,
                listCandidates: vi.fn(),
            },
            signal: caller.signal,
        })).rejects.toMatchObject({
            name: 'ExternalSessionProviderFailureError',
            code: 'cancelled',
            operation: 'resolveLinkIdentity',
        });
        expect(resolveLinkIdentity).toHaveBeenCalledTimes(1);
    });

    it.each([
        {
            name: 'same-kind source rewrite',
            resolvedIdentity: {
                remoteSessionId: 'session-1',
                source: { kind: 'claudeConfig', configDir: '/rewritten/source' },
            },
        },
        {
            name: 'remote-session id rewrite',
            resolvedIdentity: {
                remoteSessionId: 'session-2',
                source: { kind: 'claudeConfig', configDir: '/private/source' },
            },
        },
    ])('rejects a $name before the second candidate lookup', async ({ resolvedIdentity }) => {
        const listCandidates = vi.fn();

        await expect(hydrateExternalSessionCandidateThroughAgentSource({
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            candidate: {
                remoteSessionId: 'session-1',
                updatedAtMs: 1,
                linkData: { projectId: 'project-a' },
            },
            providerOps: {
                resolveLinkIdentity: async () => resolvedIdentity,
                listCandidates,
            },
        })).rejects.toMatchObject({
            name: 'ExternalSessionProviderFailureError',
            code: 'source_invalid',
            operation: 'resolveLinkIdentity',
        });

        expect(listCandidates).not.toHaveBeenCalled();
    });

    it('allows candidate identity hydration to add source fields', async () => {
        const candidate = {
            remoteSessionId: 'session-1',
            updatedAtMs: 1,
            linkData: { projectId: 'project-a' },
        } as const;
        const listCandidates = vi.fn(async () => ({
            candidates: [candidate],
            nextCursor: null,
        }));

        await expect(hydrateExternalSessionCandidateThroughAgentSource({
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            candidate,
            providerOps: {
                resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
                    remoteSessionId,
                    source: { ...source, canonicalConfigFile: '/private/source/config.json' },
                }),
                listCandidates,
            },
        })).resolves.toEqual(candidate);

        expect(listCandidates).toHaveBeenCalledWith(expect.objectContaining({
            source: {
                kind: 'claudeConfig',
                configDir: '/private/source',
                canonicalConfigFile: '/private/source/config.json',
            },
        }));
    });

    it('continues bounded candidate hydration when the exact match is beyond the first inspected entry', async () => {
        const caller = new AbortController();
        const candidate = {
            remoteSessionId: 'session-1',
            updatedAtMs: 1,
            linkData: { projectId: 'project-a' },
        } as const;
        const listCandidates = vi.fn(async ({ cursor }: Readonly<{ cursor?: string }>) => (
            cursor
                ? {
                    candidates: [candidate],
                    nextCursor: null,
                }
                : {
                    candidates: [],
                    nextCursor: 'scan:1',
                    searchIncomplete: true,
                }
        ));

        await expect(hydrateExternalSessionCandidateThroughAgentSource({
            source: { kind: 'ohMyPiAgentDir', agentDir: '/private/source' },
            candidate,
            providerOps: {
                resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
                    remoteSessionId,
                    source,
                }),
                listCandidates,
            },
            maxBytes: 4_096,
            signal: caller.signal,
        })).resolves.toEqual(candidate);

        expect(listCandidates).toHaveBeenCalledTimes(2);
        expect(listCandidates).toHaveBeenNthCalledWith(1, {
            source: { kind: 'ohMyPiAgentDir', agentDir: '/private/source' },
            limit: 1,
            searchTerm: 'session-1',
            searchMode: 'fast',
            maxBytes: 4_096,
            signal: caller.signal,
        });
        expect(listCandidates).toHaveBeenNthCalledWith(2, {
            source: { kind: 'ohMyPiAgentDir', agentDir: '/private/source' },
            cursor: 'scan:1',
            limit: 1,
            searchTerm: 'session-1',
            searchMode: 'fast',
            maxBytes: 4_096,
            signal: caller.signal,
        });
    });

    it('stops candidate hydration when a continuation cursor does not advance', async () => {
        const listCandidates = vi.fn(async () => ({
            candidates: [],
            nextCursor: 'scan:1',
            searchIncomplete: true,
        }));

        await expect(hydrateExternalSessionCandidateThroughAgentSource({
            source: { kind: 'ohMyPiAgentDir', agentDir: '/private/source' },
            candidate: {
                remoteSessionId: 'session-1',
                updatedAtMs: 1,
                linkData: { projectId: 'project-a' },
            },
            providerOps: {
                resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
                    remoteSessionId,
                    source,
                }),
                listCandidates,
            },
        })).rejects.toMatchObject({
            code: 'candidate_not_found',
            operation: 'listCandidates',
            retryable: true,
        });

        expect(listCandidates).toHaveBeenCalledTimes(2);
    });

    it('enforces exact source-work, continuation-history, and combined private-byte ceilings', () => {
        const privateByteCeiling = 64 * 1024 * 1024;
        const continuationStepCeiling = 250_000;
        const maximumHistoryBytes = 1 + (67 * continuationStepCeiling);

        expect(isExternalSessionCandidateIndexSourceWorkWithinCapacity(
            continuationStepCeiling,
            continuationStepCeiling,
        )).toBe(true);
        expect(isExternalSessionCandidateIndexSourceWorkWithinCapacity(
            continuationStepCeiling + 1,
            continuationStepCeiling + 1,
        )).toBe(false);
        expect(isExternalSessionCandidateIndexContinuationStepCountWithinCapacity(
            continuationStepCeiling,
        )).toBe(true);
        expect(isExternalSessionCandidateIndexContinuationStepCountWithinCapacity(
            continuationStepCeiling + 1,
        )).toBe(false);
        expect(isExternalSessionCandidateIndexStateWithinByteCapacity(
            privateByteCeiling - maximumHistoryBytes,
            maximumHistoryBytes,
        )).toBe(true);
        expect(isExternalSessionCandidateIndexStateWithinByteCapacity(
            privateByteCeiling - maximumHistoryBytes + 1,
            maximumHistoryBytes,
        )).toBe(false);
    });

    it.each([
        {
            name: 'Pi',
            agentIdentity: { pluginId: 'happier.agent.pi', localId: 'pi' },
            source: { kind: 'piAgentDir' },
            candidate: candidateFixture({
                remoteSessionId: 'pi-session',
                updatedAtMs: 20,
                linkData: { sessionFile: '/bounded/pi/session.jsonl' },
            }),
        },
        {
            name: 'Antigravity',
            agentIdentity: {
                pluginId: 'happier.agent.antigravity',
                localId: 'antigravity',
            },
            source: { kind: 'antigravityCliPrint' },
            candidate: candidateFixture({
                remoteSessionId: 'antigravity-conversation',
                updatedAtMs: 10,
                linkData: { sourceRevision: 'brain-generation' },
            }),
        },
    ])('returns the exact bounded $name page without creating a private index', async ({
        agentIdentity,
        source,
        candidate,
    }) => {
        const activeServerDir = await mkdtemp(join(
            tmpdir(),
            'happier-candidate-direct-leaf-',
        ));
        roots.push(activeServerDir);
        const listedCandidate = candidate;
        const listCandidates = vi.fn(async () => ({
            candidates: [listedCandidate],
            nextCursor: null,
        }));

        const result = await executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity,
            source,
            limit: 50,
            listCandidates,
        });

        expect(result).toEqual({
            candidates: [{
                ...listedCandidate,
                candidateKey: expect.stringMatching(/^[a-f0-9]{64}$/),
            }],
            nextCursor: null,
        });
        expect(result).not.toHaveProperty('preparation');
        expect(listCandidates).toHaveBeenCalledTimes(1);
        await expect(stat(join(
            activeServerDir,
            'external-sessions',
            'indexes',
        ))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('refuses candidate-index lock admission for a caller that already walked away', async () => {
        const activeServerDir = await mkdtemp(join(
            tmpdir(),
            'happier-candidate-index-cancelled-admission-',
        ));
        roots.push(activeServerDir);
        const caller = new AbortController();
        caller.abort();
        // The Agent leaf that produced this chunk is deliberately signal-blind, so the
        // only owner that can still stop the build is the index lock admission itself.
        const listCandidates = vi.fn(async () => ({
            candidates: [{
                remoteSessionId: 'oldest',
                updatedAtMs: 10,
                linkData: { projectId: 'project-a' },
            }],
            nextCursor: 'qualified-scan-cursor',
            preparation: {
                kind: 'building_candidate_index' as const,
                scanned: 1,
                total: 2,
            },
        }));

        await expect(executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 50,
            listCandidates,
            signal: caller.signal,
        })).rejects.toMatchObject({ name: 'AbortError' });

        // Nothing was persisted: the walked-away caller never held the lock, so the
        // build did not start on its behalf.
        expect(await countCandidateIndexFiles(activeServerDir)).toBe(0);
    });

    it('refuses to serve one Agent runtime generation an index another one built', async () => {
        const activeServerDir = await mkdtemp(join(
            tmpdir(),
            'happier-candidate-index-runtime-generation-',
        ));
        roots.push(activeServerDir);
        const corpus = Array.from({ length: 4 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${index}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
        }));
        const listCandidates = createBoundedCandidateSource(corpus);
        const query = (
            agentRuntimeGeneration: string | null,
            cursor?: string,
        ) => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            agentRuntimeGeneration,
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            ...(cursor ? { cursor } : {}),
            limit: 2,
            listCandidates,
            hydrateCandidate: async (candidate) => ({ ...candidate }),
        });

        const published = await readUntilPublished(() => query('generation-a'));
        const cursor = published.result.nextCursor;
        expect(cursor).toEqual(expect.any(String));
        expect(published.result.candidates).toHaveLength(2);

        // The successor generation cannot address the predecessor's pages: the
        // continuation resets instead of mixing one generation's stored rows with
        // the other's hydration.
        await expect(query('generation-b', cursor!)).rejects.toBeInstanceOf(
            ExternalSessionCandidateIndexCursorResetError,
        );

        // And its own root request rebuilds rather than adopting those rows.
        listCandidates.mockClear();
        await expect(query('generation-b')).resolves.toMatchObject({
            candidates: [],
            preparation: { kind: 'building_candidate_index' },
        });
        expect(listCandidates).toHaveBeenCalled();

        // Once the successor has rebuilt in place, the two generations hold the
        // same corpus and therefore the same `indexGeneration`, so nothing but the
        // runtime generation tells their pages apart. The predecessor's cursor must
        // still be refused rather than addressed against the successor's index.
        const rebuilt = await readUntilPublished(() => query('generation-b'));
        expect(rebuilt.result.candidates).toHaveLength(2);
        expect(rebuilt.result.nextCursor).toEqual(expect.any(String));
        expect(rebuilt.result.nextCursor).not.toBe(cursor);
        await expect(query('generation-b', cursor!)).rejects.toBeInstanceOf(
            ExternalSessionCandidateIndexCursorResetError,
        );
        // The successor's own continuation still resolves, so the refusal above is
        // about the generation the cursor names and not a dead index.
        await expect(query('generation-b', rebuilt.result.nextCursor!)).resolves.toMatchObject({
            candidates: [
                { remoteSessionId: 'session-1' },
                { remoteSessionId: 'session-0' },
            ],
        });
    });

    it('persists exact preparation chunks privately and serves only the rows it has already indexed', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-index-'));
        roots.push(activeServerDir);
        const listCandidates = vi.fn(async ({ cursor }: Readonly<{ cursor?: string }>) => cursor
            ? {
                candidates: [{
                    remoteSessionId: 'newest',
                    updatedAtMs: 30,
                    linkData: { projectId: 'project-a' },
                }],
                nextCursor: null,
                preparation: {
                    kind: 'building_candidate_index' as const,
                    scanned: 3,
                    total: 3,
                },
            }
            : {
                candidates: [
                    {
                        remoteSessionId: 'oldest',
                        title: 'Immutable first user message',
                        updatedAtMs: 10,
                        linkData: { projectId: 'project-a' },
                    },
                    {
                        remoteSessionId: 'middle',
                        updatedAtMs: 20,
                        linkData: { projectId: 'project-a' },
                    },
                ],
                nextCursor: 'qualified-scan-cursor',
                preparation: {
                    kind: 'building_candidate_index' as const,
                    scanned: 2,
                    total: 3,
                },
            });
        const base = {
            activeServerDir,
            agentIdentity: {
                pluginId: 'happier.claude',
                localId: 'claude',
            },
            source: {
                kind: 'claudeConfig',
                configDir: '/private/source/that-must-not-be-persisted',
            },
            limit: 2,
            listCandidates,
        } as const;

        await expect(executeExternalSessionCandidateQuery(base)).resolves.toEqual({
            candidates: [],
            nextCursor: null,
            preparation: {
                kind: 'building_candidate_index',
                scanned: 2,
                total: 6,
            },
        });
        expect(listCandidates).toHaveBeenCalledTimes(1);

        // The crawl has now covered the corpus, so the preparation page already
        // serves the final ordering while the validation pass is still outstanding.
        const building = await executeExternalSessionCandidateQuery(base);
        expect(building).toMatchObject({
            candidates: [
                { remoteSessionId: 'newest', updatedAtMs: 30 },
                { remoteSessionId: 'middle', updatedAtMs: 20 },
            ],
            nextCursor: null,
            preparation: { kind: 'building_candidate_index', scanned: 5 },
        });
        expect(building.candidates.map((candidate) => candidate.title)).toEqual([
            undefined,
            undefined,
        ]);
        const completed = await executeExternalSessionCandidateQuery(base);
        expect(completed).toMatchObject({
            candidates: [
                {
                    remoteSessionId: 'newest',
                    updatedAtMs: 30,
                    candidateKey: expect.stringMatching(/^[a-f0-9]{64}$/),
                },
                {
                    remoteSessionId: 'middle',
                    updatedAtMs: 20,
                    candidateKey: expect.stringMatching(/^[a-f0-9]{64}$/),
                },
            ],
            nextCursor: expect.any(String),
        });
        expect(completed).not.toHaveProperty('preparation');
        expect(listCandidates).toHaveBeenLastCalledWith(expect.objectContaining({
            cursor: 'qualified-scan-cursor',
        }));

        const indexPath = await findCandidateIndexPath(activeServerDir);
        expect(relative(activeServerDir, indexPath).split(/[\\/]/)).toEqual([
            'external-sessions',
            'candidate-indexes',
            'v1',
            expect.stringMatching(/^[a-f0-9]{64}$/),
            expect.stringMatching(/^[a-f0-9]{64}$/),
            'index.json',
        ]);
        const raw = await readFile(indexPath, 'utf8');
        expect(raw).not.toContain('/private/source');
        expect(raw).not.toContain('candidateKey');
        // The source-supplied title is the one content-derived field the index
        // keeps (approved amendment, 2026-08-07): a first user message is
        // immutable, and a partial page is served without hydration.
        expect(raw).toContain('Immutable first user message');
        expect(JSON.parse(raw)).toMatchObject({
            v: 2,
            state: 'complete',
            corpus: {
                v: 1,
                digest: expect.stringMatching(/^[a-f0-9]{64}$/),
                count: 3,
            },
            candidateCount: 3,
            candidates: [
                {
                    remoteSessionId: 'newest',
                    indexOrdinal: 0,
                    contentAddressDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
                },
                {
                    remoteSessionId: 'middle',
                    indexOrdinal: 1,
                    contentAddressDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
                },
                {
                    remoteSessionId: 'oldest',
                    indexOrdinal: 2,
                    contentAddressDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
                },
            ],
        });
        if (process.platform !== 'win32') {
            expect((await stat(indexPath)).mode & 0o777).toBe(0o600);
            expect((await stat(join(indexPath, '..'))).mode & 0o777).toBe(0o700);
        }

        listCandidates.mockClear();
        const restarted = await executeExternalSessionCandidateQuery(base);
        expect(restarted.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
            'newest',
            'middle',
        ]);
        expect(listCandidates).toHaveBeenCalledTimes(2);
        expect(listCandidates).toHaveBeenCalledWith({ limit: 2 });

        const semanticallyCorrupt = JSON.parse(await readFile(indexPath, 'utf8')) as Record<string, unknown>;
        semanticallyCorrupt.indexGeneration = '';
        await writeFile(indexPath, `${JSON.stringify(semanticallyCorrupt)}\n`, 'utf8');
        await expect(executeExternalSessionCandidateQuery(base)).resolves.toMatchObject({
            candidates: [],
            preparation: {
                kind: 'building_candidate_index',
                scanned: 2,
            },
        });
        await expect(executeExternalSessionCandidateQuery(base)).resolves.toMatchObject({
            candidates: [
                { remoteSessionId: 'newest' },
                { remoteSessionId: 'middle' },
            ],
            preparation: {
                kind: 'building_candidate_index',
                scanned: 5,
            },
        });
        await expect(executeExternalSessionCandidateQuery(base)).resolves.toMatchObject({
            candidates: [
                { remoteSessionId: 'newest' },
                { remoteSessionId: 'middle' },
            ],
        });
    });

    it('keeps strict preparation private when search mode is present without a search query', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-search-mode-'));
        roots.push(activeServerDir);
        const listCandidates = vi.fn(async (request: Readonly<{
            cursor?: string;
            limit: number;
            searchMode?: 'fast' | 'full';
        }>) => {
            if (request.searchMode) {
                return {
                    candidates: [{ remoteSessionId: 'strict-chunk-leaked', updatedAtMs: 1 }],
                    nextCursor: 'strict-cursor',
                    preparation: {
                        kind: 'building_candidate_index' as const,
                        scanned: 1,
                        total: 2,
                    },
                };
            }
            if (request.cursor) {
                return {
                    candidates: [{ remoteSessionId: 'newest', updatedAtMs: 2 }],
                    nextCursor: null,
                    preparation: {
                        kind: 'building_candidate_index' as const,
                        scanned: 2,
                        total: 2,
                    },
                };
            }
            return {
                candidates: [{ remoteSessionId: 'oldest', updatedAtMs: 1 }],
                nextCursor: 'strict-cursor',
                preparation: {
                    kind: 'building_candidate_index' as const,
                    scanned: 1,
                    total: 2,
                },
            };
        });
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 2,
            searchMode: 'fast',
            listCandidates,
        });

        await expect(query()).resolves.toEqual({
            candidates: [],
            nextCursor: null,
            preparation: {
                kind: 'building_candidate_index',
                scanned: 1,
                total: 4,
            },
        });
        expect(listCandidates).toHaveBeenLastCalledWith({ limit: 2 });
        expect(JSON.stringify(await query())).not.toContain('strict-chunk-leaked');
    });

    it.each([
        {
            name: 'non-advancing scanned count',
            continuationScanned: 1,
            continuationCursor: 'scan:next',
        },
        {
            name: 'cyclic continuation cursor',
            continuationScanned: 2,
            continuationCursor: 'scan:loop',
        },
    ])('rejects $name before returning repeated preparation progress', async ({
        continuationScanned,
        continuationCursor,
    }) => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-stalled-'));
        roots.push(activeServerDir);
        const listCandidates = vi.fn(async ({ cursor }: Readonly<{ cursor?: string }>) => (
            cursor
                ? {
                    candidates: [],
                    nextCursor: continuationCursor,
                    preparation: {
                        kind: 'building_candidate_index' as const,
                        scanned: continuationScanned,
                        total: 3,
                    },
                }
                : {
                    candidates: [{ remoteSessionId: 'oldest', updatedAtMs: 1 }],
                    nextCursor: 'scan:loop',
                    preparation: {
                        kind: 'building_candidate_index' as const,
                        scanned: 1,
                        total: 3,
                    },
                }
        ));
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 1,
            listCandidates,
        });

        await expect(query()).resolves.toMatchObject({
            candidates: [],
            preparation: { kind: 'building_candidate_index', scanned: 1 },
        });
        await expect(query()).rejects.toMatchObject({
            code: 'source_invalid',
            operation: 'listCandidates',
            retryable: true,
        });
    });

    it('rejects a non-adjacent continuation cycle after its history crosses a checkpoint', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-cycle-history-'));
        roots.push(activeServerDir);
        let fakeNowMs = 0;
        const listCandidates = vi.fn(async ({ cursor }: Readonly<{ cursor?: string }>) => {
            if (!cursor) {
                return {
                    candidates: [{ remoteSessionId: 'oldest', updatedAtMs: 1 }],
                    nextCursor: 'scan:a',
                    preparation: {
                        kind: 'building_candidate_index' as const,
                        scanned: 1,
                        total: 10,
                    },
                };
            }
            fakeNowMs += 300;
            if (cursor === 'scan:a') {
                return {
                    candidates: [],
                    nextCursor: 'scan:b',
                    preparation: {
                        kind: 'building_candidate_index' as const,
                        scanned: 2,
                        total: 10,
                    },
                };
            }
            return {
                candidates: [],
                nextCursor: 'scan:a',
                preparation: {
                    kind: 'building_candidate_index' as const,
                    scanned: 3,
                    total: 10,
                },
            };
        });
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 1,
            listCandidates,
        });

        await expect(query()).resolves.toMatchObject({
            candidates: [],
            preparation: { scanned: 1 },
        });
        const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => fakeNowMs);
        try {
            await expect(query()).resolves.toMatchObject({
                candidates: [expect.objectContaining({ remoteSessionId: 'oldest' })],
                preparation: { scanned: 2 },
            });
            await expect(query()).rejects.toMatchObject({
                code: 'source_invalid',
                operation: 'listCandidates',
                retryable: true,
            });
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('restarts an older in-progress record that has no bounded continuation history', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-history-compat-'));
        roots.push(activeServerDir);
        const corpus = Array.from({ length: 60 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${index}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
        }));
        const listCandidates = createBoundedCandidateSource(corpus);
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 1,
            listCandidates,
        });

        await expect(query()).resolves.toMatchObject({
            candidates: [],
            preparation: { scanned: 1 },
        });
        const indexPath = await findCandidateIndexPath(activeServerDir);
        const legacy = JSON.parse(await readFile(indexPath, 'utf8')) as Record<string, unknown>;
        delete legacy.continuationHistory;
        await writeFile(indexPath, `${JSON.stringify(legacy)}\n`, 'utf8');
        listCandidates.mockClear();

        await expect(query()).resolves.toMatchObject({
            candidates: [],
            preparation: { scanned: 1 },
        });
        expect(listCandidates).toHaveBeenCalledTimes(1);
        expect(listCandidates).toHaveBeenCalledWith({ limit: 1 });
    });

    it('keeps cold build-to-validation preparation progress monotonic', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-monotonic-progress-'));
        roots.push(activeServerDir);
        const corpus = Array.from({ length: 120 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${index}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
        }));
        const boundedSource = createBoundedCandidateSource(corpus);
        let fakeNowMs = 0;
        const listCandidates = async (request: Readonly<{ cursor?: string; limit: number }>) => {
            if (request.cursor) fakeNowMs += 300;
            return await boundedSource(request);
        };
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 50,
            listCandidates,
        });

        const progress: Array<Readonly<{ scanned: number; total?: number }>> = [];
        const initial = await query();
        expect(initial).toMatchObject({
            candidates: [],
            preparation: { scanned: 50, total: 240 },
        });
        progress.push(initial.preparation!);
        const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => fakeNowMs);
        try {
            // Each slice serves the rows persisted before it started, so the partial
            // page grows alongside the progress it reports.
            const building = await query();
            expect(building).toMatchObject({
                preparation: { scanned: 100, total: 240 },
            });
            expect(building.candidates).toHaveLength(50);
            expect(building.candidates[0]?.remoteSessionId).toBe('session-49');
            progress.push(building.preparation!);
            const validating = await query();
            expect(validating).toMatchObject({
                preparation: { scanned: 170, total: 240 },
            });
            // This slice finishes the crawl, so its partial page is already the
            // final ordering even though the validation pass has not published yet.
            expect(validating.candidates).toHaveLength(50);
            expect(validating.candidates[0]?.remoteSessionId).toBe('session-119');
            progress.push(validating.preparation!);
        } finally {
            nowSpy.mockRestore();
        }
        expect(progress.map(({ total }) => total)).toEqual([240, 240, 240]);
        const ratios = progress.map(({ scanned, total }) => scanned / total!);
        expect(ratios).toEqual([...ratios].sort((left, right) => left - right));
    });

    it('advances multiple bounded continuations per root request and checkpoints once', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-work-slice-'));
        roots.push(activeServerDir);
        const corpus = Array.from({ length: 1_000 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${String(index).padStart(4, '0')}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
        }));
        const listCandidates = createBoundedCandidateSource(corpus);
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 50,
            listCandidates,
        });

        let rootCalls = 0;
        let published: Awaited<ReturnType<typeof query>> | null = null;
        const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(0);
        try {
            while (rootCalls < 5 && !published) {
                rootCalls += 1;
                const page = await query();
                if (!page.preparation) published = page;
            }
        } finally {
            nowSpy.mockRestore();
        }

        expect(rootCalls).toBe(3);
        expect(listCandidates).toHaveBeenCalledTimes(41);
        expect(published?.candidates).toHaveLength(50);
        expect(published?.candidates[0]?.remoteSessionId).toBe('session-0999');
    });

    it('replays only the uncheckpointed bounded continuation slice after cancellation', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-work-replay-'));
        roots.push(activeServerDir);
        const corpus = Array.from({ length: 125 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${index}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
        }));
        let cancelAtCursor: string | null = null;
        const requestedCursors: Array<string | undefined> = [];
        const boundedSource = createBoundedCandidateSource(corpus);
        const listCandidates = vi.fn(async (request: Readonly<{ cursor?: string; limit: number }>) => {
            requestedCursors.push(request.cursor);
            if (request.cursor === cancelAtCursor) throw new Error('test cancellation');
            return await boundedSource(request);
        });
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 1,
            listCandidates,
        });

        await expect(query()).resolves.toMatchObject({
            candidates: [],
            preparation: { scanned: 1 },
        });
        cancelAtCursor = 'scan:101';
        await expect(query()).rejects.toThrow('test cancellation');

        const indexPath = await findCandidateIndexPath(activeServerDir);
        expect(JSON.parse(await readFile(indexPath, 'utf8'))).toMatchObject({
            state: 'building',
            scanCursor: 'scan:1',
            scanned: 1,
        });

        requestedCursors.length = 0;
        cancelAtCursor = null;
        await expect(query()).resolves.toHaveProperty('preparation');
        expect(requestedCursors.slice(0, 2)).toEqual([undefined, 'scan:1']);
    });

    it('checkpoints before a slow continuation slice hides preparation progress', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-work-budget-'));
        roots.push(activeServerDir);
        const corpus = Array.from({ length: 1_000 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${String(index).padStart(4, '0')}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
        }));
        const boundedSource = createBoundedCandidateSource(corpus);
        let fakeNowMs = 0;
        let continuationCalls = 0;
        const listCandidates = async (request: Readonly<{ cursor?: string; limit: number }>) => {
            if (request.cursor) {
                continuationCalls += 1;
                fakeNowMs += 200;
            }
            return await boundedSource(request);
        };
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 50,
            listCandidates,
        });

        await expect(query()).resolves.toMatchObject({
            candidates: [],
            preparation: { scanned: 50 },
        });
        const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => fakeNowMs);
        try {
            const slice = await query();
            expect(slice).toMatchObject({ preparation: { scanned: 150 } });
            expect(slice.candidates).toHaveLength(50);
            expect(slice.candidates[0]?.remoteSessionId).toBe('session-0049');
        } finally {
            nowSpy.mockRestore();
        }
        expect(continuationCalls).toBe(2);
    });

    it.each([
        {
            name: 'empty materialization',
            mutate(record: Record<string, unknown>) {
                record.candidates = [];
            },
        },
        {
            name: 'substituted materialization',
            mutate(record: Record<string, unknown>) {
                const candidates = record.candidates as Array<Record<string, unknown>>;
                candidates[0] = {
                    ...candidates[0],
                    remoteSessionId: 'schema-valid-substitute',
                };
            },
        },
    ])('rejects a schema-valid complete record with a $name that does not match its generation', async ({ mutate }) => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-integrity-'));
        roots.push(activeServerDir);
        const corpus: MutableCandidate[] = [
            { remoteSessionId: 'older', updatedAtMs: 1, linkData: { projectId: 'project-a' } },
            { remoteSessionId: 'newer', updatedAtMs: 2, linkData: { projectId: 'project-a' } },
        ];
        const listCandidates = createBoundedCandidateSource(corpus);
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 2,
            listCandidates,
        });

        await readUntilPublished(query);
        const indexPath = await findCandidateIndexPath(activeServerDir);
        const corrupted = JSON.parse(await readFile(indexPath, 'utf8')) as Record<string, unknown>;
        mutate(corrupted);
        await writeFile(indexPath, `${JSON.stringify(corrupted)}\n`, 'utf8');

        await expect(query()).resolves.toMatchObject({
            candidates: [],
            preparation: {
                kind: 'building_candidate_index',
            },
        });
        const rebuilt = await readUntilPublished(query);
        expect(rebuilt.result.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
            'newer',
            'older',
        ]);
    });

    it('rejects schema-valid candidate substitution in a checkpointed building record', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-building-integrity-'));
        roots.push(activeServerDir);
        const corpus = Array.from({ length: 120 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${String(index).padStart(3, '0')}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
        }));
        const listCandidates = createBoundedCandidateSource(corpus);
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 120,
            listCandidates,
        });

        await expect(query()).resolves.toHaveProperty('preparation');
        const indexPath = await findCandidateIndexPath(activeServerDir);
        const corrupted = JSON.parse(await readFile(indexPath, 'utf8')) as Record<string, unknown>;
        const candidates = corrupted.candidates as Array<Record<string, unknown>>;
        candidates[0] = {
            ...candidates[0],
            remoteSessionId: 'schema-valid-building-substitute',
        };
        await writeFile(indexPath, `${JSON.stringify(corrupted)}\n`, 'utf8');

        await expect(query()).resolves.toMatchObject({
            candidates: [],
            preparation: {
                kind: 'building_candidate_index',
            },
        });
        const rebuilt = await readUntilPublished(query);
        expect(rebuilt.result.candidates.map((candidate) => candidate.remoteSessionId)).not.toContain(
            'schema-valid-building-substitute',
        );
    });

    it('serves the candidates already indexed while the index is still building', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-partial-page-'));
        roots.push(activeServerDir);
        const corpus = Array.from({ length: 125 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${String(index).padStart(3, '0')}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
        }));
        const boundedSource = createBoundedCandidateSource(corpus);
        let fakeNowMs = 0;
        const listCandidates = async (request: Readonly<{ cursor?: string; limit: number }>) => {
            if (request.cursor) fakeNowMs += 300;
            return await boundedSource(request);
        };
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 2,
            listCandidates,
        });

        await expect(query()).resolves.toMatchObject({
            candidates: [],
            nextCursor: null,
            preparation: { kind: 'building_candidate_index', scanned: 2 },
        });

        const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => fakeNowMs);
        try {
            const building = await query();
            expect(building.preparation).toMatchObject({ kind: 'building_candidate_index' });
            expect(building.nextCursor).toBeNull();
            expect(building.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
                'session-001',
                'session-000',
            ]);
            expect(building.candidates.map((candidate) => candidate.candidateKey)).toEqual([
                expect.stringMatching(/^[a-f0-9]{64}$/),
                expect.stringMatching(/^[a-f0-9]{64}$/),
            ]);

            const advanced = await query();
            expect(advanced.preparation).toMatchObject({ kind: 'building_candidate_index' });
            expect(advanced.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
                'session-051',
                'session-050',
            ]);
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('serves the source-supplied title on the rows it has already indexed', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-partial-title-'));
        roots.push(activeServerDir);
        const corpus = Array.from({ length: 125 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${String(index).padStart(3, '0')}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
            // Only the odd rows have a usable first user message; the rest stay
            // identifier-only rather than being given an invented title.
            ...(index % 2 === 1 ? { title: `First message ${index}` } : {}),
        }));
        const boundedSource = createBoundedCandidateSource(corpus);
        let fakeNowMs = 0;
        const listCandidates = async (request: Readonly<{ cursor?: string; limit: number }>) => {
            if (request.cursor) fakeNowMs += 300;
            return await boundedSource(request);
        };
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 2,
            listCandidates,
        });

        await query();
        const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => fakeNowMs);
        try {
            const building = await query();
            expect(building.preparation).toMatchObject({ kind: 'building_candidate_index' });
            // A partial row is served without hydration, so a title it can only get
            // from the source chunk proves the index carried it through.
            expect(building.candidates.map((candidate) => [
                candidate.remoteSessionId,
                candidate.title,
            ])).toEqual([
                ['session-001', 'First message 1'],
                ['session-000', undefined],
            ]);
        } finally {
            nowSpy.mockRestore();
        }
        expect(await readFile(await findCandidateIndexPath(activeServerDir), 'utf8'))
            .toContain('First message 1');
    });

    it('serves the fully crawled page while the validation pass is still running', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-validation-page-'));
        roots.push(activeServerDir);
        const corpus = Array.from({ length: 120 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${String(index).padStart(3, '0')}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
        }));
        const boundedSource = createBoundedCandidateSource(corpus);
        let fakeNowMs = 0;
        const listCandidates = async (request: Readonly<{ cursor?: string; limit: number }>) => {
            if (request.cursor) fakeNowMs += 300;
            return await boundedSource(request);
        };
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 2,
            listCandidates,
        });

        const validating: Awaited<ReturnType<typeof query>>[] = [];
        const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => fakeNowMs);
        try {
            for (let rootCall = 0; rootCall < 40; rootCall += 1) {
                const page = await query();
                if (!page.preparation) break;
                validating.push(page);
            }
        } finally {
            nowSpy.mockRestore();
        }

        // Once the crawl has covered the corpus the validation pass keeps reporting
        // preparation, but the page it serves is already the final ordering.
        const finalOrdering = validating.filter((page) => (
            page.candidates[0]?.remoteSessionId === 'session-119'
        ));
        expect(finalOrdering.length).toBeGreaterThan(0);
        expect(finalOrdering[0]?.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
            'session-119',
            'session-118',
        ]);
        expect(finalOrdering[0]?.nextCursor).toBeNull();
    });

    it('hydrates only the selected cold and warm index rows without persisting hydrated titles', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-hydration-'));
        roots.push(activeServerDir);
        const corpus = Array.from({ length: 12 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${String(index).padStart(2, '0')}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
        }));
        const listCandidates = createBoundedCandidateSource(corpus);
        let titleRevision = 'cold';
        const hydrateCandidate = vi.fn(async (candidate: MutableCandidate) => ({
            ...candidate,
            title: `${titleRevision}:${candidate.remoteSessionId}`,
            details: { projectId: candidate.linkData.projectId, hydrated: true },
        }));
        const query = (cursor?: string) => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            ...(cursor ? { cursor } : {}),
            limit: 3,
            listCandidates,
            hydrateCandidate,
        });

        const cold = await readUntilPublished(() => query());
        expect(cold.result.candidates.map((candidate) => candidate.title)).toEqual([
            'cold:session-11',
            'cold:session-10',
            'cold:session-09',
        ]);
        expect(cold.result.candidates.every((candidate) => candidate.details?.hydrated === true)).toBe(true);
        expect(hydrateCandidate).toHaveBeenCalledTimes(3);
        // A hydrated title is a live projection of the current source and is still
        // never persisted; only a title the source chunk itself supplied is.
        expect(await readFile(await findCandidateIndexPath(activeServerDir), 'utf8')).not.toContain('cold:session');

        hydrateCandidate.mockClear();
        titleRevision = 'warm';
        const warm = await query(cold.result.nextCursor ?? undefined);
        expect(warm.candidates.map((candidate) => candidate.title)).toEqual([
            'warm:session-08',
            'warm:session-07',
            'warm:session-06',
        ]);
        expect(hydrateCandidate).toHaveBeenCalledTimes(3);
        expect(warm.candidates.map((candidate) => candidate.candidateKey)).not.toContain(undefined);
        expect(warm.candidates.map((candidate) => candidate.linkData)).toEqual([
            { projectId: 'project-a' },
            { projectId: 'project-a' },
            { projectId: 'project-a' },
        ]);
    });

    it('serves a source-complete stored page without one Agent call per row', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-source-complete-'));
        roots.push(activeServerDir);
        // Half the corpus arrives with the title its own chunk supplied; the other
        // half is identifier-only, which is the only field a stored row can lack
        // that the leaf can still add.
        const corpus = Array.from({ length: 12 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${String(index).padStart(2, '0')}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
            ...(index % 2 === 0 ? { title: `chunk:session-${String(index).padStart(2, '0')}` } : {}),
        }));
        const listCandidates = createBoundedCandidateSource(corpus);
        const hydrateCandidate = vi.fn(async (candidate: MutableCandidate) => ({
            ...candidate,
            title: `hydrated:${candidate.remoteSessionId}`,
        }));
        const query = (cursor?: string) => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            ...(cursor ? { cursor } : {}),
            limit: 4,
            listCandidates,
            hydrateCandidate,
        });

        const published = await readUntilPublished(() => query());
        // session-11 .. session-08, newest first: two chunk-titled, two identifier-only.
        expect(published.result.candidates.map((candidate) => candidate.title)).toEqual([
            'hydrated:session-11',
            'chunk:session-10',
            'hydrated:session-09',
            'chunk:session-08',
        ]);
        expect(hydrateCandidate).toHaveBeenCalledTimes(2);
        expect(hydrateCandidate.mock.calls.map(([candidate]) => candidate.remoteSessionId)).toEqual([
            'session-11',
            'session-09',
        ]);

        hydrateCandidate.mockClear();
        const continued = await query(published.result.nextCursor ?? undefined);
        expect(continued.candidates.map((candidate) => candidate.title)).toEqual([
            'hydrated:session-07',
            'chunk:session-06',
            'hydrated:session-05',
            'chunk:session-04',
        ]);
        expect(hydrateCandidate).toHaveBeenCalledTimes(2);
        // The rows the source already completed keep every persisted fact and still
        // carry the canonical published identity.
        expect(continued.candidates[1]).toEqual({
            remoteSessionId: 'session-06',
            updatedAtMs: 6,
            title: 'chunk:session-06',
            linkData: { projectId: 'project-a' },
            candidateKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
    });

    it('rejects corruption in the exact persisted continuation page without publishing mixed rows', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-page-corruption-'));
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

        const published = await readUntilPublished(() => query());
        const cursor = published.result.nextCursor;
        expect(cursor).toEqual(expect.any(String));
        const indexPath = await findCandidateIndexPath(activeServerDir);
        const raw = await readFile(indexPath, 'utf8');
        expect(raw).toContain('"remoteSessionId":"session-099"');
        await writeFile(
            indexPath,
            raw.replace(
                '"remoteSessionId":"session-099"',
                '"remoteSessionId":"session-X99"',
            ),
            'utf8',
        );

        await expect(query(cursor ?? undefined)).rejects.toBeInstanceOf(ExternalSessionCandidateIndexCursorResetError);
        await expect(query()).resolves.toMatchObject({
            candidates: [],
            preparation: {
                kind: 'building_candidate_index',
            },
        });
    });

    it.each([
        {
            name: 'a schema-valid duplicate identity from an earlier page',
            mutate: async (indexPath: string, raw: string) => {
                expect(raw).toContain('"remoteSessionId":"session-049","updatedAtMs":49');
                await writeFile(
                    indexPath,
                    raw.replace(
                        '"remoteSessionId":"session-049","updatedAtMs":49',
                        '"remoteSessionId":"session-149","updatedAtMs":49',
                    ),
                    'utf8',
                );
            },
        },
        {
            name: 'a schema-valid out-of-order candidate',
            mutate: async (indexPath: string, raw: string) => {
                expect(raw).toContain('"remoteSessionId":"session-049","updatedAtMs":49');
                await writeFile(
                    indexPath,
                    raw.replace(
                        '"remoteSessionId":"session-049","updatedAtMs":49',
                        '"remoteSessionId":"session-049","updatedAtMs":99',
                    ),
                    'utf8',
                );
            },
        },
        {
            name: 'a schema-valid truncation after the selected page',
            mutate: async (indexPath: string, raw: string) => {
                const record = JSON.parse(raw) as Record<string, unknown>;
                expect(record.candidates).toHaveLength(150);
                record.candidates = (record.candidates as unknown[]).slice(0, 100);
                await writeFile(indexPath, `${JSON.stringify(record)}\n`, 'utf8');
            },
        },
        {
            name: 'an atomic same-header replacement with changed later-page content',
            mutate: async (indexPath: string, raw: string) => {
                const replacementPath = `${indexPath}.replacement`;
                expect(raw).toContain('"remoteSessionId":"session-049","updatedAtMs":49');
                await writeFile(
                    replacementPath,
                    raw.replace(
                        '"remoteSessionId":"session-049","updatedAtMs":49',
                        '"remoteSessionId":"session-X49","updatedAtMs":49',
                    ),
                    'utf8',
                );
                await rename(replacementPath, indexPath);
            },
        },
    ])('rejects $name before minting a later-page cursor', async ({ mutate }) => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-lookahead-corruption-'));
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

        const first = await readUntilPublished(() => query());
        const pageTwoCursor = first.result.nextCursor;
        expect(pageTwoCursor).toEqual(expect.any(String));
        const indexPath = await findCandidateIndexPath(activeServerDir);
        await mutate(indexPath, await readFile(indexPath, 'utf8'));

        await expect(query(pageTwoCursor ?? undefined)).rejects.toBeInstanceOf(ExternalSessionCandidateIndexCursorResetError);
        await expect(query()).resolves.toMatchObject({
            candidates: [],
            preparation: {
                kind: 'building_candidate_index',
            },
        });
    });

    it('keeps continuation exact when the caller narrows and then widens its requested page size', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-page-resize-'));
        roots.push(activeServerDir);
        const corpus = Array.from({ length: 120 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${String(index).padStart(3, '0')}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
        }));
        const listCandidates = createBoundedCandidateSource(corpus);
        const query = (limit: number, cursor?: string) => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            ...(cursor ? { cursor } : {}),
            limit,
            listCandidates,
        });

        const first = await readUntilPublished(() => query(50));
        const narrowed = await query(10, first.result.nextCursor ?? undefined);
        expect(narrowed.candidates.map((candidate) => candidate.remoteSessionId)).toEqual(
            Array.from({ length: 10 }, (_, index) => `session-${String(69 - index).padStart(3, '0')}`),
        );
        const widened = await query(25, narrowed.nextCursor ?? undefined);
        expect(widened.candidates.map((candidate) => candidate.remoteSessionId)).toEqual(
            Array.from({ length: 10 }, (_, index) => `session-${String(59 - index).padStart(3, '0')}`),
        );
        const widenedNext = await query(25, widened.nextCursor ?? undefined);
        expect(widenedNext.candidates.map((candidate) => candidate.remoteSessionId)).toEqual(
            Array.from({ length: 25 }, (_, index) => `session-${String(49 - index).padStart(3, '0')}`),
        );
    });

    it.each(['offset', 'byteOffset'] as const)(
        'rejects a cursor whose page-local %s address is altered independently',
        async (field) => {
            const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-cursor-address-'));
            roots.push(activeServerDir);
            const corpus = Array.from({ length: 75 }, (_, index): MutableCandidate => ({
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

            const first = await readUntilPublished(() => query());
            const cursor = first.result.nextCursor!;
            const separator = cursor.indexOf(':');
            const decoded = JSON.parse(
                Buffer.from(cursor.slice(separator + 1), 'base64url').toString('utf8'),
            ) as Record<string, unknown>;
            decoded[field] = (decoded[field] as number) + 1;
            const altered = `${cursor.slice(0, separator + 1)}${
                Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
            }`;

            await expect(query(altered)).rejects.toBeInstanceOf(ExternalSessionCandidateIndexCursorResetError);
        },
    );

    it('clamps indexed page hydration to the canonical candidate item ceiling', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-hydration-items-'));
        roots.push(activeServerDir);
        const corpus = Array.from({ length: 60 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${String(index).padStart(2, '0')}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
        }));
        const listCandidates = createBoundedCandidateSource(corpus);
        const hydrateCandidate = vi.fn(async (candidate: MutableCandidate) => ({
            ...candidate,
            title: candidate.remoteSessionId,
        }));
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 500,
            listCandidates,
            hydrateCandidate,
        });

        const published = await readUntilPublished(query);
        expect(published.result.candidates).toHaveLength(50);
        expect(published.result.nextCursor).toEqual(expect.any(String));
        expect(hydrateCandidate).toHaveBeenCalledTimes(50);
    });

    it('rejects an indexed hydrated page above the canonical serialized-byte budget', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-hydration-bytes-'));
        roots.push(activeServerDir);
        const corpus: MutableCandidate[] = [
            { remoteSessionId: 'older', updatedAtMs: 1, linkData: { projectId: 'project-a' } },
            { remoteSessionId: 'newer', updatedAtMs: 2, linkData: { projectId: 'project-a' } },
        ];
        const listCandidates = createBoundedCandidateSource(corpus);
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 2,
            maxBytes: 512,
            listCandidates,
            hydrateCandidate: async (candidate) => ({
                ...candidate,
                title: 'x'.repeat(2_048),
            }),
        });

        await expect(readUntilPublished(query)).rejects.toMatchObject({
            code: 'agent_error',
            operation: 'listCandidates',
            retryable: false,
        });
    });

    it('rejects a hydrated cursor page when a newer generation replaces its index before publication', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-hydration-generation-'));
        roots.push(activeServerDir);
        const createCorpus = (generation: string): MutableCandidate[] => Array.from(
            { length: 4 },
            (_, index) => ({
                remoteSessionId: `${generation}-${index}`,
                updatedAtMs: index,
                linkData: { projectId: 'project-a' },
            }),
        );
        const corpus = createCorpus('g1');
        const listCandidates = createBoundedCandidateSource(corpus);
        let releaseBlockedHydration: (() => void) | undefined;
        const blockedHydrationReleased = new Promise<void>((resolve) => {
            releaseBlockedHydration = resolve;
        });
        let reportBlockedHydration: (() => void) | undefined;
        const blockedHydrationStarted = new Promise<void>((resolve) => {
            reportBlockedHydration = resolve;
        });
        let shouldBlockG1Cursor = false;
        const query = (cursor?: string) => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            ...(cursor ? { cursor } : {}),
            limit: 2,
            listCandidates,
            hydrateCandidate: async (candidate) => {
                if (shouldBlockG1Cursor && candidate.remoteSessionId === 'g1-1') {
                    reportBlockedHydration?.();
                    await blockedHydrationReleased;
                }
                return { ...candidate, title: candidate.remoteSessionId };
            },
        });

        const g1 = await readUntilPublished(() => query());
        shouldBlockG1Cursor = true;
        const lateG1Page = query(g1.result.nextCursor ?? undefined);
        await blockedHydrationStarted;

        corpus.splice(0, corpus.length, ...createCorpus('g2'));
        const g2 = await readUntilPublished(() => query());
        releaseBlockedHydration?.();

        await expect(lateG1Page).rejects.toBeInstanceOf(ExternalSessionCandidateIndexCursorResetError);
        await expect(query(g2.result.nextCursor ?? undefined)).resolves.toMatchObject({
            candidates: [
                expect.objectContaining({ remoteSessionId: 'g2-1' }),
                expect.objectContaining({ remoteSessionId: 'g2-0' }),
            ],
        });
    });

    it('does not invalidate a newer generation when stale cursor hydration fails', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-hydration-invalidation-'));
        roots.push(activeServerDir);
        const createCorpus = (generation: string): MutableCandidate[] => Array.from(
            { length: 4 },
            (_, index) => ({
                remoteSessionId: `${generation}-${index}`,
                updatedAtMs: index,
                linkData: { projectId: 'project-a' },
            }),
        );
        const corpus = createCorpus('g1');
        const listCandidates = createBoundedCandidateSource(corpus);
        let releaseBlockedHydration: (() => void) | undefined;
        const blockedHydrationReleased = new Promise<void>((resolve) => {
            releaseBlockedHydration = resolve;
        });
        let reportBlockedHydration: (() => void) | undefined;
        const blockedHydrationStarted = new Promise<void>((resolve) => {
            reportBlockedHydration = resolve;
        });
        let shouldFailG1Cursor = false;
        const query = (cursor?: string) => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            ...(cursor ? { cursor } : {}),
            limit: 2,
            listCandidates,
            hydrateCandidate: async (candidate) => {
                if (shouldFailG1Cursor && candidate.remoteSessionId === 'g1-1') {
                    reportBlockedHydration?.();
                    await blockedHydrationReleased;
                    throw Object.assign(new Error('candidate disappeared'), {
                        code: 'candidate_not_found',
                    });
                }
                return { ...candidate, title: candidate.remoteSessionId };
            },
        });

        const g1 = await readUntilPublished(() => query());
        shouldFailG1Cursor = true;
        const lateG1Page = query(g1.result.nextCursor ?? undefined);
        await blockedHydrationStarted;

        corpus.splice(0, corpus.length, ...createCorpus('g2'));
        const g2 = await readUntilPublished(() => query());
        releaseBlockedHydration?.();

        await expect(lateG1Page).rejects.toMatchObject({
            code: 'source_invalid',
            operation: 'listCandidates',
        });
        await expect(query(g2.result.nextCursor ?? undefined)).resolves.toMatchObject({
            candidates: [
                expect.objectContaining({ remoteSessionId: 'g2-1' }),
                expect.objectContaining({ remoteSessionId: 'g2-0' }),
            ],
        });
    });

    it('invalidates the indexed generation when a selected row can no longer be hydrated', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-hydration-missing-'));
        roots.push(activeServerDir);
        const corpus: MutableCandidate[] = [
            { remoteSessionId: 'older', updatedAtMs: 1, linkData: { projectId: 'project-a' } },
            { remoteSessionId: 'newer', updatedAtMs: 2, linkData: { projectId: 'project-a' } },
        ];
        const listCandidates = createBoundedCandidateSource(corpus);
        let missing = false;
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 2,
            listCandidates,
            hydrateCandidate: async (candidate) => {
                if (missing && candidate.remoteSessionId === 'newer') {
                    throw Object.assign(new Error('candidate disappeared'), {
                        code: 'candidate_not_found',
                    });
                }
                return { ...candidate, title: candidate.remoteSessionId };
            },
        });

        await readUntilPublished(query);
        missing = true;
        await expect(query()).rejects.toMatchObject({
            code: 'source_invalid',
            operation: 'listCandidates',
            retryable: true,
        });
        missing = false;
        await expect(query()).resolves.toMatchObject({
            candidates: [],
            preparation: {
                kind: 'building_candidate_index',
            },
        });
    });

    it('does not opt native non-preparing sources into the file-backed index', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-native-'));
        roots.push(activeServerDir);
        const listCandidates = vi.fn(async ({ limit }: Readonly<{ limit: number }>) => ({
            candidates: Array.from({ length: limit }, (_, index) => ({
                remoteSessionId: `native-${index}`,
                updatedAtMs: index,
            })),
            nextCursor: 'native-cursor',
        }));

        await expect(executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: {
                pluginId: 'happier.opencode',
                localId: 'opencode',
            },
            source: { kind: 'opencodeServer', endpoint: 'http://127.0.0.1:4096' },
            limit: 5,
            listCandidates,
        })).resolves.toMatchObject({
            candidates: Array.from({ length: 5 }, (_, index) => ({
                remoteSessionId: `native-${index}`,
                updatedAtMs: index,
                candidateKey: expect.stringMatching(/^[a-f0-9]{64}$/),
            })),
            nextCursor: 'native-cursor',
        });
        expect(listCandidates).toHaveBeenCalledWith({ limit: 5 });

        await expect(stat(join(activeServerDir, 'external-sessions'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('invalidates a completed index when the leaf root fingerprint continuation changes', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-invalidation-'));
        roots.push(activeServerDir);
        let sourceGeneration = 'generation-a';
        const listCandidates = vi.fn(async ({ cursor }: Readonly<{ cursor?: string }>) => {
            if (cursor) {
                return {
                    candidates: [{ remoteSessionId: `${sourceGeneration}-newest`, updatedAtMs: 20 }],
                    nextCursor: null,
                    preparation: { kind: 'building_candidate_index' as const, scanned: 2 },
                };
            }
            return {
                candidates: [{ remoteSessionId: `${sourceGeneration}-oldest`, updatedAtMs: 10 }],
                nextCursor: `scan:${sourceGeneration}`,
                preparation: { kind: 'building_candidate_index' as const, scanned: 1 },
            };
        });
        const query = (cursor?: string) => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            ...(cursor ? { cursor } : {}),
            limit: 1,
            listCandidates,
        });

        await query();
        await query();
        const firstComplete = await query();
        expect(firstComplete.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
            'generation-a-newest',
        ]);
        expect(firstComplete.nextCursor).toEqual(expect.any(String));

        sourceGeneration = 'generation-b';
        await expect(query()).resolves.toEqual({
            candidates: [],
            nextCursor: null,
            preparation: { kind: 'building_candidate_index', scanned: 1 },
        });
        await expect(query(firstComplete.nextCursor ?? undefined)).rejects.toBeInstanceOf(ExternalSessionCandidateIndexCursorResetError);
        const rebuilt = await readUntilPublished(query);
        expect(rebuilt.sourceInvalidCount).toBe(0);
        expect(rebuilt.result.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
            'generation-b-newest',
        ]);
    });

    it('reports continuing preparation when the corpus first chunk changes mid-build', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-first-chunk-drift-'));
        roots.push(activeServerDir);
        let generation = 'g1';
        const listCandidates = vi.fn(async ({ cursor }: Readonly<{ cursor?: string }>) => cursor
            ? {
                candidates: [{ remoteSessionId: `${generation}-newest`, updatedAtMs: 20 }],
                nextCursor: null,
                preparation: { kind: 'building_candidate_index' as const, scanned: 2 },
            }
            : {
                candidates: [{ remoteSessionId: `${generation}-oldest`, updatedAtMs: 10 }],
                nextCursor: `scan:${generation}`,
                preparation: { kind: 'building_candidate_index' as const, scanned: 1 },
            });
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 1,
            listCandidates,
        });

        await expect(query()).resolves.toMatchObject({
            candidates: [],
            preparation: { kind: 'building_candidate_index' },
        });

        generation = 'g2';

        await expect(query()).resolves.toMatchObject({
            candidates: [],
            nextCursor: null,
            preparation: { kind: 'building_candidate_index' },
        });
        const driftedRecord = JSON.parse(
            await readFile(await findCandidateIndexPath(activeServerDir), 'utf8'),
        ) as Readonly<{
            state: string;
            candidates: readonly Readonly<{ remoteSessionId: string }>[];
        }>;
        expect(driftedRecord.state).toBe('building');
        expect(driftedRecord.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
            'g2-oldest',
        ]);
    });

    it('reports continuing preparation when the agent source changes during index continuation', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-continuation-drift-'));
        roots.push(activeServerDir);
        let continuationFails = false;
        const listCandidates = vi.fn(async ({ cursor }: Readonly<{ cursor?: string }>) => {
            if (cursor) {
                if (continuationFails) {
                    throw new ExternalSessionProviderFailureError({
                        code: 'source_invalid',
                        operation: 'listCandidates',
                        message: 'Agent candidate source changed during continuation',
                        retryable: true,
                    });
                }
                return {
                    candidates: [{ remoteSessionId: 'newest', updatedAtMs: 20 }],
                    nextCursor: null,
                    preparation: { kind: 'building_candidate_index' as const, scanned: 2 },
                };
            }
            return {
                candidates: [{ remoteSessionId: 'oldest', updatedAtMs: 10 }],
                nextCursor: 'scan:stable-root',
                preparation: { kind: 'building_candidate_index' as const, scanned: 1 },
            };
        });
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 1,
            listCandidates,
        });

        await query();
        continuationFails = true;

        await expect(query()).resolves.toMatchObject({
            candidates: [],
            nextCursor: null,
            preparation: { kind: 'building_candidate_index' },
        });
        const driftedRecord = JSON.parse(
            await readFile(await findCandidateIndexPath(activeServerDir), 'utf8'),
        ) as Readonly<{
            state: string;
            candidates: readonly Readonly<{ remoteSessionId: string }>[];
        }>;
        expect(driftedRecord.state).toBe('building');
        expect(driftedRecord.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
            'oldest',
        ]);
    });

    it('keeps a building index when the agent cursor bytes change but the first chunk does not', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-opaque-cursor-'));
        roots.push(activeServerDir);
        let firstChunkRequests = 0;
        const listCandidates = vi.fn(async ({ cursor }: Readonly<{ cursor?: string }>) => {
            if (cursor) {
                return {
                    candidates: [{ remoteSessionId: 'newest', updatedAtMs: 20 }],
                    nextCursor: null,
                    preparation: { kind: 'building_candidate_index' as const, scanned: 2 },
                };
            }
            firstChunkRequests += 1;
            return {
                candidates: [{ remoteSessionId: 'oldest', updatedAtMs: 10 }],
                nextCursor: `scan:opaque-${firstChunkRequests}`,
                preparation: { kind: 'building_candidate_index' as const, scanned: 1 },
            };
        });
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 10,
            listCandidates,
        });

        await query();
        const indexPath = await findCandidateIndexPath(activeServerDir);
        const buildingRecord = JSON.parse(await readFile(indexPath, 'utf8')) as Readonly<{
            startToken: string;
        }>;

        const published = await readUntilPublished(query);

        expect(published.sourceInvalidCount).toBe(0);
        expect(published.result.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
            'newest',
            'oldest',
        ]);
        const publishedRecord = JSON.parse(await readFile(indexPath, 'utf8')) as Readonly<{
            startToken: string;
        }>;
        expect(publishedRecord.startToken).toBe(buildingRecord.startToken);
    });

    it('serializes concurrent build requests without publishing a partial merge', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-concurrent-'));
        roots.push(activeServerDir);
        const listCandidates = vi.fn(async ({ cursor }: Readonly<{ cursor?: string }>) => cursor
            ? {
                candidates: [{ remoteSessionId: 'newest', updatedAtMs: 2 }],
                nextCursor: null,
                preparation: { kind: 'building_candidate_index' as const, scanned: 2 },
            }
            : {
                candidates: [{ remoteSessionId: 'oldest', updatedAtMs: 1 }],
                nextCursor: 'scan:stable-root',
                preparation: { kind: 'building_candidate_index' as const, scanned: 1 },
            });
        const execute = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 10,
            listCandidates,
        });

        const results = await Promise.all([execute(), execute(), execute()]);

        expect(results.filter((result) => result.preparation)).toHaveLength(2);
        // Exactly one request publishes, and no served page — published or partial —
        // exposes a half-merged crawl.
        expect(results.filter((result) => !result.preparation)).toEqual([
            expect.objectContaining({
                candidates: [
                    expect.objectContaining({ remoteSessionId: 'newest' }),
                    expect.objectContaining({ remoteSessionId: 'oldest' }),
                ],
            }),
        ]);
        expect(results.every((result) => (
            result.candidates.length === 0
            || result.candidates.map((candidate) => candidate.remoteSessionId).join() === 'newest,oldest'
        ))).toBe(true);
        expect(listCandidates).toHaveBeenCalledTimes(5);
    });

    it('does not reuse a warm index after a hidden non-first-chunk recency mutation', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-hidden-mutation-'));
        roots.push(activeServerDir);
        const corpus = Array.from({ length: 125 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${String(index).padStart(3, '0')}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
        }));
        const listCandidates = createBoundedCandidateSource(corpus);
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 2,
            listCandidates,
        });

        const first = await readUntilPublished(query);
        expect(first.result.candidates[0]?.remoteSessionId).toBe('session-124');
        const oldCursor = first.result.nextCursor;
        expect(oldCursor).toEqual(expect.any(String));

        corpus[110]!.updatedAtMs = 10_000;
        const refreshed = await readUntilPublished(query);

        expect(refreshed.sourceInvalidCount).toBe(0);
        expect(refreshed.result.candidates[0]).toMatchObject({
            remoteSessionId: 'session-110',
            updatedAtMs: 10_000,
            linkData: { projectId: 'project-a' },
        });
        await expect(executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            cursor: oldCursor ?? undefined,
            limit: 2,
            listCandidates,
        })).rejects.toBeInstanceOf(ExternalSessionCandidateIndexCursorResetError);
    });

    it('revalidates real Claude metadata after a transcript outside the first chunk is appended', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-claude-append-index-'));
        const configDir = await mkdtemp(join(tmpdir(), 'happier-candidate-claude-append-source-'));
        roots.push(activeServerDir, configDir);
        const firstProjectDir = join(configDir, 'projects', 'a-first');
        const hiddenProjectDir = join(configDir, 'projects', 'z-hidden');
        await mkdir(firstProjectDir, { recursive: true });
        await mkdir(hiddenProjectDir, { recursive: true });
        const initialMtimeSeconds = 1_700_000_000;
        for (let index = 0; index < 100; index += 1) {
            const transcriptPath = join(firstProjectDir, `session-${String(index).padStart(3, '0')}.jsonl`);
            await writeFile(transcriptPath, '{}\n', 'utf8');
            await utimes(
                transcriptPath,
                initialMtimeSeconds + index,
                initialMtimeSeconds + index,
            );
        }
        const hiddenTranscriptPath = join(hiddenProjectDir, 'hidden-session.jsonl');
        await writeFile(hiddenTranscriptPath, '{}\n', 'utf8');
        await utimes(
            hiddenTranscriptPath,
            initialMtimeSeconds,
            initialMtimeSeconds,
        );
        vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', configDir);

        const activation = await createPluginTestkit({
            manifest: CLAUDE_PLUGIN_MANIFEST,
            module: { activate: activateClaudePlugin },
        });
        const contribution = activation.registration(
            'agents',
            'claude',
        )?.externalSessions;
        await activation.dispose();
        if (!contribution) throw new Error('Claude External Sessions contribution was not registered');
        const source = { kind: 'claudeConfig', configDir } as const;
        const listCandidates = async (request: Readonly<{ cursor?: string; limit: number }>) => {
            const result = await contribution.listCandidates({
                source,
                ...(request.cursor ? { cursor: request.cursor } : {}),
                maxItems: request.limit,
                maxSerializedBytes: 1_048_576,
                signal: new AbortController().signal,
                deadlineAtMs: Date.now() + 15_000,
                managedEndpointRead: unavailableManagedEndpointRead,
                exec: unavailableInvocationExec,
            });
            if (!result.ok) {
                throw new ExternalSessionProviderFailureError({
                    code: result.code,
                    operation: 'listCandidates',
                    message: result.message ?? 'Claude External Sessions candidate listing failed',
                    retryable: result.retryable ?? false,
                });
            }
            return result.value;
        };
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source,
            limit: 2,
            listCandidates,
        });

        const first = await readUntilPublished(query);
        expect(first.result.candidates[0]?.remoteSessionId).toBe('session-099');

        await appendFile(hiddenTranscriptPath, '{}\n', 'utf8');
        await utimes(
            hiddenTranscriptPath,
            initialMtimeSeconds + 10_000,
            initialMtimeSeconds + 10_000,
        );
        const refreshed = await readUntilPublished(query);

        expect(refreshed.sourceInvalidCount).toBe(0);
        expect(refreshed.result.candidates[0]).toMatchObject({
            remoteSessionId: 'hidden-session',
            updatedAtMs: (initialMtimeSeconds + 10_000) * 1_000,
            linkData: { projectId: 'z-hidden' },
        });
    });

    it('validates a completed crawl before publishing when an already-scanned chunk mutates mid-build', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-mid-build-mutation-'));
        roots.push(activeServerDir);
        const corpus = Array.from({ length: 125 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${String(index).padStart(3, '0')}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
        }));
        const listCandidates = createBoundedCandidateSource(corpus);
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 2,
            listCandidates,
        });

        const firstBuildChunk = await query();
        expect(firstBuildChunk).toMatchObject({
            candidates: [],
            preparation: { kind: 'building_candidate_index', scanned: 2 },
        });
        corpus[1]!.updatedAtMs = 20_000;

        const published = await readUntilPublished(query);

        expect(published.sourceInvalidCount).toBe(0);
        expect(published.result.candidates[0]).toMatchObject({
            remoteSessionId: 'session-001',
            updatedAtMs: 20_000,
        });
    });

    it('reuses an unchanged validated generation and preserves it when validation is cancelled', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-validation-cancel-'));
        roots.push(activeServerDir);
        const corpus = Array.from({ length: 125 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${String(index).padStart(3, '0')}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
        }));
        const boundedSource = createBoundedCandidateSource(corpus);
        let cancelValidation = false;
        const listCandidates = vi.fn(async (request: Readonly<{ cursor?: string; limit: number }>) => {
            if (cancelValidation && request.cursor === 'scan:52') {
                throw new Error('validation cancelled');
            }
            return await boundedSource(request);
        });
        const query = (cursor?: string) => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            ...(cursor ? { cursor } : {}),
            limit: 2,
            listCandidates,
        });

        const first = await readUntilPublished(() => query());
        const stableCursor = first.result.nextCursor;
        expect(stableCursor).toEqual(expect.any(String));
        listCandidates.mockClear();

        cancelValidation = true;
        await expect(query()).rejects.toThrow('validation cancelled');

        listCandidates.mockClear();
        const continued = await query(stableCursor ?? undefined);
        expect(continued.candidates[0]?.remoteSessionId).toBe('session-122');
        expect(listCandidates).not.toHaveBeenCalled();

        cancelValidation = false;
        const unchanged = await readUntilPublished(() => query());
        expect(unchanged.sourceInvalidCount).toBe(0);
        expect(unchanged.result.nextCursor).toBe(stableCursor);
    });

    it('resumes a checkpointed validation of a completed generation instead of cold-rebuilding it', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-validation-checkpoint-'));
        roots.push(activeServerDir);
        const corpus = Array.from({ length: 300 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${String(index).padStart(3, '0')}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
        }));
        const boundedSource = createBoundedCandidateSource(corpus);
        const requestedCursors: (string | undefined)[] = [];
        let continuationDelayMs = 0;
        const listCandidates = vi.fn(async (request: Readonly<{ cursor?: string; limit: number }>) => {
            requestedCursors.push(request.cursor);
            if (continuationDelayMs > 0 && request.cursor) {
                await new Promise((resolve) => { setTimeout(resolve, continuationDelayMs); });
            }
            return await boundedSource(request);
        });
        const query = (cursor?: string) => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            ...(cursor ? { cursor } : {}),
            limit: 50,
            listCandidates,
        });

        const published = await readUntilPublished(() => query());
        const publishedIds = published.result.candidates.map((candidate) => candidate.remoteSessionId);
        expect(publishedIds).toHaveLength(50);
        const stableCursor = published.result.nextCursor;
        expect(stableCursor).toEqual(expect.any(String));
        const indexPath = await findCandidateIndexPath(activeServerDir);
        const readIndexFile = async (): Promise<Record<string, unknown>> => (
            JSON.parse(await readFile(indexPath, 'utf8')) as Record<string, unknown>
        );
        const completed = await readIndexFile();
        expect(completed.state).toBe('complete');
        const indexGeneration = completed.indexGeneration;
        expect(indexGeneration).toEqual(expect.any(String));

        // A slow leaf makes the warm validation pass exceed one work slice, so the
        // host must checkpoint the completed generation and resume it next request.
        continuationDelayMs = 300;
        requestedCursors.length = 0;
        const checkpointed = await query();
        continuationDelayMs = 0;
        expect(checkpointed.preparation).toBeDefined();

        const checkpoint = await readIndexFile();
        expect(checkpoint.state).toBe('complete');
        expect(checkpoint.indexGeneration).toBe(indexGeneration);
        expect(checkpoint.candidateCount).toBe((checkpoint.candidates as unknown[]).length);
        expect((checkpoint.validation as Record<string, unknown> | undefined)?.scanCursor)
            .toEqual(expect.any(String));
        const persistedCandidates = checkpoint.candidates as readonly Record<string, unknown>[];
        expect(persistedCandidates.map((candidate, ordinal) => candidate.indexOrdinal === ordinal
            && typeof candidate.contentAddressDigest === 'string'
            && /^[a-f0-9]{64}$/.test(candidate.contentAddressDigest)))
            .toEqual(persistedCandidates.map(() => true));

        // The checkpoint is written through the page-addressable serializer, so an
        // outstanding cursor still reads its own immutable generation page-locally.
        listCandidates.mockClear();
        const continued = await query(stableCursor ?? undefined);
        expect(continued.candidates).toHaveLength(50);
        expect(continued.candidates[0]?.remoteSessionId).toBe('session-249');
        expect(listCandidates).not.toHaveBeenCalled();

        // Resuming must continue the checkpointed validation cursor. A cold rebuild
        // would reset the record to a fresh build and re-crawl from the first chunk.
        requestedCursors.length = 0;
        const resumed = await readUntilPublished(() => query());
        expect(requestedCursors).not.toContain('scan:50');
        expect(resumed.result.candidates.map((candidate) => candidate.remoteSessionId)).toEqual(publishedIds);
        const afterResume = await readIndexFile();
        expect(afterResume.state).toBe('complete');
        expect(afterResume.indexGeneration).toBe(indexGeneration);
        expect(afterResume.validation).toBeUndefined();
    });

    it.each([
        {
            name: 'create',
            mutate(corpus: MutableCandidate[]) {
                corpus.push({
                    remoteSessionId: 'session-created',
                    updatedAtMs: 30_000,
                    linkData: { projectId: 'project-a' },
                });
            },
            expectedId: 'session-created',
        },
        {
            name: 'delete',
            mutate(corpus: MutableCandidate[]) {
                corpus.splice(124, 1);
            },
            expectedId: 'session-123',
        },
        {
            name: 'replace',
            mutate(corpus: MutableCandidate[]) {
                corpus[110] = {
                    remoteSessionId: 'session-replaced',
                    updatedAtMs: 40_000,
                    linkData: { projectId: 'project-b' },
                };
            },
            expectedId: 'session-replaced',
        },
    ])('rebuilds after a bounded $name validation changes the corpus', async ({ mutate, expectedId }) => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-corpus-change-'));
        roots.push(activeServerDir);
        const corpus = Array.from({ length: 125 }, (_, index): MutableCandidate => ({
            remoteSessionId: `session-${String(index).padStart(3, '0')}`,
            updatedAtMs: index,
            linkData: { projectId: 'project-a' },
        }));
        const listCandidates = createBoundedCandidateSource(corpus);
        const query = () => executeExternalSessionCandidateQuery({
            activeServerDir,
            agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
            source: { kind: 'claudeConfig', configDir: '/private/source' },
            limit: 2,
            listCandidates,
        });

        await readUntilPublished(query);
        mutate(corpus);
        const refreshed = await readUntilPublished(query);

        expect(refreshed.sourceInvalidCount).toBe(0);
        expect(refreshed.result.candidates[0]?.remoteSessionId).toBe(expectedId);
    });

    it('derives distinct opaque identities for duplicate native ids in different linkData scopes', () => {
        const projectA = resolveExternalSessionCandidateIdentityKey({
            remoteSessionId: 'shared-session',
            linkData: { projectId: 'project-a' },
        });
        const projectB = resolveExternalSessionCandidateIdentityKey({
            remoteSessionId: 'shared-session',
            linkData: { projectId: 'project-b' },
        });

        expect(projectA).toMatch(/^[a-f0-9]{64}$/);
        expect(projectB).toMatch(/^[a-f0-9]{64}$/);
        expect(projectA).not.toBe(projectB);
        expect(projectA).toBe(resolveExternalSessionCandidateIdentityKey({
            remoteSessionId: 'shared-session',
            linkData: { projectId: 'project-a' },
        }));
    });

    it('keeps duplicate native ids as distinct private Browse rows in opaque identity order', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-private-duplicate-'));
        roots.push(activeServerDir);
        const listCandidates = createBoundedCandidateSource([
            {
                remoteSessionId: 'shared-session',
                updatedAtMs: 10,
                linkData: { projectId: 'project-b' },
            },
            {
                remoteSessionId: 'shared-session',
                updatedAtMs: 10,
                linkData: { projectId: 'project-a' },
            },
        ]);

        const published = await readUntilPublished(async () => (
            await executeExternalSessionCandidateQuery({
                activeServerDir,
                agentIdentity: {
                    pluginId: 'happier.agent.claude',
                    localId: 'claude',
                },
                source: { kind: 'claudeConfig', home: 'user' },
                limit: 50,
                listCandidates,
            })
        ));

        expect(published.result.candidates).toHaveLength(2);
        expect(published.result.candidates.map((candidate) => candidate.linkData)).toEqual([
            { projectId: 'project-a' },
            { projectId: 'project-b' },
        ]);
        expect(new Set(published.result.candidates.map((candidate) => candidate.candidateKey)).size).toBe(2);
    });

    it('uses a locale-independent tie-breaker for equal-timestamp indexed candidates', async () => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-candidate-ordinal-order-'));
        roots.push(activeServerDir);
        const corpus: MutableCandidate[] = [
            {
                remoteSessionId: 'z-session',
                updatedAtMs: 10,
                linkData: { projectId: 'project-a' },
            },
            {
                remoteSessionId: 'ä-session',
                updatedAtMs: 10,
                linkData: { projectId: 'project-a' },
            },
        ];
        const listCandidates = createBoundedCandidateSource(corpus);

        const published = await readUntilPublished(async () => (
            await executeExternalSessionCandidateQuery({
                activeServerDir,
                agentIdentity: {
                    pluginId: 'happier.agent.claude',
                    localId: 'claude',
                },
                source: { kind: 'claudeConfig', home: 'user' },
                limit: 50,
                listCandidates,
            })
        ));

        expect(published.result.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([
            'z-session',
            'ä-session',
        ]);
    });
});

describe.runIf(process.env.HAPPIER_RUN_EXTERNAL_SESSION_BENCHMARK === '1')(
    'External Sessions composed candidate-index benchmark',
    () => {
        let benchmarkRoot: string | null = null;

        afterEach(async () => {
            if (!benchmarkRoot) return;
            await rm(benchmarkRoot, { recursive: true, force: true });
            benchmarkRoot = null;
        });

        it('measures cold and warm host validation over 10,000 strict candidates', async () => {
            benchmarkRoot = await mkdtemp(join(tmpdir(), 'happier-candidate-host-benchmark-'));
            const corpus = Array.from({ length: 10_000 }, (_, index): MutableCandidate => ({
                remoteSessionId: `session-${String(index).padStart(5, '0')}`,
                updatedAtMs: index,
                linkData: { projectId: `project-${String(Math.floor(index / 100)).padStart(3, '0')}` },
            }));
            const boundedSource = createBoundedCandidateSource(corpus);
            let leafCalls = 0;
            let hydrationCalls = 0;
            const listCandidates = async (request: Readonly<{ cursor?: string; limit: number }>) => {
                leafCalls += 1;
                return await boundedSource(request);
            };
            const query = (cursor?: string) => executeExternalSessionCandidateQuery({
                activeServerDir: benchmarkRoot!,
                agentIdentity: { pluginId: 'happier.claude', localId: 'claude' },
                source: { kind: 'claudeConfig', configDir: '/private/source' },
                ...(cursor ? { cursor } : {}),
                limit: 50,
                listCandidates,
                hydrateCandidate: async (candidate) => {
                    hydrationCalls += 1;
                    return { ...candidate, title: `title:${candidate.remoteSessionId}` };
                },
            });
            const runUntilPublished = async (phase: 'cold' | 'warm') => {
                let rootCalls = 0;
                const phaseStartedAt = performance.now();
                const rootElapsedMs: number[] = [];
                while (rootCalls < 500) {
                    rootCalls += 1;
                    const rootStartedAt = performance.now();
                    const page = await query();
                    rootElapsedMs.push(performance.now() - rootStartedAt);
                    if (!page.preparation) return { page, rootCalls, rootElapsedMs };
                    if (rootCalls % 50 === 0) {
                        process.stdout.write(`EXTERNAL_CANDIDATE_INDEX_HOST_E10_PROGRESS ${JSON.stringify({
                            phase,
                            rootCalls,
                            leafCalls,
                            elapsedMs: Math.round((performance.now() - phaseStartedAt) * 100) / 100,
                        })}\n`);
                    }
                }
                throw new Error('10,000-candidate host benchmark exceeded 500 root calls');
            };

            const coldStartedAt = performance.now();
            const cold = await runUntilPublished('cold');
            const coldElapsedMs = performance.now() - coldStartedAt;
            const coldLeafCalls = leafCalls;
            const coldHydrationCalls = hydrationCalls;
            process.stdout.write(`EXTERNAL_CANDIDATE_INDEX_HOST_E10_COLD ${JSON.stringify({
                elapsedMs: Math.round(coldElapsedMs * 100) / 100,
                rootCalls: cold.rootCalls,
                leafCalls: coldLeafCalls,
                selectedHydrations: coldHydrationCalls,
            })}\n`);

            leafCalls = 0;
            hydrationCalls = 0;
            const cursorPageStartedAt = performance.now();
            const cursorPage = await query(cold.page.nextCursor ?? undefined);
            const cursorPageElapsedMs = performance.now() - cursorPageStartedAt;
            const cursorPageLeafCalls = leafCalls;
            const cursorPageHydrationCalls = hydrationCalls;

            leafCalls = 0;
            hydrationCalls = 0;
            const warmStartedAt = performance.now();
            const warm = await runUntilPublished('warm');
            const warmElapsedMs = performance.now() - warmStartedAt;

            const measurement = {
                schema: 'external-candidate-index-host-e10-v1',
                environment: {
                    node: process.version,
                    platform: process.platform,
                    arch: process.arch,
                    runner: 'vitest over the composed host index with a deterministic strict leaf',
                },
                corpus: {
                    candidates: corpus.length,
                    pageSize: 50,
                },
                cold: {
                    elapsedMs: Math.round(coldElapsedMs * 100) / 100,
                    rootCalls: cold.rootCalls,
                    leafCalls: coldLeafCalls,
                    selectedHydrations: coldHydrationCalls,
                    firstResponseElapsedMs: Math.round((cold.rootElapsedMs[0] ?? 0) * 100) / 100,
                    maxResponseElapsedMs: Math.round(Math.max(...cold.rootElapsedMs) * 100) / 100,
                },
                warmCursorPage: {
                    elapsedMs: Math.round(cursorPageElapsedMs * 100) / 100,
                    leafCalls: cursorPageLeafCalls,
                    selectedHydrations: cursorPageHydrationCalls,
                },
                warmRefresh: {
                    elapsedMs: Math.round(warmElapsedMs * 100) / 100,
                    rootCalls: warm.rootCalls,
                    leafCalls,
                    selectedHydrations: hydrationCalls,
                    firstResponseElapsedMs: Math.round((warm.rootElapsedMs[0] ?? 0) * 100) / 100,
                    maxResponseElapsedMs: Math.round(Math.max(...warm.rootElapsedMs) * 100) / 100,
                },
            };
            process.stdout.write(`EXTERNAL_CANDIDATE_INDEX_HOST_E10 ${JSON.stringify(measurement)}\n`);

            expect(cold.page.candidates).toHaveLength(50);
            expect(cursorPage.candidates).toHaveLength(50);
            expect(warm.page.candidates).toHaveLength(50);
            expect(cold.page.candidates[0]?.remoteSessionId).toBe('session-09999');
            expect(cursorPage.candidates[0]?.remoteSessionId).toBe('session-09949');
            expect(warm.page.candidates[0]?.remoteSessionId).toBe('session-09999');
            expect(coldHydrationCalls).toBe(50);
            expect(cursorPageLeafCalls).toBe(0);
            expect(cursorPageHydrationCalls).toBe(50);
            expect(hydrationCalls).toBe(50);
        }, 360_000);
    },
);
