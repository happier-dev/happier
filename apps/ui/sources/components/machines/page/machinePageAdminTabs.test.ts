import { describe, expect, it } from 'vitest';

import { machinePageHref } from './machinePageHref';
import { MACHINE_PAGE_TABS, resolveMachinePageTab } from './machinePageTabs';
import {
  MACHINE_THIS_MACHINE_PAGES,
  machineSubPageMovedToTab,
} from './machineSubPages';

const target = { serverId: 'home-a', machineId: 'shop-prod' };

/** The query a router hands the page for an href (path params aside). */
function queryOf(href: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(href.split('?')[1] ?? ''));
}

describe('MACH-COMPOSE D1: the Machine admin surfaces live in the tab bar', () => {
  it('lists Setup then Security after Guard, so a person finds them without scrolling the Overview', () => {
    const ids = MACHINE_PAGE_TABS.map((entry) => entry.id);
    expect(ids.indexOf('setup')).toBe(ids.indexOf('guard') + 1);
    expect(ids.indexOf('security')).toBe(ids.indexOf('setup') + 1);
  });

  it.each([
    [{ id: 'security' }],
    [{ id: 'security', page: 'network' }],
    [{ id: 'security', page: 'sharing' }],
    [{ id: 'security', page: 'isolation' }],
    [{ id: 'security', page: 'isolation', add: 'sessions' }],
    [{ id: 'sandboxes' }],
    [{ id: 'setup' }],
    [{ id: 'setup', page: 'tools' }],
  ] as const)('opens %j from its own link, in both doors', (tab) => {
    for (const door of ['rail', 'settings'] as const) {
      const resolved = resolveMachinePageTab(
        queryOf(machinePageHref({ door, target, tab })),
      );
      expect(resolved.entry.id).toBe(tab.id);
      expect(resolved.params).toEqual(tab);
    }
  });

  it('reads an unknown Security page as the tab itself', () => {
    expect(
      resolveMachinePageTab({ tab: 'security', page: 'firewall' }).params,
    ).toEqual({ id: 'security' });
  });

  it('keeps only the Machine’s own settings and diagnostics in This machine', () => {
    expect(MACHINE_THIS_MACHINE_PAGES).not.toContain('security');
    expect(MACHINE_THIS_MACHINE_PAGES).not.toContain('network');
    expect(MACHINE_THIS_MACHINE_PAGES).not.toContain('sharing');
    expect(MACHINE_THIS_MACHINE_PAGES).not.toContain('installables');
  });

  it('leads an older Security, Network or Sharing page link to its place in the Security tab', () => {
    expect(machineSubPageMovedToTab('security')).toEqual({ id: 'security' });
    expect(machineSubPageMovedToTab('network')).toEqual({
      id: 'security',
      page: 'network',
    });
    expect(machineSubPageMovedToTab('sharing')).toEqual({
      id: 'security',
      page: 'sharing',
    });
    expect(machineSubPageMovedToTab('installables')).toEqual({ id: 'setup', page: 'tools' });
    expect(machineSubPageMovedToTab('doctor')).toBeNull();
    expect(machineSubPageMovedToTab(undefined)).toBeNull();
  });
});
