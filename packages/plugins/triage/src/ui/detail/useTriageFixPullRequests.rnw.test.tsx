// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createPluginUiActionControlTestHost, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { describe, expect, it } from 'vitest';

import { useTriageFixPullRequests } from './useTriageFixPullRequests.js';
import { TriageFixPullRequests } from './fixPullRequests.js';
import { TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1, TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1 } from '@happier-dev/triage-protocol/v1';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('host-owned fix-PR write', () => {
  it.each(['unlinked', 'conflict', 'declined', 'failed'] as const)('settles %s through the owner and refreshes its answer', async outcome => {
    const entryRef = { source: { pluginId: 'happier.example.source', localId: 'example-forge' }, kindId: 'pull-request', collisionScope: 'example/repository', entryId: '2490' };
    const secondRef = { ...entryRef, entryId: '2491' };
    const candidates = [entryRef, secondRef].map((ref, index) => ({ entryRef: ref, origins: ['session'], status: 'open', display: { title: `Fix ${index}`, scopeLabel: 'example/repository' } }));
    const calls: unknown[] = [];
    let reads = 0;
    let state!: ReturnType<typeof useTriageFixPullRequests>;
    const controls = createPluginUiActionControlTestHost(async ({ action, input }) => {
      calls.push({ action, input });
      return outcome === 'failed' ? { ok: false, errorCode: 'unavailable', error: 'Unavailable' }
        : outcome === 'declined' ? { ok: false, errorCode: 'approval_rejected', error: 'Declined' }
        : { ok: true, result: { v: 1, status: outcome } };
    });
    let fixture!: Awaited<ReturnType<typeof createPluginUiTestkit>>;
    await act(async () => { fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fix-pr-control', mountNonce: 'fix-pr-control-mount' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      surface: defineUiSurface(() => {
        state = useTriageFixPullRequests({ entryRef, display: { title: 'Finding', scopeLabel: 'Repository' } });
        return state === null ? null : <TriageFixPullRequests state={state} pickable={[]} />;
      }),
      handlers: { actionControl: controls.handler, executeAction: ({ action }) => {
        if (action !== TRIAGE_READ_FIX_PULL_REQUESTS_ACTION_LOCAL_ID_V1) throw new Error('Raw write bypass');
        reads++;
        return { v: 1, candidates, primary: candidates[0], incomplete: false };
      } },
    }); });
    try {
      expect(controls.presentation('Unlink')).toBeDefined();
      expect(calls).toEqual([]);
      await act(async () => { await controls.press('Unlink'); });
      expect(calls).toEqual([{ action: TRIAGE_SET_FIX_PULL_REQUEST_ACTION_LOCAL_ID_V1, input: {
        v: 1, linked: false, entryRef, displayAtMark: { title: 'Finding', scopeLabel: 'Repository' }, fixPullRequest: secondRef,
      } }]);
      expect(state?.kind === 'ready' && state.busy).toBe(false);
      expect(state?.kind === 'ready' ? state.refusal : 'unavailable').toBe(outcome === 'conflict' ? 'conflict' : outcome === 'failed' ? 'failed' : null);
      expect(reads).toBe(2);
    } finally { await act(async () => { await fixture.dispose(); }); }
  });
});
