// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { testkitEntryRef, testkitObservation } from '../../corpus/testkit/observations.test-support.js';
import { createTriageEphemeralSharedScopeOriginFixture } from '../window/ephemeralSharedScope.test-support.js';
import { useTriageTaskCommit, TriageTaskStatusLabel } from './taskFields.js';
import { createPluginClientTestkit, type PluginClientTestkit } from '@happier-dev/plugin-sdk/testing';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { activate } from '../../actions/mountedUi.js';
import { checkTriageTaskWrite } from './taskWrite.js';
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
    await act(async () => { await write.commit(action, {}); });
    expect(write.result).toEqual({ kind: 'refused', reason: 'plugin_action_current_intent_unavailable' });
    // A deliberate retry is available after a proven refusal; no automatic replay occurs.
    expect(attempts).toBe(1);
    notStarted = false;
    await act(async () => { await write.commit(action, {}); });
    expect(write.result).toEqual({ kind: 'uncertain', failure: { class: 'unknown', code: responseCode } });
    await act(async () => { await write.commit(action, {}); });
    expect(attempts).toBe(2);
  },
);

it('retains uncertainty when the mounted host cannot transmit pre-handler dispatch evidence', async () => {
  let write!: ReturnType<typeof useTriageTaskCommit>;
  let attempts = 0;
  await act(async () => {
    mounted.push(await createPluginUiTestkit({
      identity: { instanceId: 'untransmitted-dispatch-evidence', mountNonce: 'one' },
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
        // The current hostApiWire V1 error schema does not carry this advisory.
        throw Object.assign(error, { actionHandlerInvocation: 'notStarted',
          data: { ...error.data, actionHandlerInvocation: 'notStarted' } });
      } },
    }));
  });
  await act(async () => { await write.commit('tasks/create-v1', {}); });
  expect(write.result).toEqual({ kind: 'uncertain', failure: { class: 'unknown', code: 'plugin_action_current_intent_unavailable' } });
  await act(async () => { await write.commit('tasks/create-v1', {}); });
  expect(attempts).toBe(1);
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
  await act(async () => { await write.commit('tasks/create-v1', create); });
  expect(write.result?.kind).toBe('uncertain');
  await act(async () => { showDraft(false); });
  await act(async () => { showDraft(true); });
  expect(write.result?.kind).toBe('uncertain');
  await act(async () => { await write.commit('tasks/create-v1', create); });
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
  await act(async () => { await write.commit('tasks/transition-v1', { v: 1, ...address, transitionId: 'review' },
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
    pending = writes.get('detail')!.commit('tasks/edit-v1', { v: 1, ...address, fields: { title: 'Confirmed title' } });
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
  await act(async () => { await writes.get('row')!.commit('tasks/edit-v1', { v: 1, ...address, fields: { title: 'Duplicate' } }); });
  expect(mutations).toBe(1);
  await act(async () => { await writes.get('row')!.checkAgain(); });
  expect(writes.get('detail')!.result?.kind).toBe('uncertain');
  if (observation.outcome.kind !== 'present') throw new Error('Expected present fixture');
  evidence = { kind: 'observed', entryRef, observation, taskFields: { title: 'Still the old title' } };
  await act(async () => { await writes.get('detail')!.checkAgain(); });
  expect(writes.get('row')!.result?.kind).toBe('uncertain');
  // A fresh differing value cannot prove the old write applied, but must allow new intent.
  await act(async () => {
    expect(await writes.get('row')!.commit('tasks/transition-v1', { v: 1, ...address, transitionId: 'done' })).toBeUndefined();
  });
  await act(async () => { showTask(false); });
  await act(async () => { showTask(true); });
  const beforeReplacement = unrelatedRenders();
  await act(async () => {
    pending = writes.get('detail')!.commit('tasks/edit-v1', { v: 1, ...address, fields: { title: 'New deliberate title' } });
  });
  expect(mutations).toBe(2);
  await act(async () => {
    await writes.get('row')!.commit('tasks/edit-v1', { v: 1, ...address, fields: { title: 'Concurrent duplicate' } });
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
