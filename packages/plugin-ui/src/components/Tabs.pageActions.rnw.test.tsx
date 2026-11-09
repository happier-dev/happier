import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createPluginUiTestkit, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginUiRnwSemanticSurfaceAdapter } from '../testing/index.js';
import { createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { defineUiSurface } from '../surfaceEntry.js';
import { Tabs } from './Tabs.js';
import { Text } from './Text.js';

describe('page Tabs Action bridge', () => {
  it('selects the requested local panel when the optional shell selection rejects', async () => {
    const diagnostic = vi.fn();
    const surface = defineUiSurface(() => {
      const [value, setValue] = useState('session');
      return <Tabs presentation="page" pageKind={{ pluginId: 'happier.triage', localId: 'entry' }} value={value} onValueChange={setValue} ariaLabel="Entry">
        <Tabs.Item value="overview" title="Overview"><Text value="Overview body" /></Tabs.Item>
        <Tabs.Item value="session" title="Session"><Text value="Session body" /></Tabs.Item>
      </Tabs>;
    });
    let fixture: PluginUiTestkit | undefined;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'page-rejection', mountNonce: 'page-rejection' },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface,
        surfaceContext: createSurfaceContext(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: { setPageNavigation: async () => {}, diagnostic,
          executeAction: async () => { throw new PluginError({ code: 'unavailable',
            diagnostics: [{ code: 'client_control_unavailable', severity: 'warning' }] }); } },
      });
    });
    const shell = fixture!;
    try {
      await act(async () => { await shell.press(await shell.getByRole('tab', { name: 'Overview' })); });
      await vi.waitFor(() => expect(document.body.textContent).toContain('Overview body'));
      expect(document.querySelector('[role="tablist"]')).not.toBeNull();
      expect(diagnostic).toHaveBeenCalledOnce();
    } finally { await act(async () => { await shell.dispose(); }); }
  });
  it('routes the hosted strip and desktop More through Actions, excludes hidden items, and opens the mounted customizer', async () => {
    const pageKind = { pluginId: 'happier.triage', localId: 'entry' };
    const chosen = vi.fn();
    const actions: unknown[] = [];
    let fixture: PluginUiTestkit | undefined;
    const surface = defineUiSurface(() => {
      const [value, setValue] = useState('overview');
      return <Tabs presentation="page" pageKind={pageKind} value={value} onValueChange={next => {
        chosen(next); setValue(next);
      }} ariaLabel="Entry">
        <Tabs.Item value="overview" title="Overview"><Text value="Overview body" /></Tabs.Item>
        <Tabs.Item value="activity" title="Activity"><Text value="Activity body" /></Tabs.Item>
        <Tabs.Item value="files" title="Files"><Text value="Files body" /></Tabs.Item>
        <Tabs.Item value="checks" title="Checks"><Text value="Checks body" /></Tabs.Item>
      </Tabs>;
    });
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'page-actions', mountNonce: 'page-actions' },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface,
        surfaceContext: createSurfaceContext({ page: { columnVisible: true, navigation: {
          pageKind, tabIds: ['overview', 'activity'], overflowIds: ['files'], presentation: 'local',
        } } }),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
        handlers: {
          setPageNavigation: async ({ navigation }) => {
            if (!fixture || !navigation) return;
            const current = await fixture.context.hostApi.context();
            await fixture.updateSurface({ ...current, page: { ...current.page!, navigation: {
              ...current.page!.navigation!, request: null,
            } } });
          },
          // The host Action transport is the genuine process boundary. The
          // mounted owner and settings presenter have host integration coverage.
          executeAction: async ({ action, input }) => {
            actions.push({ action, input });
            if (action === 'shell.column.set' && input && typeof input === 'object' && 'tab' in input && typeof input.tab === 'string') {
              const current = await fixture!.context.hostApi.context();
              await fixture!.updateSurface({ ...current, page: { ...current.page!, navigation: {
                ...current.page!.navigation!, request: input.tab,
              } } });
            }
            return { ok: true };
          },
        },
      });
    });
    const shell = fixture!;
    const press = async (role: 'tab' | 'button' | 'menuitem', name: string) => {
      await act(async () => { await shell.press(await shell.getByRole(role, { name })); });
    };
    try {
      await press('tab', 'Activity');
      await vi.waitFor(() => expect(actions[0]).toEqual({ action: 'shell.column.set', input: { column: 'main', visible: true, tab: 'activity' } }));
      expect(chosen).toHaveBeenCalledExactlyOnceWith('activity');
      // The trigger is the glyph alone: "More" is its accessible name and never drawn beside it.
      expect(document.querySelector('[role="button"][aria-label="More"]')?.textContent).not.toContain('More');
      await press('button', 'More');
      expect(document.querySelector('[role="menu"]')?.textContent).toContain('Files');
      expect(document.querySelector('[role="menu"]')?.textContent).not.toContain('Checks');
      await press('menuitem', 'Files');
      await vi.waitFor(() => expect(document.body.textContent).toContain('Files body'));
      expect(chosen.mock.calls).toEqual([['activity'], ['files']]);
      await press('button', 'More');
      await press('menuitem', 'Customize');
      expect(actions.at(-1)).toEqual({ action: 'settings.invoke', input: { anchor: 'appearance.navigationPlacements' } });
      const current = await shell.context.hostApi.context();
      await act(async () => { await shell.updateSurface({ ...current, page: { ...current.page!, navigation: {
        ...current.page!.navigation!, presentation: 'top', tabIds: ['overview'],
      } } }); });
      expect(document.querySelector('[aria-label="More"]')).toBeNull();
      expect([...document.querySelectorAll('[role="tab"]')].map(tab => tab.textContent)).toEqual(['Overview']);
      expect(chosen).toHaveBeenCalledTimes(2);
    } finally { await act(async () => { await shell.dispose(); }); }
  });
});
