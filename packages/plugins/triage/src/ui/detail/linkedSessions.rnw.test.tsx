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
let releaseOpen: (() => void) | null = null;
let blockOpen = false;
let selectedSessionId: string | null = null;

const renderHeader = defineUiSurface(function LinkedSessionHeader(_context: RenderContext): React.ReactElement {
  return (
    <TriageLinkedSessions
      sessions={[
        { sessionId: 'session-linked', displayTitle: 'Route repair' },
        { sessionId: 'session-other', displayTitle: 'Parser cleanup' },
      ]}
      hasMore
      onSelect={(sessionId) => { selectedSessionId = sessionId; }}
      onLoadMore={() => {}}
    />
  );
});

const mounted: PluginUiTestkit[] = [];

async function mountHeader() {
  calls.length = 0;
  openFails = false;
  releaseOpen = null;
  blockOpen = false;
  selectedSessionId = null;
  const fixture = await createPluginUiTestkit({
    identity: { instanceId: 'fixture-instance-175', mountNonce: 'fixture-mount-175' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: renderHeader,
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    handlers: {
      executeAction: async ({ action, input }) => {
        calls.push({ action: String(action), input });
        if (blockOpen) {
          await new Promise<void>((resolve) => { releaseOpen = resolve; });
        }
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
  it('selects the inline Session independently from the explicit Open operation and its retryable failure', async () => {
    const header = await mountHeader();
    openFails = true;

    await expect(header.getByRole('button', { name: 'Load more' })).resolves.toBeDefined();

    await act(async () => {
      await header.press(await header.getByRole('button', { name: 'Route repair' }));
    });

    expect(selectedSessionId).toBe('session-linked');
    expect(calls).toEqual([]);
    await act(async () => {
      await header.press(await header.getByRole('button', { name: 'Open session Route repair' }));
    });

    expect(calls).toEqual([{ action: 'session.open', input: { sessionId: 'session-linked' } }]);
    const failedRow = await header.getByRole('button', { name: 'Route repair' });
    expect(failedRow.name).toBe('Route repair');
    await expect(header.getByText('This Session could not be opened.')).resolves.toBeDefined();
    const failedButton = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]'))
      .find((button) => button.getAttribute('aria-label') === 'Route repair');
    expect(failedButton?.textContent).toContain('This Session could not be opened.');

    openFails = false;
    await act(async () => {
      await header.press(await header.getByRole('button', { name: 'Open session Route repair' }));
    });
    expect(calls).toHaveLength(2);
    await expect(header.queryByText('This Session could not be opened.')).resolves.toBeUndefined();
  });

  it('describes unavailable rows while another Session is opening', async () => {
    const header = await mountHeader();
    blockOpen = true;

    await act(async () => {
      await header.press(await header.getByRole('button', { name: 'Open session Route repair' }));
      await Promise.resolve();
    });

    const unavailable = await header.getByRole('button', {
      name: 'Parser cleanup',
      state: { disabled: true },
    });
    expect(unavailable.state?.disabled).toBe(true);
    await expect(header.getByText('Another Session is opening.')).resolves.toBeDefined();
    const unavailableButton = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]'))
      .find((button) => button.getAttribute('aria-label') === 'Parser cleanup');
    expect(unavailableButton?.textContent).toContain('Another Session is opening.');

    const release = releaseOpen;
    if (release === null) throw new Error('the Session open did not reach the host');
    await act(async () => {
      release();
      await Promise.resolve();
    });
  });
});
