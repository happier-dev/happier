// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface, usePluginHostApi } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { presentTriageMountedUiActionFailure } from './mountedActions.js';
import { useLinkedSessionOpen } from './detail/useLinkedSessionOpen.js';
import { SessionIdSchema } from '@happier-dev/plugin-sdk/sessions';
import { useTriageSourcePanelActionsV1 } from './useSourcePanelActions.js';
import type { TriageSourcePanelActionsV1 } from '@happier-dev/triage-sources/ui';
import { createTriageEphemeralSharedScopeFixture } from './window/ephemeralSharedScope.test-support.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('carries a mounted source-panel refusal to the canonical presenter and visible notification', async () => {
  const received: unknown[] = [];
  const notifications: string[] = [];
  const error = new PluginError({ code: 'source_busy', message: 'Source is busy',
    details: { requestId: 'mounted-request' }, remediation: { kind: 'retry' } });
  let actions!: TriageSourcePanelActionsV1;
  const scope = createTriageEphemeralSharedScopeFixture();
  function Surface() {
    const host = usePluginHostApi();
    actions = useTriageSourcePanelActionsV1(scope, 'failure-test', 'issue', true, host).actions;
    return null;
  }
  let page!: Awaited<ReturnType<typeof createPluginUiTestkit>>;
  await act(async () => {
    page = await createPluginUiTestkit({ identity: { instanceId: 'failure', mountNonce: 'failure' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: defineUiSurface(Surface),
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async () => { throw error; },
        presentActionFailure: async ({ failure }) => { received.push(failure); return {
          reason: 'Source is busy', nextStep: 'Retry later', technicalDetails: [
            { key: 'code', label: 'Code', value: failure.errorCode },
            { key: 'requestId', label: 'Request ID', value: failure.requestId! },
          ] }; }, notify: async ({ message }) => { notifications.push(message); } },
    });
  });
  try {
    await actions.execute({ kind: 'loadMoreSourceItems', list: 'comments' });
    expect(received).toEqual([expect.objectContaining({ errorCode: 'source_busy', requestId: 'mounted-request' })]);
    expect(notifications.join(' ')).toContain('source_busy');
    expect(notifications.join(' ')).toContain('mounted-request');
    expect(notifications.join(' ')).toContain('Retry later');
    received.length = 0;
    notifications.length = 0;
    await presentTriageMountedUiActionFailure(page.context.hostApi, error, (_key, fallback) => fallback);
    expect(received).toEqual([expect.objectContaining({ errorCode: 'source_busy', requestId: 'mounted-request',
      remediation: { kind: 'retry' } })]);
    expect(notifications.join(' ')).toContain('mounted-request');
  } finally { await act(async () => { await page.dispose(); }); }
});


it('presents a linked Session navigation failure with its Code and Request ID', async () => {
  const received: unknown[] = [];
  let linked!: ReturnType<typeof useLinkedSessionOpen>;
  function Surface() { linked = useLinkedSessionOpen(); return null; }
  let page!: Awaited<ReturnType<typeof createPluginUiTestkit>>;
  await act(async () => {
    page = await createPluginUiTestkit({ identity: { instanceId: 'linked-failure', mountNonce: 'failure' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: defineUiSurface(Surface),
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async () => { throw new PluginError({ code: 'session_unavailable',
        details: { requestId: 'linked-session-request' } }); },
        presentActionFailure: async ({ failure }) => { received.push(failure); return {
          reason: 'Session unavailable', nextStep: null, technicalDetails: [{ key: 'code', label: 'Code', value: failure.errorCode },
            { key: 'requestId', label: 'Request ID', value: failure.requestId! }] }; }, notify: async () => {} },
    });
  });
  try {
    await act(async () => { await linked.open(SessionIdSchema.parse('session-ref')); });
    expect(received).toEqual([expect.objectContaining({ errorCode: 'session_unavailable', requestId: 'linked-session-request' })]);
  } finally { await act(async () => { await page.dispose(); }); }
});
