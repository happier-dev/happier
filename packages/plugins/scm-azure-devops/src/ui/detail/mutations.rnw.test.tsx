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

import { AZURE_DEVOPS_PLUGIN_ID } from '../../azureDevopsContracts.js';
import { AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS } from '../../triage/detailActions.js';
import { AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS } from '../../triage/mutationActions.js';
import type { AzureProjectedThreadRowV1 } from '../../triage/detail/projection.js';

import {
  advanceAzureThreadReplyWindow,
  projectAzureThreadSubtitle,
  renderSurface,
} from '../renderSurface.js';
import { readReviewerIds } from './mutations.js';

/**
 * The five Azure DevOps pull-request writes, as a user can actually reach them.
 *
 * Every Action is declared `surfaces: ['ui', 'plugin']` with `placementBindings: ['detailsPanel']`.
 * `plugin` is what makes it reachable at all — a mounted plugin surface dispatches as a plugin
 * caller — while no host reads that placement binding for a source-owned Triage detail renderer;
 * the browser shell is its one consumer, over a different contribution family. So both the
 * reachability and the control are this surface's own work, and
 * these cases prove what a declaration cannot: that a user can press it, that what leaves carries
 * the branch decision they made and the merge source they were shown, and that the settled answer
 * is presented rather than swallowed.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIXTURE = createTriageSourceV1Fixture();

const recorded: { action: unknown; input: unknown }[] = [];
const mounted: PluginUiTestkit[] = [];

let nextResult: JsonValue = { kind: 'unavailable', failure: { class: 'transient', code: 'unset' } };
let nextActionError: unknown | null = null;
let completedMutations = 0;

/**
 * What a specific read answers, when a case needs one.
 *
 * The thread-status control only exists beside a thread, so its case has to make the Threads panel
 * hold one. Every other action still settles into `nextResult`.
 */
let readResults: Readonly<Record<string, JsonValue>> = {};

/** One Azure review thread, as its published projection publishes it. */
const THREADS_RESULT = {
  kind: 'threads',
  rows: [{
    id: '7',
    status: 'active',
    comments: [{ id: '1', author: 'Reviewer', content: 'Please rename this' }],
    omittedCommentCount: 0,
  }],
  omittedRowCount: 0,
  projectionTruncated: false,
} as unknown as JsonValue;

const LONG_THREAD_RESULT = {
  kind: 'threads',
  rows: [{
    id: '8',
    status: 'active',
    comments: Array.from({ length: 101 }, (_, index) => ({
      id: String(index + 1),
      author: 'Reviewer',
      content: `reply-${String(index + 1)}`,
    })),
    omittedCommentCount: 0,
  }],
  omittedRowCount: 0,
  projectionTruncated: false,
} as unknown as JsonValue;

const POLICIES_RESULT = {
  kind: 'policies',
  statuses: [{ id: 'status-1', state: 'succeeded', contextName: 'CI/status' }],
  evaluations: [
    {
      evaluationId: 'ordinary-required',
      status: 'approved',
      displayName: 'Required reviewers',
      isBlocking: true,
      isBuildValidation: false,
    },
    {
      evaluationId: 'build-optional',
      status: 'queued',
      displayName: 'Compile',
      isBlocking: false,
      isBuildValidation: true,
    },
  ],
  evaluationsPartial: false,
  omittedRowCount: 0,
  projectionTruncated: false,
} as unknown as JsonValue;

/** The mounted observation of a pull request Azure reports as abandoned. */
const ABANDONED_INPUT = {
  ...FIXTURE.detailInput,
  observation: {
    ...FIXTURE.detailInput.observation,
    snapshot: {
      ...FIXTURE.detailInput.observation.snapshot,
      state: { presentation: 'closed', nativeLabel: 'Abandoned' },
    },
  },
} as unknown as JsonValue;

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
        pluginId: AZURE_DEVOPS_PLUGIN_ID,
        pluginVersion: '0.0.0',
        viewId: 'azure-devops-triage-detail',
        generation: 'azure-devops-detail-mount',
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
          if (nextActionError !== null) throw nextActionError;
          const localId = (action as Readonly<{ localId?: string }>).localId ?? '';
          return readResults[localId] ?? nextResult;
        },
      },
    });
  });
  mounted.push(fixture);
  return fixture;
}

/** Only the writes; the root's own iteration read is not what these cases are about. */
function recordedWrites(): { action: unknown; input: unknown }[] {
  const writes = new Set<string>(Object.values(AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS));
  return recorded.filter((entry) => (
    writes.has((entry.action as Readonly<{ localId?: string }>).localId ?? '')
  ));
}

afterEach(async () => {
  recorded.splice(0);
  readResults = {};
  nextActionError = null;
  completedMutations = 0;
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the mounted Azure DevOps pull-request writes', () => {
  it('hands an applied write to the target-owned re-observation seam', async () => {
    nextResult = { kind: 'applied', observation: FIXTURE.getResult as unknown as JsonValue } as JsonValue;
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('button', { name: 'Abandon' }));

    expect(completedMutations).toBe(1);
  });

  it('hands an unknown dispatch outcome to the target-owned re-observation seam', async () => {
    const detail = await mountDetail();
    nextActionError = Object.assign(
      new Error('The Action timed out after dispatch.'),
      { code: 'timeout' },
    );

    await detail.press(await detail.getByRole('button', { name: 'Abandon' }));

    expect(completedMutations).toBe(1);
    expect(recordedWrites()).toHaveLength(1);
  });

  it('offers Abandon and sends the exact entry it is mounted on', async () => {
    nextResult = { kind: 'applied', observation: FIXTURE.getResult as unknown as JsonValue } as JsonValue;
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('button', { name: 'Abandon' }));

    expect(recordedWrites()).toEqual([{
      action: {
        pluginId: AZURE_DEVOPS_PLUGIN_ID,
        localId: AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.abandon,
      },
      input: { v: 1, instance: FIXTURE.detailInput.instance, localRef: LOCAL_REF },
    }]);
  });

  it('sends the branch decision the user made with the merge source they were shown', async () => {
    nextResult = { kind: 'applied', observation: FIXTURE.getResult as unknown as JsonValue } as JsonValue;
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('switch', {
      name: 'Delete the source branch after completing',
    }));
    await detail.press(await detail.getByRole('button', { name: 'Complete' }));

    expect(recordedWrites()).toEqual([{
      action: {
        pluginId: AZURE_DEVOPS_PLUGIN_ID,
        localId: AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.complete,
      },
      input: {
        v: 1,
        instance: FIXTURE.detailInput.instance,
        localRef: LOCAL_REF,
        observedSourceCommitId: FIXTURE.detailInput.observation.nativeRevision,
        deleteSourceBranch: true,
      },
    }]);
  });

  it('does not delete the source branch unless the reader asked for it', async () => {
    // The sibling test above presses the switch and asserts `true`, which a
    // hard-coded `deleteSourceBranch: true` would satisfy just as well. This is
    // the case that distinguishes them: complete WITHOUT touching the switch.
    // Deleting a branch the reader never asked to delete is unrecoverable from
    // this surface, so the default is pinned here rather than left to the
    // control's initial state.
    nextResult = { kind: 'applied', observation: FIXTURE.getResult as unknown as JsonValue } as JsonValue;
    const detail = await mountDetail();

    await expect(detail.getByRole('switch', {
      name: 'Delete the source branch after completing',
    })).resolves.toMatchObject({ state: { checked: false } });
    await detail.press(await detail.getByRole('button', { name: 'Complete' }));

    const writes = recordedWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.input).toMatchObject({ deleteSourceBranch: false });
  });

  it('says a refusal wrote nothing rather than returning to rest', async () => {
    nextResult = {
      kind: 'refused',
      reason: 'entry-not-active',
      observation: FIXTURE.getResult as unknown as JsonValue,
    } as JsonValue;
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('button', { name: 'Abandon' }));

    await expect(detail.queryByText(
      'Nothing was written: this pull request is no longer active.',
    )).resolves.toBeDefined();
    expect(completedMutations).toBe(0);
  });

  it('refuses to offer a completion Azure DevOps gave it no merge source for', async () => {
    const { nativeRevision: _omitted, ...observation } = FIXTURE.detailInput.observation;
    const detail = await mountDetail({ ...FIXTURE.detailInput, observation } as unknown as JsonValue);

    await expect(detail.getByRole('button', { name: 'Complete' })).resolves.toMatchObject({
      state: { disabled: true },
    });
    await expect(detail.queryByText(
      'Azure DevOps did not report the merge source commit of this pull request, so it cannot be completed from here.',
    )).resolves.toBeDefined();
  });

  // Four different facts about one write, never collapsed into "it worked" / "it didn't".
  it.each([
    [
      { kind: 'applied', observation: FIXTURE.getResult },
      'Abandoned. Azure DevOps confirmed this pull request is abandoned.',
    ],
    [
      { kind: 'pending', observation: FIXTURE.getResult },
      'Azure DevOps accepted the abandon but has not confirmed it yet.',
    ],
    [
      { kind: 'rejected', reason: 'conflicts', observation: FIXTURE.getResult },
      'Azure DevOps could not merge this pull request: it has conflicts.',
    ],
    [
      { kind: 'rejected', reason: 'rejectedByPolicy', observation: FIXTURE.getResult },
      'Azure DevOps refused the merge: a branch policy rejected it.',
    ],
    [
      { kind: 'rejected', reason: 'failure', observation: FIXTURE.getResult },
      'Azure DevOps reported that the merge failed.',
    ],
    [
      { kind: 'rejected', reason: 'fields-ignored', observation: FIXTURE.getResult },
      'Azure DevOps answered success but applied nothing.',
    ],
    [
      { kind: 'unavailable', failure: { class: 'transient', code: 'azure-unreachable' } },
      'Azure DevOps could not complete this write.',
    ],
    [
      { kind: 'uncertain', observation: FIXTURE.getResult },
      'Azure DevOps may have applied this write. Reload the pull request before trying again.',
    ],
    [
      { kind: 'something-this-build-does-not-know' },
      'This build could not read what Azure DevOps answered.',
    ],
  ])('reports settled write %# in its own words', async (result, sentence) => {
    nextResult = result as unknown as JsonValue;
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('button', { name: 'Abandon' }));

    await expect(detail.queryByText(sentence as string)).resolves.toBeDefined();
  });

  it('never calls a queued completion a completion, and names auto-complete when Azure owns it', async () => {
    nextResult = {
      kind: 'pending',
      observation: FIXTURE.getResult,
      autoCompleteEnabled: true,
    } as unknown as JsonValue;
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('button', { name: 'Complete' }));

    await expect(detail.queryByText(
      'Auto-complete is on, so Azure DevOps completes this pull request when its policies pass.',
    )).resolves.toBeDefined();
  });

  it('offers no write at all on a pull request that is no longer active', async () => {
    const { snapshot } = FIXTURE.detailInput.observation;
    const detail = await mountDetail({
      ...FIXTURE.detailInput,
      observation: {
        ...FIXTURE.detailInput.observation,
        snapshot: { ...snapshot, state: { presentation: 'closed', nativeLabel: 'Completed' } },
      },
    } as unknown as JsonValue);

    await expect(detail.queryByRole('button', { name: 'Complete' })).resolves.toBeUndefined();
    await expect(detail.queryByRole('button', { name: 'Abandon' })).resolves.toBeUndefined();
    // A completed pull request is `closed` exactly as an abandoned one is, and reactivating it
    // would be offering to undo a merge that already landed. The native label is what separates
    // them, and this is the case that proves the panel reads it.
    await expect(detail.queryByRole('button', { name: 'Reactivate' })).resolves.toBeUndefined();
  });
});

describe('the mounted Azure DevOps reactivation', () => {
  it('offers Reactivate on an abandoned pull request and sends the exact entry', async () => {
    nextResult = { kind: 'applied', observation: FIXTURE.getResult as unknown as JsonValue } as JsonValue;
    const detail = await mountDetail(ABANDONED_INPUT);

    await detail.press(await detail.getByRole('button', { name: 'Reactivate' }));

    expect(recordedWrites()).toEqual([{
      action: {
        pluginId: AZURE_DEVOPS_PLUGIN_ID,
        localId: AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.reactivate,
      },
      // No head pin and no options: reactivating is head-independent, and resending completion
      // options here would re-decide a branch outcome nobody asked about.
      input: { v: 1, instance: FIXTURE.detailInput.instance, localRef: LOCAL_REF },
    }]);
  });

  it('offers no active-only write beside it', async () => {
    const detail = await mountDetail(ABANDONED_INPUT);

    // Completion, abandonment and review requests all require an ACTIVE pull request, so offering
    // any of them here would be offering a control Azure could only refuse.
    await expect(detail.queryByRole('button', { name: 'Complete' })).resolves.toBeUndefined();
    await expect(detail.queryByRole('button', { name: 'Abandon' })).resolves.toBeUndefined();
    await expect(detail.queryByRole('button', { name: 'Request review' })).resolves.toBeUndefined();
  });

  it('says a reactivation refusal wrote nothing, in the words of the gate that refused', async () => {
    nextResult = {
      kind: 'refused',
      reason: 'entry-not-abandoned',
      observation: FIXTURE.getResult as unknown as JsonValue,
    } as JsonValue;
    const detail = await mountDetail(ABANDONED_INPUT);

    await detail.press(await detail.getByRole('button', { name: 'Reactivate' }));

    // NOT "no longer active": that sentence would name the very state the reader pressed
    // Reactivate about.
    await expect(detail.queryByText(
      'Nothing was written: only an abandoned pull request can be reactivated.',
    )).resolves.toBeDefined();
  });
});

describe('the mounted Azure DevOps review request', () => {
  it('offers a reviewer field and refuses to request review from nobody', async () => {
    const detail = await mountDetail();

    // Azure identifies a reviewer by identity id and this source declares no identity search, so
    // the field takes ids: a name-to-identity guess is how the wrong person gets added.
    await expect(detail.getByRole('textbox', {
      label: 'Reviewer identity IDs',
      placeholder: 'Separate several with commas',
    })).resolves.toMatchObject({ value: '' });
    // The semantic UI harness can press, and only press — it cannot type — so what the wire
    // carries for a named reviewer is proven at the Action in `triage/mutationActions.test.ts`
    // and by `readReviewerIds` below. What this case owns is that an unnamed request never leaves.
    await expect(detail.getByRole('button', { name: 'Request review' })).resolves.toMatchObject({
      state: { disabled: true },
    });
    expect(recordedWrites()).toHaveLength(0);
  });

  it('reads one typed line as identity ids, without inventing or repeating one', () => {
    // Commas AND whitespace separate, because a pasted list arrives as either. A repeated id
    // collapses: the Action's input rejects duplicates outright, and somebody who pasted the same
    // id twice still means one person.
    expect(readReviewerIds('  b1a1e6f0 , 8f2c7a11\n b1a1e6f0  ')).toEqual([
      'b1a1e6f0',
      '8f2c7a11',
    ]);
    // Nothing typed is nobody named — never an empty string on the wire.
    expect(readReviewerIds('   ,  \n ')).toEqual([]);
  });
});

describe('the mounted Azure DevOps thread status', () => {
  it('sends the status alone for the thread it was opened from', async () => {
    readResults = { [AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.readThreads]: THREADS_RESULT };
    nextResult = { kind: 'applied', status: 'fixed' } as unknown as JsonValue;
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('tab', { name: 'Threads' }));
    await detail.press(await detail.getByRole('button', { name: 'Set the status of thread 7' }));
    await detail.press(await detail.getByRole('radio', { name: 'Fixed' }));
    await detail.press(await detail.getByRole('button', { name: 'Set status' }));

    expect(recordedWrites()).toEqual([{
      action: {
        pluginId: AZURE_DEVOPS_PLUGIN_ID,
        localId: AZURE_DEVOPS_TRIAGE_MUTATION_ACTION_IDS.threadStatus,
      },
      // The thread id and one status. No comment array and no thread context: this write says one
      // thing about one thread, and a field it did not need to send is one it could overwrite.
      input: {
        v: 1,
        instance: FIXTURE.detailInput.instance,
        localRef: LOCAL_REF,
        threadId: '7',
        status: 'fixed',
      },
    }]);
    await expect(detail.queryByText('Azure DevOps confirmed this thread is now fixed.'))
      .resolves.toBeDefined();
  });

  it('will not write a status nobody chose', async () => {
    readResults = { [AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.readThreads]: THREADS_RESULT };
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('tab', { name: 'Threads' }));
    await detail.press(await detail.getByRole('button', { name: 'Set the status of thread 7' }));

    // Azure's six requestable statuses are all real intents and none of them is a safe guess, so
    // the control arrives unselected rather than pre-armed with one.
    await expect(detail.getByRole('button', { name: 'Set status' })).resolves.toMatchObject({
      state: { disabled: true },
    });
    expect(recordedWrites()).toHaveLength(0);
  });

  it('reports a status Azure answered success for and never applied', async () => {
    readResults = { [AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.readThreads]: THREADS_RESULT };
    nextResult = { kind: 'rejected', reason: 'fields-ignored', status: 'active' } as unknown as JsonValue;
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('tab', { name: 'Threads' }));
    await detail.press(await detail.getByRole('button', { name: 'Set the status of thread 7' }));
    await detail.press(await detail.getByRole('radio', { name: 'Fixed' }));
    await detail.press(await detail.getByRole('button', { name: 'Set status' }));

    // A `200` whose confirming read disagrees is a silently ignored property, and it is reported
    // rather than presented as done.
    await expect(detail.queryByText(
      'Azure DevOps answered success but this thread still reads active.',
    )).resolves.toBeDefined();
  });
});

describe('the mounted Azure DevOps detail read presentation', () => {
  it('expands one embedded thread by two until its first reply is visible without another provider read', async () => {
    readResults = { [AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.readThreads]: LONG_THREAD_RESULT };
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('tab', { name: 'Threads' }));
    await expect(detail.queryByText(/reply-1(?:\D|$)/)).resolves.toBeUndefined();

    const row = (LONG_THREAD_RESULT as unknown as Readonly<{
      rows: readonly AzureProjectedThreadRowV1[];
    }>).rows[0];
    if (row === undefined) throw new Error('the long-thread fixture must contain one row');
    let replyWindow = 2;
    while (replyWindow < row.comments.length) {
      replyWindow = advanceAzureThreadReplyWindow(replyWindow, row.comments.length);
    }

    expect(projectAzureThreadSubtitle(row, replyWindow)).toMatch(/reply-1(?:\D|$)/);
    await detail.press(await detail.getByRole('button', { name: /Show 2 earlier replies/ }));
    await expect(detail.queryByText(/reply-99(?:\D|$)/)).resolves.toBeDefined();
    expect(recorded.filter(({ action }) => (
      (action as Readonly<{ localId?: string }>).localId
        === AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.readThreads
    ))).toHaveLength(1);
  });

  it('renders statuses, ordinary policies, and build validations as separate accessible sections', async () => {
    readResults = { [AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.readPolicies]: POLICIES_RESULT };
    const detail = await mountDetail();

    await detail.press(await detail.getByRole('tab', { name: 'Policies' }));

    await expect(detail.getByRole('list', {
      name: 'Statuses reported against this Azure DevOps pull request',
    })).resolves.toMatchObject({
      role: 'list',
      label: 'Statuses reported against this Azure DevOps pull request',
    });
    await expect(detail.getByRole('list', {
      name: 'Policies for this Azure DevOps pull request',
    })).resolves.toMatchObject({
      role: 'list',
      label: 'Policies for this Azure DevOps pull request',
    });
    await expect(detail.getByRole('list', {
      name: 'Build validations for this Azure DevOps pull request',
    })).resolves.toMatchObject({
      role: 'list',
      label: 'Build validations for this Azure DevOps pull request',
    });
    await expect(detail.queryByText('approved · required')).resolves.toBeDefined();
    await expect(detail.queryByText('queued · optional')).resolves.toBeDefined();
  });
});
