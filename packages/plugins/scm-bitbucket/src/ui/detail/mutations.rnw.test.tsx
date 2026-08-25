// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriagePostMutationCompletionProvider } from '@happier-dev/triage-sources/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { BITBUCKET_PLUGIN_ID } from '../../bitbucketContracts.js';
import { BITBUCKET_TRIAGE_DETAIL_ACTION_IDS } from '../../triage/source/detailActions.js';
import { BITBUCKET_TRIAGE_MUTATION_ACTION_IDS } from '../../triage/source/mutationActions.js';

import { renderSurface } from '../renderSurface.js';

/**
 * The four Bitbucket Cloud pull-request writes, as a user can actually reach them.
 *
 * Every Action is declared `surfaces: ['ui', 'plugin']` with `placementBindings: ['detailsPanel']`.
 * `plugin` is what makes it reachable at all — a mounted plugin surface dispatches as a plugin
 * caller — while the host does not read that placement binding for a source-owned Triage detail
 * renderer; the browser shell is its only consumer, over a different contribution family. So both
 * the reachability and the control are this surface's own
 * work, and these cases prove the exact thing a declaration cannot: that a user can press it, that
 * what leaves carries the decisions they made and the commit they were shown, and that the settled
 * answer is presented rather than swallowed.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIXTURE = createTriageSourceV1Fixture();

const recorded: { action: unknown; input: unknown }[] = [];
const mounted: PluginUiTestkit[] = [];

let nextResult: JsonValue = { kind: 'unavailable', failure: { class: 'transient', code: 'unset' } };
let completedMutations = 0;

/**
 * What a specific read answers, when a case needs one.
 *
 * The comment-resolution controls only exist beside a comment, so their cases have to make the
 * Comments panel hold one. Every other action still settles into `nextResult`.
 */
let readResults: Readonly<Record<string, JsonValue>> = {};

/** One Bitbucket comment page, at whichever resolution the case needs. */
function commentsResult(
  rows: readonly Readonly<{ id: string; resolution: string; deleted?: boolean }>[],
): JsonValue {
  return {
    kind: 'comments',
    rows: rows.map((row) => ({
      id: row.id,
      author: 'Reviewer',
      body: 'Please rename this',
      deleted: row.deleted ?? false,
      resolution: row.resolution,
    })),
    omittedRowCount: 0,
    projectionTruncated: false,
  } as unknown as JsonValue;
}

const LOCAL_REF = {
  kindId: FIXTURE.detailInput.observation.entryRef.kindId,
  collisionScope: FIXTURE.detailInput.observation.entryRef.collisionScope,
  entryId: FIXTURE.detailInput.observation.entryRef.entryId,
};

async function mountDetail(
  launchInput: JsonValue = FIXTURE.detailInput as unknown as JsonValue,
): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        pluginId: BITBUCKET_PLUGIN_ID,
        pluginVersion: '0.0.0',
        viewId: 'bitbucket-triage-detail',
        generation: 'bitbucket-detail-mount',
      },
      surface: (context) => (
        <TriagePostMutationCompletionProvider
          onComplete={async () => { completedMutations += 1; }}
        >
          {renderSurface(context)}
        </TriagePostMutationCompletionProvider>
      ),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput,
      handlers: {
        executeAction: async ({ action, input }) => {
          recorded.push({ action, input });
          const localId = (action as Readonly<{ localId?: string }>).localId ?? '';
          return readResults[localId] ?? nextResult;
        },
      },
    });
  });
  mounted.push(fixture);
  return fixture;
}

afterEach(async () => {
  recorded.splice(0);
  readResults = {};
  completedMutations = 0;
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

/** Only the writes; the panels' own reads are not what these cases are about. */
function recordedWrites(): { action: unknown; input: unknown }[] {
  const writes = new Set<string>(Object.values(BITBUCKET_TRIAGE_MUTATION_ACTION_IDS));
  return recorded.filter((entry) => (
    writes.has((entry.action as Readonly<{ localId?: string }>).localId ?? '')
  ));
}

describe('the mounted Bitbucket Cloud pull-request writes', () => {
  it('hands an applied write to the target-owned re-observation seam', async () => {
    nextResult = { kind: 'applied', observation: FIXTURE.getResult as unknown as JsonValue } as JsonValue;
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('button', { name: 'Decline' }));

    expect(completedMutations).toBe(1);
  });

  it('offers Decline and sends the exact entry it is mounted on', async () => {
    nextResult = { kind: 'applied', observation: FIXTURE.getResult as unknown as JsonValue } as JsonValue;
    const detail = await mountDetail();

    const decline = await detail.getByRole('button', { name: 'Decline' });
    await detail.press(decline);

    expect(recordedWrites()).toEqual([{
      action: {
        pluginId: BITBUCKET_PLUGIN_ID,
        localId: BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.decline,
      },
      input: {
        v: 1,
        instance: FIXTURE.detailInput.instance,
        localRef: {
          kindId: FIXTURE.detailInput.observation.entryRef.kindId,
          collisionScope: FIXTURE.detailInput.observation.entryRef.collisionScope,
          entryId: FIXTURE.detailInput.observation.entryRef.entryId,
        },
      },
    }]);
  });

  it('will not merge until a strategy is chosen, then sends that choice with the observed head', async () => {
    nextResult = { kind: 'applied', observation: FIXTURE.getResult as unknown as JsonValue } as JsonValue;
    const detail = await mountDetail();

    await expect(detail.getByRole('button', { name: 'Merge' })).resolves.toMatchObject({
      state: { disabled: true },
    });

    await detail.press(await detail.getByRole('radio', { name: 'Squash' }));
    await detail.press(await detail.getByRole('switch', {
      name: 'Delete the source branch after merging',
    }));
    // The Action's optional merge message is reachable, and its emptiness is the documented
    // "keep Bitbucket's own message" state rather than an empty string on the wire.
    await expect(detail.getByRole('textbox', { name: 'Merge commit message' })).resolves.toMatchObject({
      value: '',
      placeholder: "Leave empty to keep Bitbucket's own message",
    });
    await detail.press(await detail.getByRole('button', { name: 'Merge' }));

    expect(recordedWrites()).toEqual([{
      action: {
        pluginId: BITBUCKET_PLUGIN_ID,
        localId: BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.merge,
      },
      input: {
        v: 1,
        instance: FIXTURE.detailInput.instance,
        localRef: {
          kindId: FIXTURE.detailInput.observation.entryRef.kindId,
          collisionScope: FIXTURE.detailInput.observation.entryRef.collisionScope,
          entryId: FIXTURE.detailInput.observation.entryRef.entryId,
        },
        observedHeadCommit: FIXTURE.detailInput.observation.nativeRevision,
        closeSourceBranch: true,
        mergeStrategy: 'squash',
      },
    }]);
  });

  it('pins merge to the provider-fresh head shown in Overview, not the launch-time revision', async () => {
    if (FIXTURE.getResult.kind !== 'present') throw new Error('fixture must be present');
    const displayedHead = 'provider-fresh-head';
    readResults = {
      [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readOverview]: {
        kind: 'overview',
        observedAtMs: 1_780_000_000_000,
        observation: { ...FIXTURE.getResult, nativeRevision: displayedHead },
      } as unknown as JsonValue,
    };
    nextResult = {
      kind: 'applied',
      observation: { ...FIXTURE.getResult, nativeRevision: displayedHead },
    } as unknown as JsonValue;
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('radio', { name: 'Squash' }));
    await detail.press(await detail.getByRole('button', { name: 'Merge' }));

    expect(recordedWrites()).toHaveLength(1);
    expect(recordedWrites()[0]?.input).toMatchObject({ observedHeadCommit: displayedHead });
    expect(recordedWrites()[0]?.input).not.toMatchObject({
      observedHeadCommit: FIXTURE.detailInput.observation.nativeRevision,
    });
  });

  it('refuses merge when the refreshed Overview cannot prove the head it shows', async () => {
    if (FIXTURE.getResult.kind !== 'present') throw new Error('fixture must be present');
    const { nativeRevision: _omitted, ...freshWithoutHead } = FIXTURE.getResult;
    readResults = {
      [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readOverview]: {
        kind: 'overview',
        observedAtMs: 1_780_000_000_000,
        observation: freshWithoutHead,
      } as unknown as JsonValue,
    };
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('radio', { name: 'Squash' }));

    await expect(detail.getByRole('button', { name: 'Merge' })).resolves.toMatchObject({
      state: { disabled: true },
    });
    expect(recordedWrites()).toEqual([]);
  });

  it('does not delete the source branch unless the reader asked for it', async () => {
    // The sibling test above presses the switch and asserts `true`, which a
    // hard-coded `closeSourceBranch: true` would satisfy just as well. This is
    // the case that distinguishes them: merge WITHOUT touching the switch.
    // Deleting a branch the reader never asked to delete is unrecoverable from
    // this surface, and it is the most destructive thing on the panel — so the
    // default is pinned here rather than left to the control's initial state.
    nextResult = { kind: 'applied', observation: FIXTURE.getResult as unknown as JsonValue } as JsonValue;
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('radio', { name: 'Squash' }));
    await expect(detail.getByRole('switch', {
      name: 'Delete the source branch after merging',
    })).resolves.toMatchObject({ state: { checked: false } });
    await detail.press(await detail.getByRole('button', { name: 'Merge' }));

    const writes = recordedWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.input).toMatchObject({ closeSourceBranch: false, mergeStrategy: 'squash' });
  });

  it('says a refusal wrote nothing rather than returning to rest', async () => {
    nextResult = {
      kind: 'refused',
      reason: 'head-advanced',
      observation: FIXTURE.getResult as unknown as JsonValue,
    } as JsonValue;
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('button', { name: 'Decline' }));

    await expect(detail.queryByText(
      'Nothing was written: new commits arrived after the ones you looked at.',
    )).resolves.toBeDefined();
  });

  it('refuses to offer a merge Bitbucket gave it no source commit for', async () => {
    const { nativeRevision: _omitted, ...observation } = FIXTURE.detailInput.observation;
    const detail = await mountDetail({
      ...FIXTURE.detailInput,
      observation,
    } as unknown as JsonValue);

    // A chosen strategy is the only other thing merge waits for, so choosing it isolates the
    // missing pin as the reason the control stays unpressable.
    await detail.press(await detail.getByRole('radio', { name: 'Squash' }));

    await expect(detail.getByRole('button', { name: 'Merge' })).resolves.toMatchObject({
      state: { disabled: true },
    });
    await expect(detail.queryByText(
      'Bitbucket did not report the source commit of this pull request, so it cannot be merged from here.',
    )).resolves.toBeDefined();
  });

  // Four different facts about one write, never collapsed into "it worked" / "it didn't".
  it.each([
    [
      { kind: 'applied', observation: FIXTURE.getResult },
      'Declined. Bitbucket confirmed this pull request is declined.',
    ],
    [
      { kind: 'pending', observation: FIXTURE.getResult },
      'Bitbucket accepted the decline but has not reported it yet.',
    ],
    [
      { kind: 'rejected', reason: 'provider-rejected', failure: { class: 'unknown', code: '409' } },
      "Bitbucket refused this write in the pull request's current state.",
    ],
    [
      { kind: 'rejected', reason: 'provider-oversized-response', failure: { class: 'unknown', code: '555' } },
      'Bitbucket timed out on a response too large to return.',
    ],
    [
      { kind: 'unavailable', failure: { class: 'transient', code: 'bitbucket-unreachable' } },
      'Bitbucket could not complete this write.',
    ],
    [
      { kind: 'unchanged', observation: FIXTURE.getResult },
      'Bitbucket did not apply this write.',
    ],
    [
      { kind: 'uncertain', observation: FIXTURE.getResult },
      'Bitbucket may have applied this write. Reload the pull request before trying again.',
    ],
    [{ kind: 'something-this-build-does-not-know' }, 'This build could not read what Bitbucket answered.'],
  ])('reports settled write %# in its own words', async (result, sentence) => {
    nextResult = result as unknown as JsonValue;
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('button', { name: 'Decline' }));

    await expect(detail.queryByText(sentence as string)).resolves.toBeDefined();
  });

  it('offers no write at all on a pull request that is no longer open', async () => {
    const { snapshot } = FIXTURE.detailInput.observation;
    const detail = await mountDetail({
      ...FIXTURE.detailInput,
      observation: {
        ...FIXTURE.detailInput.observation,
        snapshot: { ...snapshot, state: { presentation: 'closed', nativeLabel: 'Merged' } },
      },
    } as unknown as JsonValue);

    await expect(detail.queryByRole('button', { name: 'Merge' })).resolves.toBeUndefined();
    await expect(detail.queryByRole('button', { name: 'Decline' })).resolves.toBeUndefined();
  });
});

describe('the mounted Bitbucket comment-resolution writes', () => {
  async function openComments(
    rows: readonly Readonly<{ id: string; resolution: string; deleted?: boolean }>[],
    launchInput: JsonValue = FIXTURE.detailInput as unknown as JsonValue,
  ) {
    readResults = {
      [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listComments]: commentsResult(rows),
    };
    const detail = await mountDetail(launchInput);
    await detail.press(await detail.getByRole('tab', { name: 'Comments' }));
    return detail;
  }

  it('offers Resolve on an open thread and sends that exact comment', async () => {
    nextResult = { kind: 'applied', resolution: 'resolved' } as unknown as JsonValue;
    const detail = await openComments([{ id: '9001', resolution: 'unresolved' }]);

    await detail.press(await detail.getByRole('button', { name: 'Resolve comment 9001' }));

    expect(recordedWrites()).toEqual([{
      action: {
        pluginId: BITBUCKET_PLUGIN_ID,
        localId: BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.resolveComment,
      },
      // The entry and the comment, and no head pin: resolving a review thread is head-independent.
      input: {
        v: 1,
        instance: FIXTURE.detailInput.instance,
        localRef: LOCAL_REF,
        commentId: '9001',
      },
    }]);
    await expect(detail.queryByText('Resolved. Bitbucket confirmed this thread is resolved.'))
      .resolves.toBeDefined();
  });

  it('offers Reopen, and only Reopen, on a thread that already reads resolved', async () => {
    nextResult = { kind: 'applied', resolution: 'unresolved' } as unknown as JsonValue;
    const detail = await openComments([{ id: '9002', resolution: 'resolved' }]);

    // Offering Resolve here would offer a write the Action can only refuse.
    await expect(detail.queryByRole('button', { name: 'Resolve comment 9002' }))
      .resolves.toBeUndefined();
    await detail.press(await detail.getByRole('button', { name: 'Reopen comment 9002' }));

    expect(recordedWrites()).toEqual([{
      action: {
        pluginId: BITBUCKET_PLUGIN_ID,
        localId: BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.unresolveComment,
      },
      input: {
        v: 1,
        instance: FIXTURE.detailInput.instance,
        localRef: LOCAL_REF,
        commentId: '9002',
      },
    }]);
  });

  it('offers both directions when Bitbucket reported no resolution at all', async () => {
    const detail = await openComments([{ id: '9003', resolution: 'unknown' }]);

    // `unknown` is silence, not "open". Picking one direction on the reader's behalf is exactly
    // what the tri-state exists to prevent, so both are offered and the silence is said out loud.
    await expect(detail.getByRole('button', { name: 'Resolve comment 9003' })).resolves.toBeDefined();
    await expect(detail.getByRole('button', { name: 'Reopen comment 9003' })).resolves.toBeDefined();
    await expect(detail.queryByText(
      'Bitbucket did not report whether this thread is resolved.',
    )).resolves.toBeDefined();
  });

  it('offers no resolution write on a deleted comment', async () => {
    const detail = await openComments([{ id: '9004', resolution: 'unresolved', deleted: true }]);

    await expect(detail.queryByRole('button', { name: 'Resolve comment 9004' }))
      .resolves.toBeUndefined();
    await expect(detail.queryByRole('button', { name: 'Reopen comment 9004' }))
      .resolves.toBeUndefined();
  });

  it('still offers resolution on a pull request that is no longer open', async () => {
    const { snapshot } = FIXTURE.detailInput.observation;
    const detail = await openComments([{ id: '9005', resolution: 'unresolved' }], {
      ...FIXTURE.detailInput,
      observation: {
        ...FIXTURE.detailInput.observation,
        snapshot: { ...snapshot, state: { presentation: 'closed', nativeLabel: 'Merged' } },
      },
    } as unknown as JsonValue);

    // Merge and decline are transitions of an OPEN pull request and are correctly gone here.
    // Resolving a stale review thread on a merged pull request is not a transition of anything,
    // and Bitbucket allows it — so taking the control away would remove a real capability.
    await expect(detail.queryByRole('button', { name: 'Merge' })).resolves.toBeUndefined();
    await expect(detail.getByRole('button', { name: 'Resolve comment 9005' })).resolves.toBeDefined();
  });

  it('never calls an unconfirmed resolution done', async () => {
    nextResult = {
      kind: 'rejected',
      reason: 'resolution-unconfirmed',
      resolution: 'unresolved',
    } as unknown as JsonValue;
    const detail = await openComments([{ id: '9006', resolution: 'unresolved' }]);

    await detail.press(await detail.getByRole('button', { name: 'Resolve comment 9006' }));

    await expect(detail.queryByText(
      'Bitbucket accepted this but the comment does not show it. Re-read the comments.',
    )).resolves.toBeDefined();
  });

  it('says a refusal wrote nothing rather than returning to rest', async () => {
    nextResult = {
      kind: 'refused',
      reason: 'already-in-resolution',
      resolution: 'resolved',
    } as unknown as JsonValue;
    const detail = await openComments([{ id: '9007', resolution: 'unresolved' }]);

    await detail.press(await detail.getByRole('button', { name: 'Resolve comment 9007' }));

    await expect(detail.queryByText('Nothing was written: this thread already reads that way.'))
      .resolves.toBeDefined();
  });
});
