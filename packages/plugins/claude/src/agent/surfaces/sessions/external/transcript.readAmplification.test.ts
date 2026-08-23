import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fsProbe = vi.hoisted(() => ({ bytesRead: 0 }));

// The filesystem is the genuine system boundary here, and it is the thing under
// measurement: every byte the leaf reads while draining a transcript is counted
// through the real `node:fs/promises` implementation, which stays underneath.
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    const open: typeof actual.open = async (...args) => {
        const handle = await actual.open(...(args as Parameters<typeof actual.open>));
        const read = handle.read.bind(handle) as (...readArgs: unknown[]) => Promise<{ bytesRead: number }>;
        return new Proxy(handle, {
            get(target, property, receiver) {
                if (property === 'read') {
                    return async (...readArgs: unknown[]) => {
                        const result = await read(...readArgs);
                        fsProbe.bytesRead += result.bytesRead;
                        return result;
                    };
                }
                const value = Reflect.get(target, property, receiver) as unknown;
                return typeof value === 'function' ? value.bind(target) : value;
            },
        });
    };
    return { ...actual, default: { ...actual.default, open }, open };
});

const { pageClaudeExternalSessionTranscript } = await import('./transcript.js');

const PAGE_MAX_BYTES = 64 * 1024;
const PAGE_MAX_ITEMS = 10;

const roots: string[] = [];

afterEach(async () => {
    while (roots.length > 0) {
        const root = roots.pop();
        if (root) await rm(root, { recursive: true, force: true });
    }
    fsProbe.bytesRead = 0;
});

async function drainTranscript(lineCount: number): Promise<Readonly<{
    fileSizeBytes: number;
    bytesRead: number;
    pages: number;
    drained: readonly string[];
}>> {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-transcript-amplification-'));
    roots.push(root);
    const configDir = join(root, '.claude');
    const projectId = 'amplification-project';
    const remoteSessionId = 'amplification-session';
    const projectDir = join(configDir, 'projects', projectId);
    await mkdir(projectDir, { recursive: true });
    const lines: string[] = [];
    for (let index = 0; index < lineCount; index += 1) {
        lines.push(JSON.stringify({
            type: 'assistant',
            uuid: `amplification-${String(index).padStart(4, '0')}`,
            timestamp: `2026-06-08T00:00:00.${String(index % 1000).padStart(3, '0')}Z`,
            message: { content: [{ type: 'text', text: `answer ${index} ${'x'.repeat(1024)}` }] },
        }));
    }
    const contents = `${lines.join('\n')}\n`;
    await writeFile(join(projectDir, `${remoteSessionId}.jsonl`), contents, 'utf8');

    const source = { kind: 'claudeConfig' as const, configDir, projectId };
    const env = { HAPPIER_CLAUDE_CONFIG_DIR: configDir } as NodeJS.ProcessEnv;

    fsProbe.bytesRead = 0;
    const drained: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (; pages < 4 * lineCount; pages += 1) {
        const page = await pageClaudeExternalSessionTranscript({
            source,
            env,
            providerSessionId: remoteSessionId,
            direction: 'older',
            ...(cursor ? { cursor } : {}),
            maxBytes: PAGE_MAX_BYTES,
            maxItems: PAGE_MAX_ITEMS,
        });
        expect(page.truncated ?? false).toBe(false);
        drained.push(...page.items.map((item) => String(item.id)));
        if (!page.hasMore || !page.nextCursor) break;
        cursor = page.nextCursor;
    }
    return {
        fileSizeBytes: Buffer.byteLength(contents, 'utf8'),
        bytesRead: fsProbe.bytesRead,
        pages: pages + 1,
        drained,
    };
}

describe('Claude external transcript paging read amplification', () => {
    it('drains a large transcript in bytes proportional to the corpus, not to its square', async () => {
        const small = await drainTranscript(100);
        const large = await drainTranscript(400);

        // Both drains really happened: every row, exactly once.
        expect(small.drained).toHaveLength(100);
        expect(large.drained).toHaveLength(400);
        expect(new Set(large.drained).size).toBe(400);

        // Four times the corpus, paged the same way, is four times the work plus
        // a per-page constant — never sixteen. Re-hashing the whole acknowledged
        // prefix on every cursor mint AND every cursor validation is what turns
        // this ratio quadratic, and it gets worse the larger the transcript is.
        expect(large.fileSizeBytes).toBeGreaterThan(3.5 * small.fileSizeBytes);
        expect(large.bytesRead / small.bytesRead).toBeLessThan(6);

        // And the absolute cost stays inside one page-scan window plus a bounded
        // continuity-evidence overhead per page.
        const perPageBudgetBytes = PAGE_MAX_BYTES + 64 * 1024;
        expect(large.bytesRead).toBeLessThanOrEqual(large.pages * perPageBudgetBytes);
    }, 180_000);
});
