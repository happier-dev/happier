import type { JsonValue } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1 } from '../../actions/entrySessionProtocol.js';
import { testkitEntryRef } from '../../corpus/testkit/observations.test-support.js';
import { submitTriageUnlinkLinkedEntry } from './unlinkLinkedEntry.js';

/**
 * The mounted cockpit's transport to the canonical link remover.
 *
 * What this protects is the address: a removal is derived from the entry
 * reference AND the mounted Session, so a transport that reshaped either one
 * would delete nothing while reporting success — the reader would press Unlink,
 * see the row return on the next read, and have no way to undo their mistake.
 */

function recordingHost(result: unknown) {
    const calls: { action: string; input: JsonValue }[] = [];
    return {
        calls,
        host: {
            executeAction: async (action: string, input: JsonValue) => {
                calls.push({ action, input });
                return result;
            },
        },
    };
}

describe('the cockpit Unlink transport', () => {
    it('names the exact entry and mounted Session the row was rendered from', async () => {
        const entryRef = testkitEntryRef();
        const { calls, host } = recordingHost({ v: 1, status: 'unlinked' });

        expect(await submitTriageUnlinkLinkedEntry(host, { sessionId: 'session-a', entryRef }))
            .toEqual({ v: 1, status: 'unlinked' });

        expect(calls).toEqual([{
            action: TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1,
            input: { v: 1, sessionId: 'session-a', entryRef },
        }]);
        // Passed through, not rebuilt. Identity is the assertion because a
        // structurally equal copy would satisfy the deep comparison above while
        // a re-encoded or reordered one would not survive the address
        // derivation — and that failure is silent: it removes nothing and
        // reports success.
        expect((calls[0]?.input as { entryRef: unknown }).entryRef).toBe(entryRef);
    });

    it('admits the answer through the published result schema rather than a cast', async () => {
        const { host } = recordingHost({ v: 1, status: 'reticulated' });

        // A transport that trusted the wire would hand a row a state its own
        // union does not contain, and the row would render nothing at all.
        await expect(submitTriageUnlinkLinkedEntry(host, {
            sessionId: 'session-a',
            entryRef: testkitEntryRef(),
        })).rejects.toThrow();
    });

    it('carries a settled conflict back as itself rather than as a failure', async () => {
        const { host } = recordingHost({ v: 1, status: 'conflict' });

        // Another writer moved the row. That is a settled answer the reader
        // re-reads, not a broken write they should retry.
        expect(await submitTriageUnlinkLinkedEntry(host, {
            sessionId: 'session-a',
            entryRef: testkitEntryRef(),
        })).toEqual({ v: 1, status: 'conflict' });
    });
});
