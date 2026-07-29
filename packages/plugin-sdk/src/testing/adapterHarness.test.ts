import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { RuntimeEventV1 } from '@happier-dev/protocol/runtime';

import { createAdapterHarness } from './adapterHarness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

function collectTypeScriptFiles(root: string): readonly string[] {
    if (!existsSync(root)) return [];
    const files: string[] = [];
    const visit = (path: string): void => {
        const stat = statSync(path);
        if (stat.isDirectory()) {
            if (path.endsWith('/node_modules') || path.endsWith('/dist')) return;
            for (const entry of readdirSync(path)) visit(join(path, entry));
            return;
        }
        if (path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.spec.ts')) {
            files.push(path);
        }
    };
    visit(root);
    return files;
}

describe('adapter harness', () => {
    it('records only schema-valid canonical runtime events', async () => {
        const harness = createAdapterHarness();
        const turnStart = {
            kind: 'turn-start',
            sessionId: 'session-1',
            turnId: 'turn-1',
            emittedAtMs: 1,
        } satisfies RuntimeEventV1;

        harness.recordRuntimeEvent(turnStart);

        expect(harness.canonical()).toEqual([turnStart]);
        expect(() => harness.expectAllEventsValidated()).not.toThrow();
    });

    it('rejects canonical runtime events that do not parse under RuntimeEventV1Schema', () => {
        const harness = createAdapterHarness();

        harness.recordRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
        });

        expect(() => harness.expectAllEventsValidated()).toThrow(/RuntimeEventV1Schema/);
        expect(harness.validationFailures()).toHaveLength(1);
    });

    it('waits for event kind without fixed sleeps and enforces one terminal event', async () => {
        const harness = createAdapterHarness();
        const untilComplete = harness.until('turn-complete');

        harness.recordRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            turnId: 'turn-1',
            emittedAtMs: 1,
        } satisfies RuntimeEventV1);
        harness.recordRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            turnId: 'turn-1',
            emittedAtMs: 2,
            usage: null,
        } satisfies RuntimeEventV1);

        await expect(untilComplete).resolves.toMatchObject({ kind: 'turn-complete' });
        expect(() => harness.expectExactlyOneTerminalEvent()).not.toThrow();
    });

    it('rejects duplicate terminal events for the same turn', () => {
        const harness = createAdapterHarness();

        harness.recordRuntimeEvent({
            kind: 'turn-complete',
            sessionId: 'session-1',
            turnId: 'turn-1',
            emittedAtMs: 2,
            usage: null,
        } satisfies RuntimeEventV1);
        harness.recordRuntimeEvent({
            kind: 'turn-cancelled',
            sessionId: 'session-1',
            turnId: 'turn-1',
            emittedAtMs: 3,
            reason: 'user',
        } satisfies RuntimeEventV1);

        expect(() => harness.expectExactlyOneTerminalEvent({ turnId: 'turn-1' })).toThrow(/received 2/);
    });

    it('fences production plugin sources from RuntimeEventV1 casts', () => {
        const pluginSourceRoot = join(repoRoot, 'plugins');
        const offenders = collectTypeScriptFiles(pluginSourceRoot)
            .filter((path) => readFileSync(path, 'utf8').includes('as RuntimeEventV1'))
            .map((path) => relative(repoRoot, path));

        expect(offenders).toEqual([]);
    });
});
