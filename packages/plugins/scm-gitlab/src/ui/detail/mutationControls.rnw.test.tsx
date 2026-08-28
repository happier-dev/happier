// @vitest-environment jsdom
import React, { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriagePostMutationCompletionProvider } from '@happier-dev/triage-sources/ui';
import { afterEach, describe, expect, it } from 'vitest';

import {
  GITLAB_CONNECTED_ACCOUNT_PURPOSE,
  GITLAB_PLUGIN_ID,
  GITLAB_TRIAGE_MUTATION_ACTION_IDS,
} from '../../triage/contribution.js';

import { renderSurface } from '../renderSurface.js';

/**
 * The three GitLab merge-request writes, as a user can actually reach them.
 *
 * The Actions, their contracts and their confirming reads were tested long
 * before anything rendered them, and an Action a source's own detail renderer
 * does not render is an Action nobody can perform. These cases prove the one
 * thing a declaration and a schema cannot: that the control exists, that
 * pressing it dispatches, that what leaves carries the exact commit the reader
 * was shown, and that the settled answer is presented rather than swallowed.
 *
 * Two things are deliberately proved by ABSENCE. There is no confirmation
 * control in this panel — confirmation is host-owned manifest metadata raised by
 * the canonical Action gate before the handler runs, and a second "are you sure"
 * here would be a competing owner of one decision. And no write carries a squash,
 * commit-message or branch-removal value: GitLab exposes all three and this panel
 * offers none, so the project's own configured defaults decide instead of an
 * invisible default this surface picked.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = Object.freeze({ pluginId: GITLAB_PLUGIN_ID, localId: 'gitlab-forge' });

const INSTANCE = Object.freeze({
  v: 1,
  instance: Object.freeze({
    source: SOURCE,
    sourceInstanceId: '9d2a6b1e-6c1a-4b7d-9f31-1d4a6c8b2e70',
  }),
  binding: Object.freeze({
    purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
    account: Object.freeze({
      service: Object.freeze({ pluginId: GITLAB_PLUGIN_ID, localId: 'gitlab-account' }),
      accountId: 'account-1',
    }),
  }),
  localInstanceKey: 'gitlab-com',
  configuration: Object.freeze({ v: 1, token: 'gitlab-configuration-token-v1' }),
});

/** GitLab's own `sha` for this merge request, exactly as the mounted read observed it. */
const OBSERVED_HEAD = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

const LOCAL_REF = Object.freeze({
  kindId: 'merge-request',
  collisionScope: 'gitlab.com:group/project',
  entryId: '412',
});

function launchInput(overrides: Readonly<{
  kindId?: string;
  state?: Readonly<Record<string, unknown>>;
  nativeRevision?: string | undefined;
  linkedSessions?: readonly Readonly<{ sessionId: string; displayTitle?: string }>[];
}> = {}): JsonValue {
  const revision = 'nativeRevision' in overrides ? overrides.nativeRevision : OBSERVED_HEAD;
  return {
    v: 1,
    instance: INSTANCE,
    observation: {
      entryRef: { source: SOURCE, ...LOCAL_REF, kindId: overrides.kindId ?? LOCAL_REF.kindId },
      observedAtMs: 1_760_000_700_000,
      locator: {
        v: 1,
        webUrl: 'https://gitlab.com/group/project/-/merge_requests/412',
        displayPath: 'group/project !412',
        routingToken: 'group/project',
      },
      snapshot: {
        v: 1,
        title: 'Consolidate the duplicated normalizer',
        scopeLabel: 'group/project',
        state: overrides.state ?? { presentation: 'active', nativeLabel: 'Opened' },
        facts: [],
      },
      viewer: { involvement: ['reviewRequested'] },
      ...(revision === undefined ? {} : { nativeRevision: revision }),
    },
    linkedSessions: overrides.linkedSessions ?? [],
  } as unknown as JsonValue;
}

const STATE_ROW = Object.freeze({
  projectId: 3,
  iid: '412',
  state: 'opened',
  draft: false,
  autoMergeScheduled: false,
});

const recorded: { action: unknown; input: unknown }[] = [];
const mounted: PluginUiTestkit[] = [];

let nextResult: JsonValue = { kind: 'unavailable', failure: { class: 'transient', code: 'unset' } };
let completedMutations = 0;

async function mountDetail(input: JsonValue = launchInput()): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        pluginId: GITLAB_PLUGIN_ID,
        pluginVersion: '0.0.0',
        viewId: 'gitlab-detail',
        generation: 'gitlab-detail-mount',
      },
      surface: (context) => (
        <TriagePostMutationCompletionProvider
          onComplete={async () => { completedMutations += 1; }}
        >
          {renderSurface(context) as React.ReactNode}
        </TriagePostMutationCompletionProvider>
      ),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: input,
      handlers: {
        executeAction: async ({ action, input: dispatched }) => {
          recorded.push({ action, input: dispatched });
          return nextResult;
        },
      },
    });
  });
  mounted.push(fixture);
  return fixture;
}

function actionRef(localId: string) {
  return { pluginId: GITLAB_PLUGIN_ID, localId };
}

afterEach(async () => {
  recorded.splice(0);
  completedMutations = 0;
  nextResult = { kind: 'unavailable', failure: { class: 'transient', code: 'unset' } };
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the mounted GitLab merge-request writes', () => {
  it('offers all three writes on an open merge request', async () => {
    const detail = await mountDetail();

    await expect(detail.queryByRole('button', { name: 'Merge' })).resolves.toBeDefined();
    await expect(detail.queryByRole('button', { name: 'Mark ready for review' }))
      .resolves.toBeDefined();
    await expect(detail.queryByRole('button', { name: 'Close' })).resolves.toBeDefined();
    await expect(detail.queryByRole('textbox', { label: 'Reviewer username' })).resolves.toBeDefined();
    await expect(detail.queryByRole('button', { name: 'Add reviewers' })).resolves.toBeDefined();
    await expect(detail.queryByRole('button', { name: 'Remove reviewers' })).resolves.toBeDefined();
  });

  it('offers the registered merge-request reopen on a closed merge request', async () => {
    const detail = await mountDetail(launchInput({ state: { presentation: 'closed', nativeLabel: 'Closed' } }));
    await expect(detail.queryByRole('button', { name: 'Reopen' })).resolves.toBeDefined();
  });

  it('offers issue state, assignee, and label controls without deleting their input paths', async () => {
    const detail = await mountDetail(launchInput({ kindId: 'issue', nativeRevision: '2026-08-12T09:00:00.000Z' }));
    await expect(detail.queryByRole('button', { name: 'Close issue' })).resolves.toBeDefined();
    await expect(detail.queryByRole('textbox', { label: 'Assignee username' })).resolves.toBeDefined();
    await expect(detail.queryByRole('textbox', { label: 'Label name' })).resolves.toBeDefined();
    for (const name of ['Add assignees', 'Remove assignees', 'Add labels', 'Remove labels']) {
      await expect(detail.queryByRole('button', { name })).resolves.toBeDefined();
    }
  });

  it('opens a linked Work Session through the incumbent host Action', async () => {
    const detail = await mountDetail(launchInput({
      kindId: 'issue',
      nativeRevision: '2026-08-12T09:00:00.000Z',
      linkedSessions: [{ sessionId: 'session-1', displayTitle: 'Fix GitLab issue' }],
    }));
    await act(async () => { await detail.press(await detail.getByRole('tab', { name: 'Work Sessions' })); });
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Open Fix GitLab issue' })); });
    expect(recorded.at(-1)).toEqual({ action: 'session.open', input: { sessionId: 'session-1' } });
  });

  it('keeps an opaque linked Session id out of visible and accessible copy', async () => {
    const detail = await mountDetail(launchInput({
      kindId: 'issue',
      nativeRevision: '2026-08-12T09:00:00.000Z',
      linkedSessions: [{ sessionId: 'opaque-session-id' }],
    }));
    await act(async () => { await detail.press(await detail.getByRole('tab', { name: 'Work Sessions' })); });

    await expect(detail.queryByText('Untitled session')).resolves.toBeDefined();
    await expect(detail.queryByRole('button', { name: 'Open session' })).resolves.toBeDefined();
    await expect(detail.queryByText('opaque-session-id')).resolves.toBeUndefined();
  });

  it('sends the merge pinned to the exact commit the reader was shown', async () => {
    nextResult = { kind: 'merged', item: { ...STATE_ROW, state: 'merged' } } as JsonValue;
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('button', { name: 'Merge' }));

    // The whole payload, not a subset: an extra member here would be a decision
    // about the repository's history that the reader never made.
    expect(recorded).toEqual([{
      action: actionRef(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMerge),
      input: { v: 1, instance: INSTANCE, localRef: LOCAL_REF, observedHeadSha: OBSERVED_HEAD },
    }]);
    await expect(detail.queryByText('Merged. GitLab confirmed this merge request is merged.'))
      .resolves.toBeDefined();
  });

  it('sends the draft transition with the same head pin, because it summons reviewers', async () => {
    nextResult = { kind: 'ready', item: STATE_ROW } as JsonValue;
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('button', { name: 'Mark ready for review' }));

    expect(recorded).toEqual([{
      action: actionRef(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMarkReady),
      input: { v: 1, instance: INSTANCE, localRef: LOCAL_REF, observedHeadSha: OBSERVED_HEAD },
    }]);
  });

  it('sends a close that carries no pin and no branch-removal decision', async () => {
    // `sources/SCM.md` §2.6 puts close in the head-independent row, and GitLab's
    // update exposes `should_remove_source_branch`. The exact payload is asserted
    // so neither a pin that would refuse an unaffected close, nor a branch
    // deletion nobody asked for, can arrive as an invisible default.
    nextResult = { kind: 'closed', item: { ...STATE_ROW, state: 'closed' } } as JsonValue;
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('button', { name: 'Close' }));

    expect(recorded).toEqual([{
      action: actionRef(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestClose),
      input: { v: 1, instance: INSTANCE, localRef: LOCAL_REF },
    }]);
  });

  it('dispatches on one press, asking no confirmation of its own', async () => {
    // The manifest declares host-owned confirmation for all three writes. A
    // second dialog here would mean the answer the user gave was not the one that
    // counted, so the press must reach the host directly.
    nextResult = { kind: 'closed', item: { ...STATE_ROW, state: 'closed' } } as JsonValue;
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('button', { name: 'Close' }));

    expect(recorded).toHaveLength(1);
    await expect(detail.queryByRole('button', { name: 'Confirm' })).resolves.toBeUndefined();
  });

  it('keeps a scheduled merge apart from a merge that happened', async () => {
    // GitLab answers 200 on a merge it only queued behind a train or a pipeline.
    // Telling someone waiting on a release that it merged would be false.
    nextResult = {
      kind: 'scheduled',
      item: { ...STATE_ROW, autoMergeScheduled: true },
    } as JsonValue;
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('button', { name: 'Merge' }));

    await expect(detail.queryByText(
      'GitLab accepted this and will merge it later — it is queued, not merged.',
    )).resolves.toBeDefined();
    await expect(detail.queryByText('Merged. GitLab confirmed this merge request is merged.'))
      .resolves.toBeUndefined();
  });

  it('never presents an unconfirmed write as a failure or as nothing', async () => {
    nextResult = {
      kind: 'unconfirmed',
      failure: { class: 'transient', code: 'transport-failed' },
    } as JsonValue;
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('button', { name: 'Merge' }));

    await expect(detail.queryByText(
      'GitLab received this and could not confirm the result. Reload before trying again — it may already have taken effect.',
    )).resolves.toBeDefined();
  });

  it('signals the target-owned reconciliation after every settled write outcome', async () => {
    const detail = await mountDetail();

    nextResult = { kind: 'merged', item: { ...STATE_ROW, state: 'merged' } } as JsonValue;
    await detail.press(await detail.getByRole('button', { name: 'Merge' }));

    nextResult = {
      kind: 'unconfirmed',
      failure: { class: 'transient', code: 'transport-failed' },
    } as JsonValue;
    await detail.press(await detail.getByRole('button', { name: 'Merge' }));

    expect(completedMutations).toBe(2);
  });

  it('does not re-observe after a reconfirmation that wrote nothing', async () => {
    const detail = await mountDetail();
    nextResult = {
      kind: 'reconfirmationRequired',
      observed: { ...STATE_ROW, headSha: 'f'.repeat(40) },
    } as JsonValue;

    await detail.press(await detail.getByRole('button', { name: 'Merge' }));

    // The currentness preflight refused before the provider write. The mounted
    // source must not spend the target-owned exact-get trigger on an outcome
    // that cannot have changed provider state.
    expect(completedMutations).toBe(0);
  });

  it('offers close but withholds the head-pinned writes when GitLab reported no commit', async () => {
    // A just-created merge request has no populated head yet. Merge and
    // mark-ready are withheld because dispatching them would be unconditional;
    // close needs no pin, so removing it would delete a capability that works.
    const detail = await mountDetail(launchInput({ nativeRevision: undefined }));

    await expect(detail.queryByRole('button', { name: 'Merge' })).resolves.toBeUndefined();
    await expect(detail.queryByRole('button', { name: 'Mark ready for review' }))
      .resolves.toBeUndefined();
    await expect(detail.queryByRole('button', { name: 'Close' })).resolves.toBeDefined();
    await expect(detail.queryByText(
      'GitLab has not reported this merge request’s latest commit, so it cannot be merged or marked ready from here yet.',
    )).resolves.toBeDefined();
  });

  it('offers no close on a merge request that is no longer open', async () => {
    const detail = await mountDetail(launchInput({
      state: { presentation: 'closed', nativeLabel: 'Merged' },
    }));

    await expect(detail.queryByRole('button', { name: 'Merge' })).resolves.toBeUndefined();
    await expect(detail.queryByRole('button', { name: 'Close' })).resolves.toBeUndefined();
  });

  it('does not offer merge-request writes on an issue', async () => {
    const detail = await mountDetail(launchInput({ kindId: 'issue' }));

    await expect(detail.queryByRole('button', { name: 'Merge' })).resolves.toBeUndefined();
    await expect(detail.queryByRole('button', { name: 'Close' })).resolves.toBeUndefined();
  });
});
