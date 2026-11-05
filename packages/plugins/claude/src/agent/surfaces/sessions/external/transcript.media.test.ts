import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClaudeExternalSessionsContribution } from './contribution.js';
import { pageClaudeExternalSessionTranscript } from './transcript.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('Claude ordered transcript media eligibility', () => {
    it('carries only an exact image-bearing fact reference in terminal pages and keeps browsing read-only', async () => {
        const root = await mkdtemp(join(tmpdir(), 'claude-transcript-media-'));
        roots.push(root);
        const projectId = 'project';
        const remoteSessionId = 'native-1';
        const projectDir = join(root, 'projects', projectId);
        await mkdir(projectDir, { recursive: true });
        // Raw inline content exceeds the display envelope; the existing scanner admits one oversize row.
        const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'.repeat(4096);
        await writeFile(join(projectDir, `${remoteSessionId}.jsonl`), JSON.stringify({
            type: 'user', uuid: 'image-1', parentUuid: null, timestamp: '2026-06-08T00:00:00Z',
            message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: [
                { type: 'text', text: 'comparison' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
            ] }] },
        }) + '\n');
        const request = { source: { kind: 'claudeConfig' as const, configDir: root, projectId }, env: {},
            providerSessionId: remoteSessionId, direction: 'older' as const, maxBytes: 65_536, maxItems: 10 };
        const page = await pageClaudeExternalSessionTranscript({ ...request, projection: 'terminal', includeMediaReferences: true });
        expect(page.items).toContainEqual(expect.objectContaining({
            toolResultMedia: { sourceMessageId: 'claude-jsonl:main:user:image-1', toolCallId: 'read-1' },
        }));
        expect(JSON.stringify(page)).not.toContain(data);
        const browse = await pageClaudeExternalSessionTranscript(request);
        expect(browse.items.some(item => 'toolResultMedia' in item)).toBe(false);
        expect(JSON.stringify(browse)).not.toContain(data);
        const contribution = createClaudeExternalSessionsContribution({ env: {} });
        expect(contribution.materializeTranscriptMedia).toBeTypeOf('function');
        const publishToolResultMedia = vi.fn(async () => {});
        // Process and endpoint capabilities are genuine boundaries; this file-only operation must never use them.
        const unavailable = async (): Promise<never> => { throw new Error('unexpected tool execution'); };
        const materialization = {
            exec: { run: unavailable, spawn: unavailable, clients: { spawn: unavailable, connectJsonRpc: unavailable },
                agentCli: { checkReadiness: unavailable }, systemTools: { resolve: unavailable } },
            managedEndpointRead: unavailable, ripgrep: { run: unavailable },
            source: request.source, remoteSessionId, itemId: page.items[0]!.id,
            sourceMessageId: 'claude-jsonl:main:user:image-1', toolCallId: 'read-1',
            cursor: page.tailCursor!, media: { publishToolResultMedia },
            signal: new AbortController().signal, deadlineAtMs: Date.now() + 60_000,
            maxSerializedBytes: request.maxBytes,
        };
        publishToolResultMedia.mockRejectedValueOnce(new Error('media_persistence_failed'));
        const failed = await contribution.materializeTranscriptMedia!(materialization);
        expect(failed.ok).toBe(false);
        expect(await readFile(join(projectDir, `${remoteSessionId}.jsonl`), 'utf8')).toContain(data);
        publishToolResultMedia.mockClear();
        // Retry the same accepted source fact after storage recovers; no inline fallback is needed.
        const materialized = await contribution.materializeTranscriptMedia!(materialization);
        expect(materialized).toEqual({ ok: true, value: { status: 'published' } });
        expect(publishToolResultMedia.mock.calls).toEqual([[expect.objectContaining({
            localId: 'claude-jsonl:main:user:image-1:media:read-1', toolCallId: 'read-1',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }],
        }), expect.anything()]]);
        publishToolResultMedia.mockClear();
        const wrongFact = await contribution.materializeTranscriptMedia!({ ...materialization, sourceMessageId: 'other-fact' });
        expect(wrongFact.ok).toBe(false);
        expect(publishToolResultMedia).not.toHaveBeenCalled();
        await writeFile(join(projectDir, `${remoteSessionId}.jsonl`), '{}\n');
        const replaced = await contribution.materializeTranscriptMedia!(materialization);
        expect(replaced.ok).toBe(false);
        expect(publishToolResultMedia).not.toHaveBeenCalled();

    });
    it('offers no media from unselected historical branches or excluded child rows', async () => {
        const root = await mkdtemp(join(tmpdir(), 'claude-transcript-media-branch-'));
        roots.push(root);
        const directory = join(root, 'projects', 'project');
        await mkdir(directory, { recursive: true });
        const imageRow = (uuid: string) => ({ type: 'user', uuid, parentUuid: null,
            message: { content: [{ type: 'tool_result', tool_use_id: `read-${uuid}`, content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'encoded-image' } },
            ] }] } });
        await writeFile(join(directory, 'native-1.jsonl'), [
            imageRow('selected'), imageRow('other-branch'),
            { ...imageRow('child'), isSidechain: true, sidechainId: 'child-1' },
            { type: 'assistant', uuid: 'tip', parentUuid: 'selected', message: { content: [{ type: 'text', text: 'done' }] } },
        ].map(row => JSON.stringify(row)).join('\n') + '\n');
        const request = { source: { kind: 'claudeConfig' as const, configDir: root, projectId: 'project' }, env: {},
            providerSessionId: 'native-1', direction: 'older' as const, projection: 'terminal' as const,
            includeMediaReferences: true, maxBytes: 65_536, maxItems: 10 };
        const page = await pageClaudeExternalSessionTranscript(request);
        expect(page.items.flatMap(item => 'toolResultMedia' in item && item.toolResultMedia ? [item.toolResultMedia] : []))
            .toEqual([{ sourceMessageId: 'claude-jsonl:main:user:selected', toolCallId: 'read-selected' }]);
        await expect(pageClaudeExternalSessionTranscript({ ...request, resultBudget: { fits: () => false } }))
            .rejects.toMatchObject({ name: 'ClaudeTranscriptResultBudgetTooSmallError' });
    });

});
