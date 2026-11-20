import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);

const { findTeamSetupSourceCheckout, TeamSetupSourceChangeNotice } = await import('./TeamSetupSourceChange');

afterEach(() => {
  standardCleanup();
});

const checkout = (id: string, patch: Partial<WorkspaceRefV1> = {}): WorkspaceRefV1 => ({
  id, serverId: 'home', machineId: 'devbox', rootPath: `/code/${id}`, createdAtMs: 1,
  source: { sourceId: 'acme-web', revision: 3 }, ...patch,
} as WorkspaceRefV1);

it('finds the member’s checkout of a listed Source only on the chosen Machine', () => {
  const refs = [
    checkout('laptop-web', { machineId: 'laptop' }),
    checkout('devbox-web'),
    checkout('devbox-api', { source: { sourceId: 'acme-api', revision: 1 } }),
  ];
  expect(findTeamSetupSourceCheckout(refs, { serverId: 'home', machineId: 'devbox', sourceId: 'acme-web', revision: 4 })?.id)
    .toBe('devbox-web');
  // A listed Source without a checkout on this Machine shows no notice.
  expect(findTeamSetupSourceCheckout(refs, { serverId: 'home', machineId: 'mini', sourceId: 'acme-web', revision: 4 })).toBeNull();
  expect(findTeamSetupSourceCheckout(refs, { serverId: 'home', machineId: null, sourceId: 'acme-web', revision: 4 })).toBeNull();
});

it('says the Team changed the shared setup and leads to the checkout’s review without writing', async () => {
  const onReview = vi.fn();
  const screen = await renderScreen(<TeamSetupSourceChangeNotice sourceId="acme-web" teamName="Acme" onReview={onReview}
    pending={{ source: { id: 'acme-web', name: 'Web' }, setup: { kind: 'none' } as never,
      summary: [{ kind: 'scripts', count: 2 }] as never }} />);
  expect(screen.findByTestId('team-setup-source-changed:acme-web')).not.toBeNull();
  expect(onReview).not.toHaveBeenCalled();
  await screen.pressByTestIdAsync('team-setup-source-changed-review:acme-web');
  expect(onReview).toHaveBeenCalledOnce();
});
