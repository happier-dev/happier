import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NO_HOME_CAPABILITIES_V1,
  type HomeGovernanceProjectionV1,
} from '@happier-dev/protocol/home/governance';

// Device storage is the platform boundary; the warm cache owner above it stays real.
const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('react-native-mmkv', () => {
  class MMKV {
    getString(key: string) {
      return store.get(key);
    }
    set(key: string, value: string) {
      store.set(key, value);
    }
    delete(key: string) {
      store.delete(key);
    }
    getAllKeys() {
      return [...store.keys()];
    }
    trim() {}
  }
  return { MMKV };
});

import { homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { prepareWarmCacheEncryptionKey } from '@/sync/domains/state/warmCacheEncryptionKey';

import {
  applyHomeGovernanceFailure,
  applyHomeGovernanceProjection,
  readHomeGovernanceViewerAccess,
  resetHomeGovernanceSnapshotsForTests,
} from './homeGovernanceSnapshots';

const scope = createServerAccountScope('home_a', 'acc_1')!;
const otherAccount = createServerAccountScope('home_a', 'acc_2')!;

function ownerProjection(): HomeGovernanceProjectionV1 {
  return homeGovernanceProjectionFixture({
    viewer: { accountId: 'acc_1', homeRole: 'owner', status: 'active' },
    capabilities: {
      ...NO_HOME_CAPABILITIES_V1,
      viewAdministration: true,
      manageAccounts: true,
    },
    activeOwnerCount: 1,
  });
}

beforeEach(async () => {
  await prepareWarmCacheEncryptionKey();
  resetHomeGovernanceSnapshotsForTests();
});

describe("the viewer's last-known Home access", () => {
  it("answers from the live projection, and from this device's last answer once the process has none", () => {
    expect(readHomeGovernanceViewerAccess(scope)).toBeNull();
    applyHomeGovernanceProjection({
      scope,
      projection: ownerProjection(),
      observedAt: 1,
    });
    expect(readHomeGovernanceViewerAccess(scope)).toMatchObject({
      current: true,
      access: { viewer: { homeRole: 'owner' } },
    });

    // A new process: the Home has not answered yet, but this device remembers how it answered last.
    resetHomeGovernanceSnapshotsForTests();
    const lastKnown = readHomeGovernanceViewerAccess(scope);
    expect(lastKnown).toMatchObject({
      current: false,
      access: { viewer: { homeRole: 'owner' }, setupState: 'owned' },
    });
    expect(lastKnown?.access.capabilities.manageAccounts).toBe(true);
    // Another Account on the same Home was never answered.
    expect(readHomeGovernanceViewerAccess(otherAccount)).toBeNull();
  });

  it('forgets the last answer when the Home withdraws access, so a later visit offers nothing from it', () => {
    applyHomeGovernanceProjection({
      scope,
      projection: ownerProjection(),
      observedAt: 1,
    });
    applyHomeGovernanceFailure({
      scope,
      error: { kind: 'forbidden', retryable: false },
    });
    expect(readHomeGovernanceViewerAccess(scope)).toBeNull();
    resetHomeGovernanceSnapshotsForTests();
    expect(readHomeGovernanceViewerAccess(scope)).toBeNull();
  });

  it('keeps the last answer through a Home that merely did not answer', () => {
    applyHomeGovernanceProjection({
      scope,
      projection: ownerProjection(),
      observedAt: 1,
    });
    resetHomeGovernanceSnapshotsForTests();
    applyHomeGovernanceFailure({
      scope,
      error: { kind: 'unreachable', retryable: true },
    });
    expect(readHomeGovernanceViewerAccess(scope)).toMatchObject({
      current: false,
      access: { viewer: { homeRole: 'owner' } },
    });
  });
});
