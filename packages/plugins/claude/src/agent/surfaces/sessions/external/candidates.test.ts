import { utimesSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMockState = vi.hoisted((): {
    blockedReaddirPath: string | null;
    directoryEntryPulls: string[];
    activeDirectoryHandles: Set<number>;
    maxActiveDirectoryHandles: number;
    nextDirectoryHandleId: number;
    onDirectoryEntryPulled: ((directoryPath: string, entryName: string) => void) | null;
    openCalls: string[];
    readdirCalls: string[];
    statCalls: string[];
} => ({
    blockedReaddirPath: null,
    directoryEntryPulls: [],
    activeDirectoryHandles: new Set(),
    maxActiveDirectoryHandles: 0,
    nextDirectoryHandleId: 1,
    onDirectoryEntryPulled: null,
    openCalls: [],
    readdirCalls: [],
    statCalls: [],
}));

vi.mock('node:fs/promises', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return {
        ...actualFs,
        open: async (
            path: Parameters<typeof actualFs.open>[0],
            flags: Parameters<typeof actualFs.open>[1],
            mode?: Parameters<typeof actualFs.open>[2],
        ) => {
            fsMockState.openCalls.push(String(path));
            return await actualFs.open(path, flags, mode);
        },
        opendir: async (
            path: Parameters<typeof actualFs.opendir>[0],
            options?: Parameters<typeof actualFs.opendir>[1],
        ): Promise<Awaited<ReturnType<typeof actualFs.opendir>>> => {
            const directoryPath = String(path);
            const directory = await actualFs.opendir(path, options);
            const handleId = fsMockState.nextDirectoryHandleId;
            fsMockState.nextDirectoryHandleId += 1;
            fsMockState.activeDirectoryHandles.add(handleId);
            fsMockState.maxActiveDirectoryHandles = Math.max(
                fsMockState.maxActiveDirectoryHandles,
                fsMockState.activeDirectoryHandles.size,
            );
            const markClosed = () => {
                fsMockState.activeDirectoryHandles.delete(handleId);
            };
            const instrumentedEntries = async function* () {
                try {
                    for await (const entry of directory) {
                        const entryName = String(entry.name);
                        fsMockState.directoryEntryPulls.push(join(directoryPath, entryName));
                        fsMockState.onDirectoryEntryPulled?.(directoryPath, entryName);
                        yield entry;
                    }
                } finally {
                    markClosed();
                }
            };
            return new Proxy(directory, {
                get(target, property) {
                    if (property === Symbol.asyncIterator) {
                        return () => instrumentedEntries();
                    }
                    if (property === 'close') {
                        return async () => {
                            try {
                                return await target.close();
                            } finally {
                                markClosed();
                            }
                        };
                    }
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
        },
        readdir: async (path: Parameters<typeof actualFs.readdir>[0], options?: Parameters<typeof actualFs.readdir>[1]) => {
            fsMockState.readdirCalls.push(String(path));
            if (fsMockState.blockedReaddirPath && String(path) === fsMockState.blockedReaddirPath) {
                throw new Error('project session directory scan blocked');
            }
            return await actualFs.readdir(path, options);
        },
        stat: async (path: Parameters<typeof actualFs.stat>[0], options?: Parameters<typeof actualFs.stat>[1]) => {
            fsMockState.statCalls.push(String(path));
            return await actualFs.stat(path, options);
        },
    };
});

import {
    ClaudeCandidateInvalidCursorError,
    ClaudeCandidateSourceChangedError,
    listClaudeExternalSessionCandidates,
} from './candidates.js';

const roots: string[] = [];

function jsonlLine(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

function resetFsObservations(): void {
    fsMockState.directoryEntryPulls = [];
    fsMockState.maxActiveDirectoryHandles = fsMockState.activeDirectoryHandles.size;
    fsMockState.openCalls = [];
    fsMockState.readdirCalls = [];
    fsMockState.statCalls = [];
}

function transcriptPaths(paths: readonly string[]): string[] {
    return [...new Set(paths.filter((path) => path.includes(`${join('projects', '')}`) && path.endsWith('.jsonl')))];
}

function candidateIdentity(candidate: Readonly<{
    remoteSessionId: string;
    details?: Readonly<Record<string, unknown>>;
}>): string {
    return `${String(candidate.details?.projectId ?? '')}/${candidate.remoteSessionId}`;
}

async function createCandidate(params: Readonly<{
    configDir: string;
    projectId: string;
    remoteSessionId: string;
    title?: string;
    updatedAt?: Date;
}>): Promise<string> {
    const projectDir = join(params.configDir, 'projects', params.projectId);
    await mkdir(projectDir, { recursive: true });
    const filePath = join(projectDir, `${params.remoteSessionId}.jsonl`);
    await writeFile(
        filePath,
        jsonlLine({
            type: 'user',
            uuid: `${params.projectId}-${params.remoteSessionId}`,
            message: { content: params.title ?? params.remoteSessionId },
        }),
        'utf8',
    );
    if (params.updatedAt) {
        await utimes(filePath, params.updatedAt, params.updatedAt);
    }
    return filePath;
}

async function collectCandidateIdentities(params: Readonly<{
    configDir: string;
    cursor?: string;
    limit: number;
}>): Promise<string[]> {
    const identities: string[] = [];
    let cursor = params.cursor;
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
        const page = await listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir: params.configDir, projectId: null },
            env: {},
            ...(cursor ? { cursor } : {}),
            limit: params.limit,
        });
        identities.push(...page.candidates.map(candidateIdentity));
        if (!page.nextCursor) return identities;
        cursor = page.nextCursor;
    }
    throw new Error('Claude candidate pagination did not terminate within 100 pages.');
}

describe('Claude external-session candidate listing', () => {
    beforeEach(() => {
        fsMockState.blockedReaddirPath = null;
        fsMockState.onDirectoryEntryPulled = null;
        resetFsObservations();
    });

    afterEach(async () => {
        fsMockState.onDirectoryEntryPulled = null;
        await Promise.all(roots.splice(0).map(async (root) => {
            await rm(root, { recursive: true, force: true });
        }));
    });

    it('matches full search terms against surfaced session titles', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-title-search-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const projectDir = join(configDir, 'projects', 'proj-title-search');
        await mkdir(projectDir, { recursive: true });

        const matchingFile = join(projectDir, 'sess-title-only.jsonl');
        const unrelatedFile = join(projectDir, 'sess-newer-unrelated.jsonl');
        await writeFile(
            matchingFile,
            jsonlLine({
                type: 'user',
                uuid: 'u1',
                message: { content: [{ type: 'text', text: 'Investigate daemon-backed browse search' }] },
            }),
            'utf8',
        );
        await writeFile(
            unrelatedFile,
            jsonlLine({
                type: 'user',
                uuid: 'u2',
                message: { content: [{ type: 'text', text: 'Repair unrelated provider status' }] },
            }),
            'utf8',
        );
        await utimes(matchingFile, new Date('2026-01-03T00:00:00.000Z'), new Date('2026-01-03T00:00:00.000Z'));
        await utimes(unrelatedFile, new Date('2026-01-04T00:00:00.000Z'), new Date('2026-01-04T00:00:00.000Z'));

        const fast = await listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            limit: 10,
            searchTerm: 'daemon-backed',
            searchMode: 'fast',
        });
        expect(fast.candidates).toEqual([]);
        expect(fast.searchIncomplete).toBe(true);

        const full = await listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            limit: 10,
            searchTerm: 'daemon-backed',
            searchMode: 'full',
        });

        expect(full.candidates.map((candidate) => candidate.remoteSessionId)).toEqual(['sess-title-only']);
        expect(full.candidates[0]?.title).toBe('Investigate daemon-backed browse search');
        expect(full.nextCursor).toBeNull();
        expect(full.searchIncomplete).toBeUndefined();
    });

    it('does not scan title records beyond the current bounded full-search chunk', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-title-search-chunk-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        await createCandidate({
            configDir,
            projectId: 'project-a',
            remoteSessionId: 'first-row',
            title: 'unrelated first row',
        });
        await createCandidate({
            configDir,
            projectId: 'project-b',
            remoteSessionId: 'target-row',
            title: 'find this later title',
        });
        resetFsObservations();

        const first = await listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            limit: 1,
            searchTerm: 'later title',
            searchMode: 'full',
        });

        expect(first).toMatchObject({
            candidates: [],
            nextCursor: expect.any(String),
            searchIncomplete: true,
        });
        expect(transcriptPaths(fsMockState.openCalls)).toHaveLength(1);
        expect(basename(transcriptPaths(fsMockState.openCalls)[0] ?? '')).toBe('first-row.jsonl');

        resetFsObservations();
        const second = await listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            cursor: first.nextCursor ?? undefined,
            limit: 1,
            searchTerm: 'later title',
            searchMode: 'full',
        });
        expect(second.candidates).toMatchObject([
            { remoteSessionId: 'target-row', title: 'find this later title' },
        ]);
        expect(transcriptPaths(fsMockState.openCalls)).toHaveLength(1);
        expect(basename(transcriptPaths(fsMockState.openCalls)[0] ?? '')).toBe('target-row.jsonl');
    });

    it('binds continuation cursors to the normalized search term and search mode', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-candidate-search-cursor-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        await createCandidate({ configDir, projectId: 'project-a', remoteSessionId: 'session-alpha' });
        await createCandidate({ configDir, projectId: 'project-a', remoteSessionId: 'session-beta' });

        const first = await listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            limit: 1,
            searchTerm: ' SESSION ',
            searchMode: 'fast',
        });
        expect(first.nextCursor).toEqual(expect.any(String));
        const cursor = first.nextCursor;
        if (!cursor) throw new Error('Expected a continuation cursor for the search fixture.');

        await expect(listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            cursor,
            limit: 1,
            searchTerm: 'beta',
            searchMode: 'fast',
        })).rejects.toBeInstanceOf(ClaudeCandidateInvalidCursorError);
        await expect(listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            cursor,
            limit: 1,
            searchTerm: 'session',
            searchMode: 'full',
        })).rejects.toBeInstanceOf(ClaudeCandidateInvalidCursorError);
        await expect(listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            cursor,
            limit: 1,
            searchTerm: 'session',
            searchMode: 'fast',
        })).resolves.toMatchObject({ candidates: [expect.any(Object)] });
    });

    it('matches exact session ids without scanning project session directories', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-id-search-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const projectId = 'proj-target';
        const projectDir = join(configDir, 'projects', projectId);
        const matchingSessionId = 'sess-target';
        await mkdir(projectDir, { recursive: true });
        const matchingFile = join(projectDir, `${matchingSessionId}.jsonl`);
        await writeFile(
            matchingFile,
            jsonlLine({
                type: 'summary',
                leafUuid: 'leaf-target',
                summary: 'Target Claude title',
            }),
            'utf8',
        );
        await utimes(matchingFile, new Date('2026-03-06T12:00:00.000Z'), new Date('2026-03-06T12:00:00.000Z'));

        fsMockState.blockedReaddirPath = projectDir;

        const result = await listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            limit: 10,
            searchTerm: matchingSessionId,
            searchMode: 'fast',
        });

        expect(result.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([matchingSessionId]);
        expect(result.candidates[0]?.activity).toBe('idle');
        expect(fsMockState.readdirCalls).not.toContain(projectDir);
    });

    it('returns no exact-id matches when project-qualified storage does not exist yet', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-id-search-empty-'));
        roots.push(root);
        const configDir = join(root, '.claude');

        const result = await listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: 'project-not-created' },
            env: {},
            limit: 10,
            searchTerm: 'session-not-created',
            searchMode: 'fast',
        });

        expect(result).toMatchObject({
            candidates: [],
            nextCursor: null,
        });
    });

    it('hydrates selected project-qualified rows with exactly one title read per row', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-page-hydration-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const selected = ['selected-a', 'selected-b', 'selected-c'];
        for (const remoteSessionId of selected) {
            await createCandidate({
                configDir,
                projectId: 'project-selected',
                remoteSessionId,
                title: `Title for ${remoteSessionId}`,
            });
        }
        for (let index = 0; index < 20; index += 1) {
            await createCandidate({
                configDir,
                projectId: 'project-unselected',
                remoteSessionId: `unselected-${index}`,
            });
        }
        resetFsObservations();

        const hydrated = [];
        for (const remoteSessionId of selected) {
            const page = await listClaudeExternalSessionCandidates({
                source: {
                    kind: 'claudeConfig',
                    configDir,
                    projectId: 'project-selected',
                },
                env: {},
                limit: 1,
                searchTerm: remoteSessionId,
                searchMode: 'fast',
            });
            hydrated.push(...page.candidates);
        }

        expect(hydrated.map((candidate) => candidate.title)).toEqual(
            selected.map((remoteSessionId) => `Title for ${remoteSessionId}`),
        );
        expect(transcriptPaths(fsMockState.openCalls)).toHaveLength(selected.length);
        expect(transcriptPaths(fsMockState.openCalls).every(
            (path) => path.includes('project-selected'),
        )).toBe(true);
        expect(fsMockState.readdirCalls).not.toContain(join(configDir, 'projects'));
    });

    it('bounds selected transcript work and does not consume the full corpus before page one', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-bounded-list-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const projectDir = join(configDir, 'projects', 'proj-bounded');
        await mkdir(projectDir, { recursive: true });
        await Promise.all(Array.from({ length: 40 }, async (_, index) => {
            await writeFile(
                join(projectDir, `session-${String(index).padStart(3, '0')}.jsonl`),
                jsonlLine({
                    type: 'user',
                    uuid: `user-${index}`,
                    message: { content: `candidate ${index}` },
                }),
                'utf8',
            );
        }));

        const result = await listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            limit: 2,
        });

        expect(result.candidates).toHaveLength(2);
        expect(result.nextCursor).toEqual(expect.any(String));
        expect(transcriptPaths(fsMockState.statCalls)).toHaveLength(2);
        expect(result.candidates.every((candidate) => candidate.title?.startsWith('candidate '))).toBe(true);
        expect(transcriptPaths(fsMockState.openCalls).map((path) => basename(path)).sort()).toEqual(
            result.candidates.map((candidate) => `${candidate.remoteSessionId}.jsonl`).sort(),
        );
        expect(result.candidates.length + (result.nextCursor ? 1 : 0)).toBeLessThanOrEqual(3);
        expect(
            fsMockState.directoryEntryPulls.filter(
                (path) => path.startsWith(projectDir) && path.endsWith('.jsonl'),
            ).length,
        ).toBeLessThan(40);
    });

    it('keeps a budget-constrained exact row identifier-only when its title cannot fit', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-title-budget-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        await createCandidate({
            configDir,
            projectId: 'project-a',
            remoteSessionId: 'budgeted-row',
            title: 'immutable first user title',
        });
        resetFsObservations();

        const result = await listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            limit: 1,
            searchTerm: 'budgeted-row',
            searchMode: 'fast',
            resultBudget: {
                fits(candidates) {
                    return candidates.every((candidate) => candidate.title === undefined);
                },
            },
        });

        expect(result.candidates).toMatchObject([{ remoteSessionId: 'budgeted-row' }]);
        expect(result.candidates[0]).not.toHaveProperty('title');
    });

    it('returns bounded exact scan chunks for host-owned newest-first indexing', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-newest-first-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        await createCandidate({
            configDir,
            projectId: 'project-order',
            remoteSessionId: 'aaa-oldest',
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        });
        await createCandidate({
            configDir,
            projectId: 'project-order',
            remoteSessionId: 'mmm-middle',
            updatedAt: new Date('2026-01-02T00:00:00.000Z'),
        });
        await createCandidate({
            configDir,
            projectId: 'project-order',
            remoteSessionId: 'zzz-newest',
            updatedAt: new Date('2026-01-03T00:00:00.000Z'),
        });

        const result = await listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            limit: 2,
        });

        expect(result.candidates).toHaveLength(2);
        expect(result.nextCursor).toEqual(expect.any(String));
        expect(result.preparation).toEqual({
            kind: 'building_candidate_index',
            scanned: 2,
        });
    });

    it('does not duplicate or skip candidates while paging a static corpus', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-static-pagination-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const expected = new Set<string>();
        for (const projectId of ['project-a', 'project-b']) {
            for (let index = 0; index < 4; index += 1) {
                const remoteSessionId = `session-${index}`;
                expected.add(`${projectId}/${remoteSessionId}`);
                await createCandidate({ configDir, projectId, remoteSessionId });
            }
        }

        const identities = await collectCandidateIdentities({ configDir, limit: 3 });

        expect(new Set(identities)).toEqual(expected);
        expect(identities).toHaveLength(expected.size);
    });

    it('does not silently mix candidate generations after insertion', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-mutation-pagination-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const projectId = 'project-mutation';
        const originalIds = ['a-original', 'b-original', 'c-original', 'd-original'];
        for (const remoteSessionId of originalIds) {
            await createCandidate({ configDir, projectId, remoteSessionId });
        }
        const first = await listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            limit: 2,
        });
        expect(first.nextCursor).toEqual(expect.any(String));

        await createCandidate({ configDir, projectId, remoteSessionId: 'aa-inserted-before-cursor' });
        await createCandidate({ configDir, projectId, remoteSessionId: 'z-inserted-after-cursor' });

        await expect(listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            cursor: first.nextCursor ?? undefined,
            limit: 2,
        })).rejects.toBeInstanceOf(ClaudeCandidateSourceChangedError);

        const refreshed = await collectCandidateIdentities({ configDir, limit: 2 });
        const refreshedIdentities = [
            ...originalIds,
            'aa-inserted-before-cursor',
            'z-inserted-after-cursor',
        ].map((remoteSessionId) => `${projectId}/${remoteSessionId}`);
        expect(new Set(refreshed)).toEqual(new Set(refreshedIdentities));
    });

    it('keeps the first-chunk cursor stable when an unrelated project changes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-unrelated-project-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        for (const remoteSessionId of ['a-first', 'b-second', 'c-third']) {
            await createCandidate({ configDir, projectId: 'project-a', remoteSessionId });
        }
        await createCandidate({ configDir, projectId: 'project-z', remoteSessionId: 'z-existing' });

        const listFirstChunk = () => listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            limit: 2,
        });
        const first = await listFirstChunk();
        expect(first.candidates).toHaveLength(2);
        expect(first.nextCursor).toEqual(expect.any(String));

        await createCandidate({ configDir, projectId: 'project-z', remoteSessionId: 'late' });
        const second = await listFirstChunk();

        expect(second.candidates.map(candidateIdentity)).toEqual(
            first.candidates.map(candidateIdentity),
        );
        expect(second.nextCursor).toBe(first.nextCursor);
    });

    it('keeps a resume cursor valid when an unrelated project directory is created', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-new-project-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const remoteSessionIds = ['a-first', 'b-second', 'c-third', 'd-fourth'];
        for (const remoteSessionId of remoteSessionIds) {
            await createCandidate({ configDir, projectId: 'project-a', remoteSessionId });
        }

        const first = await listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            limit: 2,
        });
        expect(first.candidates).toHaveLength(2);
        expect(first.nextCursor).toEqual(expect.any(String));

        await mkdir(join(configDir, 'projects', 'project-created-later'), { recursive: true });

        const refreshedFirstChunk = await listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            limit: 2,
        });
        expect(refreshedFirstChunk.nextCursor).toBe(first.nextCursor);

        const second = await listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            cursor: first.nextCursor ?? undefined,
            limit: 2,
        });
        const identities = [
            ...first.candidates.map(candidateIdentity),
            ...second.candidates.map(candidateIdentity),
        ];
        expect(identities).toHaveLength(remoteSessionIds.length);
        expect(new Set(identities)).toEqual(new Set(
            remoteSessionIds.map((remoteSessionId) => `project-a/${remoteSessionId}`),
        ));
    });

    it('does not fail a bounded chunk when an unrelated project changes mid-scan', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-unrelated-mid-scan-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        for (const remoteSessionId of ['a-first', 'b-second', 'c-third', 'd-fourth']) {
            await createCandidate({ configDir, projectId: 'project-a', remoteSessionId });
        }
        await createCandidate({ configDir, projectId: 'project-z', remoteSessionId: 'z-existing' });
        const unrelatedProjectDir = join(configDir, 'projects', 'project-z');
        let mutatedUnrelatedProject = false;
        fsMockState.onDirectoryEntryPulled = (directoryPath) => {
            if (mutatedUnrelatedProject || !directoryPath.endsWith('project-a')) return;
            mutatedUnrelatedProject = true;
            const changedAt = new Date('2026-02-02T00:00:00.000Z');
            utimesSync(unrelatedProjectDir, changedAt, changedAt);
        };

        const page = await listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            limit: 2,
        });

        expect(mutatedUnrelatedProject).toBe(true);
        expect(page.candidates).toHaveLength(2);
        expect(page.nextCursor).toEqual(expect.any(String));
    });

    it('reports a typed source change when the scanned project changes mid-scan', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-scanned-mid-scan-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        for (const remoteSessionId of ['a-first', 'b-second', 'c-third', 'd-fourth']) {
            await createCandidate({ configDir, projectId: 'project-a', remoteSessionId });
        }
        const scannedProjectDir = join(configDir, 'projects', 'project-a');
        let mutatedScannedProject = false;
        fsMockState.onDirectoryEntryPulled = (directoryPath) => {
            if (mutatedScannedProject || !directoryPath.endsWith('project-a')) return;
            mutatedScannedProject = true;
            const changedAt = new Date('2026-02-02T00:00:00.000Z');
            utimesSync(scannedProjectDir, changedAt, changedAt);
        };

        await expect(listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            limit: 2,
        })).rejects.toBeInstanceOf(ClaudeCandidateSourceChangedError);
        expect(mutatedScannedProject).toBe(true);
    });

    it('closes directory traversal and performs no title reads after cancellation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-candidate-cancel-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        for (let index = 0; index < 10; index += 1) {
            await createCandidate({
                configDir,
                projectId: 'project-cancel',
                remoteSessionId: `session-${index}`,
            });
        }
        const controller = new AbortController();
        fsMockState.onDirectoryEntryPulled = (directoryPath) => {
            if (directoryPath.endsWith('project-cancel')) {
                controller.abort(new Error('test cancellation'));
            }
        };

        await expect(listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            limit: 5,
            signal: controller.signal,
        })).rejects.toThrow('test cancellation');

        expect(fsMockState.activeDirectoryHandles.size).toBe(0);
        expect(transcriptPaths(fsMockState.openCalls)).toEqual([]);
    });

    it('preserves project-qualified identities for duplicate native session ids', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-duplicate-native-ids-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        for (const projectId of ['project-a', 'project-b']) {
            await createCandidate({
                configDir,
                projectId,
                remoteSessionId: 'shared-session',
                title: `title from ${projectId}`,
            });
        }

        const result = await listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            limit: 10,
            searchTerm: 'shared-session',
            searchMode: 'fast',
        });

        expect(new Set(result.candidates.map(candidateIdentity))).toEqual(new Set([
            'project-a/shared-session',
            'project-b/shared-session',
        ]));
    });

    it.each(['fast', 'full'] as const)(
        'rejects an exact-id %s continuation after a newer duplicate native session is inserted',
        async (searchMode) => {
            const root = await mkdtemp(
                join(tmpdir(), `happier-claude-plugin-exact-id-${searchMode}-mutation-`),
            );
            roots.push(root);
            const configDir = join(root, '.claude');
            const remoteSessionId = 'shared-session';
            await createCandidate({
                configDir,
                projectId: 'project-oldest',
                remoteSessionId,
                updatedAt: new Date('2026-01-01T00:00:00.000Z'),
            });
            await createCandidate({
                configDir,
                projectId: 'project-newer',
                remoteSessionId,
                updatedAt: new Date('2026-01-02T00:00:00.000Z'),
            });

            const first = await listClaudeExternalSessionCandidates({
                source: { kind: 'claudeConfig', configDir, projectId: null },
                env: {},
                limit: 1,
                searchTerm: remoteSessionId,
                searchMode,
            });
            expect(first.candidates.map(candidateIdentity)).toEqual([
                'project-newer/shared-session',
            ]);
            expect(first.nextCursor).toEqual(expect.any(String));

            await createCandidate({
                configDir,
                projectId: 'project-newest',
                remoteSessionId,
                updatedAt: new Date('2026-01-03T00:00:00.000Z'),
            });

            await expect(listClaudeExternalSessionCandidates({
                source: { kind: 'claudeConfig', configDir, projectId: null },
                env: {},
                cursor: first.nextCursor ?? undefined,
                limit: 1,
                searchTerm: remoteSessionId,
                searchMode,
            })).rejects.toBeInstanceOf(ClaudeCandidateSourceChangedError);
        },
    );

    it('rejects an exact-id continuation when an existing duplicate changes recency order', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-exact-id-reorder-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const remoteSessionId = 'shared-session';
        const oldestPath = await createCandidate({
            configDir,
            projectId: 'project-oldest',
            remoteSessionId,
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        });
        await createCandidate({
            configDir,
            projectId: 'project-newer',
            remoteSessionId,
            updatedAt: new Date('2026-01-02T00:00:00.000Z'),
        });

        const first = await listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            limit: 1,
            searchTerm: remoteSessionId,
            searchMode: 'fast',
        });
        expect(first.candidates.map(candidateIdentity)).toEqual([
            'project-newer/shared-session',
        ]);

        const reorderedAt = new Date('2026-01-03T00:00:00.000Z');
        await utimes(oldestPath, reorderedAt, reorderedAt);

        await expect(listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            cursor: first.nextCursor ?? undefined,
            limit: 1,
            searchTerm: remoteSessionId,
            searchMode: 'fast',
        })).rejects.toBeInstanceOf(ClaudeCandidateSourceChangedError);
    });
});

describe.runIf(process.env.HAPPIER_RUN_EXTERNAL_SESSION_BENCHMARK === '1')(
    'Claude external-session candidate benchmark',
    () => {
        beforeEach(() => {
            fsMockState.blockedReaddirPath = null;
            fsMockState.onDirectoryEntryPulled = null;
            resetFsObservations();
        });

        afterEach(async () => {
            await Promise.all(roots.splice(0).map(async (root) => {
                await rm(root, { recursive: true, force: true });
            }));
        });

        it('measures two pages over a deterministic 10,000-candidate corpus', async () => {
            const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-candidate-benchmark-'));
            roots.push(root);
            const configDir = join(root, '.claude');
            const candidateCount = 10_000;
            const pageSize = 50;
            for (let projectIndex = 0; projectIndex < 100; projectIndex += 1) {
                const projectId = `project-${String(projectIndex).padStart(3, '0')}`;
                const projectDir = join(configDir, 'projects', projectId);
                await mkdir(projectDir, { recursive: true });
                for (let batchStart = 0; batchStart < 100; batchStart += 25) {
                    await Promise.all(Array.from({ length: 25 }, async (_, batchIndex) => {
                        const sessionIndex = batchStart + batchIndex;
                        const remoteSessionId = `session-${String(sessionIndex).padStart(3, '0')}`;
                        await writeFile(
                            join(projectDir, `${remoteSessionId}.jsonl`),
                            jsonlLine({
                                type: 'user',
                                uuid: `${projectId}-${remoteSessionId}`,
                                message: { content: `${projectId} ${remoteSessionId}` },
                            }),
                            'utf8',
                        );
                    }));
                }
            }

            const builtCandidateModulePath =
                '../../../../../dist/agent/surfaces/sessions/external/candidates.js';
            const builtCandidates = await import(/* @vite-ignore */ builtCandidateModulePath) as Readonly<{
                listClaudeExternalSessionCandidates: typeof listClaudeExternalSessionCandidates;
            }>;
            const listBuiltClaudeExternalSessionCandidates =
                builtCandidates.listClaudeExternalSessionCandidates;
            resetFsObservations();
            const firstMemoryBefore = process.memoryUsage();
            const firstStartedAt = performance.now();
            const first = await listBuiltClaudeExternalSessionCandidates({
                source: { kind: 'claudeConfig', configDir, projectId: null },
                env: {},
                limit: pageSize,
            });
            const firstElapsedMs = performance.now() - firstStartedAt;
            const firstMemoryAfter = process.memoryUsage();
            const firstObservation = {
                elapsedMs: Math.round(firstElapsedMs * 100) / 100,
                sessionEntriesPulled: fsMockState.directoryEntryPulls.filter((path) => path.endsWith('.jsonl')).length,
                projectEntriesPulled: fsMockState.directoryEntryPulls.filter((path) => !path.endsWith('.jsonl')).length,
                selectedTranscriptPaths: transcriptPaths(fsMockState.statCalls).length,
                titleReadPaths: transcriptPaths(fsMockState.openCalls).length,
                observablePageStateItems: first.candidates.length + (first.nextCursor ? 1 : 0),
                derivedRetainedEntryUpperBound: pageSize + 1,
                maxActiveDirectoryHandles: fsMockState.maxActiveDirectoryHandles,
                heapUsedDeltaBytes: firstMemoryAfter.heapUsed - firstMemoryBefore.heapUsed,
                rssDeltaBytes: firstMemoryAfter.rss - firstMemoryBefore.rss,
            };

            resetFsObservations();
            const secondMemoryBefore = process.memoryUsage();
            const secondStartedAt = performance.now();
            const second = await listBuiltClaudeExternalSessionCandidates({
                source: { kind: 'claudeConfig', configDir, projectId: null },
                env: {},
                cursor: first.nextCursor ?? undefined,
                limit: pageSize,
            });
            const secondElapsedMs = performance.now() - secondStartedAt;
            const secondMemoryAfter = process.memoryUsage();
            const secondObservation = {
                elapsedMs: Math.round(secondElapsedMs * 100) / 100,
                sessionEntriesPulled: fsMockState.directoryEntryPulls.filter((path) => path.endsWith('.jsonl')).length,
                projectEntriesPulled: fsMockState.directoryEntryPulls.filter((path) => !path.endsWith('.jsonl')).length,
                selectedTranscriptPaths: transcriptPaths(fsMockState.statCalls).length,
                titleReadPaths: transcriptPaths(fsMockState.openCalls).length,
                observablePageStateItems: second.candidates.length + (second.nextCursor ? 1 : 0),
                derivedRetainedEntryUpperBound: pageSize + 1,
                maxActiveDirectoryHandles: fsMockState.maxActiveDirectoryHandles,
                heapUsedDeltaBytes: secondMemoryAfter.heapUsed - secondMemoryBefore.heapUsed,
                rssDeltaBytes: secondMemoryAfter.rss - secondMemoryBefore.rss,
            };
            const measurement = {
                schema: 'claude-external-candidates-e10-v1',
                environment: {
                    node: process.version,
                    platform: process.platform,
                    arch: process.arch,
                    runner: 'vitest instrumentation over package build output with real temporary filesystem',
                },
                corpus: {
                    candidates: candidateCount,
                    projects: 100,
                    sessionsPerProject: 100,
                    pageSize,
                },
                firstPage: firstObservation,
                secondPage: secondObservation,
            };
            process.stdout.write(`CLAUDE_EXTERNAL_CANDIDATES_E10 ${JSON.stringify(measurement)}\n`);

            expect(first.candidates).toHaveLength(pageSize);
            expect(second.candidates).toHaveLength(pageSize);
            expect(new Set([
                ...first.candidates.map(candidateIdentity),
                ...second.candidates.map(candidateIdentity),
            ]).size).toBe(pageSize * 2);
            expect(firstObservation.selectedTranscriptPaths).toBeLessThanOrEqual(pageSize);
            expect(firstObservation.titleReadPaths).toBe(pageSize);
            expect(secondObservation.titleReadPaths).toBe(pageSize);
            expect(firstObservation.observablePageStateItems).toBeLessThanOrEqual(pageSize + 1);
            expect(firstObservation.sessionEntriesPulled).toBeLessThan(candidateCount);
        }, 120_000);
    },
);
