import React from 'react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { Icon } from '@/components/ui/icons/Icon';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

const botsRail = vi.hoisted(() => ({ writes: [] as unknown[] }));

installSessionShellCommonModuleMocks({
  storage: async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
      importOriginal,
      overrides: {
        // Rows show where each Session runs (on), status words off: one checked toggle, one unchecked.
        useSettingMutable: ((key: string) => {
          if (key === 'sessionListRowContextV1') return [true, vi.fn()];
          if (key === 'sessionListStatusWords') return [false, vi.fn()];
          if (key === 'homeBotFacesEnabled') return [undefined, (value: unknown) => { botsRail.writes.push(value); }];
          return [null, vi.fn()];
        }) as any,
      },
    });
  },
});
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(
    importOriginal,
  ),
);

let SessionListViewOptionsButton: typeof import('./sessionListChrome').SessionListViewOptionsButton;
// The shell's module graph is large; load it once, outside the test's own time.
beforeAll(async () => {
  ({ SessionListViewOptionsButton } = await import('./sessionListChrome'));
}, 300_000);

afterEach(() => standardCleanup());

// The menu owner (SelectableMenuResults) draws a checked row's check beside the row's trailing element; a row
// that passed its own check glyph as that element showed two (native QA, 11-09). A checked row says `checked`
// and leaves the glyph to the owner, in the menu and in its submenus.
it('leaves the check of every checked View options row to the menu', async () => {
  const screen = await renderScreen(<SessionListViewOptionsButton />);
  const menu = screen.root.findAll((node) => Array.isArray(node.props.items) && typeof node.props.onSelect === 'function')[0]!;
  type MenuItem = Readonly<{ id: string; checked?: boolean; rightElement?: unknown; submenu?: { items: readonly MenuItem[] } }>;
  const all = (items: readonly MenuItem[]): MenuItem[] => items.flatMap((item) => [item, ...all(item.submenu?.items ?? [])]);
  const checked = all(menu.props.items as readonly MenuItem[]).filter((item) => item.checked === true);
  // The layout, the attention placement, "Show where it runs", the leading mark and the density are on.
  expect(checked.length).toBeGreaterThanOrEqual(5);
  const drawsOwnGlyph = (element: unknown): boolean => {
    if (!React.isValidElement(element)) return false;
    const props = element.props as { name?: unknown; children?: unknown };
    if (element.type === Icon && props.name === 'check') return true;
    return React.Children.toArray(props.children as React.ReactNode).some(drawsOwnGlyph);
  };
  expect(checked.filter((item) => drawsOwnGlyph(item.rightElement)).map((item) => item.id)).toEqual([]);
});

// The Bots rail heads the list by default (lab session-orchestration L1); the View menu is where the list's own
// furniture turns off, so the rail's switch is there, on until the person turns it off.
it('turns the Bots rail off and back from the View menu', async () => {
  const screen = await renderScreen(<SessionListViewOptionsButton />);
  const menu = screen.root.findAll((node) => Array.isArray(node.props.items) && typeof node.props.onSelect === 'function')[0]!;
  type MenuItem = Readonly<{ id: string; checked?: boolean; multiSelect?: boolean; testID?: string }>;
  const rail = (menu.props.items as readonly MenuItem[]).find((item) => item.testID === 'session-list-view-bots-rail');
  expect(rail).toMatchObject({ checked: true, multiSelect: true });
  await menu.props.onSelect(rail!.id);
  expect(botsRail.writes).toEqual([false]);
});
