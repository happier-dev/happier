import { afterEach, describe, expect, it } from 'vitest';

import { createTestAuth } from '../../src/testkit/auth';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { createSession, fetchSessionsV2 } from '../../src/testkit/sessions';
import {
  fetchSessionOrganizationSnapshot,
  importSessionOrganization,
  readPinnedSessionIdsFromOrganizationSnapshot,
  setSessionOrganizationPin,
} from '../../src/testkit/uiE2e/sessionOrganization';

const run = createRunDirs({ runLabel: 'core-session-organization-persistence' });

function sortKey(index: number): string {
  return String(index + 1).padStart(8, '0');
}

describe('core e2e: session organization persistence', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('persists server-backed pins and removes unpinned sessions from pinned organization bootstrap', async () => {
    const testDir = run.testDir('session-organization-pins-unpin');
    server = await startServerLight({ testDir });
    const auth = await createTestAuth(server.baseUrl);

    const pinnedFirst = await createSession(server.baseUrl, auth.token);
    const pinnedSecond = await createSession(server.baseUrl, auth.token);
    const newestUnpinned = await createSession(server.baseUrl, auth.token);

    await importSessionOrganization({
      baseUrl: server.baseUrl,
      token: auth.token,
      request: {
        pins: [
          { sessionId: pinnedFirst.sessionId, sortKey: sortKey(1) },
          { sessionId: pinnedSecond.sessionId, sortKey: sortKey(0) },
        ],
        folders: [],
        tags: [],
        tagAssignments: [],
        orderEntries: [],
        labels: [],
      },
    });

    const snapshotBeforeUnpin = await fetchSessionOrganizationSnapshot({
      baseUrl: server.baseUrl,
      token: auth.token,
      request: {
        includeFolders: false,
        includeTags: false,
        includeLabels: false,
      },
    });
    expect(readPinnedSessionIdsFromOrganizationSnapshot(snapshotBeforeUnpin)).toEqual([
      pinnedSecond.sessionId,
      pinnedFirst.sessionId,
    ]);

    const listBeforeUnpin = await fetchSessionsV2(server.baseUrl, auth.token, { limit: 1 });
    expect(listBeforeUnpin.sessions.map((session) => session.id)).toEqual(
      expect.arrayContaining([
        pinnedFirst.sessionId,
        pinnedSecond.sessionId,
        newestUnpinned.sessionId,
      ]),
    );

    await setSessionOrganizationPin({
      baseUrl: server.baseUrl,
      token: auth.token,
      sessionId: pinnedSecond.sessionId,
      pinned: false,
    });

    const snapshotAfterUnpin = await fetchSessionOrganizationSnapshot({
      baseUrl: server.baseUrl,
      token: auth.token,
      request: {
        includeFolders: false,
        includeTags: false,
        includeLabels: false,
      },
    });
    expect(readPinnedSessionIdsFromOrganizationSnapshot(snapshotAfterUnpin)).toEqual([
      pinnedFirst.sessionId,
    ]);

    const listAfterUnpin = await fetchSessionsV2(server.baseUrl, auth.token, { limit: 1 });
    const idsAfterUnpin = listAfterUnpin.sessions.map((session) => session.id);
    expect(idsAfterUnpin).toContain(pinnedFirst.sessionId);
    expect(idsAfterUnpin).toContain(newestUnpinned.sessionId);
    expect(idsAfterUnpin).not.toContain(pinnedSecond.sessionId);
  }, 180_000);
});
