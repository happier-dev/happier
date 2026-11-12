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

async function mount(state: TriageFixPullRequestsStateV1, pickable: React.ComponentProps<typeof TriageFixPullRequests>['pickable'] = []) {
  return createPluginUiTestkit({
    identity: { instanceId: 'fix-pr-state', mountNonce: 'fix-pr-state-mount' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: defineUiSurface(() => <TriageFixPullRequests state={state} pickable={pickable} />),
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(),
  });
}

describe('fix-PR relationship read states', () => {
  it('reports the initial read and a failed read with explicit retry', async () => {
    const reading = await mount({ kind: 'reading' });
    try {
      // The read is one quiet line inside the story, like its failure below, never a page-sized loader.
      await expect(reading.getByText('Looking for a fix pull request…')).resolves.toBeDefined();
      await expect(reading.queryByRole('progressbar')).resolves.toBeUndefined();
      // The chapter keeps its heading while it reads, so nothing after it shifts or renumbers.
      expect(document.querySelector('[data-testid="triage-story-fix-pr"]')?.textContent).toContain('Fix pull request');
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
      link: () => undefined, unlink: () => undefined, unlinkControl: () => ({ prepare: () => null, onSettled() {} }),
    });
    try {
      const step = document.querySelector('[data-testid="triage-story-fix-pr"]');
      expect(step).not.toBeNull();
      expect(step?.textContent).toContain('Round totals on the server');
      expect(step?.textContent).toContain('Merged');
      // Unlink is a rare correction, kept behind the card's ⋯ so the card offers one press (lab c8 fix card).
      await expect(ready.queryByRole('button', { name: 'Unlink Round totals on the server' })).resolves.toBeUndefined();
      await expect(ready.getByRole('button', { name: 'More for Round totals on the server' })).resolves.toBeDefined();
    } finally { await ready.dispose(); }
  });

  it('keeps the fix as the story\'s second step before one is linked, offering the link there', async () => {
    const entryRef = { source: { pluginId: 'happier.example.source', localId: 'example-forge' }, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '2490' };
    const empty = await mount({
      kind: 'ready', candidates: [], primary: null, incomplete: false, busy: false, refusal: null,
      link: () => undefined, unlink: () => undefined, unlinkControl: () => ({ prepare: () => null, onSettled() {} }),
    }, [{ entryRef, title: 'Round totals on the server', scopeLabel: 'example/repository' }]);
    try {
      const step = document.querySelector('[data-testid="triage-story-fix-pr"]');
      expect(step?.textContent).toContain('Fix pull request');
      expect(step?.textContent).toContain('No pull request is linked as the fix yet.');
      await expect(empty.getByRole('button', { name: 'Link fix PR' })).resolves.toBeDefined();
    } finally { await empty.dispose(); }
    // With nothing to offer the chapter still stands, so the story's numbering never skips it.
    const nothing = await mount({
      kind: 'ready', candidates: [], primary: null, incomplete: false, busy: false, refusal: null,
      link: () => undefined, unlink: () => undefined, unlinkControl: () => ({ prepare: () => null, onSettled() {} }),
    });
    try {
      expect(document.querySelector('[data-testid="triage-story-fix-pr"]')?.textContent).toContain('No pull request is linked as the fix yet.');
    } finally { await nothing.dispose(); }
  });

  it('draws the linked fix as a card with one Open pull request, named by its number', async () => {
    const entryRef = { source: { pluginId: 'happier.example.source', localId: 'example-forge' }, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '2512' };
    const candidate = { entryRef, origins: ['session' as const], status: 'open' as const,
      display: { title: 'Bump express', scopeLabel: 'example/repository', displayPath: 'example/repository #2512' } };
    let opened = 0;
    const fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fix-pr-open', mountNonce: 'fix-pr-open-mount' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => <TriageFixPullRequests pickable={[]} onOpenPrimary={() => { opened += 1; }} state={{
        kind: 'ready', candidates: [candidate], primary: candidate, incomplete: false, busy: false, refusal: null,
        link: () => undefined, unlink: () => undefined, unlinkControl: () => ({ prepare: () => null, onSettled() {} }),
      }} />),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    });
    try {
      await expect(fixture.getByText('Fix #2512')).resolves.toBeDefined();
      await expect(fixture.getByText('Bump express')).resolves.toBeDefined();
      // An open pull request is waiting, not work in progress: its marker is a settled hollow mark, never a spinner.
      await expect(fixture.queryByRole('progressbar')).resolves.toBeUndefined();
      await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Open pull request' })); });
      expect(opened).toBe(1);
    } finally { await fixture.dispose(); }
  });
});
