import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { __resetQualifiedConnectedAccountQuotaSnapshotStore } from '@/sync/domains/connectedServices/qualifiedConnectedAccountQuotaSnapshotStore';
import {
  createQualifiedQuotaTestHarness,
  quotaTestRef as ref,
  quotaTestResponse,
  quotaTestSnapshot as snapshot,
} from '@/hooks/server/connectedServices/qualifiedConnectedAccountQuotaTestHarness';

vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

const { DeploymentTargetPlans, DeploymentTargetPlansForAccount } =
  await import('./DeploymentTargetPlans');

const plans = [
  {
    id: 'hobby',
    title: 'Hobby',
    price: { amount: '0', currency: 'USD', unit: 'month' },
    facts: [],
    source: {
      url: 'https://vercel.com/docs/plans/hobby',
      checkedAt: '2026-11-16',
    },
  },
  {
    id: 'pro',
    title: 'Pro',
    price: { amount: '20', currency: 'USD', unit: 'month' },
    facts: [],
    source: {
      url: 'https://vercel.com/docs/plans/pro-plan',
      checkedAt: '2026-11-16',
    },
  },
];

/** journey-deploy F8: one existing quota observation per connected account on visible demand; none without one. */
describe('Your plan on Review reads the account plan once, only while shown (F8 count)', () => {
  let boundary: Awaited<ReturnType<typeof createQualifiedQuotaTestHarness>>;
  function Wrapper({ children }: React.PropsWithChildren) {
    return (
      <InjectedAuthProvider credentials={boundary.account.credentials}>
        {children}
      </InjectedAuthProvider>
    );
  }

  beforeEach(async () => {
    __resetQualifiedConnectedAccountQuotaSnapshotStore();
    boundary = await createQualifiedQuotaTestHarness();
    boundary.read.mockImplementation(async () =>
      Response.json(
        quotaTestResponse({
          ...snapshot,
          fetchedAt: Date.now(),
          planLabel: 'Pro',
        }),
      ),
    );
  });
  afterEach(async () => {
    standardCleanup();
    __resetQualifiedConnectedAccountQuotaSnapshotStore();
    await boundary?.dispose();
    vi.restoreAllMocks();
  });

  it('no connected account: zero quota reads, bundled facts only', async () => {
    const screen = await renderScreen(
      <Wrapper>
        <DeploymentTargetPlans
          plans={plans}
          platform="Vercel"
          columns
          phone={false}
          testID="plans"
        />
      </Wrapper>,
    );
    await flushHookEffects({ cycles: 8, turns: 8 });
    expect(boundary.read).toHaveBeenCalledTimes(0);
    expect(screen.findByTestId('plans:yourPlan')).toBeNull();
    await screen.unmount();
  });

  it('a connected account: one read while shown, none more on rerender', async () => {
    const element = (columns: boolean) => (
      <Wrapper>
        <DeploymentTargetPlansForAccount
          account={ref}
          plans={plans}
          platform="Vercel"
          columns={columns}
          phone={false}
          testID="plans"
        />
      </Wrapper>
    );
    const screen = await renderScreen(element(true));
    await vi.waitFor(() =>
      expect(screen.findByTestId('plans:yourPlan')).not.toBeNull(),
    );
    expect(screen.getTextContent()).toContain('Pro');
    await screen.update(element(false));
    await flushHookEffects({ cycles: 8, turns: 8 });
    expect(boundary.read).toHaveBeenCalledTimes(1);
    await screen.unmount();
  });
});
