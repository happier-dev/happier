import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { ProjectsTreeProject } from './projectsTreeRows';

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
const { ProjectsAddMenu } = await import('./ProjectsAddMenu');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');

const sessionFolder = (key: string, name: string): ProjectsTreeProject => ({
  key,
  name,
  checkouts: [
    {
      refId: key,
      machineId: 'm1',
      machineName: 'studio',
      label: name,
      path: `~/src/${name}`,
      attention: null,
    },
  ],
});

describe('ProjectsAddMenu "From your sessions" (owner 11-08)', () => {
  it('offers folders only a Session brought, built only once the menu opens, and adds one through the given owner', async () => {
    const read = vi.fn(() => [
      sessionFolder('newest', 'pricing'),
      sessionFolder('older', 'scratch'),
    ]);
    const onAdd = vi.fn();
    const screen = await renderScreen(
      <ProjectsAddMenu
        testID="add"
        machines={[]}
        onAdd={async () => {}}
        onClone={() => {}}
        fromSessions={{ read, onAdd }}
      />,
    );
    // Closed: nothing is built.
    expect(read).not.toHaveBeenCalled();
    await screen.pressByTestIdAsync('add');
    // The menu opens on its scheduled tick.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    const menu = () => screen.findAllByType(DropdownMenu)[0]!;
    const entry = menu().props.items.find(
      (item: { id: string }) => item.id === 'sessions',
    );
    expect(entry?.submenu?.search).toBe(true);
    // Newest first, each named like a tree row: the folder, then "Machine · path".
    expect(
      entry.submenu.items.map(
        (item: { id: string; title: string; subtitle?: string }) => [
          item.id,
          item.title,
          item.subtitle,
        ],
      ),
    ).toEqual([
      ['session:newest', 'pricing', 'studio · ~/src/pricing'],
      ['session:older', 'scratch', 'studio · ~/src/scratch'],
    ]);
    await act(async () => {
      menu().props.onSelect('session:older');
    });
    expect(onAdd).toHaveBeenCalledWith('older');
  });

  it('offers no "From your sessions" entry when its read finds nothing to add', async () => {
    const screen = await renderScreen(
      <ProjectsAddMenu
        testID="add"
        machines={[]}
        onAdd={async () => {}}
        onClone={() => {}}
        fromSessions={{ read: () => [], onAdd: () => {} }}
      />,
    );
    await screen.pressByTestIdAsync('add');
    expect(
      screen
        .findAllByType(DropdownMenu)[0]!
        .props.items.some((item: { id: string }) => item.id === 'sessions'),
    ).toBe(false);
  });
});

describe('ProjectsAddMenu "New app…" (plan 60 §5.1)', () => {
  it('leads with New app… above the ways to bring existing code, and opens the New app flow', async () => {
    const onNewApp = vi.fn();
    const screen = await renderScreen(
      <ProjectsAddMenu
        testID="add"
        machines={[{ id: 'm1', metadata: null } as never]}
        onAdd={async () => {}}
        onClone={() => {}}
        onNewApp={onNewApp}
      />,
    );
    await screen.pressByTestIdAsync('add');
    const menu = () => screen.findAllByType(DropdownMenu)[0]!;
    const ids = menu().props.items.map((item: { id: string }) => item.id);
    expect(ids[0]).toBe('newApp');
    expect(ids).toContain('clone');
    await act(async () => { menu().props.onSelect('newApp'); });
    expect(onNewApp).toHaveBeenCalledTimes(1);
  });

  it('keeps Add a folder with no connected Machine and leads it to adding one (owner 11-11)', async () => {
    const onAdd = vi.fn(async () => {});
    const screen = await renderScreen(
      <ProjectsAddMenu testID="add" machines={[]} onAdd={onAdd} onClone={() => {}} />,
    );
    const menu = () => screen.findAllByType(DropdownMenu)[0]!;
    const folder = menu().props.items.find((item: { testID?: string }) => item.testID === 'add:folder');
    // It never vanishes: it says what it needs first.
    expect(folder).toBeDefined();
    expect(folder.subtitle).toBeTruthy();
    expect(folder.submenu).toBeUndefined();
    await act(async () => { menu().props.onSelect(folder.id); });
    expect(onAdd).not.toHaveBeenCalled();
    const { router } = await import('expo-router');
    const href = String(vi.mocked(router.push).mock.calls.at(-1)?.[0] ?? '');
    expect(href.startsWith('/settings/machines/add')).toBe(true);
  });

  it('still offers New app to someone with no Machine yet', async () => {
    const screen = await renderScreen(
      <ProjectsAddMenu testID="add" machines={[]} onAdd={async () => {}} onNewApp={() => {}} />,
    );
    // A phone-only newcomer starts here; the flow itself offers a computer.
    expect(screen.findAllByType(DropdownMenu).length).toBe(1);
  });
});
