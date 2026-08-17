import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { AgentSessionRuntimeEvent } from '../agents/runtime/index.js';

import { createAgentSessionRuntimeHarness } from './runtimeEvents.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

function collectTypeScriptFiles(root: string): readonly string[] {
    if (!existsSync(root)) return [];
    const files: string[] = [];
    const visit = (path: string): void => {
        let stat;
        try {
            stat = statSync(path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
        }
        if (stat.isDirectory()) {
            if (
                basename(path) === 'node_modules'
                || basename(path) === 'dist'
                || basename(path).startsWith('.tmp.')
            ) return;
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

function readSourceIfPresent(path: string): string | null {
    try {
        return readFileSync(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

describe('Agent Session runtime harness', () => {
    it('records only schema-valid canonical runtime events', async () => {
        const harness = createAgentSessionRuntimeHarness();
        const turnStart = {
            kind: 'turn-start',
            sequence: 1,
            sessionId: 'session-1',
            turnId: 'turn-1',
            emittedAtMs: 1,
            startedBy: 'host',
        } satisfies AgentSessionRuntimeEvent;

        harness.recordRuntimeEvent(turnStart);

        expect(harness.canonicalEvents()).toEqual([turnStart]);
        expect(() => harness.expectAllEventsValidated()).not.toThrow();
    });

    it('rejects canonical runtime events that do not parse under AgentSessionRuntimeEventSchema', () => {
        const harness = createAgentSessionRuntimeHarness();

        harness.recordRuntimeEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            emittedAtMs: 1,
        });

        expect(() => harness.expectAllEventsValidated()).toThrow(/AgentSessionRuntimeEventSchema/);
        expect(harness.validationFailures()).toHaveLength(1);
    });

    it('reports validation failures even when the raw event is not JSON-serializable', () => {
        const harness = createAgentSessionRuntimeHarness();

        harness.recordRuntimeEvent({ kind: 'turn-start', emittedAtMs: 1n });

        expect(() => harness.expectAllEventsValidated()).toThrow(/AgentSessionRuntimeEventSchema/);
    });

    it('waits for event kind without fixed sleeps and enforces one terminal event', async () => {
        const harness = createAgentSessionRuntimeHarness();
        const untilComplete = harness.until('turn-complete');

        harness.recordRuntimeEvent({
            kind: 'turn-start',
            sequence: 1,
            sessionId: 'session-1',
            turnId: 'turn-1',
            emittedAtMs: 1,
            startedBy: 'host',
        } satisfies AgentSessionRuntimeEvent);
        harness.recordRuntimeEvent({
            kind: 'turn-complete',
            sequence: 2,
            sessionId: 'session-1',
            turnId: 'turn-1',
            emittedAtMs: 2,
        } satisfies AgentSessionRuntimeEvent);

        await expect(untilComplete).resolves.toMatchObject({ kind: 'turn-complete' });
        expect(() => harness.expectExactlyOneTerminalEvent()).not.toThrow();
    });

    it('rejects duplicate terminal events for the same turn', () => {
        const harness = createAgentSessionRuntimeHarness();

        harness.recordRuntimeEvent({
            kind: 'turn-complete',
            sequence: 1,
            sessionId: 'session-1',
            turnId: 'turn-1',
            emittedAtMs: 2,
        } satisfies AgentSessionRuntimeEvent);
        harness.recordRuntimeEvent({
            kind: 'turn-cancelled',
            sequence: 2,
            sessionId: 'session-1',
            turnId: 'turn-1',
            emittedAtMs: 3,
            cause: 'user',
        } satisfies AgentSessionRuntimeEvent);

        expect(() => harness.expectExactlyOneTerminalEvent({ turnId: 'turn-1' })).toThrow(/received 2/);
    });

    it('rejects pending waits on caller cancellation and harness disposal', async () => {
        const harness = createAgentSessionRuntimeHarness();
        const caller = new AbortController();
        const cancelled = harness.until('turn-complete', { signal: caller.signal });
        const disposed = harness.until('turn-failed');

        caller.abort(new Error('caller stopped'));
        harness.dispose();

        await expect(cancelled).rejects.toThrow(/caller stopped/);
        await expect(disposed).rejects.toThrow(/disposed/);
    });

    it('fences production plugin sources from RuntimeEventV1 casts', () => {
        const pluginSourceRoot = join(repoRoot, 'plugins');
        const offenders = collectTypeScriptFiles(pluginSourceRoot)
            .filter((path) => readSourceIfPresent(path)?.includes('as RuntimeEventV1') === true)
            .map((path) => relative(repoRoot, path));

        expect(offenders).toEqual([]);
    });
});
