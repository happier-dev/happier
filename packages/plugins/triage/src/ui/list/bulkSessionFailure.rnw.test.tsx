// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { Button, defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { useTriageBulkEntrySessions } from './useBulkEntrySessions.js';
import { TRIAGE_DEFAULT_ACTIONS_V1 } from '../../settings/actions.js';
import { testkitEntryRef } from '../../corpus/testkit/observations.test-support.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it('presents a bulk authoring failure Code and Request ID through the existing notification owner', async () => {
  const received: unknown[] = [];
  const notifications: string[] = [];
  const entryRef = testkitEntryRef();
  function Surface() {
    const controller = useTriageBulkEntrySessions();
    return <Button title="Start bulk" onPress={() => controller.run({
      action: TRIAGE_DEFAULT_ACTIONS_V1.find(action => action.actionId === 'fix')!, destination: 'attachAllToNewSession',
      entries: [{ key: 'one', entryRef, workflowSubject: 'issue', display: { scopeLabel: 'example', locator: { v: 1 } },
        sourceInstance: { source: entryRef.source, sourceInstanceId: '11111111-1111-4111-8111-111111111111' }, presentation: { label: 'Issue' } }],
    })} />;
  }
  const page = await createPluginUiTestkit({ identity: { instanceId: 'bulk-authoring-failure', mountNonce: 'one' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: defineUiSurface(Surface),
    surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    handlers: { executeAction: async ({ action }) => { if (action === 'projects.list') return { items: [], truncated: false };
        throw new Error('Unexpected Action'); },
      openNewSession: async () => { throw new PluginError({ code: 'authoring_unavailable', details: { requestId: 'bulk-ui-17' } }); },
      presentActionFailure: async ({ failure }) => { received.push(failure); return { reason: 'Cannot open', nextStep: 'Try again', technicalDetails: [
        { key: 'code', label: 'Code', value: failure.errorCode }, { key: 'requestId', label: 'Request ID', value: failure.requestId! },
      ] }; }, notify: async ({ message }) => { notifications.push(message); } },
  });
  try {
    await act(async () => { await page.press(await page.getByRole('button', { name: 'Start bulk' })); });
    await vi.waitFor(() => expect(notifications.join(' ')).toContain('bulk-ui-17'));
    expect(received).toEqual([expect.objectContaining({ errorCode: 'authoring_unavailable', requestId: 'bulk-ui-17' })]);
    expect(notifications.join(' ')).toContain('authoring_unavailable');
    expect(notifications.join(' ')).toContain('bulk-ui-17');
  } finally { await act(async () => { await page.dispose(); }); }
});
