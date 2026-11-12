// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { presentActionFailure } from '@happier-dev/plugin-sdk/ui';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { triageTaskWriteInvocationFailureV1 } from '../../actions/taskWriteFailure.js';
import { TriageTaskWriteResultV1Schema } from '@happier-dev/triage-protocol/v1';
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


it('presents a transported PluginError refusal through the host, retaining recovery and correlation', async () => {
  const error = new PluginError({ code: 'source_busy', message: 'The source is busy.',
    remediation: { kind: 'retry' }, retryable: true, details: { requestId: 'refused-request', remedy: 'Try later.' } });
  Object.assign(error, { actionHandlerInvocation: 'notStarted' });
  const result = TriageTaskWriteResultV1Schema.parse(triageTaskWriteInvocationFailureV1(error));
  const received: unknown[] = [];
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'task-host-notice', mountNonce: 'refused' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => <TaskWriteNotice result={result} />),
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { presentActionFailure: async ({ failure }) => {
        received.push(failure);
        return { reason: 'Presented source refusal', nextStep: 'Retry from the source', technicalDetails: [] };
      } },
    });
  });
  mounted.push(fixture);
  expect(result).toMatchObject({ message: error.message, details: { remediation: { kind: 'retry' } }, retryable: true });
  expect(received).toEqual([expect.objectContaining({ errorCode: error.code, error: error.message,
    message: error.message, remediation: { kind: 'retry' }, requestId: 'refused-request',
    details: error.details })]);
  expect(document.body.textContent).toContain('Presented source refusal');
  expect(document.body.textContent).toContain('Retry from the source');
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Details' })); });
  expect(document.body.textContent).toContain('Code');
  expect(document.body.textContent).toContain('source_busy');
  expect(document.body.textContent).toContain('Request ID');
  expect(document.body.textContent).toContain('refused-request');
});

it('retains an uncertain PluginError request without claiming a refused effect', async () => {
  const result = TriageTaskWriteResultV1Schema.parse(triageTaskWriteInvocationFailureV1(new PluginError({
    code: 'source_disconnected', details: { requestId: 'uncertain-request' },
  })));
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'task-uncertain', mountNonce: 'uncertain' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => <TaskWriteNotice result={result} />),
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    });
  });
  mounted.push(fixture);
  expect(document.body.textContent).toContain('may have saved');
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Details' })); });
  expect(document.body.textContent).toContain('uncertain-request');
});


it('keeps the authored message and technical references on a host without failure presentation', async () => {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'older-task-host', mountNonce: 'fallback' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface: defineUiSurface(() => null),
      surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    });
  });
  mounted.push(fixture);
  await expect(presentActionFailure(fixture.context.hostApi, { ok: false, errorCode: 'credential_unavailable',
    message: 'Sign in to the source.', requestId: 'older-request' })).resolves.toMatchObject({
      reason: 'Sign in to the source.', technicalDetails: expect.arrayContaining([
        expect.objectContaining({ value: 'credential_unavailable' }), expect.objectContaining({ value: 'older-request' }),
      ]),
    });
});


it('leaves code-only refusals to the host fallback instead of claiming an authored reason', () => {
  const error = new PluginError({ code: 'credential_unavailable' });
  Object.assign(error, { actionHandlerInvocation: 'notStarted' });
  const result = TriageTaskWriteResultV1Schema.parse(triageTaskWriteInvocationFailureV1(error));
  expect(result.kind).toBe('refused');
  expect('message' in result ? result.message : undefined).toBeUndefined();
});
