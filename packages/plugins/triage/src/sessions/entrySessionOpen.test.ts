import { describe, expect, it } from 'vitest';

import { openLinkedSession } from './entrySessionOpen.js';
import { createTestkitActionInvoker } from './testkit/entrySessionTestkit.test-support.js';

describe('openLinkedSession', () => {
    it('opens exactly the stable Session id and never resolves a title', async () => {
        const invoker = createTestkitActionInvoker();

        expect(await openLinkedSession({ execute: invoker.execute, sessionId: 'session-a' }))
            .toEqual({ status: 'opened' });
        expect(invoker.calls).toEqual([
            { actionId: 'session.open', input: { sessionId: 'session-a' } },
        ]);
    });

    it('reports a navigation failure as retryable and repeats only the open', async () => {
        const failing = createTestkitActionInvoker({ openFails: true });
        expect(await openLinkedSession({ execute: failing.execute, sessionId: 'session-a' }))
            .toEqual({ status: 'failed' });
        expect(failing.calls).toHaveLength(1);

        const retry = createTestkitActionInvoker();
        expect(await openLinkedSession({ execute: retry.execute, sessionId: 'session-a' }))
            .toEqual({ status: 'opened' });
        expect(retry.calls.map((call) => call.actionId)).toEqual(['session.open']);
    });
});
