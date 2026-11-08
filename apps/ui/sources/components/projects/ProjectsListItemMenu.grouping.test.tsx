import * as React from 'react';
import { act } from 'react-test-renderer';
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

afterEach(() => standardCleanup());

// Source graph loading belongs to suite setup, outside the interaction deadline.
const { ProjectsListItemMenu } = await import('./ProjectsListItemMenu');
const { DropdownMenu } =
  await import('@/components/ui/forms/dropdown/DropdownMenu');

const workspaceRef = {
  id: 'checkout',
  serverId: 'home',
  machineId: 'm1',
  rootPath: '/app',
  projectKey: 'app',
  createdAtMs: 1,
};
const noop = () => {};

describe('ProjectsListItemMenu grouping (owner 11-08)', () => {
  it('groups a checkout with another Project or separates it, offering targets only once the menu opens', async () => {
    const targets = vi.fn(() => [
      { key: 'other', title: 'other-app', subtitle: 'studio · ~/other' },
    ]);
    const onGroup = vi.fn();
    const onSeparate = vi.fn();
    const screen = await renderScreen(
      <ProjectsListItemMenu
        testID="menu"
        workspaceRef={workspaceRef}
        onTogglePinned={noop}
        onRename={noop}
        onReset={noop}
        onRemove={noop}
        grouping={{ targets, onGroup, onSeparate }}
      />,
    );
    expect(targets).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('menu');
    const menu = () => screen.findAllByType(DropdownMenu)[0]!;
    const group = menu().props.items.find(
      (item: { id: string }) => item.id === 'group',
    );
    expect(group?.submenu?.search).toBe(true);
    expect(
      group.submenu.items.map((item: { id: string; title: string }) => [
        item.id,
        item.title,
      ]),
    ).toEqual([['group:other', 'other-app']]);
    await act(async () => {
      menu().props.onSelect('group:other');
    });
    expect(onGroup).toHaveBeenCalledWith('other');
    await act(async () => {
      menu().props.onSelect('separate');
    });
    expect(onSeparate).toHaveBeenCalledOnce();
  });

  it('offers no Separate on a checkout that is its Project alone', async () => {
    const screen = await renderScreen(
      <ProjectsListItemMenu
        testID="menu"
        workspaceRef={workspaceRef}
        onTogglePinned={noop}
        onRename={noop}
        onReset={noop}
        onRemove={noop}
        grouping={{ targets: () => [], onGroup: noop, onSeparate: null }}
      />,
    );
    await screen.pressByTestIdAsync('menu');
    const ids = screen
      .findAllByType(DropdownMenu)[0]!
      .props.items.map((item: { id: string }) => item.id);
    expect(ids).toContain('group');
    expect(ids).not.toContain('separate');
  });
});
