import { describe, expect, it } from 'vitest';

import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { Session } from '@/sync/domains/state/storageTypes';

import { readSessionLineage } from './sessionLineage';

function session(id: string, name: string, lead: string | null): Session {
  return createSessionFixture({
    id,
    serverId: 'home-a',
    metadata: { path: '/repo', host: 'host', name },
    reportsTo: lead ? { sessionId: lead } : null,
  });
}

describe('Session lineage (the reportsTo chain above a Session)', () => {
  it('names an unopened lead from the qualified list rather than a same-id transcript from another Home', () => {
    const sessions = {
      child: createSessionFixture({ id: 'child', serverId: 'home-a', reportsTo: { sessionId: 'lead' } }),
      lead: createSessionFixture({ id: 'lead', serverId: 'home-b', metadata: { path: '/other', host: 'other', name: 'Wrong Home' } }),
    };
    const rows = {
      'home-a': {
        child: createSessionListRenderableSessionFixture({ id: 'child', reportsTo: { sessionId: 'lead' } }),
        lead: createSessionListRenderableSessionFixture({ id: 'lead', metadata: { path: '/repo', host: 'host', name: 'Unopened lead' } }),
      },
    };
    expect(readSessionLineage(sessions, 'child', 'home-a', rows)).toEqual([
      { sessionId: 'lead', title: 'Unopened lead' },
    ]);
    expect(readSessionLineage(sessions, 'child', 'home-b', rows)).toEqual([]);
  });

  it('walks up from the direct lead to the root, root first', () => {
    const sessions = {
      root: session('root', 'Payments v2 rollout', null),
      api: session('api', 'Idempotent retries', 'root'),
      ledger: session('ledger', 'Backfill intent ledger', 'api'),
    };
    expect(readSessionLineage(sessions, 'ledger', 'home-a')).toEqual([
      { sessionId: 'root', title: 'Payments v2 rollout' },
      { sessionId: 'api', title: 'Idempotent retries' },
    ]);
    expect(readSessionLineage(sessions, 'root', 'home-a')).toEqual([]);
  });

  it('ends at a lead this device has not loaded, and stops a transient cycle at its first repeat', () => {
    expect(
      readSessionLineage(
        { child: session('child', 'Child', 'missing') },
        'child',
        'home-a',
      ),
    ).toEqual([]);
    const cycle = { a: session('a', 'A', 'b'), b: session('b', 'B', 'a') };
    expect(readSessionLineage(cycle, 'a', 'home-a')).toEqual([
      { sessionId: 'b', title: 'B' },
    ]);
  });
});
