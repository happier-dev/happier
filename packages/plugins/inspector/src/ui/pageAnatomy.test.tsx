// @vitest-environment jsdom

import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkitExecuteActionInput,
} from '@happier-dev/plugin-sdk/testing';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { describe, expect, it, vi } from 'vitest';

import { renderSurface } from './renderSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Configuration-surfaces U9: on its full page the Inspector is the maintained
 * plugin consumer of the public page anatomy — `PageHeader` and titled
 * `ItemGroup` sections — while its pane placements keep their compact stack.
 */
function createContext(container: 'appPage' | 'rightSidebarTab') {
  return createSurfaceContextFixture({
    mount: {
      kind: 'destination',
      destination: { pluginId: 'happier.inspector', localId: container === 'appPage' ? 'inspector-page' : 'inspector-app' },
      container,
    },
    target: { kind: 'app' },
  });
}

async function mount(container: 'appPage' | 'rightSidebarTab') {
  const executeAction = vi.fn(async ({ action }: PluginUiTestkitExecuteActionInput): Promise<JsonValue> => action === 'plugins.list'
    ? { plugins: [] }
    : { ok: true });
  return createPluginUiTestkit({
    identity: { instanceId: `fixture-${container}`, mountNonce: `mount-${container}` },
    authorPlugin: { id: 'happier.inspector', version: '0.0.0' },
    surface: renderSurface,
    surfaceContext: createContext(container),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    handlers: { executeAction },
  });
}

describe('Inspector page anatomy', () => {
  it('opens its full page with the public page header and titled sections', async () => {
    const fixture = await mount('appPage');
    try {
      await expect(fixture.getByText('No plugins installed.')).resolves.toEqual({ content: 'No plugins installed.' });
      await expect(fixture.getByRole('heading', { name: 'Plugin Inspector' })).resolves.toMatchObject({ role: 'heading' });
      await expect(fixture.getByText('Overview')).resolves.toEqual({ content: 'Overview' });
      await expect(fixture.getByRole('heading', { name: 'Surface health' })).resolves.toMatchObject({ role: 'heading' });
      await expect(fixture.getByRole('heading', { name: 'Plugin inventory' })).resolves.toMatchObject({ role: 'heading' });
      // The pane's compact heading stack is not drawn on the page.
      expect(document.querySelector('[data-testid="inspector-title"]')).toBeNull();
      expect(document.querySelector('[data-testid="inspector-self-check-action"]')).not.toBeNull();
    } finally {
      await fixture.dispose();
    }
  });

  it('keeps the compact heading stack in a pane placement', async () => {
    const fixture = await mount('rightSidebarTab');
    try {
      await expect(fixture.getByText('No plugins installed.')).resolves.toEqual({ content: 'No plugins installed.' });
      expect(document.querySelector('[data-testid="inspector-page-header"]')).toBeNull();
      expect(document.querySelector('[data-testid="inspector-title"]')).not.toBeNull();
    } finally {
      await fixture.dispose();
    }
  });
});
