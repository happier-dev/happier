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

import type { TriageListRowV1 } from '../../projection/listWindow.js';
import type { InternalTaskListProjection } from '../../internalTasks/listProjection.js';
import { TESTKIT_SOURCE_INSTANCE_ID, testkitEntryRef } from '../../corpus/testkit/observations.test-support.js';
import { createTriageEphemeralSharedScopeOriginFixture } from '../../ui/window/ephemeralSharedScope.test-support.js';
import { projectSessionWorkTasksV1, renderSurface } from './sessionWorkTasksSection.js';

const mockWindow = vi.hoisted(() => ({
  snapshot: {
    window: undefined as { rows: readonly TriageListRowV1[] } | undefined,
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

function makeTaskRow(id: string, title: string, status = 'In progress'): TriageListRowV1 {
  const entryRef = testkitEntryRef({ entryId: id, kindId: 'task' });
  return {
    entryRef,
    sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID,
    observation: {
      entryRef,
      title,
      kind: 'task',
      lifecycle: 'open',
      stateLabel: status,
      updatedAtMs: 1_700_000_000_000,
      createdAtMs: 1_700_000_000_000,
      repository: 'happier',
      scopeLabel: 'Happier tasks',
      number: null,
      author: null,
      webUrl: null,
      comments: null,
      checks: null,
      review: null,
      task: {
        statusCategory: status === 'Done' ? 'completed' : 'started',
        statusName: status,
      },
    },
  } as unknown as TriageListRowV1;
}

function makeProjection(entries: ReadonlyArray<{ id: string; linkedSessions?: readonly string[]; claimedBySessionId?: string }>): InternalTaskListProjection {
  return {
    sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID,
    entries: entries.map(entry => ({
      entryRef: testkitEntryRef({ entryId: entry.id, kindId: 'task' }),
      result: {
        kind: 'ready',
        links: (entry.linkedSessions ?? []).map(sessionId => ({ sessionId, linkedAtMs: 1_700_000_000_000 })),
      },
      ...(entry.claimedBySessionId === undefined ? {} : {
        claim: {
          attemptBinding: { kind: 'session', sessionId: entry.claimedBySessionId, runId: 'run-1' },
          version: 1,
        },
      }),
    })),
  } as unknown as InternalTaskListProjection;
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
    const t1 = makeTaskRow('t-linked', 'Fix retry backoff');
    const t2 = makeTaskRow('t-claimed', 'Add pause indicator');
    const t3 = makeTaskRow('t-other', 'Unrelated task');
    const projection = makeProjection([
      { id: 't-linked', linkedSessions: ['session-a'] },
      { id: 't-claimed', claimedBySessionId: 'session-a' },
      { id: 't-other', linkedSessions: ['session-b'] },
    ]);

    const result = projectSessionWorkTasksV1({
      sessionId: 'session-a',
      rows: [t1, t2, t3],
      taskProjection: projection,
    });

    expect(result.map(row => row.entryRef.entryId)).toEqual(['t-linked', 't-claimed']);
  });
});

describe('TriageSessionWorkTasksSection', () => {
  it('renders Tasks linked to the mounted Session and opens the Task detail on press with zero extra reads', async () => {
    const t1 = makeTaskRow('t-linked', 'Fix retry backoff', 'In progress');
    const t2 = makeTaskRow('t-other', 'Unrelated task', 'To do');
    mockWindow.snapshot = {
      window: { rows: [t1, t2] },
      taskProjection: makeProjection([
        { id: 't-linked', linkedSessions: ['session-a'] },
        { id: 't-other', linkedSessions: ['session-b'] },
      ]),
      passes: 1,
    };

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
    mockWindow.snapshot = {
      window: { rows: [makeTaskRow('t-other', 'Unrelated task')] },
      taskProjection: makeProjection([{ id: 't-other', linkedSessions: ['session-b'] }]),
      passes: 1,
    };

    const fixture = await mountSection({ sessionId: 'session-a' });
    await expect(fixture.queryByText('Tasks')).resolves.toBeUndefined();
    await expect(fixture.queryByText('Unrelated task')).resolves.toBeUndefined();
  });
});
