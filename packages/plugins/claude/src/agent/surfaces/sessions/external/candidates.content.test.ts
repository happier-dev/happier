// Initialize the real Workflow schema before the SDK during its ongoing Mini migration.
import '@happier-dev/protocol/workflows/workflowV1';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import * as fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import { listClaudeExternalSessionCandidates } from './candidates.js';
import { pageClaudeExternalSessionTranscript } from './transcript.js';
import { createClaudeExternalSessionsContribution } from './contribution.js';
import { RawJSONLinesSchema } from '../../../transcripts/rawJsonLines.js';

// Filesystem is a genuine system boundary; retain its actual reads and handles.
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, open: vi.fn(actual.open), readdir: vi.fn(actual.readdir) };
});

const roots: string[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fileSystem.open).mockReset().mockImplementation(actual.open);
    vi.mocked(fileSystem.readdir).mockReset().mockImplementation(actual.readdir);
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function corpus() {
    const configDir = await mkdtemp(join(tmpdir(), 'claude-content-'));
    roots.push(configDir);
    const directory = join(configDir, 'projects', 'project');
    await mkdir(directory, { recursive: true });
    const rows = [
        { type: 'user', uuid: 'start', parentUuid: null, message: { role: 'user', content: 'Ordinary title' } },
        { type: 'assistant', uuid: 'abandoned', parentUuid: 'start', message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned phrase' }] } },
        { type: 'system', subtype: 'compact_boundary', uuid: 'bridge', parentUuid: 'start' },
        { type: 'assistant', uuid: 'body', parentUuid: 'bridge', message: { role: 'assistant', content: [{ type: 'text', text: 'Body-only café\nwith "quotes"' }] } },
        { type: 'assistant', uuid: 'tool', parentUuid: 'body', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'Read', input: { path: 'metadata phrase' } }] } },
    ];
    await writeFile(join(directory, 'session.jsonl'), rows.map((row) => JSON.stringify(row).replace(/é/g, '\\u00e9')).join('\n') + '\n');
    // The packaged process is the boundary; the filesystem and codecs stay real.
    const ripgrep = { run: vi.fn(async ({ args, paths }: { args: readonly string[]; paths: readonly string[]; signal?: AbortSignal }) => {
        const launcher = fileURLToPath(new URL('../../../../../../../../apps/cli/scripts/ripgrep_launcher.cjs', import.meta.url));
        try {
            const pending = promisify(execFile)(process.execPath, [launcher, '--stdin']);
            pending.child.stdin?.end(JSON.stringify({ args, paths }));
            const result = await pending;
            return { ...result, exitCode: 0 };
        } catch (error) {
            // rg's no-match exit is a successful prefilter result, not a process failure.
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
                return { exitCode: 1, stdout: '', stderr: '' };
            }
            throw error;
        }
    }) };
    return { source: { kind: 'claudeConfig' as const, configDir, projectId: 'project' }, env: {}, limit: 10, searchTarget: 'content' as const, ripgrep };
}

describe('Claude candidate conversation search', () => {
    it('publishes the next hit without waiting for its held lookahead batch', async () => {
        const params = await corpus();
        const directory = join(params.source.configDir, 'projects', 'project');
        await rm(join(directory, 'session.jsonl'));
        for (let index = 0; index < 4; index++) {
            const path = join(directory, `session-${index}.jsonl`);
            await writeFile(path, JSON.stringify({ type: 'user', uuid: `body-${index}`, parentUuid: null,
                message: { role: 'user', content: index === 3 ? 'Ordinary title' : 'Visible needle' } }) + '\n');
            await utimes(path, new Date(1000 * (index + 1)), new Date(1000 * (index + 1)));
        }
        const run = params.ripgrep.run.getMockImplementation()!;
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let admitLater!: () => void;
        const later = new Promise<void>(resolve => { admitLater = resolve; });
        const admittedPaths = new Set<string>();
        const ripgrep = { run: async (request: Parameters<typeof run>[0]) => {
            for (const path of request.paths) admittedPaths.add(path);
            if (request.paths.some(path => path.endsWith('session-1.jsonl'))) { admitLater(); await held; }
            return run(request);
        } };
        const first = listClaudeExternalSessionCandidates({ ...params, limit: 1, searchTerm: 'needle', ripgrep });
        try {
            expect(await Promise.race([first.then(() => 'published'), later.then(() => 'lookahead admitted')])).toBe('lookahead admitted');
            expect((await first).candidates.map(candidate => candidate.remoteSessionId)).toEqual(['session-2']);
            expect([...admittedPaths].map(path => path.split(/[\\/]/).at(-1)).sort()).toEqual(['session-1.jsonl', 'session-2.jsonl', 'session-3.jsonl']);
        } finally { release(); await first; }
        const page = await first;
        expect(page.candidates.map(candidate => candidate.remoteSessionId)).toEqual(['session-2']);
        expect(page.contentCoverage).toBe('partial');
        expect(page.nextCursor).toBeTruthy();
        const ids = page.candidates.map(candidate => candidate.remoteSessionId);
        let cursor = page.nextCursor;
        while (cursor) {
            const next = await listClaudeExternalSessionCandidates({ ...params, limit: 1, searchTerm: 'needle', cursor });
            ids.push(...next.candidates.map(candidate => candidate.remoteSessionId));
            expect(next.nextCursor).not.toBe(cursor);
            cursor = next.nextCursor;
            if (!cursor) expect(next.contentCoverage).toBe('complete');
        }
        expect(ids).toEqual(['session-2', 'session-1', 'session-0']);
    });
    it('starts native prefilters in proportion to page demand on a large frontier', async () => {
        const params = await corpus();
        const directory = join(params.source.configDir, 'projects', 'project');
        await rm(join(directory, 'session.jsonl'));
        await Promise.all(Array.from({ length: 1000 }, async (_, index) => {
            const path = join(directory, `scale-${String(index).padStart(4, '0')}.jsonl`);
            await writeFile(path, JSON.stringify({ type: 'user', uuid: `body-${index}`, parentUuid: null,
                message: { role: 'user', content: index === 999 ? 'ordinary' : 'visible needle' } }) + '\n');
            await utimes(path, new Date(index * 1000), new Date(index * 1000));
        }));
        const run = params.ripgrep.run.getMockImplementation()!;
        const paths: string[] = [];
        const ripgrep = { run: async (request: Parameters<typeof run>[0]) => {
            paths.push(...request.paths);
            // Count every native process admission without actually forking
            // 998 irrelevant children when exercising the broken scheduler.
            if (paths.length > 3) return { exitCode: 1, stdout: '', stderr: '' };
            return run(request);
        } };
        const page = await listClaudeExternalSessionCandidates({ ...params, limit: 1, searchTerm: 'needle', ripgrep });
        expect(page.candidates.map(candidate => candidate.remoteSessionId)).toEqual(['scale-0998']);
        expect(paths.length).toBeGreaterThanOrEqual(2);
        expect(paths.length).toBeLessThanOrEqual(3);
        expect(page.nextCursor).toBeTruthy();
    });
    it('excludes unrelated transform-shaped rows from query-local decoding and coverage', async () => {
        const params = await corpus();
        const path = join(params.source.configDir, 'projects', 'project', 'session.jsonl');
        await writeFile(path, [
            { type: 'future_record', origin: { kind: 'peer', name: 'Ordinary sender' }, isCompactSummary: false,
                message: { content: [{ type: 'text', text: 'ordinary ' }, { type: 'text', text: 'conversation' }] } },
            { type: 'user', uuid: 'command', parentUuid: null, message: { role: 'user',
                content: '<local-command-stdout>Ordinary command output</local-command-stdout>' } },
        ].map(row => JSON.stringify(row)).join('\n') + '\n');
        await expect(listClaudeExternalSessionCandidates({ ...params, searchTerm: 'r283coastalsapphire' }))
            .resolves.toMatchObject({ candidates: [], contentCoverage: 'complete' });
    });
    it.each([
        ['malformed JSON', Buffer.from('{"type":"assistant","message":invalid}'), false],
        ['malformed UTF-8', Buffer.from([0xff]), false],
        ['unknown record', Buffer.from('{"type":"future_record","content":"unrelated"}'), false],
        ['admitted malformed JSON', Buffer.from('{"type":"assistant","message":invalid,"text":"needle"}'), true],
        ['admitted malformed UTF-8', Buffer.concat([Buffer.from('needle'), Buffer.from([0xff])]), true],
        ['admitted unknown record', Buffer.from('{"type":"future_record","content":"needle"}'), true],
    ] as const)('reports query-local coverage for %s', async (_name, damagedRow, admitted) => {
        const params = await corpus();
        const path = join(params.source.configDir, 'projects', 'project', 'session.jsonl');
        await writeFile(path, Buffer.concat([
            Buffer.from(JSON.stringify({ type: 'user', uuid: 'start', parentUuid: null, message: { role: 'user', content: 'Ordinary title' } }) + '\n'),
            damagedRow, Buffer.from('\n'),
            Buffer.from(JSON.stringify({ type: 'user', uuid: 'tool', parentUuid: 'start', message: { role: 'user', content: [
                { type: 'tool_result', tool_use_id: 'call', content: 'tool-only needle' },
            ] } }) + '\n'),
        ]));
        // The same proof applies to excluded files and excluded rows. A
        // truncated process result cannot exclude either and must decode.
        const run = params.ripgrep.run.getMockImplementation()!;
        const unfiltered = { run: async (request: Parameters<typeof run>[0]) => ({ ...await run(request), stdoutTruncated: true }) };
        await expect(listClaudeExternalSessionCandidates({ ...params, ripgrep: unfiltered, searchTerm: 'needle' }))
            .resolves.toMatchObject({ candidates: [], contentCoverage: 'partial' });
        await expect(listClaudeExternalSessionCandidates({ ...params, searchTerm: 'needle' }))
            .resolves.toMatchObject({ candidates: [], contentCoverage: admitted ? 'partial' : 'complete' });
        await expect(listClaudeExternalSessionCandidates({ ...params, searchTerm: 'absent phrase' }))
            .resolves.toMatchObject({ candidates: [], contentCoverage: 'complete' });
    });
    it('leaves decoded-hit ancestry with the full scan', async () => {
        const params = await corpus();
        const path = join(params.source.configDir, 'projects', 'project', 'session.jsonl');
        for (const visible of [false, true]) {
            await writeFile(path, JSON.stringify({ type: 'assistant', uuid: 'orphan', parentUuid: 'missing',
                message: { role: 'assistant', content: visible ? [{ type: 'text', text: 'needle' }]
                    : [{ type: 'tool_use', id: 'call', name: 'Read', input: { query: 'needle' } }] } }) + '\n');
            const page = await listClaudeExternalSessionCandidates({ ...params, searchTerm: 'needle' });
            expect(page.candidates).toHaveLength(visible ? 1 : 0);
            expect(page.contentCoverage).toBe(visible ? 'partial' : 'complete');
            if (visible) expect(page.candidates[0]?.match).toMatchObject({ snippet: 'needle', messageIndex: 0 });
        }
    });
    it('excludes an unadmitted damaged EOF from query coverage', async () => {
        const params = await corpus();
        const path = join(params.source.configDir, 'projects', 'project', 'session.jsonl');
        const row = JSON.stringify({ type: 'assistant', uuid: 'tool', parentUuid: null,
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'Read', input: { query: 'needle' } }] } });
        await writeFile(path, row + '\n{"unfinished":');
        await expect(listClaudeExternalSessionCandidates({ ...params, searchTerm: 'needle' }))
            .resolves.toMatchObject({ candidates: [], contentCoverage: 'complete' });
    });
    it('stops candidate decoding at a visible hit before the exact ordinal scan', async () => {
        const params = await corpus();
        const path = join(params.source.configDir, 'projects', 'project', 'session.jsonl');
        const rows = [JSON.stringify({ type: 'user', uuid: 'prompt', parentUuid: null,
            message: { role: 'user', content: 'Ordinary title' } })];
        for (let index = 0; index < 300; index++) rows.push(JSON.stringify({ type: 'user', uuid: `tool-${index}`,
            parentUuid: index ? `tool-${index - 1}` : 'prompt', message: { role: 'user', content: [
                { type: 'tool_result', tool_use_id: `call-${index}`, content: 'synthetic output '.repeat(500) },
            ] } }));
        rows.push(JSON.stringify({ type: 'user', uuid: 'hit', parentUuid: 'tool-299',
            message: { role: 'user', content: 'Visible candidate needle' } }));
        await writeFile(path, rows.join('\n') + '\n');
        let readBytes = 0;
        const open = vi.mocked(fileSystem.open).getMockImplementation()!;
        vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (args[0] === path) {
                const read = handle.read.bind(handle);
                handle.read = (async (...readArgs: Parameters<typeof read>) => {
                    const result = await read(...readArgs);
                    readBytes += result.bytesRead;
                    return result;
                }) as typeof handle.read;
            }
            return handle;
        });
        const page = await listClaudeExternalSessionCandidates({ ...params, searchTerm: 'candidate needle' });
        expect(page.candidates).toMatchObject([{ match: { messageIndex: 301, snippet: 'Visible candidate needle' } }]);
        // The exact ordinal pass owns a full read; candidate discovery must not
        // charge a second complete body read after already finding real text.
        expect(readBytes).toBeLessThan(2 * (await fileSystem.stat(path)).size);
    });
    it('marks an admitted unsupported row partial without a second full body read', async () => {
        const params = await corpus();
        const path = join(params.source.configDir, 'projects', 'project', 'session.jsonl');
        const rows = [JSON.stringify({ type: 'future_record', content: 'candidate needle' })];
        for (let index = 0; index < 300; index++) rows.push(JSON.stringify({ type: 'user', uuid: `tool-${index}`,
            parentUuid: index ? `tool-${index - 1}` : null, message: { role: 'user', content: [
                { type: 'tool_result', tool_use_id: `call-${index}`, content: 'synthetic output '.repeat(500) },
            ] } }));
        await writeFile(path, rows.join('\n') + '\n');
        let readBytes = 0;
        const open = vi.mocked(fileSystem.open).getMockImplementation()!;
        vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (args[0] === path) {
                const read = handle.read.bind(handle);
                handle.read = (async (...readArgs: Parameters<typeof read>) => {
                    const result = await read(...readArgs);
                    readBytes += result.bytesRead;
                    return result;
                }) as typeof handle.read;
            }
            return handle;
        });
        await expect(listClaudeExternalSessionCandidates({ ...params, searchTerm: 'candidate needle' }))
            .resolves.toMatchObject({ candidates: [], contentCoverage: 'partial' });
        // One boundary traversal plus bounded source anchors, not two body
        // scans merely to rediscover an already known coverage gap.
        expect(readBytes).toBeLessThan(1.5 * (await fileSystem.stat(path)).size);
    });
    it.each(['replacement', 'rewrite'])('re-decodes a native %s between line admission and decoding', async mode => {
        const params = await corpus();
        const path = join(params.source.configDir, 'projects', 'project', 'session.jsonl');
        const run = params.ripgrep.run.getMockImplementation()!;
        params.ripgrep.run.mockImplementation(async request => {
            const result = await run(request);
            if (request.args.includes('--byte-offset')) {
                const replacement = { type: 'user', uuid: 'replacement', parentUuid: null,
                    message: { role: 'user', content: 'Body-only replacement' }, padding: '' };
                const originalSize = (await fileSystem.stat(path)).size;
                replacement.padding = ' '.repeat(originalSize - Buffer.byteLength(JSON.stringify(replacement) + '\n'));
                await writeFile(mode === 'replacement' ? `${path}.replacement` : path, JSON.stringify(replacement) + '\n');
                if (mode === 'replacement') await fileSystem.rename(`${path}.replacement`, path);
            }
            return result;
        });
        await expect(listClaudeExternalSessionCandidates({ ...params, searchTerm: 'Body-only' }))
            .resolves.toMatchObject({ candidates: [{ match: { snippet: 'Body-only replacement', messageIndex: 0 } }] });
    });
    it('keeps decoded coalescing, ANSI and generated fallback matches after tool-only line admission', async () => {
        const params = await corpus();
        const path = join(params.source.configDir, 'projects', 'project', 'session.jsonl');
        for (const [query, type, content] of [
            ['needle', 'assistant', [{ type: 'text', text: 'nee' }, { type: 'text', text: 'dle' }]],
            ['needle', 'user', '<local-command-stdout>nee\u001b[31mdle</local-command-stdout>'],
            ['a&b', 'user', '<local-command-stdout>a&amp;b</local-command-stdout>'],
            ['/review main', 'user', '<command-name>/review</command-name><command-args>main</command-args>'],
            ['needle', 'assistant', [{ text: 'n', type: 'text' }, { text: 'ee', type: 'text' }, { text: 'dle', type: 'text' }]],
            ['a'.repeat(2000), 'assistant', [{ type: 'text', text: 'a'.repeat(1000) }, { type: 'text', text: 'a'.repeat(1000) }]],
            ['unsupported image', 'assistant', [{ type: 'image', source: { type: 'unknown' } }]],
        ] as const) {
            await writeFile(path, [
                { type: 'user', uuid: 'start', parentUuid: null, message: { role: 'user', content: 'Ordinary title' } },
                { type, uuid: 'visible', parentUuid: 'start', message: { role: type, content } },
                { type: 'user', uuid: 'tool', parentUuid: 'visible', message: { role: 'user', content: [
                    { type: 'tool_result', tool_use_id: 'call', content: query },
                ] } },
            ].map(row => JSON.stringify(row)).join('\n') + '\n');
            const page = await listClaudeExternalSessionCandidates({ ...params, searchTerm: query });
            expect(page.candidates).toMatchObject([{ match: { messageIndex: 1, snippet: expect.stringContaining(query) } }]);
        }
    });
    it('keeps peer bodies, compact summaries and shell text searchable after narrowing admission', async () => {
        const params = await corpus();
        const path = join(params.source.configDir, 'projects', 'project', 'session.jsonl');
        for (const [query, row] of [
            // The sender is presentation provenance beside the delivered body, not body text.
            ['ordinary body', { origin: { kind: 'peer', name: 'sender' }, message: { role: 'user', content: 'ordinary body' } }],
            ['needle', { isCompactSummary: true, message: { role: 'user', content: 'nee\u001b[31mdle' } }],
            ['multiple words', { isCompactSummary: true, message: { role: 'user', content: 'multiple\n\twords' } }],
            ['!echo', { message: { role: 'user', content: '<bash-input>echo</bash-input>' } }],
        ] as const) {
            await writeFile(path, JSON.stringify({ type: 'user', uuid: 'visible', parentUuid: null, ...row }) + '\n');
            await expect(listClaudeExternalSessionCandidates({ ...params, searchTerm: query }))
                .resolves.toMatchObject({ candidates: [{ match: { messageIndex: 0, snippet: expect.stringContaining(query) } }] });
        }
    });
    it('decodes generated fallback matches even when their text is absent from the native file', async () => {
        const params = await corpus();
        const path = join(params.source.configDir, 'projects', 'project', 'session.jsonl');
        await writeFile(path, JSON.stringify({ type: 'assistant', uuid: 'image', parentUuid: null,
            message: { role: 'assistant', content: [{ type: 'image', source: { type: 'unknown' } }] } }) + '\n');
        await expect(listClaudeExternalSessionCandidates({ ...params, searchTerm: 'unsupported image' }))
            .resolves.toMatchObject({ candidates: [{ match: { snippet: expect.stringContaining('unsupported image') } }] });
    });
    it('keeps native descriptor acquisition independent of decoded chunk count', async () => {
        const params = await corpus();
        const path = join(params.source.configDir, 'projects', 'project', 'session.jsonl');
        const query = 'native descriptor needle';
        const rows = [JSON.stringify({ type: 'user', uuid: 'prompt', parentUuid: null,
            message: { role: 'user', content: query } })];
        for (let index = 0; index < 800; index++) rows.push(JSON.stringify({ type: 'assistant', uuid: `tool-${index}`,
            parentUuid: index ? `tool-${index - 1}` : 'prompt', message: { role: 'assistant', content: [
                { type: 'tool_use', id: `call-${index}`, name: 'Read', input: { padding: 'metadata '.repeat(512) } },
            ] } }));
        await writeFile(path, rows.join('\n') + '\n');
        vi.mocked(fileSystem.open).mockClear();
        const page = await listClaudeExternalSessionCandidates({ ...params, searchTerm: query });
        expect(page.candidates).toMatchObject([{ remoteSessionId: 'session', match: { snippet: query, messageIndex: 0 } }]);
        expect(page.contentCoverage).toBe('complete');
        // Two source-evidence captures, candidate + exact scans and two locator re-reads. The
        // 3+ MiB tool-heavy body must not open/close a descriptor for every chunk.
        expect(vi.mocked(fileSystem.open).mock.calls.length).toBeLessThanOrEqual(6);
    });
    it('publishes a hit page without prefiltering later or already visited native bodies', async () => {
        const params = await corpus();
        const directory = join(params.source.configDir, 'projects', 'project');
        await rm(join(directory, 'session.jsonl'));
        const paths: string[] = [];
        for (let index = 0; index < 5; index += 1) {
            const path = join(directory, `page-${index}.jsonl`);
            await writeFile(path, JSON.stringify({ type: 'user', uuid: `hit-${index}`, parentUuid: null,
                message: { role: 'user', content: 'paged native needle' } }) + '\n');
            paths.push(await realpath(path));
            await utimes(path, new Date(2025, 0, 5 - index), new Date(2025, 0, 5 - index));
        }
        const request = { ...params, searchTerm: 'paged native needle', limit: 2 };
        const first = await listClaudeExternalSessionCandidates(request);
        expect(first.candidates.map(row => row.remoteSessionId)).toEqual(['page-0', 'page-1']);
        expect(first.contentCoverage).toBe('partial');
        // The process boundary must only read this result page's native work.
        // Eagerly scanning the root charges every future page before a hit can publish.
        expect([...new Set(params.ripgrep.run.mock.calls.flatMap(([call]) => [...call.paths]))]).toEqual(paths.slice(0, 2));
        params.ripgrep.run.mockClear();
        const second = await listClaudeExternalSessionCandidates({ ...request, cursor: first.nextCursor! });
        expect(second.candidates.map(row => row.remoteSessionId)).toEqual(['page-2', 'page-3']);
        expect(second.contentCoverage).toBe('partial');
        expect([...new Set(params.ripgrep.run.mock.calls.flatMap(([call]) => [...call.paths]))]).toEqual(paths.slice(2, 4));
        params.ripgrep.run.mockClear();
        const last = await listClaudeExternalSessionCandidates({ ...request, cursor: second.nextCursor! });
        expect(last.candidates.map(row => row.remoteSessionId)).toEqual(['page-4']);
        expect(last.contentCoverage).toBe('complete');
        expect(last.nextCursor).toBeNull();
        expect([...new Set(params.ripgrep.run.mock.calls.flatMap(([call]) => [...call.paths]))]).toEqual(paths.slice(4));
    });
    it('finds readable assistant text after a NUL record in a directory-prefiltered native transcript', async () => {
        const params = await corpus();
        const path = join(params.source.configDir, 'projects', 'project', 'session.jsonl');
        await appendFile(path, '\0\n' + JSON.stringify({ type: 'assistant', uuid: 'nul-follow-up', parentUuid: 'tool',
            message: { role: 'assistant', content: [{ type: 'text', text: 'test-r101 traced all 23' }] } }) + '\n');
        // Exercise the machine-wide layout, not an explicit file operand.
        const page = await listClaudeExternalSessionCandidates({ ...params,
            source: { kind: 'claudeConfig', configDir: params.source.configDir }, searchTerm: 'test-r101 traced all 23' });
        expect(page.candidates).toMatchObject([{ remoteSessionId: 'session',
            match: { snippet: 'test-r101 traced all 23', sourceItemId: expect.any(String) } }]);
        expect(page.contentCoverage).toBe('partial');
        expect(page.nextCursor).toBeNull();
    });
    it('excludes unrelated Unicode-escaped bodies before decoding while retaining mixed-escape hits', async () => {
        const params = await corpus();
        const directory = join(params.source.configDir, 'projects', 'project');
        const miss = join(directory, 'unicode-miss.jsonl');
        const missLine = JSON.stringify({ type: 'user', uuid: 'miss', parentUuid: null,
            message: { role: 'user', content: 'unrelated \u001b native tool output'.repeat(1000) } }) + '\n';
        await writeFile(miss, missLine);
        const hit = join(directory, 'encoded-hit.jsonl');
        await writeFile(hit, JSON.stringify({ type: 'user', uuid: 'encoded', parentUuid: null,
            message: { role: 'user', content: 'VIOLET harbor lantern' } }).replace('VIOLET', '\\u0056I\\u004fLET') + '\n');
        const sidechain = join(directory, 'subagents', 'nested.jsonl');
        await mkdir(join(directory, 'subagents'));
        await writeFile(sidechain, '{"text":"violet harbor lantern"}\n');
        // Native candidates are top-level JSONL files, independent of Git ignore rules.
        await writeFile(join(directory, '.gitignore'), 'encoded-hit.jsonl\n');
        let missBytes = 0;
        const open = vi.mocked(fileSystem.open).getMockImplementation()!;
        vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (args[0] === miss) {
                const read = handle.read.bind(handle);
                handle.read = (async (...readArgs: Parameters<typeof read>) => {
                    const result = await read(...readArgs);
                    missBytes += result.bytesRead;
                    return result;
                }) as typeof handle.read;
            }
            return handle;
        });
        const page = await listClaudeExternalSessionCandidates({ ...params, searchTerm: 'violet harbor lantern' });
        expect(page.candidates).toMatchObject([{ remoteSessionId: 'encoded-hit',
            match: { snippet: 'VIOLET harbor lantern', sourceItemId: expect.any(String), messageIndex: 0 } }]);
        expect(page.nextCursor).toBeNull();
        // The page's file prefilter excludes unrelated bodies before line admission.
        expect((await params.ripgrep.run.mock.results[0]!.value).stdout).not.toContain(sidechain);
        // Two existing 16-KiB source-anchor reads are legitimate; reading the
        // entire miss proves it crossed the prefilter into native decoding.
        expect(missBytes).toBeLessThan(missLine.length);
    });
    it('keeps fresh and between-file pages readable when the scanned native file appends', async () => {
        const params = await corpus();
        const path = join(params.source.configDir, 'projects', 'project', 'session.jsonl');
        const olderPath = join(params.source.configDir, 'projects', 'project', 'older.jsonl');
        await writeFile(olderPath, JSON.stringify({ type: 'user', uuid: 'older', parentUuid: null,
            message: { role: 'user', content: 'Body-only older' } }) + '\n');
        await utimes(olderPath, new Date('2025-01-01'), new Date('2025-01-01'));
        const run = params.ripgrep.run.getMockImplementation()!;
        params.ripgrep.run.mockImplementation(async request => {
            const result = await run(request);
            await appendFile(path, JSON.stringify({ type: 'cost-state', totalCostUSD: 0 }) + '\n');
            return result;
        });
        const request = { ...params, searchTerm: 'Body-only', limit: 1 };
        const first = await listClaudeExternalSessionCandidates(request);
        expect(first.candidates.map(hit => hit.remoteSessionId)).toEqual(['session']);
        expect(first.nextCursor).toBeTruthy();
        await appendFile(path, JSON.stringify({ type: 'atis-latch', enabled: true }) + '\n');
        const next = await listClaudeExternalSessionCandidates({ ...request, cursor: first.nextCursor! });
        expect(next.candidates.map(hit => hit.remoteSessionId)).toEqual(['older']);
    });
    it('retires intermediate development content cursors through the existing fresh-search failure', async () => {
        const params = await corpus();
        const result = await createClaudeExternalSessionsContribution({ env: {} }).listCandidates({
            source: params.source, maxItems: 1, searchTarget: 'content', searchTerm: 'Body-only',
            cursor: Buffer.from(JSON.stringify([6, null, 'body-only', 'l', 'content', {}])).toString('base64url'),
            signal: new AbortController().signal, maxSerializedBytes: 1024 * 1024,
            ripgrep: params.ripgrep, exec: {} as ExecService,
        });
        expect(result).toMatchObject({ ok: false, code: 'source_invalid', retryable: true });
        const fresh = await listClaudeExternalSessionCandidates({ ...params, searchTerm: 'Body-only' });
        expect(fresh.candidates).toMatchObject([{ remoteSessionId: 'session', match: { messageIndex: 1 } }]);
    });
    it('keeps its content frontier independent of corpus size', async () => {
        const params = await corpus();
        const directory = join(params.source.configDir, 'projects', 'project');
        const nowMs = Date.now() + 1000;
        vi.spyOn(Date, 'now').mockReturnValue(nowMs);
        const row = JSON.stringify({ type: 'user', uuid: 'hit', parentUuid: null,
            message: { role: 'user', content: 'compact frontier needle' } }) + '\n';
        await writeFile(join(directory, 'a.jsonl'), row);
        await utimes(join(directory, 'a.jsonl'), new Date(nowMs - 100), new Date(nowMs - 100));
        const request = { ...params, searchTerm: 'compact frontier needle', limit: 1 };
        const small = await listClaudeExternalSessionCandidates(request);
        expect(small.candidates.map(hit => hit.remoteSessionId)).toEqual(['a']);
        expect(small.nextCursor).toBeTruthy();
        await Promise.all(Array.from({ length: 661 }, async (_, index) => {
            const path = join(directory, `older-${index}.jsonl`);
            await writeFile(path, row);
            await utimes(path, new Date(nowMs - 200), new Date(nowMs - 200));
        }));
        const large = await listClaudeExternalSessionCandidates(request);
        expect(large.nextCursor).toBe(small.nextCursor);
        expect(large.nextCursor!.length).toBeLessThanOrEqual(2000);
    });
    it('resumes tied native identities even after the fully visited frontier file disappears', async () => {
        const params = await corpus();
        const projects = join(params.source.configDir, 'projects');
        for (const project of ['alpha', 'beta', 'gamma']) {
            await mkdir(join(projects, project));
            const path = join(projects, project, 'same-id.jsonl');
            await writeFile(path, JSON.stringify({ type: 'user', uuid: 'match', parentUuid: null,
                message: { role: 'user', content: 'tied frontier needle' } }) + '\n');
            await utimes(path, new Date('2026-01-01'), new Date('2026-01-01'));
        }
        const request = { ...params, source: { kind: 'claudeConfig' as const, configDir: params.source.configDir },
            searchTerm: 'tied frontier needle', limit: 1 };
        const first = await listClaudeExternalSessionCandidates(request);
        const found = first.candidates.map(row => row.details.projectId);
        await rm(join(projects, found[0]!, 'same-id.jsonl'));
        let cursor = first.nextCursor;
        for (let page = 0; cursor && page < 4; page += 1) {
            const next = await listClaudeExternalSessionCandidates({ ...request, cursor });
            found.push(...next.candidates.map(row => row.details.projectId));
            if (next.nextCursor) expect(next.nextCursor).not.toBe(cursor);
            cursor = next.nextCursor;
        }
        expect(cursor).toBeNull();
        expect(found.sort()).toEqual(['alpha', 'beta', 'gamma']);
    });
    it('finishes the main frontier before a single bounded changed-file pass despite visited and unrelated appends', async () => {
        const params = await corpus();
        const directory = join(params.source.configDir, 'projects', 'project');
        let nowMs = Date.now() + 1000;
        const t0 = nowMs;
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        for (const [id, age] of [['a', 10], ['b', 20], ['c', 30], ['unrelated', 40]] as const) {
            const path = join(directory, `${id}.jsonl`);
            await writeFile(path, JSON.stringify({ type: 'user', uuid: id, parentUuid: null,
                message: { role: 'user', content: id === 'unrelated' ? 'ordinary' : 'changed frontier needle' } }) + '\n');
            await utimes(path, new Date(t0 - age), new Date(t0 - age));
        }
        const request = { ...params, searchTerm: 'changed frontier needle', limit: 1 };
        const first = await listClaudeExternalSessionCandidates(request);
        expect(first.candidates.map(row => row.remoteSessionId)).toEqual(['a']);
        nowMs += 1000;
        for (const id of ['a', 'b', 'unrelated']) {
            await appendFile(join(directory, `${id}.jsonl`), JSON.stringify({ type: 'user', uuid: `${id}-next`, parentUuid: id,
                message: { role: 'user', content: 'ordinary append' } }) + '\n');
            await utimes(join(directory, `${id}.jsonl`), new Date(nowMs), new Date(nowMs));
        }
        const hits = [...first.candidates];
        let cursor = first.nextCursor;
        let changedPassStarted = false;
        for (let page = 0; cursor && page < 10; page += 1) {
            const next = await listClaudeExternalSessionCandidates({ ...request, cursor });
            hits.push(...next.candidates);
            if (next.candidates.some(row => row.remoteSessionId === 'b')) {
                changedPassStarted = true;
                // Writing an already visited file again after T1 must not loop.
                nowMs += 1000;
                await utimes(join(directory, 'b.jsonl'), new Date(nowMs), new Date(nowMs));
            }
            if (next.nextCursor) expect(next.nextCursor).not.toBe(cursor);
            cursor = next.nextCursor;
        }
        expect(changedPassStarted).toBe(true);
        expect(cursor).toBeNull();
        expect(hits.map(row => row.remoteSessionId)).toEqual(['a', 'c', 'a', 'b']);
    });
    it.each([false, true])('continues native rows with one unfinished transcript while an unvisited file changes (changed suffix=%s)', async (changeSuffix) => {
        const params = await corpus();
        await writeFile(join(params.source.configDir, 'projects', 'project', 'session.jsonl'),
            Array.from({ length: 30 }, (_, index) => JSON.stringify({ type: 'user', uuid: `row-${index}`,
                parentUuid: index ? `row-${index - 1}` : null,
                message: { role: 'user', content: (index === 0 ? 'Prepared native needle ' : '') + 'ordinary '.repeat(2500) },
            })).join('\n') + '\n');
        const olderPath = join(params.source.configDir, 'projects', 'project', 'older.jsonl');
        if (changeSuffix) {
            await writeFile(olderPath, JSON.stringify({ type: 'user', uuid: 'older', parentUuid: null,
                message: { role: 'user', content: 'Prepared native needle' } }) + '\n');
            await utimes(olderPath, new Date('2025-01-01'), new Date('2025-01-01'));
        }
        let nowMs = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
            const file = await actual.open(...args); nowMs += 3_000; return file;
        });
        const contribution = createClaudeExternalSessionsContribution({ env: {} });
        const request = { source: params.source, maxItems: 1, searchTarget: 'content' as const,
            searchTerm: 'Prepared native needle', signal: new AbortController().signal,
            maxSerializedBytes: 1024 * 1024, ripgrep: params.ripgrep, exec: {} as ExecService };
        let cursor: string | null = null;
        let previousEnd: number | null = null;
        const found: string[] = [];
        let suffixChanged = false;
        for (let page = 0; page < 30; page += 1) {
            const result = await contribution.listCandidates({ ...request, scanDeadlineAtMs: nowMs + 10_000,
                ...(cursor ? { cursor } : {}) });
            if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
            if (result.value.candidates.length > 0) {
                expect(result.value.candidates).toMatchObject([{ match: { messageIndex: 0 } }]);
                found.push(...result.value.candidates.map(row => row.remoteSessionId));
            }
            if (!result.value.nextCursor) {
                break;
            }
            const outer = JSON.parse(Buffer.from(result.value.nextCursor, 'base64url').toString('utf8')) as unknown[];
            const progress = outer[7] as { endOffsetBytes?: number } | undefined;
            if (typeof progress?.endOffsetBytes === 'number') {
                if (previousEnd !== null) expect(progress.endOffsetBytes).toBeLessThan(previousEnd);
                previousEnd = progress.endOffsetBytes;
                if (changeSuffix && !suffixChanged) {
                    nowMs += 1000;
                    await utimes(olderPath, new Date(nowMs), new Date(nowMs));
                    suffixChanged = true;
                }
            }
            cursor = result.value.nextCursor;
        }
        expect(found).toEqual(changeSuffix ? ['session', 'older'] : ['session']);
    });
    it('commits a large native row before cooperative yield across equally slow pages', async () => {
        const params = await corpus();
        const directory = join(params.source.configDir, 'projects', 'project');
        await writeFile(join(directory, 'session.jsonl'), JSON.stringify({ type: 'user', uuid: 'large', parentUuid: null,
            message: { role: 'user', content: 'ordinary '.repeat(70_000) + 'Large row café needle' } }) + '\n');
        const olderPath = join(directory, 'older.jsonl');
        await writeFile(olderPath, JSON.stringify({ type: 'user', uuid: 'older', parentUuid: null,
            message: { role: 'user', content: 'Large row café needle' } }) + '\n');
        await utimes(olderPath, new Date('2025-01-01'), new Date('2025-01-01'));
        let nowMs = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
            const handle = await actual.open(...args);
            nowMs += 3000;
            return handle;
        });
        const contribution = createClaudeExternalSessionsContribution({ env: {} });
        const request = { source: params.source, maxItems: 1, searchTarget: 'content' as const,
            searchTerm: 'Large row café needle', signal: new AbortController().signal,
            maxSerializedBytes: 1024 * 1024, ripgrep: params.ripgrep, exec: {} as ExecService };
        const hits = [];
        let cursor: string | null = null;
        for (let page = 0; page < 30; page += 1) {
            const result = await contribution.listCandidates({ ...request, scanDeadlineAtMs: nowMs + 15_000,
                ...(cursor ? { cursor } : {}) });
            if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
            hits.push(...result.value.candidates);
            if (!result.value.nextCursor) {
                expect(result.value.contentCoverage).toBe('complete');
                cursor = null;
                break;
            }
            expect(result.value.contentCoverage).toBe('partial');
            if (cursor) expect(result.value.nextCursor).not.toBe(cursor);
            cursor = result.value.nextCursor;
        }
        expect(cursor).toBeNull();
        expect(hits.map(hit => hit.remoteSessionId)).toEqual(['session', 'older']);
        expect(hits[0]?.match).toMatchObject({ messageIndex: 0 });
        expect(hits[0]?.match?.snippet).toContain('Large row café needle');
    });
    it('keeps an incomplete native tail partial while returning decoded active-branch hits', async () => {
        const params = await corpus();
        await appendFile(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), '{"type":');
        const result = await listClaudeExternalSessionCandidates({ ...params, searchTerm: 'Body-only' });
        expect(result.candidates[0]?.match?.snippet).toContain('Body-only');
        expect(result.contentCoverage).toBe('partial');
    });
    it('reaches recent sessions across projects first and resumes deterministically at equal timestamps', async () => {
        const params = await corpus();
        const projects = join(params.source.configDir, 'projects');
        const stamp = new Date('2026-10-01T00:00:00Z');
        await utimes(join(projects, 'project', 'session.jsonl'), stamp, stamp);
        for (const [projectId, id, age] of [['a-old', 'old', 1], ['z-recent', 'a-hit', 3], ['z-recent', 'b-hit', 3]] as const) {
            await mkdir(join(projects, projectId), { recursive: true });
            const path = join(projects, projectId, `${id}.jsonl`);
            await writeFile(path, JSON.stringify({ type: 'user', uuid: id, parentUuid: null,
                message: { role: 'user', content: 'Recent search needle' } }) + '\n');
            const time = new Date(stamp.getTime() + age * 1000);
            await utimes(path, time, time);
        }
        const request = { ...params, source: { kind: 'claudeConfig' as const, configDir: params.source.configDir },
            searchTerm: 'Recent search needle', limit: 1 };
        const first = await listClaudeExternalSessionCandidates(request);
        expect(first.candidates.map(row => row.remoteSessionId)).toEqual(['a-hit']);
        // Enumeration order is an OS boundary, not a continuation identity.
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        vi.mocked(fileSystem.readdir).mockImplementation(async (...args) => (await actual.readdir(...args)).reverse());
        const second = await listClaudeExternalSessionCandidates({ ...request, cursor: first.nextCursor! });
        expect(second.candidates.map(row => row.remoteSessionId)).toEqual(['b-hit']);
        // A newer unrelated conversation must not shift a recency continuation.
        await mkdir(join(projects, '0-new'), { recursive: true });
        await writeFile(join(projects, '0-new', 'new.jsonl'), '{}\n');
        const newer = new Date(stamp.getTime() + 10_000);
        await utimes(join(projects, 'z-recent', 'b-hit.jsonl'), newer, newer);
        const third = await listClaudeExternalSessionCandidates({ ...request, cursor: second.nextCursor! });
        expect(third.candidates.map(row => row.remoteSessionId)).toEqual(['old']);
        let final = third;
        for (let page = 0; final.nextCursor && page < 3; page += 1) {
            const next = await listClaudeExternalSessionCandidates({ ...request, cursor: final.nextCursor });
            if (next.nextCursor) expect(next.nextCursor).not.toBe(final.nextCursor);
            final = next;
        }
        expect(final.nextCursor).toBeNull();
        expect(final.contentCoverage).toBe('complete');
    });
    it('accepts its continuation when a newer conversation is created in the same native project', async () => {
        const params = await corpus();
        const directory = join(params.source.configDir, 'projects', 'project');
        for (const [id, day] of [['a', 3], ['b', 2], ['c', 1]] as const) {
            const path = join(directory, `${id}.jsonl`);
            await writeFile(path, JSON.stringify({ type: 'user', uuid: id, parentUuid: null,
                message: { role: 'user', content: 'stable native continuation needle' } }) + '\n');
            const stamp = new Date(Date.UTC(2026, 0, day));
            await utimes(path, stamp, stamp);
        }
        const contribution = createClaudeExternalSessionsContribution({ env: {} });
        const request = { source: params.source, maxItems: 1, searchTarget: 'content' as const,
            searchTerm: 'stable native continuation needle', signal: new AbortController().signal,
            maxSerializedBytes: 1024 * 1024, ripgrep: params.ripgrep, exec: {} as ExecService };
        const first = await contribution.listCandidates(request);
        if (!first.ok) throw new Error(`${first.code}: ${first.message}`);
        expect(first.value.candidates.map(row => row.remoteSessionId)).toEqual(['a']);
        expect(first.value.nextCursor).toEqual(expect.any(String));
        await writeFile(join(directory, 'newer.jsonl'), JSON.stringify({ type: 'user', uuid: 'newer', parentUuid: null,
            message: { role: 'user', content: 'unrelated new conversation' } }) + '\n');
        const second = await contribution.listCandidates({ ...request, cursor: first.value.nextCursor! });
        expect(second).toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId: 'b' }] } });
    });
    it('returns the real first page while another conversation appears during native enumeration', async () => {
        const params = await corpus();
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        let inserted = false;
        vi.mocked(fileSystem.readdir).mockImplementation(async (...args) => {
            const entries = await actual.readdir(...args);
            if (!inserted && args[0] === join(params.source.configDir, 'projects', 'project')) {
                inserted = true;
                await writeFile(join(params.source.configDir, 'projects', 'project', 'new.jsonl'), '{}\n');
            }
            return entries;
        });
        const contribution = createClaudeExternalSessionsContribution({ env: {} });
        const result = await contribution.listCandidates({ source: params.source, maxItems: 1,
            searchTarget: 'content', searchTerm: 'Body-only', signal: new AbortController().signal,
            maxSerializedBytes: 1024 * 1024, ripgrep: params.ripgrep, exec: {} as ExecService });
        expect(result).toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId: 'session' }] } });
    });
    it('budgets returned content hits rather than unrelated source files', async () => {
        const params = await corpus();
        await utimes(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), new Date('2025-01-01'), new Date('2025-01-01'));
        for (const projectId of ['a-miss', 'b-miss']) {
            await mkdir(join(params.source.configDir, 'projects', projectId));
            await writeFile(join(params.source.configDir, 'projects', projectId, 'unrelated.jsonl'), JSON.stringify({
                type: 'user', uuid: 'unrelated', parentUuid: null,
                message: { role: 'user', content: 'Ordinary body' },
            }) + '\n');
            await utimes(join(params.source.configDir, 'projects', projectId, 'unrelated.jsonl'), new Date('2026-01-01'), new Date('2026-01-01'));
        }
        const request = { ...params, source: { kind: 'claudeConfig' as const, configDir: params.source.configDir }, limit: 1 };
        const page = await listClaudeExternalSessionCandidates({ ...request, searchTerm: 'Body-only' });
        expect(page.candidates[0]?.match?.snippet).toContain('Body-only');
        expect(page.nextCursor).toBeNull();
        expect(page.contentCoverage).toBe('complete');
        const missing = await listClaudeExternalSessionCandidates({ ...request, searchTerm: 'never present' });
        expect(missing.candidates).toEqual([]);
        expect(missing.nextCursor).toBeNull();
        expect(missing.contentCoverage).toBe('complete');
    });
    it('advances through equally slow pages of the first large active branch and reaches older hits', async () => {
        const params = await corpus();
        const text = JSON.stringify({ type: 'custom-title', sessionId: 'session', customTitle: 'Obsolete native title' }) + '\n'
            + Array.from({ length: 1500 }, (_, index) => JSON.stringify({
            type: 'user', uuid: `row-${index}`, parentUuid: index === 0 ? null : `row-${index - 1}`,
            message: { role: 'user', content: index === 100 ? 'First file deadline needle earliest' : index === 1499 ? 'First file deadline needle latest' : 'ordinary '.repeat(40) },
        })).flatMap((row, index) => index === 49 ? [row, JSON.stringify({ type: 'assistant', uuid: 'abandoned', parentUuid: 'row-49',
            message: { role: 'assistant', content: [{ type: 'text', text: 'First file deadline needle abandoned' }] } })] : [row]).join('\n') + '\n'
            + JSON.stringify({ type: 'ai-title', sessionId: 'session', aiTitle: 'Latest native title' }) + '\n'
            + JSON.stringify({ type: 'custom-title', sessionId: 'session', customTitle: '' }) + '\n';
        await writeFile(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), text);
        const olderPath = join(params.source.configDir, 'projects', 'project', 'older.jsonl');
        await writeFile(olderPath, JSON.stringify({ type: 'user', uuid: 'older', parentUuid: null,
            message: { role: 'user', content: 'First file deadline needle' } }) + '\n');
        await utimes(olderPath, new Date('2025-01-01'), new Date('2025-01-01'));
        let nowMs = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        const sourceMtime = (await actual.stat(join(params.source.configDir, 'projects', 'project', 'session.jsonl'))).mtime;
        vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
            const handle = await actual.open(...args);
            // The native read is slow independently of descriptor reuse.
            const read = handle.read.bind(handle);
            handle.read = (async (...readArgs: Parameters<typeof read>) => {
                const result = await read(...readArgs);
                nowMs += 3000;
                return result;
            }) as typeof handle.read;
            return handle;
        });
        const contribution = createClaudeExternalSessionsContribution({ env: {} });
        const request = {
            source: params.source, maxItems: 1, searchTarget: 'content' as const, searchTerm: 'First file deadline needle',
            signal: new AbortController().signal, maxSerializedBytes: 1024 * 1024,
            ripgrep: params.ripgrep, exec: {} as ExecService,
        };
        const deadlineAtMs = nowMs + 15_000;
        const first = await contribution.listCandidates({ ...request, scanDeadlineAtMs: deadlineAtMs });
        expect(first).toMatchObject({ ok: true });
        if (!first.ok) throw new Error(`${first.code}: ${first.message}`);
        // NI27 uses the actual cooperative boundary, without predicting a
        // shorter deadline from the previous native read's duration.
        expect(nowMs).toBe(deadlineAtMs);
        expect(first.value).toMatchObject({ candidates: [], contentCoverage: 'partial', nextCursor: expect.any(String) });
        await appendFile(join(params.source.configDir, 'projects', 'project', 'session.jsonl'),
            JSON.stringify({ type: 'cost-state', totalCostUSD: 0 }) + '\n');
        await utimes(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), sourceMtime, sourceMtime);
        // A client may edit an opaque cursor. Returned content still comes
        // from a native row and must pass the canonical matcher on finalization.
        const editedCursor = JSON.parse(Buffer.from(first.value.nextCursor!, 'base64url').toString('utf8')) as unknown[];
        const progress = editedCursor[7] as Record<string, unknown>;
        const titleHeader = JSON.stringify({ type: 'custom-title', sessionId: 'session', customTitle: 'Obsolete native title' }) + '\n';
        const firstNativeRow = JSON.stringify({ type: 'user', uuid: 'row-0', parentUuid: null,
            message: { role: 'user', content: 'ordinary '.repeat(40) } });
        progress.endOffsetBytes = 0;
        progress.match = { startOffsetBytes: Buffer.byteLength(titleHeader),
            endOffsetBytes: Buffer.byteLength(titleHeader + firstNativeRow), itemIndex: 0, newerItems: 0 };
        const edited = await contribution.listCandidates({ ...request, scanDeadlineAtMs: nowMs + 15_000,
            cursor: Buffer.from(JSON.stringify(editedCursor), 'utf8').toString('base64url') });
        if (!edited.ok) throw new Error(`${edited.code}: ${edited.message}`);
        expect(edited.value.candidates.some(hit => hit.remoteSessionId === 'session')).toBe(false);
        const hits = [];
        let cursor = first.value.nextCursor;
        for (let page = 0; cursor && page < 30; page += 1) {
            const next = await contribution.listCandidates({ ...request, scanDeadlineAtMs: nowMs + 15_000, cursor });
            if (!next.ok) throw new Error(`${next.code}: ${next.message}`);
            hits.push(...next.value.candidates);
            if (next.value.nextCursor) {
                expect(next.value.contentCoverage).toBe('partial');
                expect(next.value.nextCursor).not.toBe(cursor);
            } else expect(next.value.contentCoverage).toBe('complete');
            cursor = next.value.nextCursor;
        }
        expect(cursor).toBeNull();
        expect(hits.map(hit => hit.remoteSessionId)).toEqual(['session', 'older']);
        expect(hits[0]?.match).toMatchObject({ snippet: 'First file deadline needle earliest', messageIndex: 100 });
        expect(hits[0]?.title).toBe('Latest native title');
        // Query-local line offsets are reconstructed on a candidate-phase
        // continuation; the cursor retains byte progress, never a corpus cache.
        await writeFile(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), text.replace('Obsolete', 'Replaced'));
        // Keep ordering unchanged: the captured prefix anchor must reject a
        // rewrite, including an edited EOF continuation.
        await utimes(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), sourceMtime, sourceMtime);
        await expect(listClaudeExternalSessionCandidates({ ...params, searchTerm: request.searchTerm,
            cursor: Buffer.from(JSON.stringify(editedCursor), 'utf8').toString('base64url'), deadlineAtMs: nowMs + 15_000 })).rejects.toMatchObject({ name: 'ClaudeCandidateSourceChangedError' });
    });
    it('scans a long single-file conversation within the host budget without rereading a chunk for every row', async () => {
        const params = await corpus();
        const text = Array.from({ length: 1000 }, (_, index) => JSON.stringify({
            type: 'user', uuid: `row-${index}`, parentUuid: index === 0 ? null : `row-${index - 1}`,
            message: { role: 'user', content: index === 999 ? 'Last budget needle' : 'Ordinary body' },
        })).join('\n') + '\n';
        await writeFile(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), text);
        let nowMs = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const actualFileSystem = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
            const handle = await actualFileSystem.open(...args);
            // Actual OS reads are retained. Charge file-open latency to the host
            // clock, making repeated overlapping reads visible without sleeps.
            nowMs += 100;
            return handle;
        });
        const deadlineAtMs = nowMs + 15_000;
        const result = await createClaudeExternalSessionsContribution({ env: {} }).listCandidates({
            source: params.source, maxItems: 50, searchTarget: 'content', searchTerm: 'Last budget needle',
            signal: new AbortController().signal, deadlineAtMs, maxSerializedBytes: 1024 * 1024,
            ripgrep: params.ripgrep, exec: {} as ExecService,
        });
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
        expect(result.value.candidates[0]?.match).toMatchObject({ snippet: 'Last budget needle', messageIndex: 999 });
        expect(result.value.contentCoverage).toBe('complete');
        expect(nowMs).toBeLessThan(deadlineAtMs);
    });
    it('returns completed file hits and resumes before the host deadline on a large corpus', async () => {
        const params = await corpus();
        const directory = join(params.source.configDir, 'projects', 'project');
        // Four real file scans already exceed the injected 15s host budget.
        // Keep several continuation pages without making process startup the
        // test's deciding boundary on a loaded shared executor.
        const corpusSize = 4;
        const text = Array.from({ length: 400 }, (_, index) => JSON.stringify({
            type: 'user', uuid: `row-${index}`, parentUuid: index === 0 ? null : `row-${index - 1}`,
            message: { role: 'user', content: `Budget needle ${index}` },
        })).join('\n') + '\n';
        await writeFile(join(directory, 'session.jsonl'), text);
        await Promise.all(Array.from({ length: corpusSize - 1 }, (_, index) => writeFile(join(directory, `session-${index}.jsonl`), text)));
        let nowMs = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const open = vi.mocked(fileSystem.open).getMockImplementation()!;
        const charged = new Set<string>();
        vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
            const handle = await open(...args);
            // Charge real source I/O once per file, independently of how the
            // page batches its rg process. No wall-clock sleeps are needed.
            if (typeof args[0] === 'string' && args[0].startsWith(directory) && !charged.has(args[0])) {
                charged.add(args[0]);
                nowMs += 8_000;
            }
            return handle;
        });
        const contribution = createClaudeExternalSessionsContribution({ env: {} });
        const ids = new Set<string>();
        let cursor: string | undefined;
        for (let pageIndex = 0; pageIndex < corpusSize; pageIndex += 1) {
            const deadlineAtMs = nowMs + 15_000;
            const result = await contribution.listCandidates({
                source: params.source, maxItems: 50, searchTarget: 'content', searchTerm: 'Budget needle', cursor,
                signal: new AbortController().signal, deadlineAtMs, maxSerializedBytes: 1024 * 1024,
                ripgrep: params.ripgrep, exec: {} as ExecService,
            });
            expect(result).toMatchObject({ ok: true });
            if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
            expect(nowMs).toBeLessThan(deadlineAtMs);
            expect(result.value.candidates).toHaveLength(1);
            for (const candidate of result.value.candidates) {
                expect(candidate.match?.snippet).toContain('Budget needle');
                expect(ids.has(candidate.remoteSessionId)).toBe(false);
                ids.add(candidate.remoteSessionId);
            }
            expect(result.value.contentCoverage).toBe(pageIndex < corpusSize - 1 ? 'partial' : 'complete');
            expect(Boolean(result.value.nextCursor)).toBe(pageIndex < corpusSize - 1);
            cursor = result.value.nextCursor ?? undefined;
        }
        expect(ids.size).toBe(corpusSize);
    });
    it('finds an unescaped Unicode query whose decoded lowercase differs from ripgrep folding', async () => {
        const params = await corpus();
        await writeFile(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), JSON.stringify({
            type: 'user', uuid: 'unicode', parentUuid: null, message: { role: 'user', content: 'İstanbul' },
        }) + '\n');
        const page = await listClaudeExternalSessionCandidates({ ...params, searchTerm: 'İstanbul' });
        expect(page.candidates[0]?.match).toMatchObject({ snippet: 'İstanbul', messageIndex: 0 });
        expect(page.contentCoverage).toBe('complete');
    });
    it('keeps the canonical decoded match at a Unicode lowercase expansion', async () => {
        const params = await corpus();
        await writeFile(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), JSON.stringify({
            type: 'user', uuid: 'unicode-ascii', parentUuid: null, message: { role: 'user', content: 'prefix skİ suffix' },
        }) + '\n');
        const page = await listClaudeExternalSessionCandidates({ ...params, searchTerm: 'ski' });
        expect(page.candidates).toMatchObject([{ remoteSessionId: 'session',
            match: { snippet: 'prefix skİ suffix', messageIndex: 0 } }]);
        expect(page.contentCoverage).toBe('complete');
    });
    it('matches decoded NUL text without passing NUL through process arguments', async () => {
        const params = await corpus();
        const query = 'body\u0000needle';
        await writeFile(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), JSON.stringify({
            type: 'user', uuid: 'nul-body', parentUuid: null, message: { role: 'user', content: query },
        }) + '\n');
        const page = await listClaudeExternalSessionCandidates({ ...params, searchTerm: query });
        expect(page.candidates[0]?.match).toMatchObject({ snippet: query, messageIndex: 0 });
        expect(page.contentCoverage).toBe('complete');
    });
    it('keeps a large decoded body hit within the invocation payload budget', async () => {
        const params = await corpus();
        const query = '  large café\n"needle"  ';
        const text = 'distant-prefix ' + 'İ😀before '.repeat(2000) + 'first-context ' + query + ' nearby-first😀 ' + ' after😀'.repeat(2000) + ' second-context ' + query + ' distant-tail';
        const parsed = RawJSONLinesSchema.safeParse({ type: 'user', uuid: 'large-body', parentUuid: null, message: { role: 'user', content: text } });
        if (!parsed.success) throw new Error('Native Claude fixture rejected.');
        await writeFile(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), JSON.stringify(parsed.data) + '\n');
        const page = await listClaudeExternalSessionCandidates({ ...params, searchTerm: query });
        const snippet = page.candidates[0]?.match?.snippet;
        expect(snippet).toContain(query);
        expect(snippet).toContain('first-context');
        expect(snippet).toContain('nearby-first😀');
        expect(snippet).not.toMatch(/distant-prefix|second-context|distant-tail/);
        expect(snippet?.length).toBeLessThan(1000);
        expect(snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
        expect(page.candidates[0]?.match).toMatchObject({ sourceItemId: expect.stringMatching(/^claude:/), messageIndex: 0 });
        const maxSerializedBytes = 4096;
        const contribution = createClaudeExternalSessionsContribution({ env: {} });
        const invocation = {
            source: params.source, maxItems: 1, searchTarget: 'content', searchTerm: query,
            signal: new AbortController().signal, deadlineAtMs: Date.now() + 30_000, maxSerializedBytes, ripgrep: params.ripgrep,
            // Claude never invokes this process boundary in candidate listing.
            exec: {} as ExecService,
        } as const;
        const result = await contribution.listCandidates(invocation);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.code);
        expect(result.value.candidates).toHaveLength(1);
        expect(result.value.candidates[0]?.match?.snippet).toContain(query);
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(maxSerializedBytes);
        expect(result.value.contentCoverage).toBe('complete');
        const packedSnippet = result.value.candidates[0]?.match?.snippet;
        if (typeof packedSnippet !== 'string') throw new Error('Expected a decoded hit.');
        const narrowerBytes = Buffer.byteLength(JSON.stringify(result)) - Buffer.byteLength(JSON.stringify(packedSnippet)) + Buffer.byteLength(JSON.stringify(query)) + 64;
        const narrower = await contribution.listCandidates({ ...invocation, maxSerializedBytes: narrowerBytes });
        if (!narrower.ok) throw new Error(`${narrower.code}: ${narrower.message}`);
        expect(narrower.value.candidates[0]?.match?.snippet).toContain(query);
        expect(narrower.value.candidates[0]?.match?.snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
        expect(Buffer.byteLength(JSON.stringify(narrower))).toBeLessThanOrEqual(narrowerBytes);
    });
    it('uses the same active ancestry for historical transcript paging', async () => {
        const params = await corpus();
        const items = [];
        let cursor: string | undefined;
        for (let index = 0; index < 10; index += 1) {
            const page = await pageClaudeExternalSessionTranscript({ ...params, providerSessionId: 'session', direction: 'older', maxBytes: 1024 * 1024, maxItems: 1, cursor });
            items.push(...page.items);
            if (!page.hasMore || !page.nextCursor) break;
            cursor = page.nextCursor;
        }
        expect(JSON.stringify(items)).not.toContain('abandoned phrase');
        expect(JSON.stringify(items)).toContain('Body-only');
        expect(JSON.stringify(items)).toContain('Ordinary title');
    });
    it('matches decoded conversation bodies and reports the codec source identity', async () => {
        const params = await corpus();
        const page = await listClaudeExternalSessionCandidates({ ...params, searchTerm: 'café\nwith "quotes"' });
        expect(page.candidates).toHaveLength(1);
        expect(page.candidates[0]?.match).toEqual({ snippet: 'Body-only café\nwith "quotes"', sourceItemId: expect.stringMatching(/^claude:/), messageIndex: 1 });
        expect(page.contentCoverage).toBe('complete');
        await listClaudeExternalSessionCandidates({ ...params, searchTerm: 'Body-only' });
        expect(params.ripgrep.run.mock.calls.at(-1)?.[0].paths).toEqual([await realpath(join(params.source.configDir, 'projects', 'project', 'session.jsonl'))]);
    });
    it('excludes tool metadata and abandoned branches', async () => {
        const params = await corpus();
        for (const searchTerm of ['metadata phrase', 'abandoned phrase']) {
            expect((await listClaudeExternalSessionCandidates({ ...params, searchTerm })).candidates).toEqual([]);
        }
    });
    it('rejects a cursor when its query or target changes', async () => {
        const params = await corpus();
        await writeFile(join(params.source.configDir, 'projects', 'project', 'second.jsonl'), JSON.stringify({ type: 'user', uuid: 'second', parentUuid: null, message: { role: 'user', content: 'Body-only' } }) + '\n');
        const page = await listClaudeExternalSessionCandidates({ ...params, searchTerm: 'Body-only', limit: 1 });
        expect(page.nextCursor).toBeTruthy();
        for (const change of [{ searchTerm: 'other' }, { searchTarget: 'metadata' as const }]) {
            await expect(listClaudeExternalSessionCandidates({ ...params, searchTerm: 'Body-only', cursor: page.nextCursor!, ...change })).rejects.toThrow(/cursor/i);
        }
    });
    it('passes cancellation to the packaged prefilter', async () => {
        const params = await corpus();
        const controller = new AbortController();
        params.ripgrep.run.mockImplementationOnce(async ({ signal }) => {
            expect(signal).toBe(controller.signal);
            controller.abort();
            signal?.throwIfAborted();
            return { exitCode: 1, stdout: '', stderr: '' };
        });
        await expect(listClaudeExternalSessionCandidates({ ...params, signal: controller.signal, searchTerm: 'Body-only' })).rejects.toThrow();
    });
    it('cancels the demanded and lookahead prefilters without starting later batches', async () => {
        const params = await corpus();
        const directory = join(params.source.configDir, 'projects', 'project');
        for (let index = 0; index < 3; index++) {
            await writeFile(join(directory, `parallel-${index}.jsonl`), '{"type":"user","uuid":"body","message":{"role":"user","content":"ordinary"}}\n');
        }
        const controller = new AbortController();
        let started = 0;
        let cancelled = 0;
        params.ripgrep.run.mockImplementation(async ({ signal }) => {
            expect(signal).toBe(controller.signal);
            if (started++ === 0) return { exitCode: 1, stdout: '', stderr: '' };
            await new Promise<void>((_resolve, reject) => {
                signal?.addEventListener('abort', () => { cancelled++; reject(signal.reason); }, { once: true });
            });
            throw new Error('An aborted native operation must reject');
        });
        const pending = listClaudeExternalSessionCandidates({ ...params, limit: 1, signal: controller.signal, searchTerm: 'needle' });
        const outcome = pending.then(value => ({ value }), error => ({ error }));
        try { await vi.waitFor(() => expect(started).toBe(3)); }
        finally { controller.abort(new Error('cancelled parallel scan')); }
        expect(await outcome).toMatchObject({ error: { message: 'cancelled parallel scan' } });
        expect(started).toBe(3);
        expect(cancelled).toBe(2);
    });
});
