// @vitest-environment jsdom
import React, { act } from 'react';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiActionControlTestHost, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
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
const ROUTING_TOKEN = 'group/project';

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
        routingToken: ROUTING_TOKEN,
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
type MountedFixture = PluginUiTestkit & { controls: ReturnType<typeof createPluginUiActionControlTestHost> };

let nextResult: JsonValue = { kind: 'unavailable', failure: { class: 'transient', code: 'unset' } };
let nextError: PluginError | null = null;
let completedMutations = 0;

async function mountDetail(input: JsonValue = launchInput()): Promise<MountedFixture> {
  const controls = createPluginUiActionControlTestHost(async ({ action, input }) => {
    recorded.push({ action, input });
    if (nextError !== null) return { ok: false, errorCode: nextError.diagnostics?.some(diagnostic => diagnostic.code === 'plugin_action_current_intent_rejected') ? 'approval_rejected' : nextError.code, error: nextError.message,
      ...(nextError.details === undefined ? {} : { details: nextError.details }) };
    return { ok: true, result: nextResult };
  });
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-195', mountNonce: 'fixture-mount-195' },
      authorPlugin: { id: GITLAB_PLUGIN_ID, version: '0.0.0' },
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
        actionControl: controls.handler,
        executeAction: async ({ action, input: dispatched }) => {
          if (typeof action !== 'string' && Object.values(GITLAB_TRIAGE_MUTATION_ACTION_IDS).some(localId => localId === action.localId)) {
            throw new Error('A press write must execute through the host Action control.');
          }
          recorded.push({ action, input: dispatched });
          if (nextError !== null) throw nextError;
          return nextResult;
        },
      },
    });
  });
  mounted.push(fixture);
  return { ...fixture, controls };
}

function actionRef(localId: string) {
  return { pluginId: GITLAB_PLUGIN_ID, localId };
}

function recordedCallsFor(localId: string) {
  return recorded.filter(({ action }) => (
    typeof action === 'object'
    && action !== null
    && 'pluginId' in action
    && action.pluginId === GITLAB_PLUGIN_ID
    && 'localId' in action
    && action.localId === localId
  ));
}

afterEach(async () => {
  recorded.splice(0);
  completedMutations = 0;
  nextResult = { kind: 'unavailable', failure: { class: 'transient', code: 'unset' } };
  nextError = null;
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the mounted GitLab merge-request writes', () => {
  it('shows a declined host confirmation without reporting a provider mutation', async () => {
    nextError = new PluginError({ code: 'denied',
      diagnostics: [{ code: 'plugin_action_current_intent_rejected', severity: 'error' }] });
    const detail = await mountDetail();
    await act(async () => { await act(async () => detail.controls.press('Merge')); });
    await expect(detail.getByText('You declined the confirmation, so nothing was written.')).resolves.toBeDefined();
    expect(completedMutations).toBe(0);
  });

  it('offers all three writes on an open merge request', async () => {
    const detail = await mountDetail();

    await expect(Promise.resolve(detail.controls.presentation('Merge'))).resolves.toBeDefined();
    await expect(Promise.resolve(detail.controls.presentation('Mark ready for review')))
      .resolves.toBeDefined();
    await expect(Promise.resolve(detail.controls.presentation('Close'))).resolves.toBeDefined();
    await expect(detail.queryByRole('textbox', { label: 'Reviewer username' })).resolves.toBeDefined();
    await expect(Promise.resolve(detail.controls.presentation('Add reviewers'))).resolves.toBeDefined();
    await expect(Promise.resolve(detail.controls.presentation('Remove reviewers'))).resolves.toBeDefined();
  });

  it('offers the registered merge-request reopen on a closed merge request', async () => {
    const detail = await mountDetail(launchInput({ state: { presentation: 'closed', nativeLabel: 'Closed' } }));
    await expect(Promise.resolve(detail.controls.presentation('Reopen'))).resolves.toBeDefined();
  });

  it('offers issue state, assignee, and label controls without deleting their input paths', async () => {
    const detail = await mountDetail(launchInput({ kindId: 'issue', nativeRevision: '2026-08-12T09:00:00.000Z' }));
    await expect(Promise.resolve(detail.controls.presentation('Close issue'))).resolves.toBeDefined();
    await expect(detail.queryByRole('textbox', { label: 'Assignee username' })).resolves.toBeDefined();
    await expect(detail.queryByRole('textbox', { label: 'Label name' })).resolves.toBeDefined();
    for (const name of ['Add assignees', 'Remove assignees', 'Add labels', 'Remove labels']) {
      await expect(Promise.resolve(detail.controls.presentation(name))).resolves.toBeDefined();
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

    await act(async () => detail.controls.press('Merge'));

    // The whole payload, not a subset: an extra member here would be a decision
    // about the repository's history that the reader never made.
    expect(recordedCallsFor(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMerge)).toEqual([{
      action: actionRef(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMerge),
      input: {
        v: 1,
        instance: INSTANCE,
        localRef: LOCAL_REF,
        routingToken: ROUTING_TOKEN,
        observedHeadSha: OBSERVED_HEAD,
      },
    }]);
    await expect(detail.queryByText('Merged. GitLab confirmed this merge request is merged.'))
      .resolves.toBeDefined();
  });

  it('sends the draft transition with the same head pin, because it summons reviewers', async () => {
    nextResult = { kind: 'ready', item: STATE_ROW } as JsonValue;
    const detail = await mountDetail();

    await act(async () => detail.controls.press('Mark ready for review'));

    expect(recordedCallsFor(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMarkReady)).toEqual([{
      action: actionRef(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMarkReady),
      input: {
        v: 1,
        instance: INSTANCE,
        localRef: LOCAL_REF,
        routingToken: ROUTING_TOKEN,
        observedHeadSha: OBSERVED_HEAD,
      },
    }]);
  });

  it('sends a close that carries no pin and no branch-removal decision', async () => {
    // `sources/SCM.md` §2.6 puts close in the head-independent row, and GitLab's
    // update exposes `should_remove_source_branch`. The exact payload is asserted
    // so neither a pin that would refuse an unaffected close, nor a branch
    // deletion nobody asked for, can arrive as an invisible default.
    nextResult = { kind: 'closed', item: { ...STATE_ROW, state: 'closed' } } as JsonValue;
    const detail = await mountDetail();

    await act(async () => detail.controls.press('Close'));

    expect(recordedCallsFor(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestClose)).toEqual([{
      action: actionRef(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestClose),
      input: { v: 1, instance: INSTANCE, localRef: LOCAL_REF, routingToken: ROUTING_TOKEN },
    }]);
  });

  it('dispatches on one press, asking no confirmation of its own', async () => {
    // The manifest declares host-owned confirmation for all three writes. A
    // second dialog here would mean the answer the user gave was not the one that
    // counted, so the press must reach the host directly.
    nextResult = { kind: 'closed', item: { ...STATE_ROW, state: 'closed' } } as JsonValue;
    const detail = await mountDetail();

    await act(async () => detail.controls.press('Close'));

    expect(recordedCallsFor(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestClose)).toHaveLength(1);
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

    await act(async () => detail.controls.press('Merge'));

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

    await act(async () => detail.controls.press('Merge'));

    expect(document.body.textContent).toContain(
      'GitLab received this and could not confirm the result. Reload before trying again — it may already have taken effect.',
    );
    expect(document.body.textContent).not.toContain('transport-failed');
  });

  it('shows a dispatched provider refusal with its code and request identity', async () => {
    nextResult = { kind: 'refused', reason: 'mutationRejected', dispatched: true,
      failure: { class: 'permission', code: 'forbidden', detail: 'GitLab Request ID: gitlab-denied-1' },
    };
    const detail = await mountDetail();
    await act(async () => detail.controls.press('Close'));
    expect(document.body.textContent).toContain('GitLab rejected this change');
    expect(document.body.textContent).toContain('Code: forbidden');
    expect(document.body.textContent).toContain('GitLab Request ID: gitlab-denied-1');
    expect(document.body.textContent).not.toContain('Nothing was attempted');
  });

  it('keeps the provider explanation on a dispatched GraphQL refusal', async () => {
    nextResult = { kind: 'refused', reason: 'mutationRejected', dispatched: true,
      messages: ['Only project maintainers may change reviewers'],
    };
    const detail = await mountDetail();
    await act(async () => detail.controls.press('Mark ready for review'));
    expect(document.body.textContent).toContain('Only project maintainers may change reviewers');
    expect(document.body.textContent).not.toContain('Nothing was attempted');
  });

  it('signals the target-owned reconciliation after every settled write outcome', async () => {
    const detail = await mountDetail();

    nextResult = { kind: 'merged', item: { ...STATE_ROW, state: 'merged' } } as JsonValue;
    await act(async () => detail.controls.press('Merge'));

    nextResult = {
      kind: 'unconfirmed',
      failure: { class: 'transient', code: 'transport-failed' },
    } as JsonValue;
    await act(async () => detail.controls.press('Merge'));

    expect(completedMutations).toBe(2);
  });

  it('does not re-observe after a reconfirmation that wrote nothing', async () => {
    const detail = await mountDetail();
    nextResult = {
      kind: 'reconfirmationRequired',
      observed: { ...STATE_ROW, headSha: 'f'.repeat(40) },
    } as JsonValue;

    await act(async () => detail.controls.press('Merge'));

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

    await expect(Promise.resolve(detail.controls.presentation('Merge'))).resolves.toBeUndefined();
    await expect(Promise.resolve(detail.controls.presentation('Mark ready for review')))
      .resolves.toBeUndefined();
    await expect(Promise.resolve(detail.controls.presentation('Close'))).resolves.toBeDefined();
    await expect(detail.queryByText(
      'GitLab has not reported this merge request’s latest commit, so it cannot be merged or marked ready from here yet.',
    )).resolves.toBeDefined();
  });

  it('offers no close on a merge request that is no longer open', async () => {
    const detail = await mountDetail(launchInput({
      state: { presentation: 'resolved', nativeLabel: 'Merged' },
    }));

    await expect(Promise.resolve(detail.controls.presentation('Merge'))).resolves.toBeUndefined();
    await expect(Promise.resolve(detail.controls.presentation('Close'))).resolves.toBeUndefined();
  });

  it('does not offer merge-request writes on an issue', async () => {
    const detail = await mountDetail(launchInput({ kindId: 'issue' }));

    await expect(Promise.resolve(detail.controls.presentation('Merge'))).resolves.toBeUndefined();
    await expect(Promise.resolve(detail.controls.presentation('Close'))).resolves.toBeUndefined();
  });
});
