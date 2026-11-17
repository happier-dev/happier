import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import {
  getAppliedActiveServerSnapshot,
  isAppliedActiveServerRuntimeAvailable,
  publishAppliedActiveServerSnapshot,
} from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } =
  await import('@/sync/domains/server/serverRuntime');
const { publishHomeAccountChange } =
  await import('@/sync/runtime/orchestration/homeAccountChange');
const { useApprovalProfileAudience } =
  await import('./useApprovalProfileAudience');

const profileId = 'artifact-careful';
const accountId = 'account-leeroy';
let serverId: string;
let previous = storage.getState();
let applied = getAppliedActiveServerSnapshot();
let available = isAppliedActiveServerRuntimeAvailable();
let grants: unknown[] = [];

const grant = (principal: Readonly<Record<string, string>>, name: string) => ({
  principal,
  accessLevel: 'view',
  createdByAccountId: accountId,
  createdAt: 1,
  display: { name },
});

beforeEach(async () => {
  previous = storage.getState();
  applied = getAppliedActiveServerSnapshot();
  available = isAppliedActiveServerRuntimeAvailable();
  await home.reset();
  serverId = await home.addHome({
    name: 'Studio Home',
    serverUrl: 'https://profile-audience.test',
    accountId,
  });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
  storage.setState({ profileScope: { serverId, accountId } });
  home.answer(serverId, '/v1/account/encryption/currentness', {
    body: createPlainAccountEncryptionCurrentnessFixture(),
  });
  grants = [grant({ kind: 'team', teamId: 'team-studio' }, 'Studio')];
  home.answer(serverId, `GET /v1/artifacts/${profileId}/access/grants`, {
    select: () => ({
      body: {
        artifactId: profileId,
        ownerAccountId: accountId,
        access: 'owner',
        grants,
      },
    }),
  });
});

afterEach(async () => {
  await standardCleanup();
  retireActiveServerAccountScopeLifetime();
  await home.reset();
  storage.setState(previous);
  publishAppliedActiveServerSnapshot(applied, available);
});

// D15 / Plan 03 S7: the owner's profile header says who it is shared with, from the profile's own grant roster.
describe('approval profile audience', () => {
  it('reads the roster once and again when the Account wake names the profile', async () => {
    const hook = await renderHook(() => useApprovalProfileAudience(profileId));
    await waitForHomeGovernance(() =>
      expect(hook.getCurrent()?.grants?.map((row) => row.display.name)).toEqual(
        ['Studio'],
      ),
    );
    grants = [
      ...grants,
      grant({ kind: 'account', accountId: 'account-mara' }, 'Mara'),
    ];
    await act(async () =>
      publishHomeAccountChange(serverId, ['artifact-unrelated'], {
        changeKinds: ['artifact'],
      }),
    );
    expect(hook.getCurrent()?.grants?.map((row) => row.display.name)).toEqual([
      'Studio',
    ]);
    await act(async () =>
      publishHomeAccountChange(serverId, [profileId], {
        changeKinds: ['artifact'],
      }),
    );
    await waitForHomeGovernance(() =>
      expect(hook.getCurrent()?.grants?.map((row) => row.display.name)).toEqual(
        ['Studio', 'Mara'],
      ),
    );
  });

  it('does not read a profile someone else owns', async () => {
    const hook = await renderHook(() => useApprovalProfileAudience(null));
    expect(hook.getCurrent()).toBeNull();
    expect(
      home.requests.some((request) => request.path.includes('/access/grants')),
    ).toBe(false);
  });
});
