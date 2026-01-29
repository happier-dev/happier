import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type ToolTraceFixturesV1 = {
    v: 1;
    generatedAt: number;
    examples: Record<string, unknown>;
};

function readAllowlistKeys(filePath: string): string[] {
    const text = readFileSync(filePath, 'utf8');
    return text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'))
        .sort();
}

function loadFixtureKeys(fixturePath: string): string[] {
    const raw = readFileSync(fixturePath, 'utf8');
    const parsed = JSON.parse(raw) as ToolTraceFixturesV1;
    expect(parsed.v).toBe(1);
    return Object.keys(parsed.examples ?? {}).sort();
}

describe('tool trace fixture allowlist', () => {
    it('stays in sync with the committed fixture keys', () => {
        // Keep the allowlist and committed fixture consistent so `yarn tool:trace:fixtures:v1 --write`
        // is a deterministic update that doesn't accidentally expand/shrink coverage.
        const here = path.dirname(fileURLToPath(import.meta.url));
        const cliRoot = path.join(here, '..', '..', '..', '..');
        const allowlistPath = path.join(cliRoot, 'scripts', 'tool-trace-fixtures.v1.allowlist.txt');
        const fixturePath = path.join(cliRoot, 'src', 'agent', 'tools', 'normalization', '__fixtures__', 'tool-trace-fixtures.v1.json');

        const allowlistKeys = readAllowlistKeys(allowlistPath);
        const fixtureKeys = loadFixtureKeys(fixturePath);

        expect(allowlistKeys).toEqual(fixtureKeys);
    });
});
