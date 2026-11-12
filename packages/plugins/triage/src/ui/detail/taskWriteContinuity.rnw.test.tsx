// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit, type PluginUiTestkitHostHandlers } from '@happier-dev/plugin-sdk/testing';
import { Action, defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { testkitEntryRef, testkitObservation } from '../../corpus/testkit/observations.test-support.js';
import { createTriageEphemeralSharedScopeOriginFixture } from '../window/ephemeralSharedScope.test-support.js';
import { useTriageTaskCommit, TriageTaskStatusLabel } from './taskFields.js';
import { createPluginClientTestkit, type PluginClientTestkit } from '@happier-dev/plugin-sdk/testing';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { activate } from '../../actions/mountedUi.js';
import { checkTriageTaskWrite } from './taskWrite.js';
import { commitTaskWriteForTest } from './taskActionControl.test-support.js';
import { PluginError } from '@happier-dev/plugin-sdk';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
const clients: PluginClientTestkit[] = [];
afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
  for (const client of clients.splice(0)) await client.dispose();
});

it.each([
  ['tasks/create-v1', 'unavailable'], ['tasks/edit-v1', 'unavailable'], ['tasks/transition-v1', 'unavailable'],
  ['tasks/create-v1', 'cancelled'], ['tasks/create-v1', 'denied'],
] as const)(
  'keeps a typed %s refusal distinct from a %s response lost after dispatch', async (action, responseCode) => {
    let write!: ReturnType<typeof useTriageTaskCommit>;
    let notStarted = true;
    let attempts = 0;
    await act(async () => {
      mounted.push(await createPluginUiTestkit({
        identity: { instanceId: `refused-${action}`, mountNonce: 'one' },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' },
        surface: defineUiSurface(() => {
          write = useTriageTaskCommit(async () => undefined);
          return <Text value={write.result?.kind ?? 'idle'} />;
        }),
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: { executeAction: () => {
          attempts++;
          if (notStarted) return { kind: 'refused', reason: 'plugin_action_current_intent_unavailable' };
          throw new PluginError({ code: responseCode, retryable: false });
        } },
      }));
    });
    await act(async () => { await commitTaskWriteForTest(mounted.at(-1)!.context.hostApi, write, action, {}); });
    expect(write.result).toMatchObject({ kind: 'refused', reason: 'plugin_action_current_intent_unavailable' });
    // A deliberate retry is available after a proven refusal; no automatic replay occurs.
    expect(attempts).toBe(1);
    notStarted = false;
    await act(async () => { await commitTaskWriteForTest(mounted.at(-1)!.context.hostApi, write, action, {}); });
    expect(write.result).toEqual({ kind: 'uncertain', failure: { class: 'unknown', code: responseCode } });
    await act(async () => { await commitTaskWriteForTest(mounted.at(-1)!.context.hostApi, write, action, {}); });
    expect(attempts).toBe(2);
  },
);

it('permits a deliberate retry after the mounted host confirms the handler did not start', async () => {
  let write!: ReturnType<typeof useTriageTaskCommit>;
  let attempts = 0;
  await act(async () => {
    mounted.push(await createPluginUiTestkit({
      identity: { instanceId: 'confirmed-dispatch-evidence', mountNonce: 'one' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => {
        write = useTriageTaskCommit(async () => undefined);
        return <Text value={write.result?.kind ?? 'idle'} />;
      }),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: () => {
        attempts++;
        const error = new PluginError({ code: 'plugin_action_current_intent_unavailable', retryable: false });
        // Genuine host boundary shape: cli-common/registration/actionHandlerInvocation.ts.
        throw Object.assign(error, { actionHandlerInvocation: 'notStarted',
          data: { ...error.data, actionHandlerInvocation: 'notStarted' } });
      } },
    }));
  });
  await act(async () => { await commitTaskWriteForTest(mounted.at(-1)!.context.hostApi, write, 'tasks/create-v1', {}); });
  expect(write.result).toMatchObject({ kind: 'refused', reason: 'plugin_action_current_intent_unavailable' });
  expect(attempts).toBe(1);
  await act(async () => { await commitTaskWriteForTest(mounted.at(-1)!.context.hostApi, write, 'tasks/create-v1', {}); });
  expect(attempts).toBe(2);
});

it('holds a lost create response across remounts of the same scoped draft without replaying the write', async () => {
  let write!: ReturnType<typeof useTriageTaskCommit>;
  let showDraft!: React.Dispatch<React.SetStateAction<boolean>>;
  let mutations = 0;
  const entryRef = testkitEntryRef();
  const create = { v: 1, source: entryRef.source, sourceInstanceId: testkitObservation().sourceInstanceId,
    kindId: entryRef.kindId, fields: { title: 'A task' } } as const;
  function Draft() {
    write = useTriageTaskCommit(async () => undefined, { draftId: 'admitted-draft' });
    return <Text value={write.result?.kind ?? 'idle'} />;
  }
  await act(async () => {
    mounted.push(await createPluginUiTestkit({
      identity: { instanceId: 'create-continuity', mountNonce: 'one' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => {
        const [shown, setShown] = React.useState(true);
        showDraft = setShown;
        return shown ? <Draft /> : <Text value="closed" />;
      }),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: createTriageEphemeralSharedScopeOriginFixture().forExecutionOrigin('surface') }),
      handlers: { executeAction: () => { mutations++; return { kind: 'uncertain' }; } },
    }));
  });
  await act(async () => { await commitTaskWriteForTest(mounted.at(-1)!.context.hostApi, write, 'tasks/create-v1', create); });
  expect(write.result?.kind).toBe('uncertain');
  await act(async () => { showDraft(false); });
  await act(async () => { showDraft(true); });
  expect(write.result?.kind).toBe('uncertain');
  await act(async () => { await commitTaskWriteForTest(mounted.at(-1)!.context.hostApi, write, 'tasks/create-v1', create); });
  expect(mutations).toBe(1);
});

it('retains an uncertain move target across remounts until a source reread confirms it', async () => {
  const entryRef = testkitEntryRef();
  const observation = testkitObservation();
  const scope = createTriageEphemeralSharedScopeOriginFixture().forExecutionOrigin('surface');
  const address = { entryRef, sourceInstanceId: observation.sourceInstanceId };
  let write!: ReturnType<typeof useTriageTaskCommit>;
  let show!: React.Dispatch<React.SetStateAction<boolean>>;
  let confirmed = false;
  const target = { presentation: 'active', nativeLabel: 'Review queue' } as const;
  function Task() {
    write = useTriageTaskCommit(async () => undefined, address);
    return <Text value={write.progress ?? 'idle'} />;
  }
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'uncertain-move', mountNonce: 'one' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => {
        const [shown, setShown] = React.useState(true); show = setShown;
        return shown ? <Task /> : <Text value="closed" />;
      }), surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope }),
      handlers: { executeAction: ({ action }) => {
        if (action === 'tasks/check-write-v1') return checkTriageTaskWrite(scope, entryRef, fixture.context.hostApi,
          new AbortController().signal).then(applied => ({ status: applied ? 'applied' : 'unavailable' }));
        if (action === 'entries/reobserve-v1') {
          if (!confirmed || observation.outcome.kind !== 'present') return { kind: 'unavailable' };
          return { kind: 'observed', entryRef, observation: { ...observation,
            outcome: { ...observation.outcome, snapshot: { ...observation.outcome.snapshot, state: target } } } };
        }
        expect(action).toBe('tasks/transition-v1');
        return { kind: 'uncertain' };
      } },
    }); mounted.push(fixture);
  });
  await act(async () => { await commitTaskWriteForTest(mounted.at(-1)!.context.hostApi, write, 'tasks/transition-v1', { v: 1, ...address, transitionId: 'review' },
    { label: 'Review queue', state: target }); });
  expect(write.progress).toBe('Review queue');
  await act(async () => { show(false); });
  await act(async () => { show(true); });
  await act(async () => { await write.checkAgain(); });
  expect(write.progress).toBe('Review queue');
  confirmed = true;
  await act(async () => { await write.checkAgain(); });
  expect(write.result?.kind).toBe('applied');
  expect(write.progress).toBeNull();
});

it('shares in-flight work and lets a fresh differing read rebase a new edit without replaying the unknown write', async () => {
  const entryRef = testkitEntryRef();
  const observation = testkitObservation();
  const address = { entryRef, sourceInstanceId: observation.sourceInstanceId };
  const writes = new Map<string, ReturnType<typeof useTriageTaskCommit>>();
  const renders = new Map<string, number>();
  let finishWrite!: (value: unknown) => void;
  let checks = 0;
  let mutations = 0;
  let evidence: unknown = { kind: 'unavailable' };
  const lifetime = createTriageEphemeralSharedScopeOriginFixture();
  const scope = lifetime.forExecutionOrigin('surface');
  const declaration = PLUGIN_MANIFEST.contributes.actions.find(action => action.id === 'tasks/check-write-v1');
  expect(declaration?.execution.target).toBe('client');
  if (declaration?.execution.target !== 'client') throw new Error('Missing declared task recovery');
  const target = { ...declaration.execution.client, platform: 'web' as const };
  const client = await createPluginClientTestkit({ manifest: PLUGIN_MANIFEST, target, activate });
  clients.push(client);
  const check = client.registration('actions', declaration.id);
  if (!check) throw new Error('Task recovery is not registered');
  let fixture!: PluginUiTestkit;
  let showTask!: React.Dispatch<React.SetStateAction<boolean>>;
  function Consumer({ name, other = false }: { name: string; other?: boolean }) {
    const write = useTriageTaskCommit(async () => undefined, other
      ? { ...address, entryRef: { ...entryRef, entryId: name } } : address);
    writes.set(name, write);
    renders.set(name, (renders.get(name) ?? 0) + 1);
    return <Text value={`${name}:${write.busy ? 'busy' : write.result?.kind ?? 'idle'}`} />;
  }
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'write-continuity', mountNonce: 'one' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => {
        const [shown, setShown] = React.useState(true);
        showTask = setShown;
        return <>{shown ? <><Consumer name="row" /><Consumer name="detail" />
          <TriageTaskStatusLabel entryRef={entryRef} statusLabel="Open" /></> : null}
          {Array.from({ length: 1_000 }, (_, index) => <Consumer key={index} name={`unrelated-${index}`} other />)}</>;
      }),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope }),
      // Host Action transport is the boundary: the commit, subscriptions and evidence comparison are real.
      handlers: { executeAction: ({ action, input }) => {
        if (action === 'tasks/check-write-v1') return check(input, {
          plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
          contribution: { id: declaration.id, qualifiedId: `${PLUGIN_MANIFEST.id}/actions/${declaration.id}` },
          invocationSurface: 'cli', signal: new AbortController().signal, ui: fixture.context.hostApi,
          ephemeralSharedScope: lifetime.forExecutionOrigin('action'),
        });
        if (action === 'entries/reobserve-v1') { checks++; return evidence; }
        expect(action).toBe('tasks/edit-v1');
        mutations++;
        return new Promise(resolve => { finishWrite = resolve; });
      } },
    });
    mounted.push(fixture);
  });
  const unrelatedRenders = () => [...renders.entries()].filter(([name]) => name.startsWith('unrelated-')).reduce((total, [, count]) => total + count, 0);
  const before = unrelatedRenders();
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = commitTaskWriteForTest(fixture.context.hostApi, writes.get('detail')!, 'tasks/edit-v1', { v: 1, ...address, fields: { title: 'Confirmed title' } });
  });
  expect(writes.get('row')!.busy).toBe(true);
  expect(writes.get('detail')!.busy).toBe(true);
  expect(document.body.textContent).toContain('Saving…');
  expect(unrelatedRenders()).toBe(before);
  await act(async () => { finishWrite({ kind: 'uncertain' }); await pending; });
  expect(writes.get('row')!.result?.kind).toBe('uncertain');
  expect(document.body.textContent).toContain('Not yet confirmed');
  await act(async () => { showTask(false); });
  await act(async () => { showTask(true); });
  expect(writes.get('detail')!.result?.kind).toBe('uncertain');
  await act(async () => { await commitTaskWriteForTest(fixture.context.hostApi, writes.get('row')!, 'tasks/edit-v1', { v: 1, ...address, fields: { title: 'Duplicate' } }); });
  expect(mutations).toBe(1);
  await act(async () => { await writes.get('row')!.checkAgain(); });
  expect(writes.get('detail')!.result?.kind).toBe('uncertain');
  if (observation.outcome.kind !== 'present') throw new Error('Expected present fixture');
  evidence = { kind: 'observed', entryRef, observation, taskFields: { title: 'Still the old title' } };
  await act(async () => { await writes.get('detail')!.checkAgain(); });
  expect(writes.get('row')!.result?.kind).toBe('uncertain');
  // A fresh differing value cannot prove the old write applied, but must allow new intent.
  await act(async () => {
    expect(await commitTaskWriteForTest(fixture.context.hostApi, writes.get('row')!, 'tasks/transition-v1', { v: 1, ...address, transitionId: 'done' })).toBeUndefined();
  });
  await act(async () => { showTask(false); });
  await act(async () => { showTask(true); });
  const beforeReplacement = unrelatedRenders();
  await act(async () => {
    pending = commitTaskWriteForTest(fixture.context.hostApi, writes.get('detail')!, 'tasks/edit-v1', { v: 1, ...address, fields: { title: 'New deliberate title' } });
  });
  expect(mutations).toBe(2);
  await act(async () => {
    await commitTaskWriteForTest(fixture.context.hostApi, writes.get('row')!, 'tasks/edit-v1', { v: 1, ...address, fields: { title: 'Concurrent duplicate' } });
  });
  expect(mutations).toBe(2);
  await act(async () => { finishWrite({ kind: 'uncertain' }); await pending; });
  evidence = { kind: 'observed', entryRef, observation, taskFields: { title: 'New deliberate title' } };
  await act(async () => { await writes.get('row')!.checkAgain(); });
  expect(writes.get('detail')!.result?.kind).toBe('applied');
  expect(checks).toBe(3);
  expect(mutations).toBe(2);
  expect(unrelatedRenders()).toBe(beforeReplacement);
});


it('settles the host control press without replaying it through raw plugin execution', async () => {
  let write!: ReturnType<typeof useTriageTaskCommit>;
  type HostControl = Parameters<NonNullable<PluginUiTestkitHostHandlers['actionControl']>>[0];
  let publish: HostControl['publish'] | undefined;
  const requests: HostControl['request'][] = [];
  const raw = vi.fn(() => ({ kind: 'refused', reason: 'plugin_action_current_intent_unavailable' }));
  const input = { v: 1, entryRef: testkitEntryRef(), sourceInstanceId: testkitObservation().sourceInstanceId, transitionId: 'completed' };
  const applied = { kind: 'applied' as const, observation: { ...testkitObservation().outcome,
    localRef: { kindId: input.entryRef.kindId, collisionScope: input.entryRef.collisionScope, entryId: input.entryRef.entryId } } };
  const fixture = await createPluginUiTestkit({
    identity: { instanceId: 'task-host-control', mountNonce: 'one' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: defineUiSurface(() => {
      write = useTriageTaskCommit(async () => undefined);
      const currentWrite = write;
      return <Action.Control action="tasks/transition-v1" title="Completed" controller={{
        prepare: () => currentWrite.prepare('tasks/transition-v1', input),
        onSettled: execution => { currentWrite.settle(execution); },
      }} />;
    }),
    surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
    handlers: { executeAction: raw, actionControl(control) {
      requests.push(control.request);
      if (control.request.kind === 'bind') publish = control.publish;
      if (control.request.kind === 'prepared') control.publish({ kind: 'settled', requestId: control.request.requestId,
        execution: { ok: true, result: applied } });
    } },
  });
  mounted.push(fixture);
  await vi.waitFor(() => expect(publish).toBeDefined());
  await act(async () => { publish!({ kind: 'prepare', requestId: 'present-user-press' }); });
  await vi.waitFor(() => expect(write.result?.kind).toBe('applied'));
  expect(requests).toContainEqual(expect.objectContaining({ kind: 'prepared', preparation: { input } }));
  expect(raw).not.toHaveBeenCalled();

});

it('settles the prepared task after the detail switches to another task', async () => {
  const first = testkitEntryRef();
  const second = { ...first, entryId: 'second-task' };
  const scope = createTriageEphemeralSharedScopeOriginFixture().forExecutionOrigin('surface');
  let select!: React.Dispatch<React.SetStateAction<typeof first>>;
  let current!: ReturnType<typeof useTriageTaskCommit>;
  let original!: ReturnType<typeof useTriageTaskCommit>;
  let publish!: Parameters<NonNullable<PluginUiTestkitHostHandlers['actionControl']>>[0]['publish'];
  let requestId = '';
  const fixture = await createPluginUiTestkit({
    identity: { instanceId: 'task-control-selection', mountNonce: 'one' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: defineUiSurface(() => {
      const [entryRef, setEntryRef] = React.useState(first);
      select = setEntryRef;
      current = useTriageTaskCommit(async () => undefined, { entryRef, sourceInstanceId: 'source-one' });
      original = useTriageTaskCommit(async () => undefined, { entryRef: first, sourceInstanceId: 'source-one' });
      const write = current;
      return <Action.Control action="tasks/transition-v1" title="Completed" controller={{
        prepare: () => write.prepare('tasks/transition-v1', { v: 1, entryRef, sourceInstanceId: 'source-one', transitionId: 'done' }),
        onSettled: execution => { write.settle(execution); },
      }} />;
    }),
    surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope }),
    handlers: { actionControl(control) {
      if (control.request.kind === 'bind') publish = control.publish;
      if (control.request.kind === 'prepared') requestId = control.request.requestId;
    } },
  });
  mounted.push(fixture);
  await act(async () => { publish({ kind: 'prepare', requestId: 'first-task-gesture' }); });
  expect(original.busy).toBe(true);
  await act(async () => { select(second); });
  expect(current.busy).toBe(false);
  await act(async () => { publish({ kind: 'settled', requestId, execution: { ok: true, result: { kind: 'refused', reason: 'denied' } } }); });
  expect(original.result).toMatchObject({ kind: 'refused', reason: 'denied' });
  expect(original.busy).toBe(false);
  expect(current.result).toBeNull();
});

it.each([false, true])('retains host-control failure evidence with effectAttempted=%s', async effectAttempted => {
  let write!: ReturnType<typeof useTriageTaskCommit>;
  mounted.push(await createPluginUiTestkit({
    identity: { instanceId: `control-failure-${effectAttempted}`, mountNonce: 'one' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: defineUiSurface(() => { write = useTriageTaskCommit(async () => undefined); return <Text value={write.result?.kind ?? 'idle'} />; }),
    surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
  }));
  await act(async () => {
    write.prepare('tasks/transition-v1', {});
    write.settle({ ok: false, errorCode: 'unavailable', error: 'Provider unavailable', requestId: 'host-request', effectAttempted });
  });
  expect(write.result).toMatchObject(effectAttempted
    ? { kind: 'uncertain', failure: { code: 'unavailable', requestId: 'host-request' } }
    : { kind: 'refused', reason: 'unavailable', requestId: 'host-request' });
});
