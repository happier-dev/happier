// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { HostPeopleDirectory, HostPeopleDirectoryRequest } from '@happier-dev/plugin-ui/hostApi';
import type { PluginUiTargetedContributionsV1 } from '@happier-dev/plugin-sdk/ui';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1, TriageSourceDescriptorV1Schema,
  type TriageTaskCapabilitiesV1, type TriageTaskFieldV1, type TriageTaskFieldsV1, type TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';
import { testkitEntryRef, testkitObservation } from '../../corpus/testkit/observations.test-support.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../projection/listWindow.js';
import { TriageCreateTaskActionInputV1Schema, TriageEditTaskActionInputV1Schema } from '../../actions/tasksProtocol.js';
import { TriageListEntriesInputV1Schema } from '../../actions/listEntriesProtocol.js';
import type { TriageMountedConfiguredSourceV1 } from '../configuration/useTriageConfiguredSources.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';
import { useTriageListWindow } from '../window/useTriageListWindow.js';
import { createTriageEphemeralSharedScopeFixture } from '../window/ephemeralSharedScope.test-support.js';
import type { TriageTaskFieldChoicesV1 } from '@happier-dev/triage-protocol/v1';
import { TriageCreateTaskFields, TriageEditTaskScope, TriageTaskRowStatusControl, useTriageTaskCommit } from './taskFields.js';
import { TriageTaskStory } from './taskStory.js';
import { INTERNAL_TASK_SOURCE_V1 } from '../../internalTasks/identity.js';
import { INTERNAL_TASK_SOURCE_RECORD_V1 } from '../../internalTasks/configuration.js';
import { checkTriageTaskWrite } from './taskWrite.js';
import { useTriagePostMutationRow } from './useTriagePostMutationRow.js';
import { toTriageWireObservation } from '../../projection/listWindowWire.js';
import type { TriageListWindowSnapshotV1 } from '../../projection/listWindowStore.js';

import { commitTaskWriteForTest, createTaskActionControlTestkit as createPluginUiTestkit } from './taskActionControl.test-support.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); });

function targetedTaskSource(source: TriageEntryRefV1['source'], kindId: string, role: 'create' | 'edit', readOnly = false,
  fields: readonly TriageTaskFieldV1[] = ['title', 'body'],
  transitions: NonNullable<TriageTaskCapabilitiesV1['transitions']> = [],
  initialStatuses?: TriageTaskCapabilitiesV1['initialStatuses'], fieldChoices?: true): PluginUiTargetedContributionsV1 {
  const protocol = { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 };
  const contributor = { pluginId: source.pluginId, contributionId: source.localId,
    occurrenceId: source.pluginId === 'happier.triage' ? 'triage-one' : 'source-one',
    sourceCustody: { kind: 'development' as const, registeredRootId: source.pluginId === 'happier.triage' ? 'triage-source' : 'task-source' } };
  return {
    target: { pluginId: 'happier.triage', occurrenceId: 'triage-one',
      sourceCustody: { kind: 'development', registeredRootId: 'triage-source' } },
    points: [{ pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocols: [{ protocol, contributions: [{
      contributor, protocol,
      descriptor: TriageSourceDescriptorV1Schema.parse({ ...createTriageSourceV1Fixture().descriptor,
        kinds: [{ id: kindId, task: true, workflowSubject: 'issue', displayName: 'Issue',
          taskCapabilities: { [role === 'create' ? 'createFields' : 'editFields']: fields,
            ...(initialStatuses === undefined ? {} : { initialStatuses }),
            ...(fieldChoices === undefined ? {} : { fieldChoices }),
            ...(transitions.length === 0 ? {} : { transitions }) } }] }),
      operations: readOnly ? [] : [role, 'get', ...(transitions.length === 0 ? [] : ['transition'])].map(operationRole => ({ point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol },
        contributor, role: operationRole, action: { pluginId: source.pluginId, localId: operationRole } })), surfaces: [],
    }] }] }],
  };
}

it('creates once from an error and repairs only its failed origin link before opening the task', async () => {
  const source = createTriageSourceV1Fixture();
  const originError = { entryRef: testkitEntryRef({ kindId: 'error-issue', entryId: 'checkout-error' }),
    display: { title: 'Checkout fails after payment', scopeLabel: 'Production' } };
  const actions: string[] = [];
  const created: TriageEntryRefV1[] = [];
  const fixture = await createPluginUiTestkit({
    identity: { instanceId: 'error-create-repair', mountNonce: 'one' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: defineUiSurface(() => <TriageCreateTaskFields sources={[{
      configured: source.configuredInstance, sourceInstanceId: source.configuredInstance.instance.sourceInstanceId,
      displayLabel: 'Engineering',
    }]} sourcesLoaded sourcesUnavailableReason={null} draft={{ title: 'Fix checkout', originError, linkSession: 'task-session' }}
      onApplied={async () => undefined} onClose={() => undefined} onCreated={value => created.push(value.entryRef)} />),
    surfaceContext: createSurfaceContextFixture({
      targetedContributions: targetedTaskSource(source.configuredInstance.instance.source, 'issue', 'create'),
    }),
    adapter: controls => createPluginUiRnwSemanticSurfaceAdapter({ actionBindings: { commit: controls.commit }, overlays: true, ephemeralSharedScope: createTriageEphemeralSharedScopeFixture() }),
    handlers: { executeAction: ({ action, input }) => {
      actions.push(action);
      if (action === 'tasks/create-v1') {
        expect(TriageCreateTaskActionInputV1Schema.parse(input)).toMatchObject({ originError, linkSession: 'task-session' });
        return { kind: 'createdAndLinkAttempted', creation: { kind: 'applied', observation: source.getResult }, originErrorLink: 'failed', sessionLink: 'linked' };
      }
      expect(action).toBe('tasks/set-origin-error-v1');
      expect(input).toMatchObject({ originError, entryRef: { source: source.configuredInstance.instance.source, ...source.getResult.localRef } });
      return { v: 1, status: 'linked' };
    } },
  });
  mounted.push(fixture);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Issue' })); });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Create task' })); });
  expect(fixture.rawTaskWrites).toEqual([]);
  expect(created).toEqual([]);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Repair origin link' })); });
  expect(actions).toEqual(['tasks/create-v1', 'tasks/set-origin-error-v1']);
  expect(created).toEqual([{ source: source.configuredInstance.instance.source, ...source.getResult.localRef }]);
});

it('keeps an uncertain creation at its named source and opens its observed locator without resubmitting', async () => {
  const source = createTriageSourceV1Fixture();
  const opened: string[] = [];
  let creates = 0;
  const fixture = await createPluginUiTestkit({ identity: { instanceId: 'create-uncertain-context', mountNonce: 'one' },
    authorPlugin: { id: 'happier.triage', version: '0.0.0' },
    surface: defineUiSurface(() => <TriageCreateTaskFields sources={[{ configured: source.configuredInstance,
      sourceInstanceId: source.configuredInstance.instance.sourceInstanceId, displayLabel: 'Engineering' }]}
      sourcesLoaded sourcesUnavailableReason={null} draft={{ title: 'Fix checkout' }}
      onApplied={async () => undefined} onClose={() => undefined} />),
    surfaceContext: createSurfaceContextFixture({
      targetedContributions: targetedTaskSource(source.configuredInstance.instance.source, 'issue', 'create'),
    }), adapter: controls => createPluginUiRnwSemanticSurfaceAdapter({ actionBindings: { commit: controls.commit }, ephemeralSharedScope: createTriageEphemeralSharedScopeFixture() }),
    handlers: { openExternalLink: async ({ url }) => { opened.push(url); }, executeAction: ({ action }) => {
      expect(action).toBe('tasks/create-v1'); creates++;
      return { kind: 'uncertain', observation: source.getResult };
    } },
  }); mounted.push(fixture);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Issue' })); });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Create task' })); });
  expect(document.body.textContent).toContain(`${source.descriptor.displayName} may have created`);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: `Open in ${source.descriptor.displayName}` })); });
  expect(opened).toEqual([source.getResult.locator.webUrl]);
  expect(creates).toBe(1);
});

it('opens on Happier tasks by default and preserves an explicitly chosen connected external target', async () => {
  const internal = INTERNAL_TASK_SOURCE_RECORD_V1.value.configured;
  const external = createTriageSourceV1Fixture().configuredInstance;
  const own = targetedTaskSource(INTERNAL_TASK_SOURCE_V1, 'task', 'create', false, ['title', 'body'], [], [
    { id: 'todo-native', label: 'To do', state: { presentation: 'active', stage: 'unstarted' }, isDefault: true },
    { id: 'active-native', label: 'In progress', state: { presentation: 'active', stage: 'started' } },
  ]);
  const other = targetedTaskSource(external.instance.source, 'issue', 'create');
  const targetedContributions = { ...own, points: [{ ...own.points[0]!, protocols: [{ ...own.points[0]!.protocols[0]!,
    contributions: [...other.points[0]!.protocols[0]!.contributions, ...own.points[0]!.protocols[0]!.contributions] }] }] };
  const saved: ReturnType<typeof TriageCreateTaskActionInputV1Schema.parse>[] = [];
  let setSourceSnapshot!: React.Dispatch<React.SetStateAction<TriageListWindowSnapshotV1>>;
  const sourceSnapshot: TriageListWindowSnapshotV1 = {
    configuredSources: [], freshness: 'fresh', pending: 'idle', passes: 1,
    window: foldTriageListWindow({ observations: [], configuredSourcesStatus: 'complete',
      activeSourceInstanceIds: [internal.instance.sourceInstanceId], lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 1,
      lanes: [{ source: INTERNAL_TASK_SOURCE_V1, sourceInstanceId: internal.instance.sourceInstanceId,
        exhausted: false, health: { kind: 'unavailable' } }],
    }),
    unreadableSources: [{ sourceInstanceId: internal.instance.sourceInstanceId, message: 'Could not be reached just now.' }],
  };
  await act(async () => {
    mounted.push(await createPluginUiTestkit({ identity: { instanceId: 'task-default', mountNonce: 'default' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => {
        const [snapshot, setSnapshot] = React.useState(sourceSnapshot);
        setSourceSnapshot = setSnapshot;
        return <TriageCreateTaskFields sourceSnapshot={snapshot} sources={[external, internal].map(configured => ({
        configured, sourceInstanceId: configured.instance.sourceInstanceId, displayLabel: configured.locator!.displayLabel!,
      }))} sourcesLoaded sourcesUnavailableReason={null} draft={{ title: 'My task' }}
        onApplied={async () => undefined} onClose={() => undefined} />;
      }),
      surfaceContext: createSurfaceContextFixture({ targetedContributions }),
      adapter: controls => createPluginUiRnwSemanticSurfaceAdapter({ actionBindings: { commit: controls.commit }, overlays: true, ephemeralSharedScope: createTriageEphemeralSharedScopeFixture(),
        physicalFocus: target => { target.focus(); return true; } }),
      handlers: { executeAction: ({ action, input }) => {
        expect(action).toBe('tasks/create-v1');
        saved.push(TriageCreateTaskActionInputV1Schema.parse(input));
        return { kind: 'refused', reason: 'unavailable' };
      } },
    }));
  });
  const fixture = mounted.at(-1)!;
  expect(document.querySelector('[data-testid="triage-task-draft-title"]')).toBeNull();
  expect(saved).toEqual([]);
  await act(async () => {
    setSourceSnapshot({ ...sourceSnapshot, unreadableSources: [], window: { ...sourceSnapshot.window!,
      lanes: [{ source: INTERNAL_TASK_SOURCE_V1, sourceInstanceId: internal.instance.sourceInstanceId,
        exhausted: true, health: { kind: 'walkFinished' } }],
    } });
  });
  // Arriving at a task draft puts typing in its title, rather than the pane heading.
  expect(document.activeElement).toBe(document.querySelector('[data-testid="triage-task-draft-title"]'));
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Create task' })); });
  expect(saved[0]).toMatchObject({ source: INTERNAL_TASK_SOURCE_V1, kindId: 'task', fields: { title: 'My task' } });
  expect(saved[0]).not.toHaveProperty('initialStatusId');
  // The draft names the place's own starting state; leaving it untouched still sends no initialStatusId.
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Status, To do' })); });
  await act(async () => { await fixture.press(await fixture.getByRole('menuitemradio', { name: 'In progress' })); });
  expect(saved).toHaveLength(1); // Choosing a draft value never writes before Create.
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Create task' })); });
  expect(saved[1]?.initialStatusId).toBe('active-native');
  // The place chip opens the places as a menu anchored to it: the draft stays where it is, nothing is pushed.
  await act(async () => { document.querySelector<HTMLElement>('[aria-label^="Where: "]')!.click(); });
  expect(document.querySelector('[data-testid="triage-task-draft-title"]')).not.toBeNull();
  expect(document.body.textContent).not.toContain('Where does it belong?');
  // The place the draft is going to is the checked one.
  const checkedPlaces = [...document.querySelectorAll('[role="menuitemradio"][aria-checked="true"]')].map(node => node.getAttribute('aria-label'));
  expect(checkedPlaces.length).toBeGreaterThan(0);
  expect(checkedPlaces).toEqual(expect.arrayContaining([expect.stringContaining('Happier tasks')]));
  await act(async () => { document.querySelector<HTMLElement>('[role="menuitemradio"][aria-label^="Issue"]')!.click(); });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Create task' })); });
  expect(saved[2]).toMatchObject({ source: external.instance.source, sourceInstanceId: external.instance.sourceInstanceId, kindId: 'issue' });
  expect(saved[2]).not.toHaveProperty('initialStatusId');
  expect(document.body.textContent).not.toContain('In progress');
});

it('lists places by what they create, names a connection only among several, narrows by search and cancels from the footer', async () => {
  const first = createTriageSourceV1Fixture().configuredInstance;
  const second = { ...first, instance: { ...first.instance, sourceInstanceId: `${first.instance.sourceInstanceId}-b` },
    locator: { ...first.locator!, displayLabel: 'second-account' } };
  const own = targetedTaskSource(first.instance.source, 'issue', 'create');
  let closed = 0;
  const mountPlaces = async (sources: readonly (typeof first)[]) => {
    await act(async () => {
      mounted.push(await createPluginUiTestkit({ identity: { instanceId: `task-places-${sources.length}`, mountNonce: 'places' },
        authorPlugin: { id: 'happier.triage', version: '0.0.0' },
        surface: defineUiSurface(() => <TriageCreateTaskFields sources={sources.map(configured => ({
          configured, sourceInstanceId: configured.instance.sourceInstanceId, displayLabel: configured.locator!.displayLabel!,
        }))} sourcesLoaded sourcesUnavailableReason={null} onApplied={async () => undefined} onClose={() => { closed += 1; }} />),
        surfaceContext: createSurfaceContextFixture({ targetedContributions: own }),
        adapter: controls => createPluginUiRnwSemanticSurfaceAdapter({ actionBindings: { commit: controls.commit }, overlays: true, ephemeralSharedScope: createTriageEphemeralSharedScopeFixture() }),
        handlers: {},
      }));
    });
    return mounted.at(-1)!;
  };
  const one = await mountPlaces([first]);
  expect(document.body.textContent).not.toContain(first.locator!.displayLabel!);
  await act(async () => { await one.press(await one.getByRole('button', { name: 'Cancel' })); });
  expect(closed).toBe(1);
  await one.dispose(); mounted.pop();

  await mountPlaces([first, second]);
  expect(document.body.textContent).toContain('second-account');
  const search = document.querySelector<HTMLInputElement>('input[aria-label="Search places"]')!;
  expect(search).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'second');
    search.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(document.body.textContent).toContain('second-account');
  expect(document.body.textContent).not.toContain(first.locator!.displayLabel!);
});

it.each([false, true])('submits a create through the Account aggregate without a Machine once sources are ready (Account data: %s)', async (accountData) => {
  let setReadiness!: React.Dispatch<React.SetStateAction<{ loaded: boolean; unavailableReason: string | null }>>;
  let setSources!: React.Dispatch<React.SetStateAction<readonly TriageMountedConfiguredSourceV1[]>>;
  const sourceFixture = createTriageSourceV1Fixture();
  const source = { ...sourceFixture, configuredInstance: { ...sourceFixture.configuredInstance,
    binding: accountData ? { purpose: sourceFixture.descriptor.purpose, source: 'accountData' as const } : sourceFixture.configuredInstance.binding } };
  const saved: ReturnType<typeof TriageCreateTaskActionInputV1Schema.parse>[] = [];
  await act(async () => {
    mounted.push(await createPluginUiTestkit({ identity: { instanceId: 'task-create', mountNonce: 'readiness' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => {
        const [readiness, update] = React.useState<{ loaded: boolean; unavailableReason: string | null }>({ loaded: false, unavailableReason: null });
        const [sources, updateSources] = React.useState<readonly TriageMountedConfiguredSourceV1[]>([]);
        setReadiness = update;
        setSources = updateSources;
        return <TriageCreateTaskFields sources={sources} sourcesLoaded={readiness.loaded}
          sourcesUnavailableReason={readiness.unavailableReason}
          draft={{ title: 'Fix reconnect handling' }}
          onApplied={async () => undefined} onClose={() => undefined} />;
      }),
      surfaceContext: createSurfaceContextFixture({ targetedContributions: targetedTaskSource(source.configuredInstance.instance.source, 'issue', 'create'),
        machineConnectionPending: true, machineExecutionReady: false }),
      adapter: controls => createPluginUiRnwSemanticSurfaceAdapter({ actionBindings: { commit: controls.commit }, overlays: true, ephemeralSharedScope: createTriageEphemeralSharedScopeFixture(),
        physicalFocus: target => { target.focus(); return true; } }),
      handlers: { executeAction: ({ action, input }) => {
        expect(action).toBe('tasks/create-v1');
        saved.push(TriageCreateTaskActionInputV1Schema.parse(input));
        return { kind: 'refused', reason: 'unavailable' };
      } },
    }));
  });
  const fixture = mounted.at(-1)!;
  const place = () => fixture.getByRole('button', { name: 'Issue' });
  // Where comes first (lab `tasks-create`): no place can be chosen while the sources are still being read.
  await expect(place()).rejects.toBeDefined();
  expect(document.querySelector('[role="progressbar"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Title"]')).toBeNull();
  await act(async () => { setReadiness({ loaded: true, unavailableReason: null }); });
  expect(document.querySelector('[role="progressbar"]')).toBeNull();
  await expect(place()).rejects.toBeDefined();
  expect(document.body.textContent).toContain('Add a source that supports creating tasks');
  await act(async () => { setSources([{ sourceInstanceId: source.configuredInstance.instance.sourceInstanceId,
    configured: source.configuredInstance, displayLabel: 'Engineering' }]); });
  expect((await place()).state?.disabled).not.toBe(true);
  await act(async () => { await fixture.press(await place()); });
  expect(document.querySelector('[aria-label="Title"]')).not.toBeNull();
  expect(document.activeElement).toBe(document.querySelector('[aria-label="Title"]'));
  const createButton = document.querySelector<HTMLElement>('[role="button"][aria-label="Create task"]')!;
  act(() => { createButton.focus(); });
  await act(async () => { setSources(previous => [...previous]); });
  expect(document.activeElement).toBe(createButton);
  // The chosen place stays named above its form; its chip offers the places in place, without losing the draft.
  await act(async () => { document.querySelector<HTMLElement>('[aria-label^="Where: "]')!.click(); });
  expect(document.querySelector('[aria-label="Title"]')).not.toBeNull();
  await act(async () => { document.querySelector<HTMLElement>('[role="menuitemradio"][aria-label^="Issue"]')!.click(); });
  expect(document.querySelector('[aria-label="Title"]')).not.toBeNull();
  expect((await fixture.getByRole('button', { name: 'Create task' })).state?.disabled).not.toBe(true);
  await act(async () => { setReadiness({ loaded: true, unavailableReason: 'The Account is unavailable.' }); });
  expect(document.body.textContent).toContain('The Account is unavailable.');
  expect(document.querySelector('[aria-label="Title"]')).toBeNull();
  expect(saved).toEqual([]);
  await act(async () => { setReadiness({ loaded: true, unavailableReason: null }); });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Create task' })); });
  expect(saved).toHaveLength(1);
  expect(saved[0]?.fields).toEqual({ title: 'Fix reconnect handling' });
  expect(saved[0]?.sourceInstanceId).toBe(source.configuredInstance.instance.sourceInstanceId);
});

/** The same admitted source, also declaring the optional `listCreationPlaces` role. */
function withCreationPlaces(targeted: PluginUiTargetedContributionsV1): PluginUiTargetedContributionsV1 {
  const point = targeted.points[0]!;
  const protocol = point.protocols[0]!;
  const contribution = protocol.contributions[0]!;
  const create = contribution.operations[0]!;
  return { ...targeted, points: [{ ...point, protocols: [{ ...protocol, contributions: [{ ...contribution, operations: [...contribution.operations,
    { ...create, role: 'listCreationPlaces', action: { ...create.action, localId: 'list-creation-places' } }] }] }] }] };
}

it('creates at the place the source names, narrowed by its own places, with the source’s operands and no typed ids', async () => {
  const source = createTriageSourceV1Fixture();
  const placeReads: (string | null)[] = [];
  const saved: ReturnType<typeof TriageCreateTaskActionInputV1Schema.parse>[] = [];
  const page = (places: readonly unknown[]) => ({ kind: 'page', status: 'complete', places });
  let fixture!: Awaited<ReturnType<typeof createPluginUiTestkit>>;
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'task-create-places', mountNonce: 'places' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => <TriageCreateTaskFields sources={[{ sourceInstanceId: source.configuredInstance.instance.sourceInstanceId,
        configured: source.configuredInstance, displayLabel: 'Engineering' }]} sourcesLoaded sourcesUnavailableReason={null}
        draft={{ title: 'Show the server total' }} onApplied={async () => undefined} onClose={() => undefined} />),
      surfaceContext: createSurfaceContextFixture({ targetedContributions: withCreationPlaces(targetedTaskSource(source.configuredInstance.instance.source,
        'issue', 'create', false, ['title', 'scopeId', 'projectId'])) }),
      adapter: controls => createPluginUiRnwSemanticSurfaceAdapter({ actionBindings: { commit: controls.commit }, overlays: true, ephemeralSharedScope: createTriageEphemeralSharedScopeFixture() }),
      handlers: { executeAction: ({ action, input }) => {
        if (action === 'tasks/create-v1') { saved.push(TriageCreateTaskActionInputV1Schema.parse(input)); return { kind: 'refused', reason: 'unavailable' }; }
        expect(action).toMatchObject({ localId: 'list-creation-places' });
        const scopeId = (input as { scopeId?: string }).scopeId ?? null;
        placeReads.push(scopeId);
        if (scopeId === null) return page([
          { id: 'team-chk', label: 'Checkout', kindId: 'issue', fields: { scopeId: 'team-chk' }, childScopeId: 'team-chk' },
          { id: 'project-ops', label: 'Platform Ops', kindId: 'issue', fields: {}, childScopeId: 'project-ops', refusal: { reason: 'example/typeRequired' } },
          { id: 'team-mob', label: 'Mobile', kindId: 'issue', fields: {}, refusal: { reason: 'example/excluded', message: 'Not part of this connection' } },
        ]);
        if (scopeId === 'team-chk') return page([
          { id: 'project-q4', label: 'Q4 checkout reliability', kindId: 'issue', fields: { scopeId: 'team-chk', projectId: 'project-q4' } },
        ]);
        return page([{ id: 'project-ops/bug', placeId: 'project-ops/bug', label: 'Bug', kindId: 'issue', fields: {} }]);
      } },
    });
  });
  mounted.push(fixture);
  // Places are named, one read for the whole list; a place that can't be used says why and can't be chosen.
  expect(placeReads).toEqual([null]);
  expect((await fixture.getByRole('button', { name: 'Mobile' })).state?.disabled).toBe(true);
  expect(document.body.textContent).toContain('Not part of this connection');
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Checkout' })); });
  // The place sets where the task goes: no typed team or project id, and its projects are picked by name.
  expect(document.querySelector('[aria-label^="Repository or project"]')).toBeNull();
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Project, None' })); });
  await act(async () => { await fixture.press(await fixture.getByRole('menuitemradio', { name: 'Q4 checkout reliability' })); });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Create task' })); });
  expect(saved.at(-1)).toMatchObject({ kindId: 'issue', fields: { title: 'Show the server total', scopeId: 'team-chk', projectId: 'project-q4' } });
  expect(saved.at(-1)).not.toHaveProperty('placeId');
  // A place the source must narrow first opens its own places; the narrower place's opaque id goes to the source unchanged.
  await act(async () => { document.querySelector<HTMLElement>('[aria-label^="Where: "]')!.click(); });
  await act(async () => { document.querySelector<HTMLElement>('[role="menuitemradio"][aria-label^="Platform Ops"]')!.click(); });
  expect(placeReads).toEqual([null, 'team-chk', 'project-ops']);
  await act(async () => { await fixture.press(await fixture.findByRole('button', { name: 'Bug' })); });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Create task' })); });
  expect(saved.at(-1)).toMatchObject({ kindId: 'issue', placeId: 'project-ops/bug', fields: { title: 'Show the server total' } });
  expect(saved.at(-1)?.fields).not.toHaveProperty('scopeId');
  expect(saved).toHaveLength(2);
  expect(placeReads).toEqual([null, 'team-chk', 'project-ops']);
});

it('creates with the typed properties the chosen place accepts, in one write', async () => {
  const source = createTriageSourceV1Fixture();
  const saved: ReturnType<typeof TriageCreateTaskActionInputV1Schema.parse>[] = [];
  let fixture!: Awaited<ReturnType<typeof createPluginUiTestkit>>;
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'task-create-typed', mountNonce: 'typed' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => <TriageCreateTaskFields sources={[{ sourceInstanceId: source.configuredInstance.instance.sourceInstanceId,
        configured: source.configuredInstance, displayLabel: 'Engineering' }]} sourcesLoaded sourcesUnavailableReason={null}
        draft={{ title: 'Write the replay runbook' }} onApplied={async () => undefined} onClose={() => undefined} />),
      surfaceContext: createSurfaceContextFixture({ targetedContributions: targetedTaskSource(source.configuredInstance.instance.source, 'issue', 'create',
        false, ['title', 'body', 'labelIds', 'dueDate']) }),
      adapter: controls => createPluginUiRnwSemanticSurfaceAdapter({ actionBindings: { commit: controls.commit }, overlays: true, ephemeralSharedScope: createTriageEphemeralSharedScopeFixture() }),
      handlers: { executeAction: ({ input }) => { saved.push(TriageCreateTaskActionInputV1Schema.parse(input)); return { kind: 'refused', reason: 'unavailable' }; } },
    });
  });
  mounted.push(fixture);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Issue' })); });
  // Only the fields this place accepts are offered, and editing one changes the draft, not the source.
  await expect(fixture.getByRole('button', { name: 'Labels, None' })).resolves.toBeDefined();
  await expect(fixture.queryByRole('button', { name: 'Estimate, None' })).resolves.toBeUndefined();
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Due date, None' })); });
  const input = [...document.querySelectorAll<HTMLInputElement>('input')].at(-1)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '2026-11-03');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Save' })); });
  expect(saved).toEqual([]);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Create task' })); });
  expect(saved.map(write => write.fields)).toEqual([{ title: 'Write the replay runbook', dueDate: '2026-11-03' }]);
});

async function mountAssigneeDraft(options: Readonly<{ internal: boolean;
  directory?: (request: HostPeopleDirectoryRequest) => HostPeopleDirectory | null }>) {
  const configured = options.internal ? INTERNAL_TASK_SOURCE_RECORD_V1.value.configured : createTriageSourceV1Fixture().configuredInstance;
  const saved: ReturnType<typeof TriageCreateTaskActionInputV1Schema.parse>[] = [];
  let fixture!: Awaited<ReturnType<typeof createPluginUiTestkit>>;
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'task-create-assignees', mountNonce: `assignees-${mounted.length}` },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => <TriageCreateTaskFields sources={[{ sourceInstanceId: configured.instance.sourceInstanceId,
        configured, displayLabel: 'Engineering' }]} sourcesLoaded sourcesUnavailableReason={null}
        draft={{ title: 'Pair on the release' }} onApplied={async () => undefined} onClose={() => undefined} />),
      surfaceContext: createSurfaceContextFixture({ accountScope: { serverId: 'fixture-home', accountId: 'viewer-account' },
        targetedContributions: targetedTaskSource(configured.instance.source, options.internal ? 'task' : 'issue', 'create', false, ['title', 'assigneeIds'],
          [], undefined, options.internal ? undefined : true) }),
      adapter: controls => createPluginUiRnwSemanticSurfaceAdapter({ actionBindings: { commit: controls.commit }, overlays: true, ephemeralSharedScope: createTriageEphemeralSharedScopeFixture(),
        ...(options.directory === undefined ? {} : { peopleDirectory: options.directory }) }),
      handlers: { executeAction: ({ input }) => { saved.push(TriageCreateTaskActionInputV1Schema.parse(input)); return { kind: 'refused', reason: 'unavailable' }; } },
    });
  });
  mounted.push(fixture);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Issue' })); });
  return { fixture, saved };
}

it('picks a Happier task’s assignees from the host people directory, read only once the picker opens', async () => {
  const requests: HostPeopleDirectoryRequest[] = [];
  const { fixture, saved } = await mountAssigneeDraft({ internal: true, directory: (request) => {
    requests.push(request);
    return { status: request.enabled ? 'ready' : 'idle', retry: () => undefined, people: request.enabled ? [
      { accountId: 'viewer-account', name: 'Lee', handle: 'You' }, { accountId: 'grace-account', name: 'Grace Hopper', handle: '@grace' },
    ] : [] };
  } });
  expect(requests.every(request => !request.enabled), 'nothing is read before the picker opens').toBe(true);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Assignees, None' })); });
  expect(requests.at(-1)).toEqual({ scope: { serverId: 'fixture-home', accountId: 'viewer-account' }, enabled: true });
  expect(document.querySelector('[placeholder="Separate names with commas"]'), 'a person is picked, never typed').toBeNull();
  await act(async () => { await fixture.press(await fixture.getByRole('menuitemcheckbox', { name: 'Grace Hopper \u00b7 @grace' })); });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Create task' })); });
  expect(saved.map(write => write.fields)).toEqual([{ title: 'Pair on the release', assigneeIds: ['grace-account'] }]);
});

it('never offers a typed assignee field where the source has no people directory for a draft', async () => {
  const { fixture } = await mountAssigneeDraft({ internal: false });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Assignees, None' })); });
  expect(document.querySelector('[placeholder="Separate names with commas"]')).toBeNull();
  await expect(fixture.getByRole('menuitem', { name: 'Assign people once the task is created' })).resolves.toBeDefined();
});

it('opens the created task before a mounted aggregate reread settles and preserves the applied write when that read fails', async () => {
  const source = createTriageSourceV1Fixture();
  const scope = createTriageEphemeralSharedScopeFixture();
  const saved: ReturnType<typeof TriageCreateTaskActionInputV1Schema.parse>[] = [];
  let readStarted!: () => void;
  const reading = new Promise<void>(resolve => { readStarted = resolve; });
  let rejectRead!: (error: Error) => void;
  const heldRead = new Promise<never>((_resolve, reject) => { rejectRead = reject; });
  let window!: ReturnType<typeof useTriageListWindow>;
  let fixture!: Awaited<ReturnType<typeof createPluginUiTestkit>>;
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'created-task', mountNonce: 'held-read' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => {
        window = useTriageListWindow();
        const [created, setCreated] = React.useState<TriageEntryRefV1 | null>(null);
        return created === null ? <TriageCreateTaskFields sources={[{
          sourceInstanceId: source.configuredInstance.instance.sourceInstanceId,
          configured: source.configuredInstance, displayLabel: 'Engineering',
        }]} sourcesLoaded sourcesUnavailableReason={null} draft={{ title: 'Saved Account task' }}
          onApplied={() => window.refresh('manual')} onClose={() => undefined}
          onCreated={result => setCreated(result.entryRef)} />
          : <Text value={created.entryId} />;
      }),
      surfaceContext: createSurfaceContextFixture({
        targetedContributions: targetedTaskSource(source.configuredInstance.instance.source, 'issue', 'create'),
        machineConnectionPending: true, machineExecutionReady: false,
      }),
      adapter: controls => createPluginUiRnwSemanticSurfaceAdapter({ actionBindings: { commit: controls.commit }, ephemeralSharedScope: scope }),
      // The SDK host request is the genuine boundary. Commit, form and mounted
      // refresh/coalescing owners are real; only the aggregate transport is held.
      handlers: { executeAction: ({ action, input }) => {
        if (action === 'tasks/create-v1') {
          saved.push(TriageCreateTaskActionInputV1Schema.parse(input));
          return { kind: 'applied', observation: source.getResult };
        }
        expect(action).toBe('entries/list-v1');
        TriageListEntriesInputV1Schema.parse(input);
        readStarted();
        return heldRead;
      } },
    });
  });
  mounted.push(fixture);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Issue' })); });
  let submission: Promise<void> | undefined;
  try {
    await act(async () => {
      submission = fixture.press(await fixture.getByRole('button', { name: 'Create task' }));
      await reading;
    });
    expect(saved).toHaveLength(1);
    expect(window.snapshot.pending).not.toBe('idle');
    expect(document.querySelector('[aria-label="Title"]')).toBeNull();
    expect(document.body.textContent).toContain(source.getResult.localRef.entryId);
  } finally {
    await act(async () => {
      rejectRead(new Error('Another source could not finish its aggregate read'));
      await submission;
    });
  }
  expect(window.snapshot.error).toBeDefined();
  expect(document.querySelector('[aria-label="Title"]')).toBeNull();
  expect(document.body.textContent).toContain(source.getResult.localRef.entryId);
  expect(saved).toHaveLength(1);
});

it('keeps message context and an optional Session link through create, and shows the partial link outcome in the created detail', async () => {
  const source = createTriageSourceV1Fixture();
  const entryRef = { source: source.configuredInstance.instance.source, ...source.getResult.localRef };
  const observation = { entryRef, sourceInstanceId: source.configuredInstance.instance.sourceInstanceId,
    observedAtMs: 1_000, outcome: source.getResult };
  const row = foldTriageListWindow({ observations: [observation], lanes: [], configuredSourcesStatus: 'complete',
    activeSourceInstanceIds: [observation.sourceInstanceId], lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 1_000 }).rows[0]!;
  const saved: ReturnType<typeof TriageCreateTaskActionInputV1Schema.parse>[] = [];
  const opened: unknown[] = [];
  let confirmLink!: React.Dispatch<React.SetStateAction<readonly string[]>>;
  let fixture!: Awaited<ReturnType<typeof createPluginUiTestkit>>;
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'message-create', mountNonce: 'link-partial' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => {
        const [created, setCreated] = React.useState(false);
        const [linkedSessionIds, setLinkedSessionIds] = React.useState<readonly string[]>([]);
        confirmLink = setLinkedSessionIds;
        return created ? <TriageEditTaskScope row={row} instance={source.configuredInstance} disabled={false} linkedSessionIds={linkedSessionIds} onApplied={async () => {}}>
          {placement => <>{placement.status}{placement.controls}<TriageTaskStory task={placement} notes={null} renderAgentStep={() => null} /></>}
        </TriageEditTaskScope> : <TriageCreateTaskFields sources={[{ sourceInstanceId: observation.sourceInstanceId,
          configured: source.configuredInstance, displayLabel: 'Engineering' }]} sourcesLoaded sourcesUnavailableReason={null}
          draft={{ title: 'Investigate reconnect', body: 'Explicit notes', origin: { sessionId: 'session-a', serverId: 'home-a',
            messageId: 'message-a', observedRevision: 'revision-a', role: 'agent', quote: 'The original answer', sessionTitle: 'Reconnect investigation' } }}
          onApplied={async () => {}} onClose={() => {}} onCreated={() => setCreated(true)} />;
      }),
      surfaceContext: createSurfaceContextFixture({ targetedContributions: targetedTaskSource(entryRef.source, entryRef.kindId, 'create') }),
      adapter: controls => createPluginUiRnwSemanticSurfaceAdapter({ actionBindings: { commit: controls.commit }, overlays: true, ephemeralSharedScope: createTriageEphemeralSharedScopeFixture() }),
      handlers: { executeAction: ({ action, input }) => {
        if (action === 'session.open') { opened.push(input); return { status: 'opened' } as never; }
        expect(action).toBe('tasks/create-v1');
        saved.push(TriageCreateTaskActionInputV1Schema.parse(input));
        return { kind: 'createdAndLinkAttempted', creation: { kind: 'applied', observation: source.getResult }, sessionLink: 'failed' };
      } },
    });
  });
  mounted.push(fixture);
  // One quiet line of the Session and its words; pressing it opens that Session.
  await act(async () => { await fixture.press(await fixture.getByRole('link', { name: 'Reconnect investigation, The original answer' })); });
  expect(opened).toEqual([{ sessionId: 'session-a', serverId: 'home-a' }]);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Issue' })); });
  const link = await fixture.getByRole('switch', { name: 'Link this Session' });
  if (!link.state?.checked) await act(async () => { await fixture.press(link); });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Create task' })); });
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ fields: { title: 'Investigate reconnect', body: 'Explicit notes' }, linkSession: 'session-a' });
  expect(document.body.textContent).toContain('The task was created, but this Session could not be linked.');
  expect(document.querySelector('[aria-label="Title"]')).toBeNull();
  await act(async () => { confirmLink(['session-a']); });
  expect(document.body.textContent).not.toContain('The task was created, but this Session could not be linked.');
  expect(saved).toHaveLength(1);
});

async function mountEditor(options: Readonly<{ readOnly?: boolean; uncertain?: boolean; truncated?: boolean; readFailed?: boolean;
  fields?: readonly TriageTaskFieldV1[]; values?: TriageTaskFieldsV1; transitions?: NonNullable<TriageTaskCapabilitiesV1['transitions']>;
  nativeLabel?: string; accountData?: boolean; relationRows?: readonly ReturnType<typeof foldTriageListWindow>['rows'][number][];
  refuse?: boolean; viewerAccountId?: string; assigneeLabel?: string | null;
  labelOutcome?: 'refused' | 'uncertain';
  taskFieldChoices?: TriageTaskFieldChoicesV1;
  rereadFails?: boolean;
  recoveryValues?: TriageTaskFieldsV1;
  snapshotCapabilities?: TriageTaskCapabilitiesV1;
  labelColors?: readonly Readonly<{ name: string; colorToken: string }>[] }> = {}) {
  const sourceFixture = createTriageSourceV1Fixture();
  const source = { ...sourceFixture, configuredInstance: { ...sourceFixture.configuredInstance,
    binding: options.accountData ? { purpose: sourceFixture.descriptor.purpose, source: 'accountData' as const } : sourceFixture.configuredInstance.binding } };
  const entryRef = testkitEntryRef();
  const base = testkitObservation();
  if (base.outcome.kind !== 'present') throw new Error('Expected a present fixture');
  const observation = { ...base, outcome: { ...base.outcome, snapshot: { ...base.outcome.snapshot,
    ...(options.truncated ? { projectionTruncated: true as const } : {}),
    ...(options.assigneeLabel === undefined ? {} : { assigneeLabel: options.assigneeLabel }),
    ...(options.snapshotCapabilities === undefined ? {} : { taskCapabilities: options.snapshotCapabilities }),
    ...(options.labelColors === undefined ? {} : { labelColors: options.labelColors }),
    ...(options.nativeLabel === undefined ? {} : { state: { presentation: 'active' as const, nativeLabel: options.nativeLabel } }) } } };
  const row = foldTriageListWindow({ observations: [{ ...observation, entryRef }], lanes: [],
    configuredSourcesStatus: 'complete', activeSourceInstanceIds: [observation.sourceInstanceId],
    lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 1_000 }).rows[0]!;
  const targeted = targetedTaskSource(entryRef.source, entryRef.kindId, 'edit', options.readOnly, options.fields, options.transitions);
  const saved: ReturnType<typeof TriageEditTaskActionInputV1Schema.parse>[] = [];
  const transitioned: unknown[] = [];
  const opened: string[] = [];
  const notifications: string[] = [];
  const colored: Readonly<{ action: string; input: unknown }>[] = [];
  let rereads = 0;
  let reads = 0;
  let fixture!: Awaited<ReturnType<typeof createPluginUiTestkit>>;
  const scope = createTriageEphemeralSharedScopeFixture();
  const lanes = Object.freeze([]);
  const initialValues = options.values ?? { title: row.content!.outcome.snapshot.title, body: 'Full body\n\nOriginal Markdown.  \n' };
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'task-edit', mountNonce: `edit-${mounted.length}` },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => {
        const detail = useTriagePostMutationRow(row, lanes);
        return <TriageEditTaskScope row={detail.row ?? row} instance={source.configuredInstance} disabled={false}
          taskFields={detail.exactRead?.taskFields} taskFieldChoices={detail.exactRead?.taskFieldChoices} onApplied={async () => {
            rereads++;
            if (options.rereadFails) throw new Error('Refresh unavailable');
            await detail.completePostMutation();
          }}
          relationRows={[row, ...(options.relationRows ?? [])]}>
          {(task) => <>{task.status}{task.controls}<TriageTaskStory task={task} notes={null} renderAgentStep={() => null} /></>}
        </TriageEditTaskScope>;
      }),
      surfaceContext: createSurfaceContextFixture({ targetedContributions: targeted,
        ...(options.viewerAccountId === undefined ? {} : { accountScope: { serverId: 'fixture-home', accountId: options.viewerAccountId } }) }),
      adapter: controls => createPluginUiRnwSemanticSurfaceAdapter({ actionBindings: { commit: controls.commit }, overlays: true, ephemeralSharedScope: scope }),
      // Host Action transport is the genuine boundary; field drafts and capability decisions stay real.
      handlers: { openExternalLink: async ({ url }) => { opened.push(url); },
        notify: async ({ message }) => { notifications.push(message); }, executeAction: ({ action, input }) => {
        if (typeof action === 'string') {
          if (action === 'tasks/check-write-v1') return checkTriageTaskWrite(scope, entryRef, fixture.context.hostApi,
            new AbortController().signal).then(resolved => ({ status: resolved ? 'applied' : 'unavailable' }));
          if (action === 'entries/reobserve-v1') {
            reads++;
            if (options.readFailed) throw new Error('Source unavailable');
            const { entryRef: _entryRef, ...projected } = observation;
            return { kind: 'observed', entryRef, observation: toTriageWireObservation(projected),
              taskFields: reads > 1 ? options.recoveryValues ?? initialValues : initialValues,
              ...((input as { includeTaskFieldChoices?: true }).includeTaskFieldChoices === true && options.taskFieldChoices !== undefined
                ? { taskFieldChoices: options.taskFieldChoices } : {}) };
          }
          if (action === 'tasks.internal.labels.setColor' || action === 'tasks.internal.labels.clearColor') {
            colored.push({ action, input });
            if (options.labelOutcome) return { status: options.labelOutcome, reason: 'task_conflict' };
            return { status: 'applied', scope: (input as { scope: unknown }).scope, labelCatalog: [] };
          }
          if (action === 'tasks/transition-v1') transitioned.push(input);
          else {
            expect(action).toBe('tasks/edit-v1');
            saved.push(TriageEditTaskActionInputV1Schema.parse(input));
          }
          if (options.refuse) return { kind: 'refused', reason: 'unsupportedField' };
          return options.uncertain ? { kind: 'uncertain' } : { kind: 'applied', observation: {
            ...source.getResult, kind: 'present', localRef: { kindId: entryRef.kindId, collisionScope: entryRef.collisionScope, entryId: entryRef.entryId },
            locator: row.content!.outcome.locator, snapshot: row.content!.outcome.snapshot,
            viewer: { involvement: [] },
          } };
        }
        throw new Error(`Task fields must consume the opening read, received ${action.localId}`);
      } },
    });
  });
  mounted.push(fixture);
  return { fixture, saved, transitioned, colored, opened, notifications, sourceUrl: observation.outcome.locator.webUrl,
    rereads: () => rereads, reads: () => reads, entryRef };
}

it('picks assignees from the source directory once the source declares one, committing the chosen set', async () => {
  const { fixture, saved } = await mountEditor({ fields: ['assigneeIds'], values: { assigneeIds: ['ada'] },
    snapshotCapabilities: { editFields: ['assigneeIds'], fieldChoices: true },
    taskFieldChoices: { assigneeIds: [{ id: 'ada', label: 'ada' }, { id: 'grace', label: 'grace' }] } });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Assignees, ada' })); });
  await act(async () => { await fixture.press(await fixture.getByRole('menuitemcheckbox', { name: 'grace' })); });
  expect(saved.map(write => write.fields)).toEqual([{ assigneeIds: ['ada', 'grace'] }]);
});

it('never types assignees and reads once when the source declares no directory, keeping the current one removable', async () => {
  const { fixture, reads, saved } = await mountEditor({ fields: ['assigneeIds'], values: { assigneeIds: ['ada'] } });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Assignees, ada' })); });
  expect(reads()).toBe(1);
  expect(document.querySelector('[placeholder="Separate names with commas"]')).toBeNull();
  await expect(fixture.getByRole('menuitem', { name: 'This source\u2019s people can\u2019t be listed here' })).resolves.toBeDefined();
  await act(async () => { await fixture.press(await fixture.getByRole('menuitemcheckbox', { name: 'ada' })); });
  expect(saved.map(write => write.fields)).toEqual([{ assigneeIds: [] }]);
});

it('names the viewing Account in Assignees through the Account display owner and preserves native edit ids', async () => {
  const accountId = '5e3a0581-0000-4000-8000-000000000001';
  const { fixture, saved, reads } = await mountEditor({ accountData: true, viewerAccountId: accountId,
    fields: ['assigneeIds'], values: { assigneeIds: [accountId, 'octocat'] } });
  const assignees = await fixture.getByRole('button', { name: 'Assignees, You, octocat' });
  expect(document.querySelector('[data-testid="triage-task-properties.assigneeIds"]')?.textContent).not.toContain(accountId);
  expect(reads()).toBe(1);
  await act(async () => { await fixture.press(assignees); });
  expect(document.querySelector('[placeholder="Separate names with commas"]')).toBeNull();
  await act(async () => { await fixture.press(await fixture.getByRole('menuitemcheckbox', { name: 'octocat' })); });
  expect(saved.map(write => write.fields)).toEqual([{ assigneeIds: [accountId] }]);
});

it.each(['Mara', null])('uses the shared task assignee display without exposing its Account id (name: %s)', async assigneeLabel => {
  const ownerId = '5e3a0581-0000-4000-8000-000000000001';
  const { reads } = await mountEditor({ accountData: true, viewerAccountId: 'recipient', assigneeLabel,
    fields: ['assigneeIds'], values: { assigneeIds: [ownerId] } });
  const property = document.querySelector('[data-testid="triage-task-properties.assigneeIds"]');
  expect(property).not.toBeNull();
  expect(property?.textContent).not.toContain(ownerId);
  if (assigneeLabel !== null) expect(property?.textContent).toContain(assigneeLabel);
  expect(reads()).toBe(1);
});

it('shows the projected owner to a view-only recipient without an editor or an additional read', async () => {
  const { reads, saved } = await mountEditor({ accountData: true, viewerAccountId: 'recipient', assigneeLabel: 'Mara',
    fields: ['assigneeIds'], snapshotCapabilities: { editFields: [], transitions: [] } });
  const property = document.querySelector('[data-testid="triage-task-properties.assigneeIds"]');
  expect(property).not.toBeNull();
  expect(property?.textContent).toContain('Mara');
  expect(property?.getAttribute('role')).not.toBe('button');
  expect(property?.querySelector('button, [role="button"], input')).toBeNull();
  expect(reads()).toBe(1);
  expect(saved).toEqual([]);
});

it('keeps typing local, commits one edit, and does not replay an uncertain edit', async () => {
  const { fixture, saved, rereads } = await mountEditor({ uncertain: true });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Edit title and notes' })); });
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Title"]');
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Fix reconnect handling');
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(saved).toEqual([]);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Save changes' })); });
  expect(saved).toHaveLength(1);
  expect(saved[0]?.fields).toEqual({ title: 'Fix reconnect handling' });
  expect(rereads()).toBe(1);
  expect(await fixture.getByRole('button', { name: `Open in ${createTriageSourceV1Fixture().descriptor.displayName}` })).toBeDefined();
  await act(async () => { await expect(fixture.press(await fixture.getByRole('button', { name: 'Save changes' }))).rejects.toMatchObject({ code: 'stale_surface' }); });
  expect(saved).toHaveLength(1);
});

it('names the source and attempted move target in recovery and opens only its known locator', async () => {
  const transitions = [
    { id: 'review', label: 'Review queue', state: { presentation: 'active', nativeLabel: 'Review queue' } },
  ] satisfies NonNullable<TriageTaskCapabilitiesV1['transitions']>;
  const { fixture, transitioned, opened, notifications, sourceUrl } = await mountEditor({ uncertain: true, transitions });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Change status, Open' })); });
  await act(async () => { await fixture.press(await fixture.getByRole('menuitemradio', { name: 'Review queue' })); });
  expect(transitioned).toHaveLength(1);
  expect(document.body.textContent).toContain('Review queue');
  const sourceName = createTriageSourceV1Fixture().descriptor.displayName;
  expect(notifications).toEqual([expect.stringContaining(sourceName)]);
  expect(notifications[0]).toContain('Review queue');
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: `Open in ${sourceName}` })); });
  expect(opened).toEqual([sourceUrl]);
});

it('rebases a deliberate title and due-date edit on fresh values while retaining the unknown-write notice', async () => {
  const { fixture, saved } = await mountEditor({ uncertain: true, fields: ['title', 'body', 'dueDate'],
    values: { title: 'Original title', body: 'Original notes', dueDate: null },
    recoveryValues: { title: 'Peer title', body: 'Peer notes', dueDate: null } });
  const changeTitle = async (title: string) => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Title"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, title);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Save changes' })); });
  };
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Edit title and notes' })); });
  await changeTitle('Lost intent');
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Check again' })); });
  expect(saved).toHaveLength(1);
  expect(document.body.textContent).toContain(`${createTriageSourceV1Fixture().descriptor.displayName} may have saved`);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Edit title and notes' })); });
  expect(document.querySelector<HTMLInputElement>('input[aria-label="Title"]')!.value).toBe('Peer title');
  await changeTitle('New title');
  expect(saved.at(-1)?.fields).toEqual({ title: 'New title' });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Check again' })); });
  await typeAndSave(fixture, 'Due date, None', '2026-11-03');
  expect(saved.map(write => write.fields)).toEqual([{ title: 'Lost intent' }, { title: 'New title' }, { dueDate: '2026-11-03' }]);
});

it('offers no Edit task when the admitted source has no edit role', async () => {
  const { fixture, saved } = await mountEditor({ readOnly: true });
  // A control that can never succeed is not drawn (a greyed "Edit task" on every read-only source's entry).
  await expect(fixture.queryByRole('button', { name: 'Edit title and notes' })).resolves.toBeUndefined();
  expect(document.querySelector('input[aria-label="Title"]')).toBeNull();
  expect(saved).toEqual([]);
});

it.each([true, false])('refuses an editor when the admitted source cannot supply its current fields (Machine pending: %s)', async (pending) => {
  const { fixture, saved } = await mountEditor({ readFailed: true });
  const source = createTriageSourceV1Fixture();
  const entry = testkitEntryRef();
  await act(async () => { await fixture.updateSurface(createSurfaceContextFixture({
    targetedContributions: targetedTaskSource(source.configuredInstance.instance.source, entry.kindId, 'edit'),
    machineConnectionPending: pending, machineExecutionReady: false,
  })); });
  await expect(fixture.queryByRole('button', { name: 'Edit title and notes' })).resolves.toBeUndefined();
  expect(document.querySelector('[aria-label="Notes"]')).toBeNull();
  expect(saved).toEqual([]);
});

it('edits an Account task while no Machine is reachable', async () => {
  const { fixture, saved, rereads } = await mountEditor({ accountData: true });
  const source = createTriageSourceV1Fixture();
  const entry = testkitEntryRef();
  await act(async () => { await fixture.updateSurface(createSurfaceContextFixture({
    targetedContributions: targetedTaskSource(source.configuredInstance.instance.source, entry.kindId, 'edit'),
    machineConnectionPending: true, machineExecutionReady: false,
  })); });
  expect((await fixture.getByRole('button', { name: 'Edit title and notes' })).state?.disabled).not.toBe(true);
  expect(saved).toEqual([]);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Edit title and notes' })); });
  const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Notes"]');
  expect(input?.value).toContain('Original Markdown.');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Account notes');
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Save changes' })); });
  expect(saved.map(input => input.fields)).toEqual([{ body: 'Account notes' }]);
  expect(rereads()).toBe(1);
});

it('edits the full body independently of truncated display facts and sends only the changed field', async () => {
  const { fixture, saved } = await mountEditor({ truncated: true });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Edit title and notes' })); });
  const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Notes"]');
  expect(input?.value).toBe('Full body\n\nOriginal Markdown.  \n');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Updated body\n\nKeep whitespace.  \n');
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(saved).toEqual([]);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Save changes' })); });
  expect(saved[0]?.fields).toEqual({ body: 'Updated body\n\nKeep whitespace.  \n' });
});

it('does not open an edit form with fabricated values when the full read fails', async () => {
  const { fixture, saved } = await mountEditor({ readFailed: true });
  await expect(fixture.queryByRole('button', { name: 'Edit title and notes' })).resolves.toBeUndefined();
  expect(document.querySelector('[role="form"]')).toBeNull();
  expect(saved).toEqual([]);
});

it('supports body-only sources and does not offer a field whose current value is unavailable', async () => {
  const { fixture, saved } = await mountEditor({ fields: ['body', 'labelIds'], values: { body: 'Current notes' } });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Edit title and notes' })); });
  expect(document.querySelector('input[aria-label="Title"]')).toBeNull();
  expect(document.querySelector('textarea[aria-label="Labels"]')).toBeNull();
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Notes"]')?.value).toBe('Current notes');
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Save changes' })); });
  expect(saved).toEqual([]);
});

function otherTaskRow(entryId: string, title: string) {
  const base = testkitObservation();
  if (base.outcome.kind !== 'present') throw new Error('Expected a present fixture');
  const entryRef = testkitEntryRef({ entryId });
  return foldTriageListWindow({ observations: [{ ...base, entryRef, outcome: { ...base.outcome,
    localRef: { kindId: entryRef.kindId, collisionScope: entryRef.collisionScope, entryId },
    snapshot: { ...base.outcome.snapshot, title, designation: `#${entryId}` } } }], lanes: [], configuredSourcesStatus: 'complete',
    activeSourceInstanceIds: [base.sourceInstanceId], lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 1_000 }).rows[0]!;
}

async function typePropertyValue(fixture: PluginUiTestkit, control: string, value: string) {
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: control })); });
  const input = [...document.querySelectorAll<HTMLInputElement>('input')].at(-1)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function typeAndSave(fixture: PluginUiTestkit, control: string, value: string) {
  await typePropertyValue(fixture, control, value);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Save' })); });
}

it('shows each declared field as its own typed property and commits only that field per change', async () => {
  const blocker = otherTaskRow('41', 'Add the webhook replay tool');
  const parentRow = otherTaskRow('42', 'Server-side rounding');
  const values: TriageTaskFieldsV1 = { title: 'Exact title', body: 'Exact notes\n', labelIds: ['docs'], assigneeIds: [],
    dueDate: null, estimate: 2, parent: null, blockedBy: [] };
  const fields = Object.keys(values) as TriageTaskFieldV1[];
  const { fixture, saved, reads } = await mountEditor({ fields, values, relationRows: [blocker, parentRow] });
  // The exact values are read once when the task opens: no Edit press, no JSON document.
  expect(reads()).toBe(1);
  expect(document.querySelector('[role="form"]')).toBeNull();
  expect(document.querySelector('textarea[aria-label="Due date"], textarea[aria-label="Parent task"]')).toBeNull();
  await expect(fixture.getByRole('button', { name: 'Labels, docs' })).resolves.toBeDefined();

  // Numeric inputs normalize 2.0 to 2; PropertyList disables Save while the value is unchanged.
  await typePropertyValue(fixture, 'Estimate, 2', '2.0');
  expect((await fixture.getByRole('button', { name: 'Save' })).state?.disabled).toBe(true);
  expect(saved).toEqual([]);
  expect(reads()).toBe(1);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Cancel' })); });

  // A typed number: one write carrying only the estimate, then the authoritative values are read again.
  await typeAndSave(fixture, 'Estimate, 2', '5');
  expect(saved.map(input => input.fields)).toEqual([{ estimate: 5 }]);
  expect(reads()).toBe(2);
  // A malformed day never reaches the source.
  await typeAndSave(fixture, 'Due date, None', '2026-13-01');
  expect(saved).toHaveLength(1);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Cancel' })); });
  await typeAndSave(fixture, 'Due date, None', '2026-11-03');
  expect(saved.at(-1)?.fields).toEqual({ dueDate: '2026-11-03' });

  // The parent is chosen from the entries the window holds and written as their complete reference.
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Parent, None' })); });
  const parentChoice = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]')]
    .find(node => node.textContent?.includes('Server-side rounding'));
  await act(async () => { parentChoice!.click(); });
  expect(saved.at(-1)?.fields).toEqual({ parent: parentRow.entryRef });

  // A blocker is added the same way, and removing it writes the remaining list.
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Add a blocker' })); });
  const blockerChoice = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(node => node.textContent?.includes('Add the webhook replay tool'));
  await act(async () => { blockerChoice!.click(); });
  expect(saved.at(-1)?.fields).toEqual({ blockedBy: [blocker.entryRef] });
  expect(saved.every(input => Object.keys(input.fields).length === 1)).toBe(true);
  expect(fixture.rawTaskWrites).toEqual([]);
});

it('removes an existing blocker through its host control', async () => {
  const blocker = otherTaskRow('41', 'Add the webhook replay tool');
  const { fixture, saved } = await mountEditor({ fields: ['blockedBy'],
    values: { blockedBy: [blocker.entryRef] }, relationRows: [blocker] });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Remove, Add the webhook replay tool' })); });
  expect(saved.map(input => input.fields)).toEqual([{ blockedBy: [] }]);
  expect(fixture.rawTaskWrites).toEqual([]);
});

it.each(['refused', 'uncertain'] as const)('shows a %s label colour outcome without reporting it applied', async labelOutcome => {
  const { fixture, colored, rereads } = await mountEditor({ fields: ['labelIds'], values: { labelIds: ['bug'] },
    labelColors: [], viewerAccountId: 'account-me', labelOutcome });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Labels, bug' })); });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Colour of bug, No colour' })); });
  await act(async () => { await fixture.press(await fixture.getByRole('menuitemradio', { name: 'Green' })); });
  expect(document.body.textContent).toContain(labelOutcome === 'refused' ? 'not applied' : 'not confirmed');
  expect(colored).toHaveLength(1);
  expect(rereads()).toBe(0);
});

it('shows a personal label in its colour and changes the colour from the label editor, Account-wide', async () => {
  const { fixture, saved, colored, rereads } = await mountEditor({ fields: ['labelIds'], values: { labelIds: ['bug', 'docs'] },
    labelColors: [{ name: 'bug', colorToken: 'danger' }], viewerAccountId: 'account-me' });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Labels, bug, docs' })); });
  // Set and clear keep their own declared Actions and input schemas.
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Colour of bug, Red' })); });
  await act(async () => { await fixture.press(await fixture.getByRole('menuitemradio', { name: 'No colour' })); });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Colour of bug, Red' })); });
  await act(async () => { await fixture.press(await fixture.getByRole('menuitemradio', { name: 'Green' })); });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Colour of docs, No colour' })); });
  await act(async () => { await fixture.press(await fixture.getByRole('menuitemradio', { name: 'Blue' })); });

  expect(colored).toEqual([
    { action: 'tasks.internal.labels.clearColor', input: { scope: { serverId: 'fixture-home', accountId: 'account-me' }, name: 'bug' } },
    { action: 'tasks.internal.labels.setColor', input: { scope: { serverId: 'fixture-home', accountId: 'account-me' }, name: 'bug', colorToken: 'success' } },
    { action: 'tasks.internal.labels.setColor', input: { scope: { serverId: 'fixture-home', accountId: 'account-me' }, name: 'docs', colorToken: 'accent' } },
  ]);
  // A colour is the Account's label catalog, not a task edit; the window re-reads to show it.
  expect(saved).toEqual([]);
  expect(rereads()).toBe(3);
  expect(fixture.rawTaskWrites).toEqual([]);
});

it('preserves an applied label colour settlement when the aggregate refresh fails', async () => {
  const { fixture, colored, rereads } = await mountEditor({ fields: ['labelIds'], values: { labelIds: ['bug'] },
    labelColors: [], viewerAccountId: 'account-me', rereadFails: true });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Labels, bug' })); });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Colour of bug, No colour' })); });
  await act(async () => { await fixture.press(await fixture.getByRole('menuitemradio', { name: 'Green' })); });
  expect(colored).toHaveLength(1);
  expect(rereads()).toBe(1);
  expect(document.body.textContent).not.toContain('Change not confirmed');
  expect(document.body.textContent).not.toContain('Change not applied');
});

it('draws Blue and Purple labels in the theme\'s own hues, not its accent or info tone', async () => {
  const { fixture } = await mountEditor({ fields: ['labelIds'], values: { labelIds: ['docs', 'ui'] },
    labelColors: [{ name: 'docs', colorToken: 'accent' }, { name: 'ui', colorToken: 'info' }], viewerAccountId: 'account-me' });
  const { theme } = createSurfaceContextFixture();
  const paint = (color: string) => { const probe = document.createElement('span'); probe.style.backgroundColor = color; return probe.style.backgroundColor; };
  const dots = () => [...document.querySelectorAll<HTMLElement>('[style*="background-color"]')].map(node => node.style.backgroundColor);
  // The chip on the closed trigger, then the swatch in the colour menu.
  expect(dots()).toContain(paint(theme.colors.blue!));
  expect(dots()).toContain(paint(theme.colors.purple!));
  expect(dots()).not.toContain(paint(theme.colors.accent));
  expect(dots()).not.toContain(paint(theme.colors.info));
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Labels, docs, ui' })); });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Colour of docs, Blue' })); });
  const blue = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(node => node.textContent?.includes('Blue'))!;
  expect([...blue.querySelectorAll<HTMLElement>('[style*="background-color"]')].map(node => node.style.backgroundColor))
    .toContain(paint(theme.colors.blue!));
  const purple = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(node => node.textContent?.includes('Purple'))!;
  expect([...purple.querySelectorAll<HTMLElement>('[style*="background-color"]')].map(node => node.style.backgroundColor))
    .toContain(paint(theme.colors.purple!));
});

it.each(['refused', 'uncertain'] as const)('says a %s typed field change and leaves the read values in place', async outcome => {
  const { fixture, saved, reads } = await mountEditor({ fields: ['labelIds'], values: { labelIds: ['bug'] },
    refuse: outcome === 'refused', uncertain: outcome === 'uncertain' });
  await typeAndSave(fixture, 'Labels, bug', 'bug, ui');
  expect(saved.map(input => input.fields)).toEqual([{ labelIds: ['bug', 'ui'] }]);
  expect(document.body.textContent).toContain(outcome === 'refused' ? 'This change is not available for this task.'
    : `${createTriageSourceV1Fixture().descriptor.displayName} may have saved`);
  expect(reads()).toBe(outcome === 'uncertain' ? 2 : 1);
  const control = await fixture.getByRole('button', { name: 'Labels, bug' });
  if (outcome === 'uncertain') expect(control.state?.disabled).toBe(true);
});

it('offers the source transitions without a Machine and commits the chosen one through the Account aggregate', async () => {
  const transitions = [
    { id: 'close', label: 'Closed', state: { presentation: 'resolved', nativeLabel: 'Closed', completionReason: 'completed' } },
    { id: 'reopen', label: 'Open', state: { presentation: 'active', nativeLabel: 'Open' } },
  ] satisfies NonNullable<TriageTaskCapabilitiesV1['transitions']>;
  const { fixture, saved, transitioned } = await mountEditor({ transitions });
  const source = createTriageSourceV1Fixture();
  const entry = testkitEntryRef();
  await act(async () => { await fixture.updateSurface(createSurfaceContextFixture({
    targetedContributions: targetedTaskSource(source.configuredInstance.instance.source, entry.kindId, 'edit', false, ['title', 'body'], transitions),
    machineConnectionPending: true, machineExecutionReady: false,
  })); });
  // An operation, not a field: no unlabelled "Choose…" select waiting for a value.
  expect(document.querySelector('[aria-label="Change status"][role="combobox"]')).toBeNull();
  // The fixture task is Open: the control says so, and its name keeps the operation.
  const trigger = await fixture.getByRole('button', { name: 'Change status, Open' });
  await act(async () => { await fixture.press(trigger); });
  const closed = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent?.includes('Closed'));
  expect(closed).toBeDefined();
  await act(async () => { closed!.click(); });
  expect(transitioned).toHaveLength(1);
  expect(transitioned[0]).toMatchObject({ transitionId: 'close' });
  expect(fixture.rawTaskWrites).toEqual([]);
  expect(saved).toEqual([]);
});

it('checks the task\'s current status in its workflow menu, and choosing it again writes nothing', async () => {
  const transitions = [
    { id: 'reopen', label: 'Open', state: { presentation: 'active', nativeLabel: 'Open' } },
    { id: 'close', label: 'Closed', state: { presentation: 'resolved', nativeLabel: 'Closed', completionReason: 'completed' } },
  ] satisfies NonNullable<TriageTaskCapabilitiesV1['transitions']>;
  const { fixture, transitioned } = await mountEditor({ nativeLabel: 'Open', transitions });
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Change status, Open' })); });
  const choice = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    .find(node => node.textContent?.includes(label));
  expect(choice('Open')?.getAttribute('aria-checked')).toBe('true');
  expect(choice('Closed')?.getAttribute('aria-checked')).toBe('false');
  await act(async () => { choice('Open')!.click(); });
  expect(transitioned).toHaveLength(0);
});

it('names the status control by the task\'s current status in the source\'s own word', async () => {
  const { fixture } = await mountEditor({ nativeLabel: 'In Review', transitions: [
    { id: 'done', label: 'Done', state: { presentation: 'resolved', nativeLabel: 'Done', completionReason: 'completed' } },
  ] });
  const trigger = await fixture.getByRole('button', { name: 'Change status, In Review' });
  expect(trigger).toBeDefined();
  await expect(fixture.getByText('In Review')).resolves.toBeDefined();
});

it('gathers a native transition’s required input before one write, and Cancel writes nothing', async () => {
  const { fixture, transitioned } = await mountEditor({ nativeLabel: 'In Review', transitions: [
    { id: 'finish', label: 'Finish review', state: { presentation: 'resolved', nativeLabel: 'Done' },
      requiredFields: [{ id: 'resolution', label: 'Resolution note', kind: 'text' }] },
  ] });
  const open = async () => {
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Change status, In Review' })); });
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(node => node.textContent?.includes('Finish review'));
    await act(async () => { item!.click(); });
  };
  await open();
  expect(transitioned).toHaveLength(0);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Cancel' })); });
  expect(transitioned).toHaveLength(0);
  await open();
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Resolution note"]');
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Verified with the reporter');
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const submit = [...document.querySelectorAll<HTMLElement>('[role="form"] [role="button"], [role="form"] button')]
    .find(node => node.textContent === 'Finish review');
  expect(submit).toBeDefined();
  await act(async () => { submit!.click(); });
  expect(transitioned).toHaveLength(1);
  expect(transitioned[0]).toMatchObject({ transitionId: 'finish',
    fieldValues: [{ fieldId: 'resolution', value: 'Verified with the reporter' }] });
  expect(fixture.rawTaskWrites).toEqual([]);
});

it('does not report an unsettled commit when its authoritative reread fails', async () => {
  let write: ReturnType<typeof useTriageTaskCommit> | undefined;
  let calls = 0;
  await act(async () => {
    mounted.push(await createPluginUiTestkit({ identity: { instanceId: 'reread', mountNonce: 'reread' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => {
        write = useTriageTaskCommit(async () => { throw new Error('Read transport unavailable'); });
        return null;
      }), surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: () => { calls++; return { kind: 'uncertain' }; } },
    }));
  });
  await act(async () => {
    const currentWrite = write!;
    const commit = (...args: Parameters<typeof currentWrite.prepare>) => commitTaskWriteForTest(mounted.at(-1)!.context.hostApi, currentWrite, ...args);
    await expect(commit('tasks/edit-v1', {})).resolves.toMatchObject({ kind: 'uncertain' });
    // A second activation can still hold the preceding render's callback.
    await commit('tasks/edit-v1', {});
  });
  expect(write!.result).toEqual({ kind: 'uncertain' });
  expect(write!.busy).toBe(false);
  await act(async () => { await commitTaskWriteForTest(mounted.at(-1)!.context.hostApi, write!, 'tasks/edit-v1', {}); });
  expect(calls).toBe(1);
});

async function mountRowStatus(task: React.ComponentProps<typeof TriageTaskRowStatusControl>['task'], transitions: NonNullable<TriageTaskCapabilitiesV1['transitions']>) {
  const entryRef = testkitEntryRef();
  const observation = testkitObservation();
  const row = foldTriageListWindow({ observations: [{ ...observation, entryRef }], lanes: [],
    configuredSourcesStatus: 'complete', activeSourceInstanceIds: [observation.sourceInstanceId],
    lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 1_000 }).rows[0]!;
  const selected = readTriageSelectedObservationV1(row)!;
  const transitioned: unknown[] = [];
  let rereads = 0;
  let fixture!: Awaited<ReturnType<typeof createPluginUiTestkit>>;
  await act(async () => {
    fixture = await createPluginUiTestkit({ identity: { instanceId: 'task-row', mountNonce: `row-${mounted.length}` },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => <TriageTaskRowStatusControl task={task} onApplied={async () => { rereads++; }}
        address={{ entryRef, sourceInstanceId: selected.sourceInstanceId, lastKnownLocator: selected.observation.locator }} />),
      surfaceContext: createSurfaceContextFixture({ targetedContributions: targetedTaskSource(entryRef.source, entryRef.kindId, 'edit', false, ['title'], transitions) }),
      adapter: controls => createPluginUiRnwSemanticSurfaceAdapter({ actionBindings: { commit: controls.commit }, overlays: true, ephemeralSharedScope: createTriageEphemeralSharedScopeFixture() }),
      // Host Action transport is the genuine boundary.
      handlers: { executeAction: ({ input }) => { transitioned.push(input); return { kind: 'refused', reason: 'unavailable' }; } },
    });
  });
  mounted.push(fixture);
  return { fixture, transitioned, entryRef, rereads: () => rereads };
}

const ROW_TRANSITIONS = [
  { id: 'start', label: 'In Progress', state: { presentation: 'active', stage: 'started', nativeLabel: 'In Progress' } },
  { id: 'done', label: 'Done', state: { presentation: 'resolved', nativeLabel: 'Done', completionReason: 'completed' } },
] as const satisfies NonNullable<TriageTaskCapabilitiesV1['transitions']>;

it('completes a task directly when completion is the source’s only offered transition', async () => {
  const { fixture, transitioned, entryRef } = await mountRowStatus({ category: 'unstarted', statusLabel: 'Todo', relations: null,
    completingTransitionId: 'done', transitions: [{ id: 'done', label: 'Done', category: 'completed' }] }, [ROW_TRANSITIONS[1]]);
  const glyph = await fixture.getByRole('button', { name: 'Mark as done, Todo' });
  await act(async () => { await fixture.press(glyph); });
  // One press, one write of the declared completing transition; no menu in between.
  expect(document.querySelector('[role="menuitem"]')).toBeNull();
  expect(transitioned).toHaveLength(1);
  expect(transitioned[0]).toMatchObject({ entryRef, transitionId: 'done' });
  expect(fixture.rawTaskWrites).toEqual([]);
});

it('opens the source workflow from the row glyph when no single completing transition exists', async () => {
  const { fixture, transitioned } = await mountRowStatus({ category: 'started', statusLabel: 'In Review', relations: null,
    transitions: [{ id: 'start', label: 'In Progress', category: 'started' }, { id: 'done', label: 'Done', category: 'completed' }] }, ROW_TRANSITIONS);
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Change status, In Review' })); });
  expect(transitioned).toEqual([]);
  const done = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent?.includes('Done'));
  await act(async () => { done!.click(); });
  expect(transitioned).toHaveLength(1);
  expect(transitioned[0]).toMatchObject({ transitionId: 'done' });
});
