/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

// Real RNW rows and the real menu results owner; only native styling and storage cross the test boundary.
vi.mock('react-native', async () =>
  vi.importActual<typeof import('react-native-web')>('react-native-web'),
);
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub, createUseLocalSettingMock } =
    await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({
    useLocalSetting: createUseLocalSettingMock(),
  });
});

import { SelectableMenuResults } from './SelectableMenuResults';

// SESSION-ROWS-ACCEPT-1119 fix 3: the View menu's independent toggles announced themselves as one radio choice. A menu
// row says what it is in menu terms: an independent toggle is a checkable menu item, one of a single choice a menu radio.
// (A field's option list, `rowKind="item"`, is a select's options, not a menu: it keeps its option roles.)
it.each(['slim'] as const)(
  'announces menu toggles as checkable items and a single choice as menu radios (%s rows)',
  async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <SelectableMenuResults
            categories={[
              {
                id: 'details',
                title: 'Row details',
                items: [
                  {
                    id: 'where',
                    title: 'Show where it runs',
                    checked: true,
                    multiSelect: true,
                  },
                  {
                    id: 'words',
                    title: 'Status words',
                    checked: false,
                    multiSelect: true,
                  },
                ],
              },
              {
                id: 'lines',
                title: 'Lines',
                items: [
                  { id: 'lines:1', title: '1 line', checked: false },
                  { id: 'lines:2', title: '2 lines', checked: true },
                ],
              },
            ]}
            selectedIndex={-1}
            onSelectionChange={() => {}}
            onPressItem={() => {}}
            rowVariant="slim"
          />,
        );
      });
      // The row's own announced element: the one carrying its role (the row, a node in it, or the press target around it).
      const announced = (id: string) => {
        const row = container.querySelector<HTMLElement>(`[data-testid="dropdown-option-${id}"]`);
        const node = row === null ? null : row.hasAttribute('role') ? row : row.querySelector('[role]') ?? row.closest('[role]');
        return [node?.getAttribute('role'), node?.getAttribute('aria-checked')];
      };
      expect(announced('where')).toEqual(['menuitemcheckbox', 'true']);
      expect(announced('words')).toEqual(['menuitemcheckbox', 'false']);
      expect(announced('lines_1')).toEqual(['menuitemradio', 'false']);
      expect(announced('lines_2')).toEqual(['menuitemradio', 'true']);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  },
);

// SESSION-ROWS-ACCEPT-1119 fix 4: 2–4 short choices in a menu (Lines 1 · 2 · 3) take one segmented row, built once here:
// its name, then one radio per choice; a press reports that choice.
it('draws a segmented menu row: one radio group named by the row, each choice one press', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const pressed: string[] = [];
  try {
    await act(async () => {
      root.render(
        <SelectableMenuResults
          categories={[{ id: 'view', title: '', items: [{
            id: 'lines', title: 'Lines', testID: 'menu-lines',
            segments: { selectedId: 'lines:2', options: [
              { id: 'lines:1', label: '1' }, { id: 'lines:2', label: '2' }, { id: 'lines:3', label: '3' },
            ] },
          }] }]}
          selectedIndex={-1}
          onSelectionChange={() => {}}
          onPressItem={(item) => { pressed.push(item.id); }}
          rowVariant="slim"
        />,
      );
    });
    const group = container.querySelector<HTMLElement>('[role="radiogroup"]');
    expect(group?.getAttribute('aria-label')).toBe('Lines');
    const radios = [...group!.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.map((radio) => radio.textContent)).toEqual(['1', '2', '3']);
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    await act(async () => { radios[2]!.click(); });
    expect(pressed).toEqual(['lines:3']);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
