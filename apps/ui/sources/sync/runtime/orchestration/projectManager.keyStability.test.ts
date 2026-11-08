import { beforeEach, describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import {
  removeServerProfile,
  resolveServerProfileScopeIdForIdentifier,
  setServerProfileIdentityForUrl,
  upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';

import { projectManager } from './projectManager';

function folderSession(id: string, path: string) {
  return createSessionFixture({
    id,
    metadata: { machineId: 'm1', host: 'h', path },
  });
}

describe('projectManager Project registration across Home identity changes', () => {
  beforeEach(() => {
    projectManager.clear();
  });

  it('retires the exact key a Project was registered under when its Home id later resolves differently', async () => {
    // A Project is keyed by its Home as resolved when it is created. Learning a Home's identity
    // changes that resolution, so retiring the Project must release the key it registered.
    const serverUrl = 'https://project-key-alias.test';
    const home = await upsertServerProfile({
      serverUrl,
      name: 'Home',
      source: 'manual',
    });
    const registeredAs = resolveServerProfileScopeIdForIdentifier(home.id);
    projectManager.addSession(folderSession('first', '/a'), {
      serverId: home.id,
    });

    await setServerProfileIdentityForUrl(serverUrl, 'srv_project_key_alias');
    expect(resolveServerProfileScopeIdForIdentifier(home.id)).not.toBe(
      registeredAs,
    );
    projectManager.addSession(folderSession('first', '/b'), {
      serverId: home.id,
    });

    await removeServerProfile(home.id);
    const again = await upsertServerProfile({
      serverUrl,
      name: 'Home',
      source: 'manual',
    });
    expect(resolveServerProfileScopeIdForIdentifier(again.id)).toBe(
      registeredAs,
    );

    expect(() =>
      projectManager.addSession(folderSession('second', '/a'), {
        serverId: again.id,
      }),
    ).not.toThrow();
    expect(projectManager.getProjectForSession('second')?.sessionIds).toEqual([
      'second',
    ]);
  });
});
