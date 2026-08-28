// @vitest-environment jsdom

import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
} from '@happier-dev/plugin-sdk/testing';
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const flatListRenderItems = vi.hoisted(() => [] as unknown[]);

// FlatList is the native platform boundary. Keep its real RNW behavior while
// observing the renderer identity that the public List hands to it.
vi.mock('react-native', async (importOriginal) => {
  const reactNative = await importOriginal<typeof import('react-native')>();
  type FlatListProps = React.ComponentProps<typeof reactNative.FlatList>;
  return {
    ...reactNative,
    FlatList: (props: FlatListProps) => {
      flatListRenderItems.push(props.renderItem);
      return React.createElement(reactNative.FlatList, props);
    },
  };
});

// First-party RNW contract coverage consumes the same public testing subpath
// exposed to external authors.
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { renderSurface } from './renderSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type InspectorExecuteActionRequest = Readonly<{
  action: unknown;
  input?: unknown;
}>;

function enterText(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('The RNW semantic fixture did not expose an input value setter.');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function createInspectorSurfaceContext() {
  return createSurfaceContextFixture({
    mount: {
      kind: 'destination',
      destination: { pluginId: 'happier.inspector', localId: 'inspector-app' },
      container: 'rightSidebarTab',
    },
    target: { kind: 'app' },
  });
}

function verticalScrollAncestors(element: HTMLElement): HTMLElement[] {
  const ancestors: HTMLElement[] = [];
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.style.overflowY === 'auto' || ancestor.style.overflowY === 'scroll') {
      ancestors.push(ancestor);
    }
  }
  return ancestors;
}

describe('Inspector public presentation contract', () => {
  beforeEach(() => {
    flatListRenderItems.length = 0;
  });

  it('publishes the settled public Action result for the mounted self-check', async () => {
    const executeAction = vi.fn(async ({ action }: InspectorExecuteActionRequest) => (
      action === 'plugins.list' ? { plugins: [] } : { ok: true }
    ));
    const fixture = await createPluginUiTestkit({
      identity: {
        pluginId: 'happier.inspector',
        pluginVersion: '0.0.0',
        viewId: 'inspector-app',
        generation: 'inspector-self-check-settlement',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createInspectorSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction },
    });
    try {
      await fixture.press(await fixture.findByRole('button', { name: 'Execute Inspector self-check' }));
      await expect(fixture.getByText('Inspector self-check: success')).resolves.toEqual({
        content: 'Inspector self-check: success',
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('does not offer page navigation through its action panel when the mounted host has not negotiated openSurface', async () => {
    const executeAction = vi.fn(async ({ action }: InspectorExecuteActionRequest) => {
      if (action === 'plugins.list') return { plugins: [] };
      return { ok: true };
    });
    const fixture = await createPluginUiTestkit({
      identity: {
        pluginId: 'happier.inspector',
        pluginVersion: '0.0.0',
        viewId: 'inspector-app',
        generation: 'inspector-without-open-surface-contract',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createInspectorSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction },
    });

    try {
      await expect(fixture.queryByRole('button', { name: 'Open inspector page' })).resolves.toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });

  it('offers page navigation through its action panel only when the mounted host has negotiated openSurface', async () => {
    const executeAction = vi.fn(async ({ action }: InspectorExecuteActionRequest) => {
      if (action === 'plugins.list') return { plugins: [] };
      return { ok: true };
    });
    const openSurface = vi.fn(async () => undefined);
    const fixture = await createPluginUiTestkit({
      identity: {
        pluginId: 'happier.inspector',
        pluginVersion: '0.0.0',
        viewId: 'inspector-app',
        generation: 'inspector-with-open-surface-contract',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createInspectorSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction, openSurface },
    });

    try {
      const inspectorActions = await fixture.getAllByRole('button', { name: 'Inspector actions' });
      await fixture.press(inspectorActions[0]!);
      await fixture.press(await fixture.findByRole('button', { name: 'Open inspector page' }));

      await vi.waitFor(() => {
        expect(openSurface).toHaveBeenCalledWith(expect.objectContaining({
          view: { pluginId: 'happier.inspector', localId: 'inspector-page' },
          input: { source: 'inspector-action-panel' },
        }));
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('renders the admitted inventory without a bulk reload path and dispatches only the selected row reload action through the public host boundary', async () => {
    const executeAction = vi.fn(async ({ action }: InspectorExecuteActionRequest) => {
      if (action === 'plugins.list') {
        return {
          plugins: [{
            pluginId: 'com.acme.review-assistant',
            version: '1.2.3',
            title: 'Review Assistant',
            enabled: true,
          }],
        };
      }
      if (action === 'plugins.reload') {
        return { ok: true, generation: 2, changedPluginIds: [], affectedPluginIds: [] };
      }
      return { ok: true };
    });
    const fixture = await createPluginUiTestkit({
      identity: {
        pluginId: 'happier.inspector',
        pluginVersion: '0.0.0',
        viewId: 'inspector-app',
        generation: 'inspector-presentation-contract',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createInspectorSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction },
    });

    try {
      await expect(fixture.queryByRole('button', { name: 'Reload all' })).resolves.toBeUndefined();
      const inspectorActionTriggers = await fixture.getAllByRole('button', { name: 'Inspector actions' });
      await fixture.press(inspectorActionTriggers[0]!);
      await expect(fixture.queryByText('Reload all')).resolves.toBeUndefined();

      const plugin = await fixture.findByRole('option', {
        name: 'Review Assistant',
        state: { selected: false },
      });
      await fixture.press(plugin);
      const pluginReload = await fixture.findByRole('button', { name: 'Reload Review Assistant' });

      await fixture.press(pluginReload);

      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'plugins.reload',
          input: { pluginId: 'com.acme.review-assistant' },
        }));
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'plugins.list', input: {} }));
      });
      const reloadRequests = executeAction.mock.calls
        .map(([request]) => request)
        .filter((request) => request.action === 'plugins.reload');
      expect(reloadRequests.map((request) => request.input)).toEqual([
        { pluginId: 'com.acme.review-assistant' },
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  it('uses the virtualized public List as the sole populated scroll owner', async () => {
    const executeAction = vi.fn(async ({ action }: InspectorExecuteActionRequest) => action === 'plugins.list'
      ? {
          plugins: [{
            pluginId: 'com.acme.review-assistant',
            title: 'Review Assistant',
            enabled: true,
          }],
        }
      : { ok: true });
    const fixture = await createPluginUiTestkit({
      identity: {
        pluginId: 'happier.inspector',
        pluginVersion: '0.0.0',
        viewId: 'inspector-app',
        generation: 'inspector-scroll-owner-contract',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createInspectorSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction },
    });

    try {
      await expect(fixture.findByRole('option', {
        name: 'Review Assistant',
        state: { selected: false },
      })).resolves.toBeDefined();

      const listbox = document.querySelector<HTMLElement>('[role="listbox"][aria-label="Installed plugins"]');
      expect(listbox, 'the populated Inspector List must be the surface scroll owner').not.toBeNull();
      expect(listbox?.dataset.testid).toBe('inspector-surface');
      expect(verticalScrollAncestors(listbox!)).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });

  it('uses public Image for a non-brand packaged illustration with an accessible fallback', async () => {
    const executeAction = vi.fn(async ({ action }: InspectorExecuteActionRequest) => action === 'plugins.list'
      ? { plugins: [] }
      : { ok: true });
    const fixture = await createPluginUiTestkit({
      identity: {
        pluginId: 'happier.inspector',
        pluginVersion: '0.0.0',
        viewId: 'inspector-app',
        generation: 'inspector-image-contract',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createInspectorSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction },
    });

    try {
      await expect(fixture.getByText('No plugins installed.')).resolves.toEqual({
        content: 'No plugins installed.',
      });
      const inventoryIllustration = document.querySelector<HTMLElement>(
        '[data-testid="inspector-inventory-illustration"]',
      );
      expect(inventoryIllustration, 'Inspector must maintain a public generic Image consumer').not.toBeNull();
      expect(inventoryIllustration?.getAttribute('aria-label')).toBe('Plugin inventory illustration');
      expect(inventoryIllustration?.tagName).not.toBe('IMG');
      await expect(fixture.getByText('PI')).resolves.toEqual({ content: 'PI' });
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps the admitted inventory visible and reports an in-flight refresh through the public Progress contract', async () => {
    let listReadCount = 0;
    let resolveRefresh!: (result: unknown) => void;
    const pendingRefresh = new Promise<unknown>((resolve) => {
      resolveRefresh = resolve;
    });
    const reviewAssistant = {
      pluginId: 'com.acme.review-assistant',
      version: '1.2.3',
      title: 'Review Assistant',
      enabled: true,
    };
    const executeAction = vi.fn(async ({ action }: InspectorExecuteActionRequest) => {
      if (action !== 'plugins.list') return { ok: true };
      listReadCount += 1;
      return listReadCount === 1
        ? { plugins: [reviewAssistant] }
        : pendingRefresh;
    });
    const fixture = await createPluginUiTestkit({
      identity: {
        pluginId: 'happier.inspector',
        pluginVersion: '0.0.0',
        viewId: 'inspector-app',
        generation: 'inspector-refresh-progress-contract',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createInspectorSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction },
    });

    try {
      await expect(fixture.findByRole('option', {
        name: 'Review Assistant',
        state: { selected: false },
      })).resolves.toBeDefined();

      const settledRenderItem = flatListRenderItems.at(-1);
      expect(settledRenderItem).toBeTypeOf('function');

      const refreshActions = await fixture.getAllByRole('button', {
        name: 'Refresh plugin inventory',
      });
      await React.act(async () => {
        await fixture.press(refreshActions[0]!);
      });

      await vi.waitFor(() => {
        expect(listReadCount).toBe(2);
      });
      await expect(fixture.getByRole('progressbar', {
        name: 'Refreshing plugin inventory',
      })).resolves.toEqual({
        role: 'progressbar',
        name: 'Refreshing plugin inventory',
      });
      await expect(fixture.getByRole('option', {
        name: 'Review Assistant',
        state: { selected: false },
      })).resolves.toBeDefined();
      expect(flatListRenderItems.at(-1), 'refresh chrome must preserve the virtualized row renderer')
        .toBe(settledRenderItem);

      await React.act(async () => {
        resolveRefresh({ plugins: [reviewAssistant] });
        await Promise.resolve();
      });
      await vi.waitFor(async () => {
        await expect(fixture.queryByRole('progressbar', {
          name: 'Refreshing plugin inventory',
        })).resolves.toBeUndefined();
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('filters through the public List before virtualization and never reloads a filtered-out selection', async () => {
    const executeAction = vi.fn(async ({ action }: InspectorExecuteActionRequest) => {
      if (action === 'plugins.list') {
        return {
          plugins: [{
            pluginId: 'com.acme.review-assistant',
            version: '1.2.3',
            title: 'Review Assistant',
            enabled: true,
          }, {
            pluginId: 'com.acme.terminal-helper',
            version: '2.0.0',
            title: 'Terminal Helper',
            enabled: false,
          }],
        };
      }
      if (action === 'plugins.reload') {
        return { ok: true, generation: 2, changedPluginIds: [], affectedPluginIds: [] };
      }
      return { ok: true };
    });
    const fixture = await createPluginUiTestkit({
      identity: {
        pluginId: 'happier.inspector',
        pluginVersion: '0.0.0',
        viewId: 'inspector-app',
        generation: 'inspector-search-selection-contract',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createInspectorSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction },
    });

    try {
      const review = await fixture.findByRole('option', {
        name: 'Review Assistant',
        state: { selected: false },
      });
      await expect(fixture.getByText('com.acme.review-assistant · v1.2.3 · enabled')).resolves.toEqual({
        content: 'com.acme.review-assistant · v1.2.3 · enabled',
      });
      await expect(fixture.getByText('com.acme.terminal-helper · v2.0.0 · disabled')).resolves.toEqual({
        content: 'com.acme.terminal-helper · v2.0.0 · disabled',
      });
      await fixture.press(review);
      await expect(fixture.getByRole('button', { name: 'Reload Review Assistant' })).resolves.toBeDefined();

      const search = document.querySelector<HTMLInputElement>('[data-testid="inspector-plugin-search"]');
      expect(search, 'the maintained Inspector surface must expose its public search control').not.toBeNull();
      await React.act(async () => { enterText(search!, 'disabled'); });

      await expect(fixture.queryByRole('option', { name: 'Review Assistant' })).resolves.toBeUndefined();
      await expect(fixture.queryByRole('button', { name: 'Reload Review Assistant' })).resolves.toBeUndefined();

      const terminal = await fixture.findByRole('option', {
        name: 'Terminal Helper',
        state: { selected: false },
      });
      await fixture.press(terminal);
      await fixture.press(await fixture.findByRole('button', { name: 'Reload Terminal Helper' }));

      await vi.waitFor(() => {
        expect(executeAction).toHaveBeenCalledWith(expect.objectContaining({
          action: 'plugins.reload',
          input: { pluginId: 'com.acme.terminal-helper' },
        }));
      });
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps the author-local selection when a refresh temporarily omits its row', async () => {
    let listReadCount = 0;
    const reviewAssistant = {
      pluginId: 'com.acme.review-assistant',
      version: '1.2.3',
      title: 'Review Assistant',
      enabled: true,
    };
    const executeAction = vi.fn(async ({ action }: InspectorExecuteActionRequest) => {
      if (action === 'plugins.list') {
        listReadCount += 1;
        return { plugins: listReadCount === 2 ? [] : [reviewAssistant] };
      }
      if (action === 'plugins.reload') {
        return { ok: true, generation: listReadCount + 1, changedPluginIds: [], affectedPluginIds: [] };
      }
      return { ok: true };
    });
    const fixture = await createPluginUiTestkit({
      identity: {
        pluginId: 'happier.inspector',
        pluginVersion: '0.0.0',
        viewId: 'inspector-app',
        generation: 'inspector-selection-currentness-contract',
        sessionId: 'session-1',
      },
      surface: renderSurface,
      surfaceContext: createInspectorSurfaceContext(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction },
    });

    try {
      const review = await fixture.findByRole('option', {
        name: 'Review Assistant',
        state: { selected: false },
      });
      await fixture.press(review);
      await fixture.press(await fixture.findByRole('button', { name: 'Reload Review Assistant' }));

      await vi.waitFor(async () => {
        expect(await fixture.getByText('No plugins installed.')).toEqual({ content: 'No plugins installed.' });
      });
      await expect(fixture.queryByRole('button', { name: 'Reload Review Assistant' })).resolves.toBeUndefined();

      const refreshActions = await fixture.getAllByRole('button', { name: 'Refresh plugin inventory' });
      await fixture.press(refreshActions[0]!);

      await expect(fixture.findByRole('option', {
        name: 'Review Assistant',
        state: { selected: true },
      })).resolves.toBeDefined();
      await expect(fixture.findByRole('button', { name: 'Reload Review Assistant' })).resolves.toBeDefined();
    } finally {
      await fixture.dispose();
    }
  });
});
