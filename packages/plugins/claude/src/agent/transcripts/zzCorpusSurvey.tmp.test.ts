import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import { projectClaudeJsonlLineRecord } from './projection.js';

async function listJsonl(root: string, out: string[], depth = 0): Promise<void> {
    if (depth > 3 || out.length > 400) return;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        const p = join(root, entry.name);
        if (entry.isDirectory()) await listJsonl(p, out, depth + 1);
        else if (entry.name.endsWith('.jsonl')) out.push(p);
        if (out.length > 400) return;
    }
}

describe('corpus survey', () => {
    it('classifies the local Claude corpus', async () => {
        const files: string[] = [];
        await listJsonl(join(homedir(), '.claude', 'projects'), files);
        const byDisposition = new Map<string, Map<string, number>>();
        let lines = 0;
        for (const file of files.slice(0, 300)) {
            const text = await readFile(file, 'utf8').catch(() => '');
            for (const line of text.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                lines += 1;
                let value: unknown;
                try { value = JSON.parse(trimmed); } catch { value = trimmed; }
                const projected = projectClaudeJsonlLineRecord({
                    fileRelPath: 'x.jsonl',
                    lineStartOffsetBytes: 0,
                    lineValue: value,
                });
                const type = (value && typeof value === 'object' && !Array.isArray(value)
                    ? String((value as Record<string, unknown>).type ?? '<no-type>')
                    : '<non-object>');
                const bucket = byDisposition.get(projected.disposition) ?? new Map<string, number>();
                bucket.set(type, (bucket.get(type) ?? 0) + 1);
                byDisposition.set(projected.disposition, bucket);
            }
        }
        const summary: Record<string, Record<string, number>> = {};
        for (const [disposition, bucket] of byDisposition) {
            summary[disposition] = Object.fromEntries([...bucket].sort((a, b) => b[1] - a[1]));
        }
        console.log('CORPUS_SURVEY', JSON.stringify({ files: files.length, lines, summary }, null, 2));
    }, 300_000);
});
