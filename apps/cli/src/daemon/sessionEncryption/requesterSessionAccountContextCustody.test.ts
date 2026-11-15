import { describe, expect, it } from 'vitest';

import type { TrackedSession } from '../types';
import { createRequesterSessionAccountContextCustody } from './requesterSessionAccountContextCustody';
import { createRequesterSessionRuntimeContextResolver, type RequesterSessionRuntimeContext } from './requesterSessionCredentials';

const attribution = { v: 1, serverId: 'home-a', accountId: 'requester', machineId: 'machine-a', installationId: 'installation-a' } as const;

/**
 * The real resolver and custody select the tracked requester. The held context
 * stands in for the Account observation: its `isCurrent` is that observation's
 * read, counted here.
 */
function heldRequester() {
  let currentnessReads = 0;
  const context = {
    bootstrap: { attribution, getBoundSessionId: () => 'session-a' },
    isCurrent: async () => { currentnessReads += 1; return true; },
  } as unknown as RequesterSessionRuntimeContext;
  const tracked = { happySessionId: 'session-a', requesterSessionRuntimeContext: context,
    requesterWorkAttributionV1: attribution } as unknown as TrackedSession;
  const trackedSessions = new Map([['session-a', tracked]]);
  const resolver = createRequesterSessionRuntimeContextResolver({ trackedSessions,
    getCreateRuntime: () => null, recoverBootstrap: async () => null });
  const custody = createRequesterSessionAccountContextCustody({ trackedSessions,
    resolveRequesterSessionRuntimeContext: resolver, serverId: 'home-a', machineId: 'machine-a',
    externalActionAccountId: 'owner', isRetired: () => false });
  return { custody, context, reads: () => currentnessReads };
}

describe('requester Session account custody', () => {
  it('reads the held requester currentness once per resolve', async () => {
    const { custody, context, reads } = heldRequester();
    expect(await custody.resolveSessionAccountContext('session-a')).toBe(context);
    expect(reads()).toBe(1);
  });
});
