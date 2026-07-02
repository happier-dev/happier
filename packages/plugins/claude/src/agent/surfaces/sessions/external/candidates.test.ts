import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fsMockState = vi.hoisted((): {
    blockedReaddirPath: string | null;
    readdirCalls: string[];
} => ({
    blockedReaddirPath: null,
    readdirCalls: [],
}));

vi.mock('node:fs/promises', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return {
        ...actualFs,
        readdir: async (path: Parameters<typeof actualFs.readdir>[0], options?: Parameters<typeof actualFs.readdir>[1]) => {
            fsMockState.readdirCalls.push(String(path));
            if (fsMockState.blockedReaddirPath && String(path) === fsMockState.blockedReaddirPath) {
                throw new Error('project session directory scan blocked');
            }
            return await actualFs.readdir(path, options);
        },
    };
});

function jsonlLine(value: unknown): string {
    return `${JSON.stringify(value)}\n`;
}

async function loadCandidates() {
    return await import('./candidates.js');
}

describe('Claude external-session candidate listing', () => {
    afterEach(() => {
        fsMockState.blockedReaddirPath = null;
        fsMockState.readdirCalls = [];
        vi.restoreAllMocks();
        vi.resetModules();
    });

    it('matches full search terms against surfaced session titles', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-title-search-'));
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

        const { listClaudeExternalSessionCandidates } = await loadCandidates();
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

    it('matches exact session ids without scanning project session directories', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-claude-plugin-id-search-'));
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

        const { listClaudeExternalSessionCandidates } = await loadCandidates();
        const result = await listClaudeExternalSessionCandidates({
            source: { kind: 'claudeConfig', configDir, projectId: null },
            env: {},
            limit: 10,
            searchTerm: matchingSessionId,
            searchMode: 'fast',
        });

        expect(result.candidates.map((candidate) => candidate.remoteSessionId)).toEqual([matchingSessionId]);
        expect(fsMockState.readdirCalls).not.toContain(projectDir);
    });
});
