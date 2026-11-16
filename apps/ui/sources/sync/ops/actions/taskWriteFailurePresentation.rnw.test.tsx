// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { Action, defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriageTaskWriteResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { createGithubTaskWriteTestkit } from '@happier-dev/plugins-scm-github/testkit';
import { TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1, TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1 } from '@happier-dev/plugins-triage/testkit';
import { TaskWriteNotice } from '../../../../../../packages/plugins/triage/src/ui/detail/TaskWriteNotice.js';
import { useTriageTaskCommit } from '../../../../../../packages/plugins/triage/src/ui/detail/taskWrite.js';
import { createTaskActionControlTestkit } from '../../../../../../packages/plugins/triage/src/ui/detail/taskActionControl.test-support.js';
import { createTriageEphemeralSharedScopeOriginFixture } from '../../../../../../packages/plugins/triage/src/ui/window/ephemeralSharedScope.test-support.js';
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

it.each(['refused', 'uncertain'] as const)('retains a real GitHub %s write through Task controls, notice and recovery', async kind => {
  const source = await createGithubTaskWriteTestkit(kind);
  const action = kind === 'refused' ? TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1 : TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1;
  const address = { entryRef: { source: source.source, ...source.localRef },
    sourceInstanceId: source.instance.instance.sourceInstanceId, lastKnownLocator: source.locator };
  const input = { v: 1, ...address, ...(kind === 'refused'
    ? { transitionId: 'not_planned', fieldValues: [] } : { fields: { title: 'Changed', labelIds: ['bug'] } }) };
  let write!: ReturnType<typeof useTriageTaskCommit>;
  let fixture: Awaited<ReturnType<typeof createTaskActionControlTestkit>> | undefined;
  let transported: ReturnType<typeof TriageTaskWriteResultV1Schema.parse> | undefined;
  let invocation: { action: unknown; input: unknown } | undefined;
  let invocationError: unknown;
  const lifetime = createTriageEphemeralSharedScopeOriginFixture();
  const opened: string[] = [];
  try {
    await act(async () => {
      fixture = await createTaskActionControlTestkit({
        identity: { instanceId: 'task-source-host', mountNonce: kind },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' },
        surface: defineUiSurface(() => {
          write = useTriageTaskCommit(async () => undefined, address);
          const current = write;
          const sourceUrl = current.result?.kind === 'uncertain' ? current.result.observation?.locator.webUrl : undefined;
          return <>
            <Action.Control action={action} title="Save task" controller={{
              prepare: () => current.prepare(action, input),
              onSettled: execution => { current.settle(execution); },
            }} />
            <TaskWriteNotice result={current.result} onCheckAgain={current.checkAgain} sourceUrl={sourceUrl}
              context={{ sourceName: 'GitHub', operation: 'edit' }} />
          </>;
        }),
        surfaceContext: createSurfaceContextFixture(),
        adapter: controls => createPluginUiRnwSemanticSurfaceAdapter({ actionBindings: controls,
          ephemeralSharedScope: lifetime.forExecutionOrigin('surface') }),
        handlers: {
          // The CLI/plugin process transport serializes the registered source's real result;
          // only the source testkit's vendor HTTP and credential boundaries are substituted.
          executeAction: async request => {
            invocation = { action: request.action, input: request.input };
            try {
              transported = TriageTaskWriteResultV1Schema.parse(JSON.parse(JSON.stringify(
                await source.plugin.invokeAction(source.writeAction, source.writeInput, { surface: 'ui' }),
              )));
              return transported;
            } catch (error) { invocationError = error; throw error; }
          },
          presentActionFailure: ({ failure }) => presentActionExecutionFailure(failure),
          openExternalLink: async ({ url }) => { opened.push(url); },
        },
      });
    });
    const mounted = fixture;
    if (!mounted) throw new Error('Expected the Task UI to mount');
    await act(async () => { await mounted.press(await mounted.getByRole('button', { name: 'Save task' })); });

    await vi.waitFor(() => {
      expect(invocationError).toBeUndefined();
      expect(transported).toBeDefined();
    });
    expect(invocation).toEqual({ action, input });
    await vi.waitFor(() => expect(write.result).toEqual(transported));
    expect(write.result).toMatchObject(kind === 'refused' ? { kind: 'refused', reason: 'state_changed' }
      : { kind: 'uncertain', failure: { class: 'permission', code: 'github_forbidden' },
        observation: { kind: 'present', snapshot: { title: 'Changed' } } });
    expect(document.body.textContent).toContain(kind === 'refused' ? 'This change is not available' : 'may have saved');
    await act(async () => { await mounted.press(await mounted.getByRole('button', { name: 'Details' })); });
    expect(document.body.textContent).toContain(source.expectedCode);
    expect(source.readIssueReadCount()).toBeGreaterThan(0);
    const writes = source.readWrites();
    expect(writes).toEqual(kind === 'refused' ? []
      : [{ method: 'PATCH', body: { title: 'Changed' } }, { method: 'POST', body: { labels: ['bug'] } }]);
    if (kind === 'uncertain') {
      await expect(mounted.getByRole('button', { name: 'Check again' })).resolves.toBeDefined();
      await act(async () => { await mounted.press(await mounted.getByRole('button', { name: 'Save task' })); });
      expect(write.result).toEqual(transported);
      await act(async () => { await mounted.press(await mounted.getByRole('button', { name: 'Open in GitHub' })); });
      const expectedUrl = transported?.kind === 'uncertain' ? transported.observation?.locator.webUrl : undefined;
      expect(expectedUrl).toBeTypeOf('string');
      expect(opened).toEqual([expectedUrl]);
      expect(source.readWrites()).toEqual(writes);
    }
  } finally {
    await act(async () => { await fixture?.dispose(); });
    lifetime.retire();
    await source.plugin.dispose();
  }
});
