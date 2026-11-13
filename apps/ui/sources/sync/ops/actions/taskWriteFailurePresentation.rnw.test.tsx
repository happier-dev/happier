// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriageTaskWriteResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { TaskWriteNotice } from '../../../../../../packages/plugins/triage/src/ui/detail/TaskWriteNotice.js';
import { triageTaskWriteInvocationFailureV1 } from '../../../../../../packages/plugins/triage/src/actions/taskWriteFailure.js';
import { presentActionExecutionFailure } from './resolveActionExecutionFailureMessage';
import { t } from '@/text';

// Use the real RNW platform adapter instead of the unit harness's native host tags.
vi.mock('react-native', () => vi.importActual<typeof import('react-native-web')>('react-native-web'));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('renders authored task refusal and recovery through the real host presenter and discloses its request', async () => {
  const error = new PluginError({ code: 'credential_unavailable', message: 'Sign in to the task source.',
    remediation: { kind: 'retry' }, details: { requestId: 'task-host-request' } });
  Object.assign(error, { actionHandlerInvocation: 'notStarted' });
  const result = TriageTaskWriteResultV1Schema.parse(triageTaskWriteInvocationFailureV1(error));
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'task-real-host', mountNonce: 'refused' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => <TaskWriteNotice result={result} />),
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { presentActionFailure: ({ failure }) => presentActionExecutionFailure(failure) },
    });
  });
  try {
    expect(document.body.textContent).toContain('This change is not available');
    expect(document.body.textContent).toContain(`Sign in to the task source. ${t('errors.tryAgain')}`);
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Details' })); });
    expect(document.body.textContent).toContain('Code');
    expect(document.body.textContent).toContain('credential_unavailable');
    expect(document.body.textContent).toContain('Request ID');
    expect(document.body.textContent).toContain('task-host-request');
  } finally { await act(async () => { await fixture.dispose(); }); }
});
