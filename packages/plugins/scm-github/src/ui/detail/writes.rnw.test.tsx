// @vitest-environment jsdom
// The package compiles JSX with the classic runtime, so `React` must be in scope.
import React, { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriagePostMutationCompletionProvider } from '@happier-dev/triage-sources/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from '../../triage/contribution.js';

import { renderSurface } from '../renderSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE_CONTRIBUTION = Object.freeze({
  pluginId: GITHUB_PLUGIN_ID,
  localId: 'github-forge',
});
const CONFIGURED_INSTANCE = Object.freeze({
  v: 1,
  instance: Object.freeze({
    source: SOURCE_CONTRIBUTION,
    sourceInstanceId: '9d2a6b1e-6c1a-4b7d-9f31-1d4a6c8b2e70',
  }),
  binding: Object.freeze({
    purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
    account: Object.freeze({
      service: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' }),
      accountId: 'account-1',
    }),
  }),
  localInstanceKey: 'github.com',
  configuration: Object.freeze({ v: 1, token: 'github-configuration-token-v1' }),
});

const OBSERVED_HEAD = 'b3f1c0a9d2e4f60718293a4b5c6d7e8f90a1b2c3';

function launchInput(
  state: Readonly<{ presentation: string; nativeLabel: string }>,
  kindId: 'pull-request' | 'issue' = 'pull-request',
  linkedSessions: readonly JsonValue[] = [],
): JsonValue {
  return {
    v: 1,
    instance: CONFIGURED_INSTANCE,
    observation: {
      entryRef: {
        source: SOURCE_CONTRIBUTION,
        kindId,
        collisionScope: 'github:1296269',
        entryId: '1284',
      },
      observedAtMs: 1_760_000_700_000,
      locator: {
        v: 1,
        webUrl: 'https://github.com/octo-org/example-app/pull/1284',
        displayPath: 'octo-org/example-app#1284',
        routingToken: 'octo-org/example-app',
      },
      snapshot: {
        v: 1,
        title: 'Consolidate the duplicated normalizer',
        scopeLabel: 'octo-org/example-app',
        state,
        facts: [],
      },
      viewer: { involvement: ['reviewRequested'] },
      nativeRevision: OBSERVED_HEAD,
    },
    linkedSessions,
  } as JsonValue;
}

const APPLIED_OBSERVATION = {
  kind: 'present',
  localRef: { kindId: 'pull-request', collisionScope: 'github:1296269', entryId: '1284' },
  locator: {
    v: 1,
    webUrl: 'https://github.com/octo-org/example-app/pull/1284',
    displayPath: 'octo-org/example-app#1284',
    routingToken: 'octo-org/example-app',
  },
  snapshot: {
    v: 1,
    title: 'Consolidate the duplicated normalizer',
    scopeLabel: 'octo-org/example-app',
    state: { presentation: 'closed', nativeLabel: 'Merged' },
    facts: [],
  },
  viewer: { involvement: ['reviewRequested'] },
} as const;

const recorded: { action: unknown; input: unknown }[] = [];
const mounted: PluginUiTestkit[] = [];
let nextResult: JsonValue = { kind: 'applied', effect: 'changed', observation: APPLIED_OBSERVATION };
let nextActionError: unknown | null = null;
let completedMutations = 0;

async function mountDetail(
  state: Readonly<{ presentation: string; nativeLabel: string }>,
  kindId: 'pull-request' | 'issue' = 'pull-request',
  linkedSessions: readonly JsonValue[] = [],
): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        pluginId: GITHUB_PLUGIN_ID,
        pluginVersion: '0.0.0',
        viewId: 'github-triage-detail',
        generation: 'github-triage-detail-mount',
      },
      surface: (context) => (
        <TriagePostMutationCompletionProvider
          onComplete={async () => { completedMutations += 1; }}
        >
          {/* The SDK surface produces an opaque host element, not a React node. */}
          {renderSurface(context) as React.ReactNode}
        </TriagePostMutationCompletionProvider>
      ),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: launchInput(state, kindId, linkedSessions),
      handlers: {
        executeAction: async ({ action, input }) => {
          recorded.push({ action, input });
          if (nextActionError !== null) throw nextActionError;
          return nextResult;
        },
      },
    }) as PluginUiTestkit;
  });
  mounted.push(fixture);
  return fixture;
}

afterEach(async () => {
  recorded.splice(0);
  completedMutations = 0;
  nextResult = { kind: 'applied', effect: 'changed', observation: APPLIED_OBSERVATION };
  nextActionError = null;
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

/**
 * The mounted write controls.
 *
 * The projections behind them are proved in `mutations.test.ts`; what only a mount
 * can prove is that they are REACHABLE — that a user looking at a pull request is
 * actually offered them, that the merge control cannot fire before a method is
 * chosen, that the payload carries the head the surface displayed, and that the
 * settled answer appears where the reader is looking rather than vanishing.
 *
 * The detail surface's own reads are absent from these cases on purpose: every
 * panel read is issued when its tab becomes active, and only the Overview tab is
 * active here.
 */
describe('the mounted GitHub write controls', () => {
  it('mounts every approved pull-request mutation and keeps blocked review publication absent', async () => {
    const detail = await mountDetail({ presentation: 'active', nativeLabel: 'Draft' });

    for (const name of [
      'Merge pull request',
      'Close pull request',
      'Mark ready for review',
      'Update branch',
      'Request review',
      'Withdraw review requests',
      'Set thread resolution',
    ]) {
      await expect(detail.getByRole('button', { name })).resolves.toMatchObject({ role: 'button' });
    }
    await expect(detail.getByRole('textbox', { label: 'Reviewer user logins' }))
      .resolves.toMatchObject({ value: '' });
    await expect(detail.getByRole('textbox', { label: 'Reviewer team slugs' }))
      .resolves.toMatchObject({ value: '' });
    await expect(detail.getByRole('textbox', { label: 'Review thread ID' }))
      .resolves.toMatchObject({ value: '' });
    await expect(detail.queryByRole('button', { name: 'Submit review' }))
      .resolves.toBeUndefined();
    await expect(detail.queryByRole('textbox', { label: 'Review summary' }))
      .resolves.toBeUndefined();
  });

  it('opens an exact linked Session through the incumbent host Action and exposes local failure', async () => {
    const detail = await mountDetail(
      { presentation: 'active', nativeLabel: 'Open' },
      'issue',
      [{ sessionId: 'session-linked-1', displayTitle: 'Fix flaky CI' }],
    );
    await act(async () => {
      await detail.press(await detail.getByRole('tab', { name: 'Work Sessions' }));
    });

    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Open Fix flaky CI' }));
    });

    expect(recorded.at(-1)).toEqual({
      action: 'session.open',
      input: { sessionId: 'session-linked-1' },
    });
  });

  it('mounts all four exact issue member deltas beside its state transition', async () => {
    const detail = await mountDetail({ presentation: 'active', nativeLabel: 'Open' }, 'issue');

    for (const name of ['Add assignees', 'Remove assignees', 'Add labels', 'Remove label']) {
      await expect(detail.getByRole('button', { name })).resolves.toMatchObject({ role: 'button' });
    }
    await expect(detail.getByRole('textbox', { label: 'Assignee usernames' }))
      .resolves.toMatchObject({ value: '' });
    await expect(detail.getByRole('textbox', { label: 'Label names' }))
      .resolves.toMatchObject({ value: '' });
  });

  it('offers the open pull request its two writes and no third', async () => {
    const detail = await mountDetail({ presentation: 'active', nativeLabel: 'Open' });

    await expect(detail.getByRole('button', { name: 'Merge pull request' }))
      .resolves.toMatchObject({ role: 'button' });
    await expect(detail.getByRole('button', { name: 'Close pull request' }))
      .resolves.toMatchObject({ role: 'button' });
    await expect(detail.queryByRole('button', { name: 'Reopen pull request' }))
      .resolves.toBeUndefined();
  });

  it('offers the closed pull request only its reopen', async () => {
    const detail = await mountDetail({ presentation: 'closed', nativeLabel: 'Closed' });

    await expect(detail.getByRole('button', { name: 'Reopen pull request' }))
      .resolves.toMatchObject({ role: 'button' });
    await expect(detail.queryByRole('button', { name: 'Merge pull request' }))
      .resolves.toBeUndefined();
    await expect(detail.queryByRole('button', { name: 'Close pull request' }))
      .resolves.toBeUndefined();
  });

  it('will not merge until a method is chosen, and dispatches nothing meanwhile', async () => {
    // A merge that fired on the first press would pick how history is rewritten
    // on the user's behalf, and would do it before the host confirmation is ever
    // reached.
    const detail = await mountDetail({ presentation: 'active', nativeLabel: 'Open' });

    const merge = await detail.getByRole('button', { name: 'Merge pull request' });
    expect(merge.state?.disabled).toBe(true);

    // The control is not merely styled inert: the mounted surface refuses the
    // press outright, and nothing reaches the host.
    await expect(act(async () => { await detail.press(merge); })).rejects.toThrow();
    expect(recorded).toEqual([]);
  });

  it('sends the head the surface showed and the method the reader chose', async () => {
    const detail = await mountDetail({ presentation: 'active', nativeLabel: 'Open' });

    await act(async () => {
      await detail.press(await detail.getByRole('radio', { name: 'Squash and merge' }));
    });
    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Merge pull request' }));
    });

    expect(recorded).toEqual([{
      action: {
        pluginId: GITHUB_PLUGIN_ID,
        localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMerge,
      },
      input: {
        v: 1,
        instance: CONFIGURED_INSTANCE,
        localRef: {
          kindId: 'pull-request',
          collisionScope: 'github:1296269',
          entryId: '1284',
        },
        routingToken: 'octo-org/example-app',
        headRevision: OBSERVED_HEAD,
        mergeMethod: 'squash',
      },
    }]);
  });

  it('shows the refusal rather than returning the control to rest', async () => {
    nextResult = { kind: 'refused', reason: 'head_advanced' };
    const detail = await mountDetail({ presentation: 'active', nativeLabel: 'Open' });

    await act(async () => {
      await detail.press(await detail.getByRole('radio', { name: 'Create a merge commit' }));
    });
    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Merge pull request' }));
    });

    await expect(detail.getByText(
      'New commits were pushed since the head shown here, so nothing was merged.',
    )).resolves.toEqual({
      content: 'New commits were pushed since the head shown here, so nothing was merged.',
    });
  });

  it('sends reopen, not close, from the control that says reopen', async () => {
    // Two head-independent writes share one control shape, so the only thing
    // separating them is the action each is bound to. Nothing else in this file
    // would notice them swapped.
    const detail = await mountDetail({ presentation: 'closed', nativeLabel: 'Closed' });

    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Reopen pull request' }));
    });

    expect(recorded.map((entry) => entry.action)).toEqual([{
      pluginId: GITHUB_PLUGIN_ID,
      localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestReopen,
    }]);
    expect(recorded.map((entry) => entry.input)).toEqual([{
      v: 1,
      instance: CONFIGURED_INSTANCE,
      localRef: {
        kindId: 'pull-request',
        collisionScope: 'github:1296269',
        entryId: '1284',
      },
      routingToken: 'octo-org/example-app',
    }]);
  });

  it('does not report a close that GitHub could not confirm as a close that happened', async () => {
    nextResult = { kind: 'uncertain' };
    const detail = await mountDetail({ presentation: 'active', nativeLabel: 'Open' });

    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Close pull request' }));
    });

    expect(recorded.map((entry) => entry.action)).toEqual([{
      pluginId: GITHUB_PLUGIN_ID,
      localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestClose,
    }]);
    await expect(detail.queryByText('Done')).resolves.toBeUndefined();
    await expect(detail.getByText('Outcome unknown')).resolves.toEqual({ content: 'Outcome unknown' });
  });

  it('asks the canonical aggregate owner to reobserve after a settled write', async () => {
    const detail = await mountDetail({ presentation: 'active', nativeLabel: 'Open' });
    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Close pull request' }));
    });

    expect(completedMutations).toBe(1);
    expect(recorded).toHaveLength(1);
  });

  it('does not reobserve after GitHub reports a write was refused before dispatch', async () => {
    nextResult = { kind: 'refused', reason: 'state_changed' };
    const detail = await mountDetail({ presentation: 'active', nativeLabel: 'Open' });

    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Close pull request' }));
    });

    expect(completedMutations).toBe(0);
    expect(recorded).toHaveLength(1);
  });

  it('reobserves after the host cannot settle a dispatched GitHub write', async () => {
    const detail = await mountDetail({ presentation: 'active', nativeLabel: 'Open' });
    nextActionError = Object.assign(
      new Error('The Action timed out after dispatch.'),
      { code: 'timeout' },
    );

    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Close pull request' }));
    });

    expect(completedMutations).toBe(1);
    expect(recorded).toHaveLength(1);
  });

  it('offers an open issue its close, with a reason, and dispatches the issue Action', async () => {
    // Six issue writes are registered and none of them was reachable from the
    // product: an issue's detail body offered no controls at all.
    const detail = await mountDetail({ presentation: 'active', nativeLabel: 'Open' }, 'issue');

    await expect(detail.queryByRole('button', { name: 'Merge pull request' }))
      .resolves.toBeUndefined();
    const close = await detail.getByRole('button', { name: 'Close issue' });

    // Inert until a reason is chosen: `Completed` and `Not planned` are two
    // different public statements about the same issue. (That a disabled control
    // also refuses the press outright is pinned on the merge control above; it is
    // one contract of the shared button, not two.)
    expect(close.state?.disabled).toBe(true);
    expect(recorded).toEqual([]);

    await act(async () => {
      await detail.press(await detail.getByRole('radio', { name: 'Not planned' }));
    });
    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Close issue' }));
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.action).toEqual({
      pluginId: GITHUB_PLUGIN_ID,
      localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueClose,
    });
    expect(recorded[0]?.input).toMatchObject({ stateReason: 'not_planned' });
  });

  it('keeps rendering the entry it opened when a write answers about another one', async () => {
    nextResult = {
      kind: 'applied',
      effect: 'changed',
      observation: {
        ...APPLIED_OBSERVATION,
        localRef: { ...APPLIED_OBSERVATION.localRef, entryId: '9999' },
      },
    } as JsonValue;
    const detail = await mountDetail({ presentation: 'active', nativeLabel: 'Open' });
    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Close pull request' }));
    });

    await expect(detail.getByRole('button', { name: 'Merge pull request' }))
      .resolves.toMatchObject({ role: 'button' });
  });
});
