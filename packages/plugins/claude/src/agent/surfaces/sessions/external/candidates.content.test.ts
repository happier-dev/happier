import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

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
            const result = await promisify(execFile)(process.execPath, [launcher, JSON.stringify([...args, '--', ...paths])]);
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
    it('finds an unescaped Unicode query whose decoded lowercase differs from ripgrep folding', async () => {
        const params = await corpus();
        await writeFile(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), JSON.stringify({
            type: 'user', uuid: 'unicode', parentUuid: null, message: { role: 'user', content: 'İstanbul' },
        }) + '\n');
        const page = await listClaudeExternalSessionCandidates({ ...params, searchTerm: 'İstanbul' });
        expect(page.candidates[0]?.match).toMatchObject({ snippet: 'İstanbul', messageIndex: 0 });
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
        await writeFile(join(params.source.configDir, 'projects', 'project', 'second.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'Body-only' } }) + '\n');
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
});
