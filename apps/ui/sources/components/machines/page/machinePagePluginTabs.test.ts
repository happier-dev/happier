import { describe, expect, it } from 'vitest';

import { buildPluginMachinePageRoutePath } from '@/components/plugins/pages/pluginPageRoute';

import { machinePageHref } from './machinePageHref';
import {
  isMachinePageTabRoot,
  machinePageTabKey,
  machinePageTabRouteParams,
} from './machinePageTabQuery';
import {
  MACHINE_PAGE_TABS,
  machinePagePluginTabEntry,
  machinePageTabEntryKey,
  resolveMachinePageTab,
} from './machinePageTabs';

const target = { serverId: 'home-a', machineId: 'shop-prod' };
const sandboxes = machinePagePluginTabEntry({
  pluginId: 'happier.machine-docker-sandboxes',
  localId: 'sandboxes',
  label: 'Sandboxes',
});
const tabs = [...MACHINE_PAGE_TABS, sandboxes];

/** The query a router hands the page for an href (path params aside). */
function queryOf(href: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(href.split('?')[1] ?? ''));
}

describe('Machine page plugin tabs', () => {
  it('opens the plugin page a qualified destination link names, at its own location', () => {
    const href = buildPluginMachinePageRoutePath({
      ...target,
      pluginId: sandboxes.pluginId,
      localId: 'sandboxes',
      subPath: 'runs/fix-checkout',
    });
    const resolved = resolveMachinePageTab(queryOf(href), tabs);
    expect(resolved.entry).toBe(sandboxes);
    expect(resolved.params).toEqual({
      id: 'plugin',
      pluginId: 'happier.machine-docker-sandboxes',
      localId: 'sandboxes',
      pluginPath: 'runs/fix-checkout',
    });
    // The tab is page state: the same encoder writes it in place and as a link, so they never drift.
    expect(
      machinePageHref({ door: 'rail', target, tab: resolved.params }),
    ).toBe(href);
    expect(isMachinePageTabRoot(resolved.params)).toBe(false);
    expect(
      isMachinePageTabRoot({
        id: 'plugin',
        pluginId: sandboxes.pluginId,
        localId: 'sandboxes',
      }),
    ).toBe(true);
  });

  it('keeps two pages of one plugin, and one page id across plugins, apart', () => {
    const other = machinePagePluginTabEntry({
      pluginId: 'acme.tools',
      localId: 'sandboxes',
      label: 'Sandboxes',
    });
    const resolved = resolveMachinePageTab(
      { tab: 'plugin', pluginId: 'acme.tools', localId: 'sandboxes' },
      [...tabs, other],
    );
    expect(resolved.entry).toBe(other);
    expect(machinePageTabEntryKey(other)).not.toBe(
      machinePageTabEntryKey(sandboxes),
    );
    expect(machinePageTabKey(resolved.params)).toBe(
      machinePageTabEntryKey(other),
    );
    // Core tabs keep their ids as keys, so the strip and the retained bodies address both alike.
    expect(machinePageTabEntryKey(MACHINE_PAGE_TABS.find(tab => tab.id === 'processes')!)).toBe('processes');
  });

  it('never answers a plugin link with Overview while that page is not in the catalog yet', () => {
    const resolved = resolveMachinePageTab(
      { tab: 'plugin', pluginId: 'acme.tools', localId: 'later' },
      MACHINE_PAGE_TABS,
    );
    expect(resolved.params).toEqual({
      id: 'plugin',
      pluginId: 'acme.tools',
      localId: 'later',
    });
    expect(resolved.entry.id).toBe('plugin');
    // A malformed plugin link is still a tolerant read: the page opens on Overview.
    expect(
      resolveMachinePageTab({ tab: 'plugin', pluginId: 'acme.tools' }, tabs)
        .entry.id,
    ).toBe('overview');
    expect(
      resolveMachinePageTab(
        { tab: 'plugin', pluginId: 'a/b', localId: 'x' },
        tabs,
      ).entry.id,
    ).toBe('overview');
  });

  it('clears a plugin page from the query when another tab opens in place', () => {
    const next = machinePageTabRouteParams({ id: 'processes' });
    expect(next).toMatchObject({
      tab: 'processes',
      pluginId: undefined,
      localId: undefined,
      pluginPath: undefined,
    });
    expect(Object.keys(next)).toEqual(
      expect.arrayContaining(['pluginId', 'localId', 'pluginPath']),
    );
  });
});
