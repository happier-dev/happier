import { describe, expect, it } from 'vitest';

import { createTriageInitialScanOwner } from './initialScan.js';

/**
 * Exactly one bounded pass follows explicit configuration — one, not a poll and
 * not a schedule — and it enters the same process-local single-flight owner
 * every other refresh producer uses.
 */

const INSTANCE = '11111111-1111-4111-8111-111111111111';

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
    let resolve = (): void => {};
    const promise = new Promise<void>((settle) => { resolve = settle; });
    return { promise, resolve };
}

describe('the post-configuration initial scan owner', () => {
    it('runs exactly one pass for one explicit configuration', async () => {
        const owner = createTriageInitialScanOwner({ nowMs: () => 1_000 });
        let passes = 0;

        await owner.request({
            sourceInstanceId: INSTANCE,
            pass: async () => {
                passes += 1;
                return { kind: 'completed' };
            },
        });

        expect(passes).toBe(1);
        owner.dispose();
    });

    it('coalesces a second configuration request for the same instance into the running pass', async () => {
        const owner = createTriageInitialScanOwner({ nowMs: () => 1_000 });
        const gate = deferred();
        let passes = 0;
        const pass = async (): Promise<Readonly<{ kind: 'completed' }>> => {
            passes += 1;
            await gate.promise;
            return { kind: 'completed' };
        };

        const first = owner.request({ sourceInstanceId: INSTANCE, pass });
        const second = owner.request({ sourceInstanceId: INSTANCE, pass });
        gate.resolve();
        await Promise.all([first, second]);

        // A Select-all scope, a double-tapped Save, or a retried Action must
        // not multiply into provider reads.
        expect(passes).toBe(1);
        owner.dispose();
    });

    it('aborts the running pass and forgets the instance when it is retired', async () => {
        const owner = createTriageInitialScanOwner({ nowMs: () => 1_000 });
        const started = deferred();
        const gate = deferred();
        let observedAbort: boolean | null = null;

        const running = owner.request({
            sourceInstanceId: INSTANCE,
            pass: async ({ signal }) => {
                started.resolve();
                await gate.promise;
                observedAbort = signal.aborted;
                return { kind: 'interrupted' };
            },
        });
        await started.promise;
        owner.retire(INSTANCE);
        gate.resolve();
        await running;

        expect(observedAbort).toBe(true);

        // A retired instance keeps no registered pass behind it.
        let laterPasses = 0;
        await owner.request({
            sourceInstanceId: INSTANCE,
            pass: async () => {
                laterPasses += 1;
                return { kind: 'completed' };
            },
        });
        expect(laterPasses).toBe(1);
        owner.dispose();
    });
});
