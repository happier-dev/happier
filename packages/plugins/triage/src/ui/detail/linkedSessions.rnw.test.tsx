// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TriageLinkedSessions } from './linkedSessions.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const calls: Array<Readonly<{ action: string; input: unknown }>> = [];
let openFails = false;

const renderHeader = defineUiSurface(function LinkedSessionHeader(_context: RenderContext): React.ReactElement {
  return (
    <TriageLinkedSessions
      sessions={[{ sessionId: 'session-linked', displayTitle: 'Route repair' }]}
      hasMore
      onLoadMore={() => {}}
    />
  );
});

const mounted: PluginUiTestkit[] = [];

async function mountHeader() {
  calls.length = 0;
  openFails = false;
  const fixture = await createPluginUiTestkit({
    identity: {
      pluginId: 'happier.triage',
      pluginVersion: '0.0.0',
      viewId: 'linked-session-header',
      generation: 'test-generation',
    },
    surface: renderHeader,
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    handlers: {
      executeAction: async ({ action, input }) => {
        calls.push({ action: String(action), input });
        if (openFails) throw new Error('open failed');
        return {};
      },
    },
  });
  mounted.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('common-header linked Sessions', () => {
  it('opens the exact linked Session and renders a local retryable failure', async () => {
    const header = await mountHeader();
    openFails = true;

    await expect(header.getByRole('button', { name: 'Load more' })).resolves.toBeDefined();

    await act(async () => {
      await header.press(await header.getByRole('button', { name: 'Route repair' }));
    });

    expect(calls).toEqual([{ action: 'session.open', input: { sessionId: 'session-linked' } }]);
    await expect(header.getByText('This Session could not be opened.')).resolves.toBeDefined();

    openFails = false;
    await act(async () => {
      await header.press(await header.getByRole('button', { name: 'Route repair' }));
    });
    expect(calls).toHaveLength(2);
    await expect(header.queryByText('This Session could not be opened.')).resolves.toBeUndefined();
  });
});
