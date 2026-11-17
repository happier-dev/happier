import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReadableApprovalProfileV1 } from '@happier-dev/protocol/actions/approvalProfiles';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { ApprovalProfilePageHeader } from './ApprovalProfilePageHeader';

vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'web' });
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({
    router: {
      push: vi.fn(),
      back: vi.fn(),
      replace: vi.fn(),
      setParams: vi.fn(),
    },
  }).module;
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({
    translate: (key: string) => key,
    translateLoose: (key: string) => key,
  });
});
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);

afterEach(() => standardCleanup());

const row = (
  access: ReadableApprovalProfileV1['access'],
): ReadableApprovalProfileV1 => ({
  id: 'artifact-careful',
  profile: { id: 'artifact-careful', name: 'Careful agent', actions: {} },
  access,
  ...(access === 'owner'
    ? {}
    : { ownerAccountId: 'account-leeroy', ownerDisplayName: 'Leeroy' }),
  revision: { headerVersion: 1, bodyVersion: 1 },
});

async function renderHeader(access: ReadableApprovalProfileV1['access']) {
  return renderScreen(
    <ApprovalProfilePageHeader
      profileRow={row(access)}
      machineApprovalProfiles={{}}
      write={vi.fn()}
      machineChip={null}
    />,
  );
}

// Plan 03 S7 / 05 S7: the owner shares the profile; a person it was shared with to use sees who shared it and
// duplicates it to change it, and is never offered Rename or Delete of someone else's profile.
describe('ApprovalProfilePageHeader access', () => {
  it('offers Share, Rename and Delete to the owner', async () => {
    const screen = await renderHeader('owner');
    expect(
      screen.findByTestId('settings-actions:approval-profile-page:share'),
    ).not.toBeNull();
    expect(
      screen.findByTestId('settings-actions:approval-profile-page:duplicate'),
    ).toBeNull();
    expect(
      screen.findByTestId('settings-actions:approval-profile-page:menu'),
    ).not.toBeNull();
    expect(screen.getTextContent()).not.toContain(
      'workflows.triggers.guided.profile.sharedBy',
    );
    await screen.unmount();
  });

  it('lets a person it was shared with to use see who shared it and duplicate it, with no Rename or Delete', async () => {
    const screen = await renderHeader('view');
    expect(
      screen.findByTestId('settings-actions:approval-profile-page:share'),
    ).toBeNull();
    expect(
      screen.findByTestId('settings-actions:approval-profile-page:duplicate'),
    ).not.toBeNull();
    expect(
      screen.findByTestId('settings-actions:approval-profile-page:menu'),
    ).toBeNull();
    expect(screen.getTextContent()).toContain(
      'workflows.triggers.guided.profile.sharedBy',
    );
    expect(screen.getTextContent()).toContain(
      'workflows.triggers.guided.profile.sharedWithYouToUse',
    );
    await screen.unmount();
  });

  it('lets an editor rename but not share or delete', async () => {
    const screen = await renderHeader('edit');
    expect(
      screen.findByTestId('settings-actions:approval-profile-page:share'),
    ).toBeNull();
    expect(
      screen.findByTestId('settings-actions:approval-profile-page:duplicate'),
    ).toBeNull();
    expect(
      screen.findByTestId('settings-actions:approval-profile-page:menu'),
    ).not.toBeNull();
    expect(screen.getTextContent()).toContain(
      'workflows.triggers.guided.profile.sharedWithYouToChange',
    );
    await screen.unmount();
  });
});
