import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import { projectCodexRolloutRecord } from './actions.js';

function walk(dir: string, out: string[], limit: number): void {
    if (out.length >= limit) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
        if (out.length >= limit) return;
        const full = join(dir, entry);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) walk(full, out, limit);
        else if (entry.endsWith('.jsonl')) out.push(full);
    }
}

describe('codex rollout grammar probe', () => {
    it('reports dispositions over real rollout files', () => {
        const files: string[] = [];
        walk(join(process.env.HOME ?? '', '.codex/sessions/2026/08'), files, 60);
        const counts = new Map<string, number>();
        for (const file of files) {
            for (const line of readFileSync(file, 'utf8').split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                let value: unknown;
                try { value = JSON.parse(trimmed); } catch { continue; }
                const record = value as { type?: string; payload?: { type?: string } };
                const key = `${record.type}/${record.payload?.type ?? '-'}`;
                const projected = projectCodexRolloutRecord(value, { debug: false });
                const tag = `${projected.disposition}:${projected.actions.length} ${key}`;
                counts.set(tag, (counts.get(tag) ?? 0) + 1);
            }
        }
        const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        console.log('PROBE_FILES', files.length);
        for (const [tag, count] of rows) console.log('PROBE', String(count).padStart(6), tag);
    });
});
