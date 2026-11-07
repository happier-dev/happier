import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';
import {
  createDefaultCollectionSpaceV1,
  type CollectionSpaceV1,
} from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';

import { renderScreen } from '@/dev/testkit';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';

// Boundaries: credential-bound Action execution and the app's modal presenter. Form state and mutation
// construction stay real.
const execute = vi.fn(async (_actionId: string, _input: unknown) => ({
  ok: true as const,
  result: { status: 'completed' },
}));
vi.mock('@/components/approvals/useMountedActionExecution', () => ({
  useMountedActionExecution: () => ({
    execute,
    approval: {},
    isCurrent: () => true,
  }),
}));
const { confirm } = vi.hoisted(() => ({ confirm: vi.fn(async () => false) }));
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      spies: { confirm },
    }).module,
);
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/components/ui/popover', async (importOriginal) => {
  const { createInlinePopoverModuleMock } =
    await import('@/dev/testkit/mocks/popover');
  return createInlinePopoverModuleMock(importOriginal);
});

import { useCollectionSpaceEditing } from './useCollectionSpaceEditing';

const base = createDefaultCollectionSpaceV1('sessionWork');
const release: CollectionSpaceV1<'sessionWork'> = {
  ...base,
  id: 'release',
  name: 'Release',
};
const anchorRef = { current: null };
const ACCOUNT: AccountSettingsScope = {
  serverId: 'server',
  accountId: 'account',
};
let editing: ReturnType<typeof useCollectionSpaceEditing<'sessionWork'>>;
function Host(
  props: Readonly<{
    selectedSpace: CollectionSpaceV1<'sessionWork'> | null;
    scope: AccountSettingsScope | null;
  }>,
) {
  editing = useCollectionSpaceEditing({
    entityKind: 'sessionWork',
    testIDPrefix: 'space',
    scope: props.scope,
    spaces: [base, release],
    selectedSpace: props.selectedSpace,
    currentFilter: base.filter,
    suggestion: { name: 'Work', icon: base.icon },
    summary: [],
    anchorRef,
  });
  return editing.formOverlay;
}
async function renderForm(
  input: Readonly<{
    selectedSpace?: CollectionSpaceV1<'sessionWork'>;
    scope?: AccountSettingsScope | null;
  }>,
) {
  const screen = await renderScreen(
    <HappierUiPlatformProvider
      platform={{ platform: 'ios', colorScheme: 'light' }}
    >
      <Host
        selectedSpace={input.selectedSpace ?? null}
        scope={input.scope === undefined ? ACCOUNT : input.scope}
      />
    </HappierUiPlatformProvider>,
  );
  await act(() =>
    input.selectedSpace ? editing.openEdit() : editing.openSaveAs(),
  );
  return screen;
}
const deletions = () =>
  execute.mock.calls.filter(
    ([, input]) =>
      (input as { input?: { mutation?: { op?: string } } }).input?.mutation
        ?.op === 'delete',
  );

describe('space form writes', () => {
  beforeEach(() => {
    execute.mockClear();
    confirm.mockReset();
  });

  it('asks once before deleting a space and keeps it when the person cancels', async () => {
    confirm.mockResolvedValue(false);
    const screen = await renderForm({ selectedSpace: release });
    await screen.pressByTestIdAsync('space-delete');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deletions()).toHaveLength(0);
    expect(screen.findByTestId('space-form')).toBeTruthy();
  });

  it('deletes through the existing settings intent once the person confirms', async () => {
    confirm.mockResolvedValue(true);
    const screen = await renderForm({ selectedSpace: release });
    await screen.pressByTestIdAsync('space-delete');
    expect(deletions()).toHaveLength(1);
    expect(deletions()[0]?.[1]).toHaveProperty('input.mutation', {
      op: 'delete',
      spaceId: 'release',
    });
  });

  it('resets the default space without a removal confirmation', async () => {
    const screen = await renderForm({ selectedSpace: base });
    await screen.pressByTestIdAsync('space-delete');
    expect(confirm).not.toHaveBeenCalled();
    expect(execute.mock.calls.at(-1)?.[1]).toHaveProperty('input.mutation', {
      op: 'resetDefault',
    });
  });

  it('explains why a space cannot be saved without an Account and submits nothing', async () => {
    const screen = await renderForm({ scope: null });
    expect(screen.findByTestId('space-disabled-reason')).toBeTruthy();
    await screen.pressByTestIdAsync('space-submit');
    expect(execute).not.toHaveBeenCalled();
  });
});
