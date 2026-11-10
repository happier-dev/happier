import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({});
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(
    importOriginal,
  ),
);
// The Machine RPC transport is the boundary; nothing is reachable in this test.
vi.mock('@/sync/ops/scm/machineScm', () => ({
  machineScmHostingRepositoryDescribePublishTargets: vi.fn(async () => ({
    success: false,
    errorCode: 'machine_unreachable',
  })),
}));

afterEach(() => standardCleanup());

const { NewAppScreen } = await import('./NewAppScreen');

describe('New app flow (Plan 60, lab s1)', () => {
  it('starts on the bundled starter gallery and moves on to describing the app', async () => {
    const screen = await renderScreen(<NewAppScreen onClose={() => {}} />);
    expect(screen.findByTestId('newApp.starter:static-website')).toBeTruthy();
    await screen.pressByTestIdAsync('newApp.continue');
    expect(screen.findByTestId('newApp.description')).toBeTruthy();
  });

  it('never offers Create while nothing can build it: someone with no computer is led to add one', async () => {
    const screen = await renderScreen(<NewAppScreen onClose={() => {}} />);
    await screen.pressByTestIdAsync('newApp.continue');
    expect(screen.findByTestId('newApp.addComputer')).toBeTruthy();
    expect(screen.findByTestId('newApp.create')?.props.disabled).toBe(true);
  });
});
