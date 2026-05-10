import { describe, expect, it } from 'vitest';

import type { SessionActionSelectorRow } from './SessionActionSelector';

type SelectorModule = typeof import('./SessionActionSelector') & {
  findNextSessionActionSelectorIndex?: (
    rows: ReadonlyArray<SessionActionSelectorRow>,
    start: number,
    direction: 1 | -1,
  ) => number;
  resolveSessionActionSelectorDisabledGroupLabel?: (actionVerb: string) => string;
  resolveSessionActionSelectorViewport?: (
    params: Readonly<{
      rowCount: number;
      selectedIndex: number;
      terminalRows: number | null | undefined;
    }>,
  ) => Readonly<{ startIndex: number; endIndex: number; visibleCount: number }>;
  resolveSessionActionSelectorIndicator?: (params: Readonly<{
    disabled?: boolean;
    isSelected: boolean;
  }>) => string;
  resolveSessionActionSelectorEnterResult?: (
    row: SessionActionSelectorRow | null | undefined,
    actionVerb: string,
  ) => Readonly<{ type: 'selected'; sessionId: string } | { type: 'blocked'; message: string } | { type: 'none' }>;
};

const rows: SessionActionSelectorRow[] = [
  { sessionId: 'enabled', agentId: 'codex', updatedAt: 3, title: 'Enabled', path: '/repo' },
  {
    sessionId: 'remote-probe',
    agentId: 'opencode',
    updatedAt: 2,
    title: 'Remote',
    path: '/repo',
    disabled: true,
    probeable: true,
  },
  {
    sessionId: 'disabled',
    agentId: 'codex',
    updatedAt: 1,
    title: 'Disabled',
    path: '/repo',
    disabled: true,
  },
];

describe('SessionActionSelector model helpers', () => {
  it('arrow navigation can reach disabled and probeable rows', async () => {
    const mod = await import('./SessionActionSelector') as SelectorModule;

    expect(typeof mod.findNextSessionActionSelectorIndex).toBe('function');
    expect(mod.findNextSessionActionSelectorIndex?.(rows, 0, 1)).toBe(1);
    expect(mod.findNextSessionActionSelectorIndex?.(rows, 1, 1)).toBe(2);
    expect(mod.findNextSessionActionSelectorIndex?.(rows, 2, 1)).toBe(0);
  });

  it('uses the current action verb for the disabled group label', async () => {
    const mod = await import('./SessionActionSelector') as SelectorModule;

    expect(typeof mod.resolveSessionActionSelectorDisabledGroupLabel).toBe('function');
    expect(mod.resolveSessionActionSelectorDisabledGroupLabel?.('attach')).toBe('Cannot attach');
    expect(mod.resolveSessionActionSelectorDisabledGroupLabel?.('resume')).toBe('Cannot resume');
  });

  it('clamps visible rows around the selected index', async () => {
    const mod = await import('./SessionActionSelector') as SelectorModule;

    expect(typeof mod.resolveSessionActionSelectorViewport).toBe('function');
    expect(mod.resolveSessionActionSelectorViewport?.({
      rowCount: 50,
      selectedIndex: 25,
      terminalRows: 18,
    })).toEqual({ startIndex: 16, endIndex: 26, visibleCount: 10 });
  });

  it('shows the selector marker on selected disabled rows', async () => {
    const mod = await import('./SessionActionSelector') as SelectorModule;

    expect(typeof mod.resolveSessionActionSelectorIndicator).toBe('function');
    expect(mod.resolveSessionActionSelectorIndicator?.({ isSelected: true, disabled: true })).toBe('› ');
    expect(mod.resolveSessionActionSelectorIndicator?.({ isSelected: false, disabled: true })).toBe('  ');
  });

  it('turns Enter on a disabled selected row into visible feedback instead of a no-op', async () => {
    const mod = await import('./SessionActionSelector') as SelectorModule;

    expect(typeof mod.resolveSessionActionSelectorEnterResult).toBe('function');
    expect(mod.resolveSessionActionSelectorEnterResult?.({
      ...rows[2],
      disabledReason: 'This session cannot be attached from here.',
    }, 'attach')).toEqual({
      type: 'blocked',
      message: 'This session cannot be attached from here.',
    });
  });
});
