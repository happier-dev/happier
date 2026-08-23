import { appendFile, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const inodeProbe = vi.hoisted(() => ({ reportZeroInode: false }));

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
        return new Proxy(handle, {
            get(target, property, receiver) {
                if (property === 'stat') {
                    return async (...statArgs: unknown[]) => patchStats(
                        await (target.stat as (...a: unknown[]) => Promise<object>).call(target, ...statArgs),
                    );
                }
                const value = Reflect.get(target, property, receiver) as unknown;
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
    }) as typeof actual.open;
    return { ...actual, default: { ...actual.default, stat, open }, stat, open };
});

const {
    pageClaudeExternalSessionTranscript,
    readAfterClaudeExternalSessionTranscript,
} = await import('./transcript.js');

const roots: string[] = [];

afterEach(async () => {
    inodeProbe.reportZeroInode = false;
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
