// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { describe, expect, it } from 'vitest';

import { TriageFixPullRequests } from './fixPullRequests.js';
import type { TriageFixPullRequestsStateV1 } from './useTriageFixPullRequests.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(state: TriageFixPullRequestsStateV1) {
  return createPluginUiTestkit({
    identity: { instanceId: 'fix-pr-state', mountNonce: 'fix-pr-state-mount' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: defineUiSurface(() => <TriageFixPullRequests state={state} pickable={[]} />),
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(),
  });
}

describe('fix-PR relationship read states', () => {
  it('reports the initial read and a failed read with explicit retry', async () => {
    const reading = await mount({ kind: 'reading' });
    try {
      await expect(reading.getByRole('progressbar')).resolves.toBeDefined();
    } finally { await reading.dispose(); }
    let retries = 0;
    const unreachable = await mount({ kind: 'unreachable', retry: () => { retries += 1; } });
    try {
      await expect(unreachable.getByText('Fix pull request links could not be read.')).resolves.toBeDefined();
      // A failed read is a quiet line with its Retry inside the story, never a full-page error block.
      await expect(unreachable.queryByRole('alert')).resolves.toBeUndefined();
      await act(async () => { await unreachable.press(await unreachable.getByRole('button', { name: 'Retry: Fix pull request' })); });
      expect(retries).toBe(1);
    } finally { await unreachable.dispose(); }
  });

  it('is a story step named after the fix, with its state as the marker and Unlink kept quiet', async () => {
    const entryRef = { source: { pluginId: 'happier.example.source', localId: 'example-forge' }, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '2490' };
    const candidate = { entryRef, origins: ['session' as const], status: 'merged' as const, display: { title: 'Round totals on the server', scopeLabel: 'example/repository' } };
    const ready = await mount({
      kind: 'ready', candidates: [candidate], primary: candidate, incomplete: false, busy: false, refusal: null,
      link: () => undefined, unlink: () => undefined,
    });
    try {
      const step = document.querySelector('[data-testid="triage-story-fix-pr"]');
      expect(step).not.toBeNull();
      expect(step?.textContent).toContain('Round totals on the server');
      expect(step?.textContent).toContain('Merged');
      await expect(ready.getByRole('button', { name: 'Unlink Round totals on the server' })).resolves.toBeDefined();
    } finally { await ready.dispose(); }
  });
});
