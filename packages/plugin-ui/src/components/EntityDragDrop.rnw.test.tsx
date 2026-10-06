import * as React from 'react';
import { describe, expect, it } from 'vitest';
import type { PluginUiEntityDropDestinationV1, PluginUiUpdateEntityDragDropRequestV1 } from '@happier-dev/plugin-sdk/ui';

import { mountThroughReactNativeWebAsync } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { DragSource } from './EntityDragDrop.js';

async function source() {
  const context = createSurfaceContext();
  const requests: PluginUiUpdateEntityDragDropRequestV1[] = [];
  const destination: PluginUiEntityDropDestinationV1 = { targetId: 'queue', destination: { kind: 'center' },
    admission: { status: 'allowed', effect: { actionId: 'example.copy', input: {},
      preview: { verb: 'Copy', target: 'Review', glyph: 'copy' } } } };
  // The hosted transport is the system boundary; retain the real SDK binding and shared grip.
  const hostApi = createHostApiStub(context, {
    updateEntityDragDrop: async request => {
      requests.push(request);
      return request.kind === 'destinations' ? { accepted: true, destinations: [destination] } : { accepted: true };
    },
    watchEntityDragDrop: async () => ({ dispose() {} }),
  });
  const mounted = await mountThroughReactNativeWebAsync(<PluginUiProvider hostApi={hostApi} context={context}>
    <DragSource sourceId="issue" reference="issue-42" organizing testID="source"><span>Issue #42</span></DragSource>
  </PluginUiProvider>);
  const grip = mounted.container.querySelector<HTMLElement>('[data-testid="source-grip"]')!;
  return { mounted, grip, requests };
}

async function key(grip: HTMLElement, value: string) {
  await React.act(async () => {
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
    grip.dispatchEvent(new KeyboardEvent('keyup', { key: value, bubbles: true, cancelable: true }));
  });
}

describe('hosted Organize grip through shared interaction', () => {
  it('stages and commits from the focused grip without reopening the chooser on key release', async () => {
    const { mounted, grip, requests } = await source();
    try {
      React.act(() => { grip.focus(); });
      expect(document.activeElement).toBe(grip);
      expect(grip.getAttribute('aria-haspopup')).toBe('menu');
      await key(grip, ' ');
      expect(requests.some(request => request.kind === 'begin' && request.input === 'keyboard')).toBe(true);
      expect(requests.some(request => request.kind === 'choose' && request.targetId === 'queue')).toBe(true);
      expect(mounted.container.querySelector('[role="status"]')?.textContent).toContain('Review');
      await key(grip, 'Enter');
      expect(requests.filter(request => request.kind === 'commit')).toHaveLength(1);
      expect(grip.getAttribute('aria-expanded')).toBe('false');
      expect(mounted.container.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(grip);
    } finally { mounted.unmount(); }
  });

  it('cancels a staged move without issuing an Action commit', async () => {
    const { mounted, grip, requests } = await source();
    try {
      await key(grip, ' ');
      await key(grip, 'Escape');
      expect(requests.some(request => request.kind === 'cancel')).toBe(true);
      expect(requests.some(request => request.kind === 'commit' || request.kind === 'perform')).toBe(false);
      expect(mounted.container.querySelector('[role="status"]')?.textContent).toBe('');
    } finally { mounted.unmount(); }
  });
});
