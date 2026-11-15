// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTargetedContributionsV1 } from '@happier-dev/plugin-sdk/ui';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1, type TriageSourceDescriptorV1 } from '@happier-dev/triage-protocol/v1';
import { GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1 } from '../../../../scm-github/src/triage/contribution.js';
import { INTERNAL_TASK_DESCRIPTOR_V1 } from '../../internalTasks/contribution.js';
import { testkitEntryRef, testkitObservation } from '../../corpus/testkit/observations.test-support.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../projection/listWindow.js';
import { TriageTransitionTaskActionInputV1Schema } from '../../actions/tasksProtocol.js';
import { planTriageListItemsV1 } from '../list/sections.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';
import { createTriageEphemeralSharedScopeFixture } from '../window/ephemeralSharedScope.test-support.js';
import { TriageTaskRowStatusControl } from './taskFields.js';
import { createTaskActionControlTestkit } from './taskActionControl.test-support.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); });

async function mountSourceRow(descriptor: TriageSourceDescriptorV1, kindId: string) {
  const entryRef = testkitEntryRef({ kindId });
  const observation = testkitObservation();
  const row = foldTriageListWindow({ observations: [{ ...observation, entryRef }], lanes: [],
    configuredSourcesStatus: 'complete', activeSourceInstanceIds: [observation.sourceInstanceId],
    lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: observation.observedAtMs }).rows[0]!;
  const kind = descriptor.kinds.find(candidate => candidate.id === kindId)!;
  const item = planTriageListItemsV1({ rows: [row], pins: [], workflowSubjectOf: () => kind.workflowSubject ?? null,
    tasks: { audience: 'everyone', isTask: () => kind.task === true, hasSessions: () => false,
      capabilitiesOf: () => kind.taskCapabilities } })[0]!;
  const selected = readTriageSelectedObservationV1(row)!;
  const protocol = { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 };
  const contributor = { pluginId: entryRef.source.pluginId, contributionId: entryRef.source.localId,
    occurrenceId: 'source-one', sourceCustody: { kind: 'development' as const, registeredRootId: 'task-source' } };
  // Targeted contributions and Action execution cross the genuine SDK host boundary.
  // The descriptor is the real source producer; list projection and rendered control stay real.
  const targeted: PluginUiTargetedContributionsV1 = {
    target: { pluginId: 'happier.triage', occurrenceId: 'triage-one',
      sourceCustody: { kind: 'development', registeredRootId: 'triage-source' } },
    points: [{ pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocols: [{ protocol, contributions: [{
      contributor, protocol, descriptor,
      operations: [{ point: { pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocol },
        contributor, role: 'transition', action: { pluginId: entryRef.source.pluginId, localId: 'transition' } }], surfaces: [],
    }] }] }],
  };
  const writes: ReturnType<typeof TriageTransitionTaskActionInputV1Schema.parse>[] = [];
  let fixture!: Awaited<ReturnType<typeof createTaskActionControlTestkit>>;
  await act(async () => {
    fixture = await createTaskActionControlTestkit({ identity: { instanceId: 'source-task-row', mountNonce: `row-${mounted.length}` },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface(() => <TriageTaskRowStatusControl task={item.task!} sourceName={descriptor.displayName} onApplied={async () => undefined}
        address={{ entryRef, sourceInstanceId: selected.sourceInstanceId, lastKnownLocator: selected.observation.locator }} />),
      surfaceContext: createSurfaceContextFixture({ targetedContributions: targeted }),
      adapter: controls => createPluginUiRnwSemanticSurfaceAdapter({ actionBindings: { commit: controls.commit },
        overlays: true, ephemeralSharedScope: createTriageEphemeralSharedScopeFixture() }),
      handlers: { executeAction: ({ action, input }) => {
        expect(action).toBe('tasks/transition-v1');
        writes.push(TriageTransitionTaskActionInputV1Schema.parse(input));
        return { kind: 'refused', reason: 'unavailable' };
      } },
    });
  });
  mounted.push(fixture);
  return { fixture, writes, entryRef };
}

it('opens GitHub’s native status menu from its source-derived row glyph before any write', async () => {
  const { fixture, writes, entryRef } = await mountSourceRow(GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1, 'issue');
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Change status, Open' })); });
  expect(writes).toEqual([]);
  const choices = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  expect(choices.map(choice => choice.textContent)).toEqual(['Open', 'Completed', 'Not planned']);
  await act(async () => { choices.find(choice => choice.textContent === 'Not planned')!.click(); });
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ entryRef, transitionId: 'not_planned' });
  expect(fixture.rawTaskWrites).toEqual([]);
});

it('offers the personal task’s declared transitions from its status glyph', async () => {
  const { fixture, writes, entryRef } = await mountSourceRow(INTERNAL_TASK_DESCRIPTOR_V1, 'task');
  await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Change status, Open' })); });
  expect(writes).toEqual([]);
  const choices = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  expect(choices).toHaveLength(INTERNAL_TASK_DESCRIPTOR_V1.kinds[0]!.taskCapabilities!.transitions!.length);
  const completed = INTERNAL_TASK_DESCRIPTOR_V1.kinds[0]!.taskCapabilities!.transitions!.find(transition => transition.id === 'completed')!;
  await act(async () => { choices.find(choice => choice.textContent === completed.label)!.click(); });
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ entryRef, transitionId: 'completed' });
  expect(fixture.rawTaskWrites).toEqual([]);
});
