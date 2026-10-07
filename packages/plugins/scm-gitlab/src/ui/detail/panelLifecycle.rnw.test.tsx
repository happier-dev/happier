// @vitest-environment jsdom
import React, { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit, PluginUiTestkitHostHandlers } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriagePostMutationCompletionProvider } from '@happier-dev/triage-sources/ui';
import { afterEach, describe, expect, it } from 'vitest';

import {
  GITLAB_CONNECTED_ACCOUNT_PURPOSE,
  GITLAB_PLUGIN_ID,
  GITLAB_TRIAGE_DETAIL_ACTION_IDS,
} from '../../triage/contribution.js';
import { renderSurface } from '../renderSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = Object.freeze({ pluginId: GITLAB_PLUGIN_ID, localId: 'gitlab-forge' });
const LOCAL_REF = Object.freeze({
  kindId: 'merge-request',
  collisionScope: 'gitlab.com:group/project',
  entryId: '412',
});
const LOCATOR = Object.freeze({
  v: 1,
  webUrl: 'https://gitlab.com/group/project/-/merge_requests/412',
  displayPath: 'group/project !412',
  routingToken: 'group/project',
});
const SNAPSHOT = Object.freeze({
  v: 1,
  title: 'Read the provider description',
  scopeLabel: 'group/project',
  state: Object.freeze({ presentation: 'active', nativeLabel: 'Opened' }),
  facts: Object.freeze([]),
});
const VIEWER = Object.freeze({ involvement: Object.freeze(['reviewRequested']) });
const LAUNCH_INPUT = {
  v: 1,
  instance: {
    v: 1,
    instance: {
      source: SOURCE,
      sourceInstanceId: '9d2a6b1e-6c1a-4b7d-9f31-1d4a6c8b2e70',
    },
    binding: {
      purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
      account: {
        service: { pluginId: GITLAB_PLUGIN_ID, localId: 'gitlab-account' },
        accountId: 'account-1',
      },
    },
    localInstanceKey: 'gitlab-com',
    configuration: { v: 1, token: 'gitlab-configuration-token-v1' },
  },
  observation: {
    entryRef: { source: SOURCE, ...LOCAL_REF },
    observedAtMs: 1_760_000_700_000,
    locator: LOCATOR,
    snapshot: SNAPSHOT,
    viewer: VIEWER,
  },
  linkedSessions: [],
} as unknown as JsonValue;

function overviewResult(description: string): JsonValue {
  return {
    kind: 'overview',
    observedAtMs: 1_760_000_700_100,
    observation: {
      kind: 'present',
      localRef: LOCAL_REF,
      locator: LOCATOR,
      snapshot: SNAPSHOT,
      viewer: VIEWER,
    },
    description,
    descriptionTruncated: false,
  } as unknown as JsonValue;
}

function changesResult(
  path: string,
  continuation: string | null,
): JsonValue {
  return {
    kind: 'changes',
    rows: [{
      path,
      newFile: false,
      renamedFile: false,
      deletedFile: false,
      collapsed: false,
      tooLarge: false,
    }],
    diffLimitStatus: 'reported',
    omittedRowCount: 0,
    projectionTruncated: false,
    ...(continuation === null ? {} : { continuation }),
  } as unknown as JsonValue;
}

/** The typed failure a GitLab Changes read returns when the provider refuses it. */
function unavailableChanges(): JsonValue {
  return {
    kind: 'unavailable',
    failure: { class: 'transient', code: 'gitlab-changes-page-refused' },
  } as unknown as JsonValue;
}

const mounted: PluginUiTestkit[] = [];

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

async function mountDetail(
  executeAction: NonNullable<PluginUiTestkitHostHandlers['executeAction']>,
  panel?: string,
): Promise<PluginUiTestkit> {
  let detail!: PluginUiTestkit;
  await act(async () => {
    detail = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-194', mountNonce: 'fixture-mount-194' },
      authorPlugin: { id: GITLAB_PLUGIN_ID, version: '0.0.0' },
      surface: (context) => (
        <TriagePostMutationCompletionProvider onComplete={async () => {}}>
          {renderSurface(context) as React.ReactNode}
        </TriagePostMutationCompletionProvider>
      ),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: panel === undefined ? LAUNCH_INPUT : { ...LAUNCH_INPUT as object, panel } as JsonValue,
      handlers: { executeAction },
    });
  });
  mounted.push(detail);
  return detail;
}

async function openTab(detail: PluginUiTestkit, name: string): Promise<void> {
  await act(async () => {
    await detail.press(await detail.getByRole('tab', { name }));
  });
}

describe('the mounted GitLab detail-panel lifecycle', () => {
  it('reads merge-request Activity as one stream with each remark once and no story step', async () => {
    const note = { id: 'note-1', author: 'Mara', body: 'Source-only discussion.', system: false, atMs: 1_760_000_100_000 };
    const detail = await mountDetail(async ({ action, input }) => {
      const localId = (action as Readonly<{ localId?: string }>).localId;
      if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.listNotes) return {
        kind: 'notes', rows: [note], omittedRowCount: 0, projectionTruncated: false,
      };
      if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.listDiscussions) return {
        kind: 'discussions',
        rows: [{ id: 'discussion-1', individualNote: true, resolved: false, notes: [note], omittedNoteCount: 0 }],
        omittedRowCount: 0, projectionTruncated: false,
      };
      if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.listActivityEvents) {
        const source = (input as Readonly<{ eventSource?: string }>).eventSource ?? 'state';
        return {
          kind: 'activityEvents', source,
          rows: source === 'state' ? [{ id: 'state-1', source: 'state', action: 'closed', actor: 'Jonas', atMs: 1_760_000_200_000 }] : [],
          omittedRowCount: 0, projectionTruncated: false,
        };
      }
      return { kind: 'unavailable', failure: { class: 'transient', code: 'fixture-unavailable' } };
    }, 'activity');
    await expect(detail.getByText('closed')).resolves.toBeDefined();
    const text = document.body.textContent ?? '';
    // One remark, one event: the notes walk and the discussions walk return the same note.
    expect(text.split('Source-only discussion.').length - 1).toBe(1);
    expect(text.indexOf('Source-only discussion.')).toBeLessThan(text.indexOf('closed'));
    // Activity is the host tab, not a numbered step inside it.
    await expect(detail.queryByRole('heading', { name: 'Activity' })).resolves.toBeUndefined();
    await expect(detail.queryByRole('tab')).resolves.toBeUndefined();
  });
  it.each([
    [1, 2, 3, '1 failed', '· 3 passed · 2 running'],
    [0, 2, 3, 'Running', '2 running · 3 passed'],
    [0, 0, 3, 'Passed', 'All 3 passed'],
  ] as const)('uses the canonical job rollup for the story state (%s failing, %s running)', async (failingCount, runningCount, passingCount, label, summary) => {
    const detail = await mountDetail(async ({ action }) => {
      const localId = (action as Readonly<{ localId?: string }>).localId;
      if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.readOverview) return overviewResult('Repair');
      if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.listChanges) return changesResult('src/story.ts', null);
      if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.listPipelines) return {
        kind: 'pipelines', rows: [], failingCount, runningCount, passingCount,
        rollupPipelineId: 'pipeline-1', omittedRowCount: 0, projectionTruncated: false,
      };
      return { kind: 'unavailable', failure: { class: 'transient', code: 'fixture-unavailable' } };
    }, 'overview');
    await expect(detail.getByRole('heading', { name: 'Pipelines' })).resolves.toBeDefined();
    await expect(detail.getByRole('image', { name: label })).resolves.toBeDefined();
    await expect(detail.getByText(summary)).resolves.toBeDefined();
  });
  it('does not turn an unavailable job breakdown into a passing story state', async () => {
    const detail = await mountDetail(async ({ action }) => {
      const localId = (action as Readonly<{ localId?: string }>).localId;
      if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.readOverview) return overviewResult('Repair');
      if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.listChanges) return changesResult('src/story.ts', null);
      if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.listPipelines) return {
        kind: 'pipelines', rows: [], omittedRowCount: 0, projectionTruncated: false,
      };
      return { kind: 'unavailable', failure: { class: 'transient', code: 'fixture-unavailable' } };
    }, 'overview');
    await expect(detail.queryByRole('heading', { name: 'Pipelines' })).resolves.toBeUndefined();
    await expect(detail.queryByRole('image', { name: 'Passed' })).resolves.toBeUndefined();
  });
  it('renders the ask and changed files in the host Overview story without a second tab strip', async () => {
    const detail = await mountDetail(async ({ action }) => {
      const localId = (action as Readonly<{ localId?: string }>).localId;
      if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.readOverview) return overviewResult('The requested repair.');
      if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.listChanges) return changesResult('src/story.ts', null);
      return { kind: 'unavailable', failure: { class: 'transient', code: 'fixture-unavailable' } };
    }, 'overview');
    await expect(detail.getByRole('heading', { name: 'The ask' })).resolves.toBeDefined();
    await expect(detail.getByRole('heading', { name: 'What changed' })).resolves.toBeDefined();
    await expect(detail.getByText('The requested repair.')).resolves.toBeDefined();
    await expect(detail.getByText('src/story.ts')).resolves.toBeDefined();
    // GitLab's changes read carries no line counts; the story says so instead of listing every file as a fact.
    await expect(detail.getByText('1 file')).resolves.toBeDefined();
    await expect(detail.getByText('Line counts not reported')).resolves.toBeDefined();
    await expect(detail.queryByText('1 file(s) read.')).resolves.toBeUndefined();
    for (const chrome of ['No projected facts', 'Answered in the panels beside this one, not on the list row:']) {
      await expect(detail.queryByText(chrome)).resolves.toBeUndefined();
    }
    await expect(detail.queryByRole('button', { name: 'Re-read this overview from GitLab' })).resolves.toBeUndefined();
    await expect(detail.queryByRole('tab')).resolves.toBeUndefined();
  });
  it('reads the provider description when the initially active Overview mounts', async () => {
    const dispatched: string[] = [];
    const detail = await mountDetail(async ({ action }) => {
      const localId = (action as Readonly<{ localId?: string }>).localId ?? '';
      dispatched.push(localId);
      if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.readOverview) {
        return overviewResult('Description fetched from GitLab on the first active interval.');
      }
      throw new Error(`unexpected action ${localId}`);
    });

    await expect(detail.getByText('Description fetched from GitLab on the first active interval.'))
      .resolves.toBeDefined();
    expect(dispatched.filter((id) => id === GITLAB_TRIAGE_DETAIL_ACTION_IDS.readOverview))
      .toHaveLength(1);
  });

  it('returns to the Changes page model it already loaded instead of re-reading page one', async () => {
    const continuations: Array<string | undefined> = [];
    const detail = await mountDetail(async ({ action, input }) => {
      const localId = (action as Readonly<{ localId?: string }>).localId ?? '';
      if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.readOverview) {
        return overviewResult('Current provider description.');
      }
      if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.listChanges) {
        const continuation = (input as Readonly<{ continuation?: string }>).continuation;
        continuations.push(continuation);
        if (continuations.length === 1) return changesResult('src/first.ts', 'changes-page-2');
        if (continuations.length === 2) return changesResult('src/second.ts', 'changes-page-3');
        return changesResult('src/third.ts', null);
      }
      throw new Error(`unexpected action ${localId}`);
    });

    await openTab(detail, 'Changes');
    await expect(detail.getByText('src/first.ts')).resolves.toBeDefined();
    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Show more files' }));
    });
    await expect(detail.getByText('src/second.ts')).resolves.toBeDefined();

    await openTab(detail, 'Overview');
    await openTab(detail, 'Changes');

    // §4.6 retains the parsed per-file page model. A reader who loaded a later
    // file and glanced at Overview comes back to it, and the tab does not spend
    // GitLab's budget re-reading what it already holds.
    await expect(detail.getByText('src/first.ts')).resolves.toBeDefined();
    await expect(detail.getByText('src/second.ts')).resolves.toBeDefined();
    expect(continuations).toEqual([undefined, 'changes-page-2']);

    // The retained cursor is the one that follows the retained pages, not a
    // restart: the next request continues the walk.
    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Show more files' }));
    });
    await expect(detail.getByText('src/third.ts')).resolves.toBeDefined();
    expect(continuations).toEqual([undefined, 'changes-page-2', 'changes-page-3']);
  });

  it('keeps the Changes pages it settled when a later page failed and the reader returns', async () => {
    const continuations: Array<string | undefined> = [];
    const detail = await mountDetail(async ({ action, input }) => {
      const localId = (action as Readonly<{ localId?: string }>).localId ?? '';
      if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.readOverview) {
        return overviewResult('Current provider description.');
      }
      if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.listChanges) {
        continuations.push((input as Readonly<{ continuation?: string }>).continuation);
        if (continuations.length === 1) return changesResult('src/retained.ts', 'changes-page-2');
        if (continuations.length === 2) return unavailableChanges();
        return changesResult('src/restarted.ts', null);
      }
      throw new Error(`unexpected action ${localId}`);
    });

    await openTab(detail, 'Changes');
    await expect(detail.getByText('src/retained.ts')).resolves.toBeDefined();
    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Show more files' }));
    });
    await expect(detail.getByText('src/retained.ts')).resolves.toBeDefined();

    await openTab(detail, 'Overview');
    await openTab(detail, 'Changes');

    // A later page that failed says nothing about the pages that settled. §4.6
    // retains those, so the reader comes back to the file they already read
    // rather than to a walk restarted from page one over GitLab's budget.
    await expect(detail.getByText('src/retained.ts')).resolves.toBeDefined();
    await expect(detail.queryByText('src/restarted.ts')).resolves.toBeUndefined();
    expect(continuations).toEqual([undefined, 'changes-page-2']);
  });

  it('lets the reader retry the Changes continuation whose page failed', async () => {
    const continuations: Array<string | undefined> = [];
    const detail = await mountDetail(async ({ action, input }) => {
      const localId = (action as Readonly<{ localId?: string }>).localId ?? '';
      if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.readOverview) {
        return overviewResult('Current provider description.');
      }
      if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.listChanges) {
        continuations.push((input as Readonly<{ continuation?: string }>).continuation);
        if (continuations.length === 1) return changesResult('src/first.ts', 'changes-page-2');
        if (continuations.length === 2) return unavailableChanges();
        return changesResult('src/second.ts', null);
      }
      throw new Error(`unexpected action ${localId}`);
    });

    await openTab(detail, 'Changes');
    await expect(detail.getByText('src/first.ts')).resolves.toBeDefined();
    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Show more files' }));
    });

    // The position was never read, so the enabled control the reader is looking
    // at must actually ask for it again instead of being inert.
    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Show more files' }));
    });

    await expect(detail.getByText('src/second.ts')).resolves.toBeDefined();
    expect(continuations).toEqual([undefined, 'changes-page-2', 'changes-page-2']);
  });

  it('discards a Changes walk whose only read was still in flight when the reader left', async () => {
    const continuations: Array<string | undefined> = [];
    let resolveFirstPage!: (value: JsonValue) => void;
    const firstPage = new Promise<JsonValue>((resolve) => { resolveFirstPage = resolve; });
    const detail = await mountDetail(async ({ action, input }) => {
      const localId = (action as Readonly<{ localId?: string }>).localId ?? '';
      if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.readOverview) {
        return overviewResult('Current provider description.');
      }
      if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.listChanges) {
        continuations.push((input as Readonly<{ continuation?: string }>).continuation);
        return continuations.length === 1 ? firstPage : changesResult('src/restarted.ts', null);
      }
      throw new Error(`unexpected action ${localId}`);
    });

    await openTab(detail, 'Changes');
    await openTab(detail, 'Overview');
    await act(async () => {
      resolveFirstPage(changesResult('src/abandoned.ts', null));
      await Promise.resolve();
    });
    await openTab(detail, 'Changes');

    // The abandoned read settled nothing, so there is no page model to return
    // to and the panel starts its walk again rather than waiting on a request
    // that no longer exists.
    await expect(detail.getByText('src/restarted.ts')).resolves.toBeDefined();
    await expect(detail.queryByText('src/abandoned.ts')).resolves.toBeUndefined();
    expect(continuations).toEqual([undefined, undefined]);
  });
});
