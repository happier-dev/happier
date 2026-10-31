import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';

const registration = vi.hoisted(() => ({
    cases: new Map<string, () => Promise<void>>(),
    before: [] as Array<() => Promise<void>>,
    after: [] as Array<() => Promise<void>>,
}));
// Vitest's third-party runner is the boundary: the real public kit registers
// its cases here, then this self-test executes those callbacks and lifecycle hooks.
vi.mock('vitest', async importOriginal => ({
    ...await importOriginal<typeof import('vitest')>(),
    describe: (_title: string, register: () => void) => register(),
    it: (title: string, run: () => Promise<void>) => registration.cases.set(title, run),
    beforeEach: (run: () => Promise<void>) => registration.before.push(run),
    afterEach: (run: () => Promise<void>) => registration.after.push(run),
}));

import { createAgentLaunchObserver, type AgentLaunchObserverBoundaries } from './observeAgentLaunch.js';
import { runAgentSkillDeliveryContract } from './skillDeliveryContract.js';

test.each(['valid', 'invalid', 'duplicate', 'missing-invoker'])('K13 validates %s evidence from a claiming Agent', async mode => {
    const home = await mkdtemp(join(tmpdir(), 'happier-skill-kit-evidence-'));
    const observer = createAgentLaunchObserver({ home });
    const boundaries = observer.boundaries as AgentLaunchObserverBoundaries;
    registration.cases.clear();
    registration.before.length = 0;
    registration.after.length = 0;
    runAgentSkillDeliveryContract({
        agent: { id: 'evidence-fixture', title: 'Evidence fixture', primary: 'sessions', runtime: { kind: 'custom' },
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
                skills: { delivery: 'none', nativeDisable: 'unsupported', liveReload: 'unsupported', usageEvidence: 'reported' } } },
        async openSession() {
            boundaries.reset();
            boundaries.recordLaunch({ argv: [], env: { HOME: home } });
            return { send: async () => ({ status: 'admitted' }), cancel: async () => ({ status: 'notRunning' }),
                updateConfiguration: async () => ({ status: 'applied', changed: [] }), watch: () => ({ dispose() {} }), dispose: async () => {} };
        },
        ...(mode === 'missing-invoker' ? {} : { async invokeSkill(_runtime, name) {
            const event = { kind: 'skill-usage', sequence: 1, sessionId: 'skill-delivery-contract', emittedAtMs: 1,
                turnId: 'fixture-turn', skills: [{ name }], ...(mode === 'invalid' ? { unsupported: true } : {}) };
            boundaries.recordRuntimeEvent(event);
            if (mode === 'duplicate') boundaries.recordRuntimeEvent({ ...event, sequence: 2 });
        } } satisfies Pick<Parameters<typeof runAgentSkillDeliveryContract>[0], 'invokeSkill'>),
        observeLaunch: observer.observeLaunch,
    });
    const run = [...registration.cases].find(([title]) => title.startsWith('K13'))?.[1];
    expect(run).toBeTypeOf('function');
    try {
        for (const before of registration.before) await before();
        if (mode === 'valid') {
            await expect(run!()).resolves.toBeUndefined();
        } else if (mode === 'invalid') {
            await expect(run!()).rejects.toMatchObject({
                issues: expect.arrayContaining([
                    expect.objectContaining({ code: 'unrecognized_keys', keys: ['unsupported'] }),
                ]),
            });
        } else if (mode === 'duplicate') {
            await expect(run!()).rejects.toThrow(/K13: a native invocation is reported exactly once/u);
        } else {
            await expect(run!()).rejects.toMatchObject({
                name: 'AssertionError', actual: 'undefined', expected: 'function',
            });
        }
    } finally {
        try { for (const after of registration.after) await after(); }
        finally { await rm(home, { recursive: true, force: true }); }
    }
});
