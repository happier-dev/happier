// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';

import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1, type TriageListWindowV1 } from '../../projection/listWindow.js';
import { INTERNAL_TASK_SOURCE_V1 } from '../../internalTasks/identity.js';
import { InternalTaskListProjectionSchema } from '../../internalTasks/listProjection.js';
import type { InternalTaskListProjection } from '../../internalTasks/listProjection.js';
import { TESTKIT_SOURCE_INSTANCE_ID, testkitEntryRef, testkitObservation, testkitPresentOutcome, testkitSnapshot } from '../../corpus/testkit/observations.test-support.js';
import { createTriageEphemeralSharedScopeOriginFixture } from '../../ui/window/ephemeralSharedScope.test-support.js';
import { projectSessionWorkTasksV1, renderSurface } from './sessionWorkTasksSection.js';

const mockWindow = vi.hoisted(() => ({
  snapshot: {
    window: undefined as TriageListWindowV1 | undefined,
    taskProjection: undefined as InternalTaskListProjection | undefined,
    passes: 1,
  },
  refresh: vi.fn(async () => undefined),
  readiness: { pending: false, ready: true, revision: 1 },
  readOwner: null,
}));

vi.mock('../../ui/window/useTriageListWindow.js', () => ({
  useTriageListWindow: () => mockWindow,
}));

vi.mock('../../ui/window/useTriageListWindowViewDemand.js', () => ({
  useTriageListWindowViewDemand: () => undefined,
}));

function makeWindow(entries: ReadonlyArray<{
  id: string;
  title: string;
  linkedSession?: string;
  claimedBySessionId?: string;
  linkResult?: 'complete' | 'partial' | 'failed';
}>) {
  const tasks = entries.map(entry => ({
    ...entry,
    entryRef: testkitEntryRef({ source: INTERNAL_TASK_SOURCE_V1, kindId: 'task', entryId: entry.id }),
  }));
  return {
    window: foldTriageListWindow({
      observations: tasks.map(task => ({
        ...testkitObservation({ outcome: testkitPresentOutcome({
          snapshot: testkitSnapshot({ title: task.title, state: { presentation: 'active', nativeLabel: 'In progress' } }),
        }) }),
        entryRef: task.entryRef,
      })),
      lanes: [{ source: INTERNAL_TASK_SOURCE_V1, sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID,
        health: { kind: 'walkFinished' }, exhausted: true }],
      configuredSourcesStatus: 'complete',
      activeSourceInstanceIds: [TESTKIT_SOURCE_INSTANCE_ID],
      lens: TRIAGE_LIST_DEFAULT_LENS_V1,
      assembledAtMs: 1_760_000_100_000,
    }),
    taskProjection: InternalTaskListProjectionSchema.parse({
      sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID,
      entries: tasks.map(task => ({
        entryRef: task.entryRef,
        result: {
          kind: task.linkResult ?? 'complete',
          links: task.linkedSession === undefined ? [] : [{
            entryRef: task.entryRef, sessionId: task.linkedSession, linkedAtMs: 1_760_000_000_000, displayPath: task.title,
          }],
        },
        ...(task.claimedBySessionId === undefined ? {} : {
          claim: { attemptBinding: { sessionId: task.claimedBySessionId, runId: 'run-1' }, version: 1 },
        }),
      })),
    }),
    passes: 1,
  };
}

const mountedFixtures: PluginUiTestkit[] = [];

afterEach(async () => {
  mockWindow.snapshot = { window: undefined, taskProjection: undefined, passes: 1 };
  mockWindow.refresh.mockClear();
  for (const fixture of mountedFixtures.splice(0)) await fixture.dispose();
});

async function mountSection(input: Readonly<{
  sessionId: string;
  onOpenSurface?: (view: unknown) => void;
  onExecuteAction?: (input: unknown) => Promise<unknown>;
}>): Promise<PluginUiTestkit> {
  const scope = createTriageEphemeralSharedScopeOriginFixture();
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-session-work-tasks', mountNonce: `mount-${mountedFixtures.length}` },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture({
        target: { kind: 'session', sessionId: input.sessionId },
      }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({
        ephemeralSharedScope: scope.forExecutionOrigin('fixture'),
      }),
      handlers: {
        openSurface: ({ view }) => {
          input.onOpenSurface?.(view);
        },
        executeAction: async ({ input: actionInput }) => (await input.onExecuteAction?.(actionInput)) ?? { ok: true },
      },
    });
  });
  mountedFixtures.push(fixture);
  return fixture;
}

describe('projectSessionWorkTasksV1', () => {
  it('selects Tasks linked to or claimed by the exact sessionId from the shared Task projection', () => {
    const { window, taskProjection } = makeWindow([
      { id: 't-linked', title: 'Fix retry backoff', linkedSession: 'session-a' },
      { id: 't-partial', title: 'Improve partial results', linkedSession: 'session-a', linkResult: 'partial' },
      { id: 't-claimed', title: 'Add pause indicator', claimedBySessionId: 'session-a', linkResult: 'failed' },
      { id: 't-other', title: 'Unrelated task', linkedSession: 'session-b' },
    ]);
    expect(window.rows).toHaveLength(4);
    const result = projectSessionWorkTasksV1({ sessionId: 'session-a', rows: window.rows, taskProjection });
    expect(result.map(row => row.entryRef.entryId).sort()).toEqual(['t-claimed', 't-linked', 't-partial']);
  });
});

describe('TriageSessionWorkTasksSection', () => {
  it('renders Tasks linked to the mounted Session and opens the Task detail on press with zero extra reads', async () => {
    mockWindow.snapshot = makeWindow([
      { id: 't-linked', title: 'Fix retry backoff', linkedSession: 'session-a' },
      { id: 't-other', title: 'Unrelated task', linkedSession: 'session-b' },
    ]);

    const opened: unknown[] = [];
    const executed: unknown[] = [];
    const fixture = await mountSection({
      sessionId: 'session-a',
      onOpenSurface: view => opened.push(view),
      onExecuteAction: async actionInput => {
        executed.push(actionInput);
        return { ok: true };
      },
    });

    await vi.waitFor(() => fixture.getByText('Fix retry backoff'));
    await expect(fixture.getByText('Tasks')).resolves.toBeTruthy();
    await expect(fixture.queryByText('Unrelated task')).resolves.toBeUndefined();
    expect(executed).toHaveLength(0);

    await act(async () => {
      const row = (await fixture.getAllByRole('button')).find(target => target.name?.includes('Fix retry backoff'));
      if (row === undefined) throw new Error('The linked Task row button was not found');
      await fixture.press(row);
    });
    expect(opened).toHaveLength(1);
  });

  it('renders nothing when no Tasks are linked or assigned to the Session', async () => {
    mockWindow.snapshot = makeWindow([{ id: 't-other', title: 'Unrelated task', linkedSession: 'session-b' }]);

    const fixture = await mountSection({ sessionId: 'session-a' });
    await expect(fixture.queryByText('Tasks')).resolves.toBeUndefined();
    await expect(fixture.queryByText('Unrelated task')).resolves.toBeUndefined();
  });
});
