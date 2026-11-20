import { appendFile, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const inodeProbe = vi.hoisted(() => ({ reportZeroInode: false, duringAnchorRead: null as (() => Promise<void>) | null, bytesRead: 0 }));

// The filesystem is the genuine system boundary, and the inode is the part of it
// this suite has to vary: a Windows share or network mount reports zero, and the
// leaf must still mint and honor a cursor there. Everything below the stat —
// reads, offsets, anchors, cursor arithmetic — stays the real implementation.
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    const patchStats = <T extends object>(stats: T): T => {
        if (!inodeProbe.reportZeroInode) return stats;
        return new Proxy(stats, {
            get(target, property, receiver) {
                if (property === 'ino') return 0n;
                const value = Reflect.get(target, property, receiver) as unknown;
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
    };
    const stat = (async (...args: unknown[]) => patchStats(
        await (actual.stat as (...a: unknown[]) => Promise<object>)(...args),
    )) as typeof actual.stat;
    const open = (async (...args: unknown[]) => {
        const handle = await (actual.open as (...a: unknown[]) => Promise<Record<string, unknown>>)(...args);
        let anchorStarted = false;
        return new Proxy(handle, {
            get(target, property, receiver) {
                if (property === 'stat') {
                    return async (...statArgs: unknown[]) => {
                        const stats = await (target.stat as (...a: unknown[]) => Promise<object>).call(target, ...statArgs);
                        anchorStarted = true;
                        return patchStats(stats);
                    };
                }
                if (property === 'read') {
                    return async (...readArgs: unknown[]) => {
                        if (anchorStarted && inodeProbe.duringAnchorRead) {
                            const append = inodeProbe.duringAnchorRead;
                            inodeProbe.duringAnchorRead = null;
                            await append();
                        }
                        const result = await (target.read as (...a: unknown[]) => Promise<{ bytesRead: number }>).call(target, ...readArgs);
                        inodeProbe.bytesRead += result.bytesRead;
                        return result;
                    };
                }
                const value = Reflect.get(target, property, receiver) as unknown;
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
    }) as typeof actual.open;
    return { ...actual, default: { ...actual.default, stat, open }, stat, open };
});

const {
    claudeAsyncAgentLaunchAck, claudeHandbackPointerNotification, claudeHandbackUserRow,
} = await import('../../../transcripts/peerMessage.testkit.js');
const {
    pageClaudeExternalSessionTranscript,
    readAfterClaudeExternalSessionTranscript,
} = await import('./transcript.js');

const roots: string[] = [];

afterEach(async () => {
    inodeProbe.reportZeroInode = false;
    inodeProbe.duringAnchorRead = null;
    inodeProbe.bytesRead = 0;
    while (roots.length > 0) {
        const root = roots.pop();
        if (root) await rm(root, { recursive: true, force: true });
    }
});

function transcriptLine(index: number, padding: number): string {
    return `${JSON.stringify({
        type: 'assistant',
        uuid: `continuity-${String(index).padStart(4, '0')}`,
        timestamp: `2026-06-08T00:00:00.${String(index % 1000).padStart(3, '0')}Z`,
        message: { content: [{ type: 'text', text: `answer ${'x'.repeat(padding)}` }] },
    })}\n`;
}

async function createTranscript(lineCount: number, padding: number): Promise<Readonly<{
    source: { kind: 'claudeConfig'; configDir: string; projectId: string };
    env: NodeJS.ProcessEnv;
    remoteSessionId: string;
    transcriptPath: string;
}>> {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-transcript-continuity-'));
    roots.push(root);
    const configDir = join(root, '.claude');
    const projectId = 'continuity-project';
    const remoteSessionId = 'continuity-session';
    const projectDir = join(configDir, 'projects', projectId);
    await mkdir(projectDir, { recursive: true });
    const transcriptPath = join(projectDir, `${remoteSessionId}.jsonl`);
    let contents = '';
    for (let index = 0; index < lineCount; index += 1) contents += transcriptLine(index, padding);
    await writeFile(transcriptPath, contents, 'utf8');
    return {
        source: { kind: 'claudeConfig', configDir, projectId },
        env: { HAPPIER_CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv,
        remoteSessionId,
        transcriptPath,
    };
}

async function mintTailCursor(fixture: Awaited<ReturnType<typeof createTranscript>>): Promise<string> {
    const tail = await readAfterClaudeExternalSessionTranscript({
        source: fixture.source,
        env: fixture.env,
        providerSessionId: fixture.remoteSessionId,
        cursor: 'tail',
        maxBytes: 64 * 1024,
        maxItems: 10,
    });
    expect(tail.readAfterOutcome).toBe('already_current');
    const cursor = tail.nextCursor;
    // A leaf that cannot mint a cursor cannot page at all; an absent cursor here
    // is the failure, not a reason to skip the rest of the case.
    expect(typeof cursor).toBe('string');
    return String(cursor);
}

async function readAfter(
    fixture: Awaited<ReturnType<typeof createTranscript>>,
    cursor: string,
) {
    return await readAfterClaudeExternalSessionTranscript({
        source: fixture.source,
        env: fixture.env,
        providerSessionId: fixture.remoteSessionId,
        cursor,
        maxBytes: 64 * 1024,
        maxItems: 10,
    });
}

/** Overwrites bytes in place, keeping the inode and the total length. */
async function rewriteInPlace(path: string, position: number, replacement: string): Promise<void> {
    const handle = await open(path, 'r+');
    try {
        await handle.write(Buffer.from(replacement, 'utf8'), 0, Buffer.byteLength(replacement, 'utf8'), position);
    } finally {
        await handle.close();
    }
}

describe('Claude external transcript continuity evidence', () => {
    it('keeps current-tail and small append work bounded independently of native history size', async () => {
        const fixture = await createTranscript(16_000, 1024);
        const cursor = await mintTailCursor(fixture);
        inodeProbe.bytesRead = 0;
        const current = await readAfter(fixture, cursor);
        expect(current).toMatchObject({ items: [], truncated: false, hasMore: false });
        expect(inodeProbe.bytesRead).toBeLessThanOrEqual(64 * 1024);

        await appendFile(fixture.transcriptPath, [
            { type: 'assistant', uuid: 'discarded', parentUuid: 'continuity-15999', message: { content: [{ type: 'text', text: 'discarded branch' }] } },
            { type: 'assistant', uuid: 'active', parentUuid: 'continuity-15999', message: { content: [{ type: 'text', text: 'active branch' }] } },
            { type: 'future-native-message' },
        ].map(row => JSON.stringify(row) + '\n').join(''));
        inodeProbe.bytesRead = 0;
        const discarded = await readAfterClaudeExternalSessionTranscript({ source: fixture.source, env: fixture.env,
            providerSessionId: fixture.remoteSessionId, cursor, maxBytes: 64 * 1024, maxItems: 1 });
        expect(discarded).toMatchObject({ items: [], truncated: false, hasMore: true });
        expect(discarded.diagnostics).toContainEqual(expect.objectContaining({ code: 'non_transcript_record_skipped', count: 1 }));
        expect(inodeProbe.bytesRead).toBeLessThanOrEqual(3 * 64 * 1024);
        inodeProbe.bytesRead = 0;
        const advanced = await readAfter(fixture, String(discarded.nextCursor));
        expect(advanced).toMatchObject({ truncated: false, hasMore: false });
        expect(advanced.items).toHaveLength(2);
        expect(JSON.stringify(advanced.items)).toContain('active branch');
        expect(JSON.stringify(advanced.items)).not.toContain('discarded branch');
        expect(advanced.diagnostics).toContainEqual(expect.objectContaining({ code: 'unsupported_record_skipped', count: 1 }));
        // One forward page, one backward branch page, and bounded cursor anchors.
        expect(inodeProbe.bytesRead).toBeLessThanOrEqual(3 * 64 * 1024);
    });

    it('anchors the acknowledged prefix while a native writer appends during evidence capture', async () => {
        const fixture = await createTranscript(2, 40);
        inodeProbe.duringAnchorRead = () => appendFile(fixture.transcriptPath, transcriptLine(1000, 40));
        const cursor = await mintTailCursor(fixture);
        const next = await readAfter(fixture, cursor);
        expect(next.readAfterOutcome).toBeUndefined();
        expect(JSON.stringify(next.items)).toContain('answer');
        expect(next.truncated).toBe(false);
    });
    it.each(['stdout', 'stderr'] as const)('publishes live shell %s before its ordered observation while ordinary prompts stay observation-only', async (stream) => {
        const fixture = await createTranscript(1, 0);
        const cursor = await mintTailCursor(fixture);
        const outputText = `SYNTHETIC_COMMAND_RESULT\n  literal </bash-${stream}> tail &lt;value&gt;\n`;
        const output = {
            type: 'user', uuid: `shell-${stream}`, parentUuid: 'continuity-0000', sessionId: fixture.remoteSessionId,
            timestamp: '2026-10-17T00:00:01.000Z',
            message: { role: 'user', content: `<bash-${stream}>${outputText}</bash-${stream}>` },
        };
        const prompt = {
            type: 'user', uuid: 'ordinary-next-prompt', parentUuid: output.uuid, sessionId: fixture.remoteSessionId,
            timestamp: '2026-10-17T00:00:02.000Z', message: { role: 'user', content: 'next ordinary prompt' },
        };
        await appendFile(fixture.transcriptPath, `${JSON.stringify(output)}\n${JSON.stringify(prompt)}\n`);
        const params = { source: fixture.source, env: fixture.env, providerSessionId: fixture.remoteSessionId,
            projection: 'terminal' as const, maxBytes: 64 * 1024, maxItems: 10 };
        const live = await readAfterClaudeExternalSessionTranscript({ ...params, cursor });
        expect(live.items).toMatchObject([
            { raw: { role: 'agent', content: { type: 'acp', agentId: 'claude', data: {
                type: 'message', message: outputText,
            } } } },
            { raw: { role: 'source_observation', content: { uuid: output.uuid } } },
            { raw: { role: 'source_observation', content: { uuid: prompt.uuid } } },
        ]);
        const historical = await pageClaudeExternalSessionTranscript({ ...params, direction: 'older' });
        expect(historical.items.filter(item => item.raw.role === 'agent'
            && JSON.stringify(item.raw).includes('SYNTHETIC_COMMAND_RESULT'))).toHaveLength(1);
    });

    it('publishes a delivered peer attachment through the live terminal stream as visible recipient text', async () => {
        const fixture = await createTranscript(1, 0);
        const cursor = await mintTailCursor(fixture);
        await appendFile(fixture.transcriptPath, `${JSON.stringify({ type: 'attachment', uuid: 'live-peer',
            attachment: { type: 'queued_command', prompt: '<cross-session-message from="uds:/tmp/sender.sock" from-name="Sender">Delivered</cross-session-message>' },
        })}\n`);
        const page = await readAfterClaudeExternalSessionTranscript({ source: fixture.source, env: fixture.env,
            providerSessionId: fixture.remoteSessionId, cursor, projection: 'terminal', maxBytes: 64 * 1024, maxItems: 10 });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({ raw: { role: 'agent', content: { type: 'acp', agentId: 'claude',
            data: { type: 'message', message: 'Delivered', peer: { name: 'Sender', handback: false } } } } });
        expect(JSON.stringify(page.items)).not.toContain('uds:/tmp');
    });

    it('leaves restored hand-backs and task notifications to the runtime task projector', async () => {
        const fixture = await createTranscript(1, 0);
        const launch = { type: 'assistant', uuid: 'launch', parentUuid: 'continuity-0000', timestamp: '2026-10-25T00:00:00.000Z',
            message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_handback', name: 'Agent',
                input: { subagent_type: 'general-purpose', prompt: 'review', run_in_background: true } }] } };
        const rows = [launch,
            { ...claudeAsyncAgentLaunchAck({ toolUseId: 'toolu_handback' }), parentUuid: 'launch', timestamp: '2026-10-25T00:00:01.000Z' },
            { ...claudeHandbackUserRow({ withReportText: true }), parentUuid: 'ack', timestamp: '2026-10-25T00:00:02.000Z' },
            { ...claudeHandbackPointerNotification({ toolUseId: 'toolu_handback' }), parentUuid: 'handback', timestamp: '2026-10-25T00:00:03.000Z' }];
        await appendFile(fixture.transcriptPath, rows.map(row => `${JSON.stringify(row)}\n`).join(''));
        const restored = await pageClaudeExternalSessionTranscript({ source: fixture.source, env: fixture.env,
            providerSessionId: fixture.remoteSessionId, projection: 'terminal', direction: 'older', maxBytes: 64 * 1024, maxItems: 20 });
        // The runtime's ordered task projector settles these rows from their observations, as it does live.
        const displayed = restored.items.filter(item => item.raw.role === 'agent').map(item => JSON.stringify(item.raw));
        expect(displayed.filter(raw => raw.includes('"peer"'))).toEqual([]);
        expect(displayed.join('\n')).not.toContain('report was delivered to you');
        expect(restored.items.filter(item => item.raw.role === 'source_observation').map(item => item.raw.content))
            .toEqual(expect.arrayContaining([expect.objectContaining({ uuid: 'handback' }), expect.objectContaining({ uuid: 'pointer-notification' })]));
    });

    it.each(['page', 'pageNewer', 'tail', 'readAfter', 'sourceReset'] as const)('preserves an incomplete tail through %s cursor capture', async (capture) => {
        const fixture = await createTranscript(2, 40);
        const earlierCursor = await mintTailCursor(fixture);
        if (capture === 'sourceReset') await writeFile(fixture.transcriptPath, transcriptLine(300, 40));
        const line = transcriptLine(1000, 40);
        await appendFile(fixture.transcriptPath, line.slice(0, -2));
        const cursor = capture === 'page' || capture === 'pageNewer'
            ? (await pageClaudeExternalSessionTranscript({
                source: fixture.source, env: fixture.env, providerSessionId: fixture.remoteSessionId,
                direction: capture === 'page' ? 'older' : 'newer', maxBytes: 64 * 1024, maxItems: 10,
            })).tailCursor
            : capture === 'tail'
                ? await mintTailCursor(fixture)
                : (await readAfter(fixture, earlierCursor)).nextCursor;
        expect(cursor).toEqual(expect.any(String));
        await appendFile(fixture.transcriptPath, line.slice(-2));
        const advanced = await readAfter(fixture, String(cursor));
        expect(advanced.readAfterOutcome).toBeUndefined();
        expect(advanced.items).toHaveLength(1);
        expect(advanced.truncated).toBe(false);
        expect(advanced.hasMore).toBe(false);
    });

    it('refuses a tail whose boundary exceeds the existing reader budget', async () => {
        const fixture = await createTranscript(1, 40);
        await appendFile(fixture.transcriptPath, '{"text":"' + 'x'.repeat(8 * 1024 * 1024));
        const request = {
            source: fixture.source, env: fixture.env, providerSessionId: fixture.remoteSessionId,
            maxBytes: 1024, maxItems: 10,
        };
        await expect(pageClaudeExternalSessionTranscript({ ...request, direction: 'older' })).rejects.toThrow();
    });

    it('keeps valid oversize tail records when the boundary read uses smaller chunks', async () => {
        const fixture = await createTranscript(1, 128 * 1024);
        const cursor = await mintTailCursor(fixture);
        await appendFile(fixture.transcriptPath, transcriptLine(1000, 40));
        const advanced = await readAfter(fixture, cursor);
        expect(advanced.items).toHaveLength(1);
        expect(advanced).toMatchObject({ truncated: false, hasMore: false });
        expect(advanced.readAfterOutcome).toBeUndefined();
    });

    it.each([false, true])('reports a typed refusal for an oversized valid UTF-8 row with newer row=%s', async (withNewerRow) => {
        const fixture = await createTranscript(0, 0);
        await writeFile(fixture.transcriptPath, JSON.stringify({ type: 'assistant', uuid: 'oversized',
            message: { content: [{ type: 'text', text: 'answer' }] }, pad: '🙂'.repeat(2_100_000) }) + '\n');
        if (withNewerRow) await appendFile(fixture.transcriptPath, transcriptLine(1, 40));
        const request = { source: fixture.source, env: fixture.env, providerSessionId: fixture.remoteSessionId,
            direction: 'older' as const, projection: 'terminal' as const, maxBytes: 64 * 1024, maxItems: 10 };
        if (withNewerRow) {
            const initial = await pageClaudeExternalSessionTranscript(request);
            expect(initial.items.length).toBeGreaterThan(0);
            expect(initial).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });
            await expect(pageClaudeExternalSessionTranscript({ ...request, cursor: initial.nextCursor! }))
                .rejects.toMatchObject({ code: 'JSONL_RECORD_TOO_LARGE' });
        } else {
            await expect(pageClaudeExternalSessionTranscript(request))
                .rejects.toMatchObject({ code: 'JSONL_RECORD_TOO_LARGE' });
        }
    });

    it.each([false, true])('reports bounded continuation with result budgeting %s', async (withBudget) => {
        const fixture = await createTranscript(1, 40);
        const cursor = await mintTailCursor(fixture);
        await appendFile(fixture.transcriptPath, transcriptLine(1000, 40) + transcriptLine(1001, 40));
        const page = await readAfterClaudeExternalSessionTranscript({
            source: fixture.source, env: fixture.env, providerSessionId: fixture.remoteSessionId,
            cursor, maxBytes: 64 * 1024, maxItems: 1,
            ...(withBudget ? { resultBudget: { fits: () => true } } : {}),
        });
        expect(page.items).toHaveLength(1);
        expect(page).toMatchObject({ truncated: false, hasMore: true });
        const remainder = await readAfter(fixture, String(page.nextCursor));
        expect(remainder.items).toHaveLength(1);
        expect(remainder.items[0]?.id).not.toBe(page.items[0]?.id);
        expect(remainder).toMatchObject({ truncated: false, hasMore: false });
    });

    it.each([false, true])('keeps unknown and malformed appended records visible with result budgeting %s', async withBudget => {
        const fixture = await createTranscript(1, 40);
        const cursor = await mintTailCursor(fixture);
        await appendFile(fixture.transcriptPath, transcriptLine(1000, 40)
            + JSON.stringify({ type: 'future-native-message', private: 'unreadable private payload' }) + '\n'
            + '{malformed complete record}\n' + transcriptLine(1001, 40));
        const page = await readAfterClaudeExternalSessionTranscript({ source: fixture.source, env: fixture.env,
            providerSessionId: fixture.remoteSessionId, cursor, maxBytes: 64 * 1024, maxItems: 10,
            ...(withBudget ? { resultBudget: { fits: () => true } } : {}) });
        expect(page.truncated).toBe(false);
        expect(page.items).toHaveLength(4);
        expect(page.diagnostics).toContainEqual(expect.objectContaining({
            code: 'unsupported_record_skipped', severity: 'benign', count: 2,
        }));
        expect(JSON.stringify(page.items)).not.toContain('unreadable private payload');
        expect(JSON.stringify(page.items)).not.toContain('malformed complete record');
        expect(page.items.slice(1, 3).every(item => JSON.stringify(item).includes('Agent emitted an unsupported content block.'))).toBe(true);
        const older = await pageClaudeExternalSessionTranscript({ source: fixture.source, env: fixture.env,
            providerSessionId: fixture.remoteSessionId, direction: 'older', maxBytes: 64 * 1024, maxItems: 10,
            ...(withBudget ? { resultBudget: { fits: () => true } } : {}) });
        expect(older.truncated).not.toBe(true);
        expect(older.items).toHaveLength(5);
    });

    it('continues across an append', async () => {
        const fixture = await createTranscript(40, 400);
        const cursor = await mintTailCursor(fixture);
        await appendFile(fixture.transcriptPath, transcriptLine(1000, 40), 'utf8');

        const advanced = await readAfter(fixture, cursor);
        expect(advanced.readAfterOutcome).toBeUndefined();
        expect(advanced.truncated).toBe(false);
        expect(advanced.items).toHaveLength(1);
    });

    it('refuses to continue across an in-place rewrite of the acknowledged prefix', async () => {
        // Same inode, same total length, same trailing append — only the
        // acknowledged bytes changed. Nothing but the content anchor can tell
        // this from an ordinary append.
        const fixture = await createTranscript(6, 200);
        const cursor = await mintTailCursor(fixture);
        await rewriteInPlace(fixture.transcriptPath, 0, 'Z'.repeat(40));
        await appendFile(fixture.transcriptPath, transcriptLine(1000, 40), 'utf8');

        const outcome = await readAfter(fixture, cursor);
        expect(outcome.readAfterOutcome).toBe('source_replaced');
        expect(outcome.items).toHaveLength(0);
    });

    it('refuses to continue when a large prefix is rewritten at its acknowledged boundary', async () => {
        // The anchor windows are bounded, so this pins the boundary case: the
        // last bytes before the cursor offset, which is exactly where a writer
        // that reflowed the prefix lands.
        const fixture = await createTranscript(120, 400);
        const cursor = await mintTailCursor(fixture);
        const { size } = await (await import('node:fs/promises')).stat(fixture.transcriptPath);
        await rewriteInPlace(fixture.transcriptPath, size - 60, 'Z'.repeat(40));
        await appendFile(fixture.transcriptPath, transcriptLine(1000, 40), 'utf8');

        const outcome = await readAfter(fixture, cursor);
        expect(outcome.readAfterOutcome).toBe('source_replaced');
    });

    it('refuses to continue across a same-path replacement', async () => {
        const fixture = await createTranscript(20, 200);
        const cursor = await mintTailCursor(fixture);
        await rm(fixture.transcriptPath);
        let replacement = '';
        for (let index = 0; index < 21; index += 1) replacement += transcriptLine(500 + index, 200);
        await writeFile(fixture.transcriptPath, replacement, 'utf8');

        const outcome = await readAfter(fixture, cursor);
        expect(outcome.readAfterOutcome).toBe('source_replaced');
    });

    it('still pages, and still refuses a replacement, on a filesystem that reports no inode', async () => {
        inodeProbe.reportZeroInode = true;
        const fixture = await createTranscript(40, 400);

        // Refusing to mint a cursor without an inode — the previous behavior —
        // made external transcript paging fail outright here rather than degrade.
        const page = await pageClaudeExternalSessionTranscript({
            source: fixture.source,
            env: fixture.env,
            providerSessionId: fixture.remoteSessionId,
            direction: 'older',
            maxBytes: 64 * 1024,
            maxItems: 10,
        });
        expect(page.truncated ?? false).toBe(false);
        expect(page.items.length).toBeGreaterThan(0);
        expect(page.tailCursor).toEqual(expect.any(String));

        const cursor = await mintTailCursor(fixture);
        await appendFile(fixture.transcriptPath, transcriptLine(1000, 40), 'utf8');
        const advanced = await readAfter(fixture, cursor);
        expect(advanced.readAfterOutcome).toBeUndefined();
        expect(advanced.items).toHaveLength(1);

        const replacementCursor = await mintTailCursor(fixture);
        await rm(fixture.transcriptPath);
        let replacement = '';
        for (let index = 0; index < 42; index += 1) replacement += transcriptLine(500 + index, 400);
        await writeFile(fixture.transcriptPath, replacement, 'utf8');
        const outcome = await readAfter(fixture, replacementCursor);
        expect(outcome.readAfterOutcome).toBe('source_replaced');
    });
});


it('preserves UUID-free credential_org through historical and appended ordered source observations', async () => {
  const fixture = await createTranscript(0, 0);
  const row = {type: 'attachment', attachment: {type: 'credential_org', organizationUuid: 'native-org'}, sessionId: fixture.remoteSessionId, timestamp: 1000};
  await writeFile(fixture.transcriptPath, JSON.stringify(row) + '\n');
  const input = {source: fixture.source, env: fixture.env, providerSessionId: fixture.remoteSessionId, projection: 'terminal' as const, maxItems: 10, maxBytes: 65536};
  const initial = await pageClaudeExternalSessionTranscript({...input, direction: 'older'});
  expect(initial.items).toMatchObject([{raw: {role: 'source_observation', content: row}}]);
  if (!initial.tailCursor) throw new Error('Missing terminal source tail cursor');
  const appended = {...row, timestamp: 2000};
  await appendFile(fixture.transcriptPath, JSON.stringify(appended) + '\n');
  const live = await readAfterClaudeExternalSessionTranscript({...input, cursor: initial.tailCursor});
  expect(live.items).toMatchObject([{raw: {role: 'source_observation', content: appended}}]);
  expect(initial.items[0]?.id).not.toEqual(live.items[0]?.id);
  if (!live.nextCursor) throw new Error('Missing advanced source cursor');
  expect((await readAfterClaudeExternalSessionTranscript({...input, cursor: live.nextCursor})).items).toEqual([]);
});
