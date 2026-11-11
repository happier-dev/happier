// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TaskWriteNotice } from './TaskWriteNotice.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); });

it.each(['refused', 'uncertain'] as const)('discloses a %s write cause and request without losing settlement meaning', async kind => {
  const result = kind === 'refused'
    ? { kind, reason: 'action_forbidden', message: 'Your access to this task changed.', requestId: 'write-request', actionHandlerInvocation: 'notStarted' as const }
    : { kind, message: 'The source connection closed before confirmation.', failure: { class: 'unknown' as const, code: 'outcome_unknown', requestId: 'write-request' } };
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'task-notice', mountNonce: kind },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => <TaskWriteNotice result={result} context={{ sourceName: 'Linear', operation: 'edit' }} />),
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    });
  });
  mounted.push(fixture);
  expect(document.body.textContent).toContain(kind === 'uncertain' ? 'may have saved' : 'This change is not available');
  expect(document.body.textContent).toContain(result.message);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Details' })); });
  expect(document.body.textContent).toContain('Code');
  expect(document.body.textContent).toContain(kind === 'refused' ? result.reason : result.failure!.code);
  expect(document.body.textContent).toContain('Request ID');
  expect(document.body.textContent).toContain('write-request');
});
