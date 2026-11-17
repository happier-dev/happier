import { act } from 'react';
import type { PluginUiHostApi, SessionStateV1 } from '@happier-dev/plugin-sdk/ui';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWebAsync } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { SessionCard } from './SessionCard.js';

const SESSION: SessionStateV1 = {
  sessionId: 'linked', title: 'Review the change', lifecycle: 'active',
  runtime: 'working', operational: 'working', pendingPermissions: [],
  workStatus: { state: 'thinking', bucket: 'working', tone: 'neutral', attentionType: null, word: 'Working' },
};

describe('SessionCard read facts', () => {
  it('distinguishes a read failure from confirmed absence and follows recovery', async () => {
    let fail = true;
    let invalidate: Parameters<PluginUiHostApi['watchSession']>[1] | undefined;
    const base = createHostApiStub();
    const context = createSurfaceContext();
    const hostApi = createHostApiStub(context, {
      version: () => ({ ...base.version(), methods: ['readSession', 'watchSession'] }),
      readSession: async () => {
        if (fail) throw new Error('Host unavailable');
        return SESSION;
      },
      watchSession: async (_id, listener) => {
        invalidate = listener;
        return { dispose() {} };
      },
    });
    const view = await mountThroughReactNativeWebAsync(
      <PluginUiProvider hostApi={hostApi} context={context}>
        <SessionCard sessionId="linked" onOpen={() => {}} />
      </PluginUiProvider>,
    );
    try {
      expect(view.container.textContent).toContain('Session unavailable');
      expect(view.container.textContent).not.toContain('Session not found');
      fail = false;
      await act(async () => {
        invalidate!({ version: 1, subscriptionId: 'linked', kind: 'invalidated', digest: 'recovered' });
      });
      expect(view.container.textContent).toContain(SESSION.title);
      expect(view.container.textContent).toContain('Working');
    } finally { view.unmount(); }
  });

  it.each([
    { supported: true, expected: 'Session not found' },
    { supported: false, expected: 'Session unavailable' },
  ])('renders the owner result when read support is $supported', async ({ supported, expected }) => {
    const base = createHostApiStub();
    const context = createSurfaceContext();
    const hostApi = createHostApiStub(context, {
      version: () => ({ ...base.version(), methods: supported ? ['readSession'] : [] }),
      readSession: async () => null,
    });
    const view = await mountThroughReactNativeWebAsync(
      <PluginUiProvider hostApi={hostApi} context={context}>
        <SessionCard sessionId="linked" onOpen={() => {}} />
      </PluginUiProvider>,
    );
    try { expect(view.container.textContent).toContain(expected); }
    finally { view.unmount(); }
  });
});
