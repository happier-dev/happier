import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SOURCES_ROOT = join(__dirname, '..', '..', '..');

async function listSourceFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        if (entry.name === 'node_modules') continue;
        if (entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...await listSourceFiles(full));
            continue;
        }
        if (!entry.isFile()) continue;
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) continue;
        if (/\.testHelpers\.(ts|tsx)$/.test(entry.name)) continue;
        files.push(full);
    }
    return files;
}

describe('capabilities guardrails', () => {
    it('only fetches /v1/features via serverFeaturesClient', async () => {
        const allowed = new Set<string>([
            join(SOURCES_ROOT, 'sync', 'api', 'capabilities', 'serverFeaturesClient.ts'),
        ]);

        const files = await listSourceFiles(SOURCES_ROOT);
        const offenders: string[] = [];
        for (const file of files) {
            const content = await readFile(file, 'utf8');
            if (content.includes('/v1/features') && !allowed.has(file)) {
                offenders.push(file);
            }
        }

        expect(offenders).toEqual([]);
    });
});
