// @vitest-environment jsdom
import React, { act } from 'react';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { TriageActivityAgentProvider } from '@happier-dev/triage-sources/ui';
import type { PluginUiActionControlEventV1, RenderContext } from '@happier-dev/plugin-sdk/ui';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiActionControlTestHost, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit, PluginUiTestkitExecuteActionInput } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { formatTriageTimestampV1, TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
} from '../../observations/githubProviderContracts.js';
import {
  GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1,
  GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1,
} from '../../triage/contribution.js';

import { renderSurface } from '../renderSurface.js';
import { sendGithubGraphqlRequest } from '../../triage/mutations/graphql.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let declineSuggestion = false;

const SOURCE_CONTRIBUTION = Object.freeze({
  pluginId: GITHUB_PLUGIN_ID,
  localId: 'github-forge',
});

const OBSERVED_AT_MS = 1_760_000_700_000;
/** The locale `createSurfaceContextFixture` mounts this surface under. */
const SURFACE_LOCALE = 'en-GB';
const HEAD_REVISION = '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29';

function launchInput(
  kindId: 'pull-request' | 'issue',
  facts: readonly JsonValue[] = [],
  linkedSessions: readonly JsonValue[] = [],
): JsonValue {
  return {
    v: 1,
    instance: {
      v: 1,
      instance: {
        source: SOURCE_CONTRIBUTION,
        sourceInstanceId: '9d2a6b1e-6c1a-4b7d-9f31-1d4a6c8b2e70',
      },
      binding: {
        purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
        account: {
          service: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' },
          accountId: 'account-1',
        },
      },
      localInstanceKey: 'github.com',
      configuration: { v: 1, token: 'github-configuration-token-v1' },
    },
    observation: {
      entryRef: {
        source: SOURCE_CONTRIBUTION,
        kindId,
        collisionScope: 'github:1296269',
        entryId: '1284',
      },
      observedAtMs: OBSERVED_AT_MS,
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
        state: { presentation: 'active', nativeLabel: 'Open' },
        facts,
      },
      viewer: { involvement: ['reviewRequested'] },
    },
    linkedSessions,
  } as JsonValue;
}

/** The five independent reads the Feedback plane composes. */
const answers: {
  comments: JsonValue;
  threads: JsonValue;
  reviews: JsonValue;
  requests: JsonValue;
  checks: JsonValue;
} = {
  comments: { kind: 'comments', rows: [] },
  threads: { kind: 'threads', rows: [] },
  reviews: { kind: 'reviews', rows: [] },
  requests: { kind: 'requests', rows: [] },
  checks: {
    kind: 'checks',
    headRevision: HEAD_REVISION,
    state: 'none',
    rows: [],
    omittedRowCount: 0,
    projectionTruncated: false,
  },
};

const dispatched: string[] = [];
const mutationInputs: unknown[] = [];
const mounted: PluginUiTestkit[] = [];
const pageRefreshes = new WeakMap<PluginUiTestkit, () => void>();
const githubControls = new WeakMap<PluginUiTestkit, ReturnType<typeof createPluginUiActionControlTestHost>>();
const suggestionControls = new WeakMap<PluginUiTestkit, ReturnType<typeof createPluginUiActionControlTestHost>>();
const publishControls = new WeakMap<PluginUiTestkit, () => {
  publish(event: PluginUiActionControlEventV1): void;
  presentation: { title: string; disabled?: boolean };
} | undefined>();
const deviceDrafts = new Map<string, JsonValue>();
let reviewRefusal = false;
let subscriptionFailure: JsonValue | null = null;
let nextChecksGate: Promise<JsonValue> | null = null;

function withFeedbackPageEvidence(value: JsonValue): JsonValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  if ('kind' in value && value.kind === 'unavailable') return value;
  return {
    ...value,
    omittedRowCount: 'omittedRowCount' in value ? value.omittedRowCount : 0,
    projectionTruncated: 'projectionTruncated' in value ? value.projectionTruncated : false,
  } as JsonValue;
}

async function mountFeedback(
  input: JsonValue,
  platform: 'web' | 'ios' = 'web',
): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  let refreshPage = () => {};
  function MountedPage({ context }: { context: RenderContext }): React.ReactElement {
    const [generation, setGeneration] = React.useState(0);
    refreshPage = () => setGeneration((value) => value + 1);
    const body = renderSurface(context);
    if (body !== null && !React.isValidElement(body)) throw new Error('Expected a native GitHub surface');
    return <TriageActivityAgentProvider value={{ events: [], tail: null, refreshGeneration: generation }}>
      {body}
    </TriageActivityAgentProvider>;
  }
  const executeBoundary = async ({ action, input: actionInput }: Pick<PluginUiTestkitExecuteActionInput, 'action' | 'input'>): Promise<JsonValue> => {
          if (action === 'scm.suggestion.apply') {
            mutationInputs.push({ localId: action, input: actionInput });
            return { success: false, files: [
              { path: 'src/pump.ts', status: 'applied' },
              { path: 'src/tail.ts', status: 'refused', errorCode: 'suggestion_outdated', error: 'changed' },
            ] };
          }
          if (action === 'reviews.comments.list') {
            dispatched.push(action);
            return {
              items: [{
                id: 'review-comment-1',
                body: 'Please keep the returned error.',
                serverRevision: 3,
                anchor: { kind: 'file', filePath: 'src/pump.ts' },
                snapshot: {
                  kind: 'text',
                  selectedLines: ['return error;'],
                  beforeContext: [],
                  afterContext: [],
                  selectedLinesHash: 'selected-hash',
                  contextWindowHash: 'context-hash',
                  capturedAt: OBSERVED_AT_MS,
                  fileLength: 80,
                  source: 'committed',
                  commitSha: HEAD_REVISION,
                  isUncommitted: false,
                  isUntracked: false,
                  truncated: false,
                  hasBidiControls: false,
                  likelyMinified: false,
                },
                linkedRefs: [{
                  kind: 'pullRequest',
                  url: 'https://github.com/octo-org/example-app/pull/1284',
                }],
              }],
              cursor: null,
            } as JsonValue;
          }
          const localId = (action as { localId: string }).localId;
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readCapabilities) {
            return {
              kind: 'capabilities',
              operations: Object.fromEntries(Object.keys(GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1)
                .map((key) => [key, { kind: 'available' }])),
              mergeMethods: {
                merge: { kind: 'available' },
                squash: { kind: 'available' },
                rebase: { kind: 'available' },
              },
            } as JsonValue;
          }
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback) {
            const connection = (actionInput as { connection: keyof typeof answers }).connection;
            dispatched.push(`${localId}:${connection}`);
            return withFeedbackPageEvidence(answers[connection]);
          }
          dispatched.push(localId);
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview) {
            // The Overview read states the detail's checks from its own rollup.
            const gate = nextChecksGate;
            nextChecksGate = null;
            const answer = (gate === null ? answers.checks : await gate) as Record<string, JsonValue>;
            if (answer.kind !== 'checks') return answer as JsonValue;
            const { kind: _kind, ...checks } = answer;
            return { kind: 'overview', kindId: 'pull-request', observedAtMs: 1_760_000_800_000,
              headRevision: checks.headRevision, branchUpdateEligibility: 'not-behind', checks,
              ...(subscriptionFailure === null ? {} : { viewerSubscription: 'SUBSCRIBED' }) } as JsonValue;
          }
          if (localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestThreadResolution) {
            mutationInputs.push(actionInput);
            return { kind: 'applied', effect: 'changed' };
          }
          if (localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.commentEdit) {
            mutationInputs.push(actionInput);
            const edit = actionInput as { target: { id: string }; body: string };
            return { kind: 'applied', effect: 'changed', comment: { id: edit.target.id, body: edit.body } };
          }
          if (localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.entryUnsubscribe && subscriptionFailure !== null) {
            return subscriptionFailure;
          }
          if (localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pendingReviewCreate) {
            mutationInputs.push({ localId, input: actionInput });
            const request = actionInput as { body?: string };
            answers.reviews = { kind: 'reviews', rows: [{ id: 'PRR_created', author: 'me',
              body: request.body ?? '', state: 'PENDING', editable: true }] };
            return { kind: 'applied', effect: 'changed', review: { id: 'PRR_created', state: 'PENDING', body: request.body ?? '' } };
          }
          if (localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.reviewDismiss
            || localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pendingReviewSubmit
            || localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pendingReviewDelete) {
            mutationInputs.push({ localId, input: actionInput });
            const review = actionInput as { reviewId: string };
            return { kind: 'applied', effect: 'changed', review: { id: review.reviewId, state: 'DISMISSED' } };
          }
          if (localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestThreadReply) {
            mutationInputs.push(actionInput);
            return {
              kind: 'settled',
              publication: {
                publicationPlanId: 'P'.repeat(43),
                entries: [{
                  happierCommentId: 'review-comment-1',
                  publicationCorrelationId: 'C'.repeat(43),
                  outcome: { kind: 'uncertain' },
                }],
                verdict: { kind: 'notRequested' },
              },
            };
          }
          throw new Error(`unexpected action ${localId}`);
  };
  const githubHost = createPluginUiActionControlTestHost(async request => {
    if (reviewRefusal && typeof request.action !== 'string'
      && request.action.localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pendingReviewCreate) {
      return { ok: false, errorCode: 'contributed_action_unavailable', error: 'contributed_action_unavailable' };
    }
    return { ok: true, result: await executeBoundary(request) };
  });
  const githubSlots = new Set<string>();
  const suggestionHost = createPluginUiActionControlTestHost(async ({ action, input }) => {
    if (declineSuggestion) { declineSuggestion = false; return { ok: false, errorCode: 'approval_rejected', error: 'Declined' }; }
    mutationInputs.push({ localId: action, input });
    return { ok: true, result: { success: false, files: [
      { path: 'src/pump.ts', status: 'applied' },
      { path: 'src/tail.ts', status: 'refused', errorCode: 'suggestion_outdated', error: 'changed' },
    ] } };
  });
  const suggestionSlots = new Set<string>();
  let boundPublish: { publish(event: PluginUiActionControlEventV1): void; presentation: { title: string; disabled?: boolean } } | undefined;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-201', mountNonce: 'fixture-mount-201' },
      authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      surface: defineUiSurface((context) => <MountedPage context={context} />),
      surfaceContext: createSurfaceContextFixture({ platform }),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: input,
      handlers: {
        actionControl: async (hostInput) => {
          const { request, publish } = hostInput;
          if (request.kind === 'bind' && request.action === 'scm.suggestion.apply') suggestionSlots.add(request.subscriptionId);
          if (suggestionSlots.has(request.subscriptionId)) return suggestionHost.handler(hostInput);
          if (request.kind === 'bind' && typeof request.action !== 'string'
            && request.action.localId !== GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.commentCreate) githubSlots.add(request.subscriptionId);
          if (githubSlots.has(request.subscriptionId)) return githubHost.handler(hostInput);
          if (request.kind === 'bind') {
            expect(request.action).toEqual({ pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.commentCreate });
            boundPublish = { publish, presentation: request.presentation };
            return;
          }
          if (request.kind === 'update') {
            if (boundPublish) boundPublish.presentation = request.presentation;
            return;
          }
          if (request.preparation === null) return;
          const actionInput = request.preparation.input;
          mutationInputs.push(actionInput);
          publish({ kind: 'settled', requestId: request.requestId, execution: { ok: true, result: {
            kind: 'applied', effect: 'changed', comment: {
              id: 'IC_posted', body: (actionInput as { body: string }).body, author: 'me', createdAtMs: OBSERVED_AT_MS,
            },
          } } });
        },
        executeAction: executeBoundary,
        presentActionFailure({ failure }) {
          expect(failure.errorCode).toBe('contributed_action_unavailable');
          return { reason: 'This action is unavailable. Check the plugin and machine connection.', nextStep: null, technicalDetails: [] };
        },
        deviceState(request) {
          // The web device adapter rejects backslashes in its namespaced key.
          if (JSON.stringify([request.key]).includes('\\')) {
            return { status: 'unavailable', reason: 'storage_unavailable' };
          }
          if (request.operation === 'write') deviceDrafts.set(request.key, request.value);
          if (request.operation === 'remove') deviceDrafts.delete(request.key);
          return { status: 'ready', value: deviceDrafts.get(request.key) ?? null };
        },
      },
    }) as PluginUiTestkit;
  });
  pageRefreshes.set(fixture, () => refreshPage());
  // Binding happens when Activity opens, after this mount returns.
  suggestionControls.set(fixture, suggestionHost);
  githubControls.set(fixture, githubHost);
  publishControls.set(fixture, () => boundPublish);
  mounted.push(fixture);
  return fixture;
}

async function refreshPage(detail: PluginUiTestkit): Promise<void> {
  await act(async () => { pageRefreshes.get(detail)!(); });
}

/** The inline remark editor's real field, apart from the Actions panel's own text areas. */
function editorField(): HTMLTextAreaElement | undefined {
  return [...document.querySelectorAll('textarea')]
    .find((area) => ['Comment', 'Review summary'].includes(area.getAttribute('aria-label') ?? '')
      // The shared comment box at the end of Activity is not the inline editor.
      && area.getAttribute('placeholder') !== 'Write a comment');
}

async function openFeedback(detail: PluginUiTestkit): Promise<void> {
  await act(async () => {
    await detail.press(await detail.getByRole('tab', { name: 'Feedback' }));
  });
}

function resetAnswers(): void {
  answers.comments = { kind: 'comments', rows: [] };
  answers.threads = { kind: 'threads', rows: [] };
  answers.reviews = { kind: 'reviews', rows: [] };
  answers.requests = { kind: 'requests', rows: [] };
  answers.checks = {
    kind: 'checks',
    headRevision: HEAD_REVISION,
    state: 'none',
    rows: [],
    omittedRowCount: 0,
    projectionTruncated: false,
  };
}

afterEach(async () => {
  dispatched.splice(0);
  mutationInputs.splice(0);
  nextChecksGate = null;
  resetAnswers();
  reviewRefusal = false;
  subscriptionFailure = null;
  deviceDrafts.clear();
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

/**
 * The mounted `Feedback` plane.
 *
 * The projection behind it is proved in `feedback.test.ts`; what only a mount
 * can prove is that a reviewer is actually OFFERED it, that it reads the
 * authoritative reviews and checks rather than the Timeline panel, and that a
 * failed read leaves the other answers usable.
 */
describe('the mounted GitHub Feedback plane', () => {
  it('offers a pull request Feedback, and does not also offer it Comments', async () => {
    const detail = await mountFeedback(launchInput('pull-request'));

    await expect(detail.getByRole('tab', { name: 'Feedback' }))
      .resolves.toMatchObject({ role: 'tab' });
    await expect(detail.queryByRole('tab', { name: 'Comments' })).resolves.toBeUndefined();
  });

  it('offers an issue Comments, and does not offer it Feedback', async () => {
    answers.comments = {
      kind: 'comments',
      rows: [],
      previousCursor: 'issue-comments-before',
    };
    const detail = await mountFeedback(launchInput('issue'));

    await expect(detail.getByRole('tab', { name: 'Comments' }))
      .resolves.toMatchObject({ role: 'tab' });
    await expect(detail.queryByRole('tab', { name: 'Feedback' })).resolves.toBeUndefined();

    await act(async () => {
      await detail.press(await detail.getByRole('tab', { name: 'Comments' }));
    });
    expect(dispatched).toEqual([
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:comments`,
    ]);
    await expect(detail.getByRole('button', { name: 'Show 40 earlier comments' }))
      .resolves.toMatchObject({ role: 'button' });
  });

  it('keeps a complete issue conversation quiet: no read counts and no pull-request-only Feedback pointer', async () => {
    answers.comments = {
      kind: 'comments',
      rows: [{ id: 'IC_1', author: 'hubber', body: 'Is this ready?', createdAtMs: OBSERVED_AT_MS - 20_000 }],
    };
    const detail = await mountFeedback(launchInput('issue'));
    await act(async () => {
      await detail.press(await detail.getByRole('tab', { name: 'Comments' }));
    });
    await expect(detail.getByText('Is this ready?')).resolves.toBeDefined();
    expect(document.body.textContent).not.toContain('comment(s) read');
    expect(document.body.textContent).not.toContain('Line-anchored review conversations');
  });

  it('edits only the comments GitHub lets this viewer update, in place, through the confirmed edit Action', async () => {
    answers.comments = {
      kind: 'comments',
      rows: [
        { id: 'IC_mine', author: 'me', body: 'The tail is droped.', createdAtMs: OBSERVED_AT_MS - 20_000, editable: true },
        { id: 'IC_theirs', author: 'hubber', body: 'Agreed.', createdAtMs: OBSERVED_AT_MS - 10_000 },
      ],
    };
    const detail = await mountFeedback(launchInput('issue'));
    await act(async () => {
      await detail.press(await detail.getByRole('tab', { name: 'Comments' }));
    });

    const names = (await detail.getAllByRole('button')).map((button) => button.name);
    expect(names).toContain('Edit me · Commented');
    expect(names.filter((name) => name?.startsWith('Edit ') === true)).toHaveLength(1);

    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Edit me · Commented' })); });
    const textarea = editorField();
    if (!textarea) throw new Error('Expected the inline comment editor');
    expect(textarea.value).toBe('The tail is droped.');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(textarea, 'The tail is dropped.');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await githubControls.get(detail)!.press('Save'); });

    expect(mutationInputs).toEqual([{
      v: 1,
      instance: expect.any(Object),
      localRef: { kindId: 'issue', collisionScope: 'github:1296269', entryId: '1284' },
      routingToken: 'octo-org/example-app',
      target: { kind: 'issue-comment', id: 'IC_mine' },
      body: 'The tail is dropped.',
    }]);
    await expect(detail.getByText('The tail is dropped.')).resolves.toMatchObject({ content: 'The tail is dropped.' });
    expect(editorField()).toBeUndefined();
    // The other comments of this conversation are never re-read for an edit.
    expect(dispatched.filter((action) => action.endsWith(':comments'))).toHaveLength(1);
  });

  it('posts a new comment from the box at the end of Activity and shows it without re-reading', async () => {
    answers.comments = {
      kind: 'comments',
      rows: [{ id: 'IC_1', author: 'hubber', body: 'Is this ready?', createdAtMs: OBSERVED_AT_MS - 20_000 }],
    };
    const detail = await mountFeedback(launchInput('issue'));
    await act(async () => {
      await detail.press(await detail.getByRole('tab', { name: 'Comments' }));
    });
    const field = () => [...document.querySelectorAll('textarea')]
      .find((area) => area.getAttribute('placeholder') === 'Write a comment');
    const box = field();
    if (!box) throw new Error('Expected the comment box');
    expect(publishControls.get(detail)!()?.presentation).toMatchObject({ disabled: true });
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(box, 'Yes, merging after CI.');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(publishControls.get(detail)!()?.presentation.disabled).not.toBe(true);
    await act(async () => {
      publishControls.get(detail)!()!.publish({ kind: 'prepare', requestId: 'publish-comment' });
    });

    expect(mutationInputs).toEqual([{
      v: 1,
      instance: expect.any(Object),
      localRef: { kindId: 'issue', collisionScope: 'github:1296269', entryId: '1284' },
      routingToken: 'octo-org/example-app',
      body: 'Yes, merging after CI.',
    }]);
    await expect(detail.getByText('Yes, merging after CI.')).resolves.toMatchObject({ content: 'Yes, merging after CI.' });
    expect(field()?.value).toBe('');
    // The posted comment is the viewer's own, so it can be edited at once.
    await expect(detail.getByRole('button', { name: 'Edit me · Commented' })).resolves.toMatchObject({ role: 'button' });
    expect(dispatched.filter((action) => action.endsWith(':comments'))).toHaveLength(1);
  });

  it('edits a review summary and a line reply as their own GitHub kinds', async () => {
    answers.reviews = {
      kind: 'reviews',
      rows: [{ id: 'PRR_mine', author: 'me', body: 'Looks good.', state: 'COMMENTED', submittedAtMs: OBSERVED_AT_MS - 5_000, editable: true }],
    };
    answers.threads = {
      kind: 'threads',
      rows: [{
        id: 'PRRT_1',
        isResolved: false,
        path: 'src/pump.ts',
        line: 42,
        firstReply: { id: 'PRRC_mine', author: 'me', body: 'The tail is dropped.', editable: true },
        replyCount: 1,
        replies: [{ id: 'PRRC_mine', author: 'me', body: 'The tail is dropped.', editable: true }],
      }],
    };
    const detail = await mountFeedback(launchInput('pull-request'));
    await openFeedback(detail);

    const save = async (button: string, next: string) => {
      await act(async () => { await detail.press(await detail.getByRole('button', { name: button })); });
      const textarea = editorField()!;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      await act(async () => {
        setter.call(textarea, next);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => { await githubControls.get(detail)!.press('Save'); });
    };
    await save('Edit me · Commented', 'Looks good once the tail is kept.');
    await save('Edit me', 'The tail is dropped at line 42.');

    expect(mutationInputs.map((input) => (input as { target: unknown }).target)).toEqual([
      { kind: 'review', id: 'PRR_mine' },
      { kind: 'review-comment', id: 'PRRC_mine' },
    ]);
  });

  it('dismisses a submitted review with the reason the reader wrote, and only a submitted one', async () => {
    answers.reviews = {
      kind: 'reviews',
      rows: [
        { id: 'PRR_ok', author: 'octocat', body: '', state: 'APPROVED', submittedAtMs: OBSERVED_AT_MS - 5_000 },
        { id: 'PRR_note', author: 'hubot', body: 'A note.', state: 'COMMENTED', submittedAtMs: OBSERVED_AT_MS - 4_000 },
      ],
    };
    const detail = await mountFeedback(launchInput('pull-request'));
    await openFeedback(detail);
    // GitHub dismisses approvals and change requests; a plain comment review has nothing to dismiss.
    expect(await detail.queryByRole('button', { name: 'Dismiss hubot · Commented' })).toBeUndefined();

    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Dismiss octocat · Approved' })); });
    const field = [...document.querySelectorAll('textarea')].find((area) => area.getAttribute('aria-label') === 'Reason for dismissing')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(field, 'Approved before the rebase.');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await githubControls.get(detail)!.press('Dismiss review'); });

    expect(mutationInputs).toEqual([{ localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.reviewDismiss,
      input: expect.objectContaining({ reviewId: 'PRR_ok', message: 'Approved before the rebase.' }) }]);
  });

  it('starts a GitHub-owned pending review at the observed head and replaces creation with its lifecycle', async () => {
    const launch = TriageDetailSurfaceInputV1Schema.parse(launchInput('pull-request'));
    const input = { ...launch, observation: { ...launch.observation, snapshot: { ...launch.observation.snapshot,
      reviewRevision: { baseSha: 'a'.repeat(40), headSha: HEAD_REVISION, nativeRevision: HEAD_REVISION } } } };
    const openDraft = async () => {
      const detail = await mountFeedback(input as unknown as JsonValue);
      await openFeedback(detail);
      await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Start a review' })); });
      return detail;
    };
    let detail = await openDraft();
    const summaryField = () => [...document.querySelectorAll('textarea')]
      .find((area) => area.getAttribute('aria-label') === 'Summary (optional)')!;
    const field = summaryField();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(field, 'The lifecycle needs one correction.');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await detail.dispose(); });
    mounted.splice(mounted.indexOf(detail), 1);
    detail = await openDraft();
    expect(summaryField().value).toBe('The lifecycle needs one correction.');
    await act(async () => { await githubControls.get(detail)!.press('Start review'); });
    expect(deviceDrafts.size).toBe(0);
    expect(mutationInputs).toEqual([{ localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pendingReviewCreate,
      input: expect.objectContaining({ headRevision: HEAD_REVISION, body: 'The lifecycle needs one correction.' }) }]);
    // The containing Triage page publishes its ordinary post-mutation refresh signal.
    await refreshPage(detail);
    expect(await detail.queryByRole('button', { name: 'Start a review' })).toBeUndefined();
    expect(githubControls.get(detail)!.presentation('Delete draft review')).toMatchObject({ disabled: false });
    expect(await detail.getByRole('button', { name: 'Submit me · Not submitted yet' })).toMatchObject({ role: 'button' });
  });

  it('describes an unavailable Start review Action in words', async () => {
    reviewRefusal = true;
    const launch = TriageDetailSurfaceInputV1Schema.parse(launchInput('pull-request'));
    const input = { ...launch, observation: { ...launch.observation, snapshot: { ...launch.observation.snapshot,
      reviewRevision: { baseSha: 'a'.repeat(40), headSha: HEAD_REVISION, nativeRevision: HEAD_REVISION } } } };
    const detail = await mountFeedback(input as unknown as JsonValue);
    await openFeedback(detail);
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Start a review' })); });
    await act(async () => { await githubControls.get(detail)!.press('Start review'); });
    expect(document.body.textContent).toContain('Check the plugin and machine connection.');
    expect(document.body.textContent).not.toContain('contributed_action_unavailable');
  });

  it('keeps the retry instruction from a GraphQL rate limit carried in an HTTP 200', async () => {
    const payload = { data: null, errors: [{ type: 'RATE_LIMITED' }] };
    const result = await sendGithubGraphqlRequest({ query: 'mutation Subscription { __typename }', variables: {} }, {
      now: () => OBSERVED_AT_MS,
      client: { request: async () => ({ status: 200, headers: { 'retry-after': '120' },
        body: new TextEncoder().encode(JSON.stringify(payload)) }) },
    });
    expect(result).toMatchObject({ ok: false, mayHaveChanged: false,
      failure: { class: 'rateLimit', retryNotBeforeMs: OBSERVED_AT_MS + 120_000 } });
  });

  it.each(['failed', 'uncertain'] as const)('explains a rate-limited unsubscribe (%s) and keeps the last observed subscription', async (kind) => {
    const retryNotBeforeMs = OBSERVED_AT_MS + 120_000;
    subscriptionFailure = { kind, failure: { class: 'rateLimit', code: 'github_rate_limited', retryNotBeforeMs } };
    const detail = await mountFeedback(launchInput('pull-request'));
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Re-read this overview from GitHub' })); });
    const toggle = await detail.getByRole('switch', { name: 'Subscribed' });
    expect(toggle.state?.checked).toBe(true);
    await act(async () => { await detail.press(toggle); });
    expect((await detail.getByRole('switch', { name: 'Subscribed' })).state?.checked).toBe(true);
    expect(document.body.textContent).toContain('GitHub is limiting requests');
    expect(document.body.textContent).toContain(formatTriageTimestampV1(SURFACE_LOCALE, retryNotBeforeMs, 'absolute', retryNotBeforeMs));
    if (kind === 'uncertain') expect(document.body.textContent).toContain('Outcome unknown');
  });

  it.each([
    { previousCursor: 'earlier-reviews' },
    { incomplete: 'continuationUnavailable' },
    { omittedRowCount: 1 },
  ])('withholds review creation when review history does not establish draft absence: %j', async (coverage) => {
    answers.reviews = { kind: 'reviews', rows: [], ...coverage };
    const detail = await mountFeedback(launchInput('pull-request'));
    await openFeedback(detail);
    expect(await detail.queryByRole('button', { name: 'Start a review' })).toBeUndefined();
  });

  it('submits or deletes the viewer\'s pending review by its own id', async () => {
    answers.reviews = {
      kind: 'reviews',
      rows: [{ id: 'PRR_draft', author: 'me', body: 'Two notes.', state: 'PENDING' }],
    };
    // Submitting names the head the reader saw, so the observation carries one.
    const launch = launchInput('pull-request') as { observation: { snapshot: Record<string, JsonValue> } };
    launch.observation.snapshot.reviewRevision = { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), nativeRevision: 'b'.repeat(40) };
    const detail = await mountFeedback(launch as unknown as JsonValue);
    await openFeedback(detail);

    expect(await detail.queryByRole('button', { name: 'Start a review' })).toBeUndefined();

    await act(async () => { await githubControls.get(detail)!.press('Delete draft review'); });
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Submit me · Not submitted yet' })); });
    await act(async () => { await detail.press(await detail.getByRole('radio', { name: 'Approve' })); });
    // The Actions panel also owns a disabled control with this title; press the enabled lifecycle form.
    const submit = githubControls.get(detail)!.getSnapshot()
      .find(control => control.presentation.title === 'Submit review' && !control.presentation.disabled);
    expect(submit).toBeDefined();
    await act(async () => { await githubControls.get(detail)!.pressById(submit!.id); });

    expect(mutationInputs).toEqual([
      { localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pendingReviewDelete, input: expect.objectContaining({ reviewId: 'PRR_draft' }) },
      { localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pendingReviewSubmit,
        input: expect.objectContaining({ reviewId: 'PRR_draft', verdict: 'approve', headRevision: 'b'.repeat(40) }) },
    ]);
  });

  it('applies a conversation\'s suggestions in the linked Session and reports each file honestly', async () => {
    const suggestion = { path: 'src/pump.ts', commitOid: 'c'.repeat(40), startLine: 42, endLine: 42,
      originalLines: ['  drop(tail);'], replacement: '  keep(tail);', outdated: false };
    const outdated = { ...suggestion, path: 'src/tail.ts', outdated: true };
    answers.threads = {
      kind: 'threads',
      rows: [{
        id: 'PRRT_s', isResolved: false, path: 'src/pump.ts', line: 42,
        firstReply: { id: 'PRRC_s', author: 'octocat', body: 'Keep it.', suggestions: [suggestion, outdated] },
        replyCount: 1,
        replies: [{ id: 'PRRC_s', author: 'octocat', body: 'Keep it.', suggestions: [suggestion, outdated] }],
      }],
    };
    const detail = await mountFeedback(launchInput('pull-request', [],
      [{ sessionId: 'session-fix-1', displayTitle: 'Fix the pump' }]));
    await openFeedback(detail);
    declineSuggestion = true;
    await act(async () => { await suggestionControls.get(detail)!.press('Apply 2 suggestions in Fix the pump'); });
    expect(await detail.queryByText("Check the Session's changes to see what was applied.")).toBeUndefined();
    expect(suggestionControls.get(detail)!.presentation('Apply 2 suggestions in Fix the pump')?.disabled).not.toBe(true);
    await act(async () => { await suggestionControls.get(detail)!.press('Apply 2 suggestions in Fix the pump'); });

    expect(mutationInputs).toEqual([{ localId: 'scm.suggestion.apply',
      input: { sessionId: 'session-fix-1', suggestions: [suggestion, outdated] } }]);
    await expect(detail.getByText('Applied 1 of 2 files. src/tail.ts: the file changed since this suggestion.'))
      .resolves.toMatchObject({ content: expect.any(String) });
  });

  it('renders envelope omissions and an unavailable continuation as partial evidence', async () => {
    answers.comments = {
      kind: 'comments',
      rows: [],
      omittedRowCount: 2,
      projectionTruncated: true,
      incomplete: 'continuationUnavailable',
    };
    const detail = await mountFeedback(launchInput('issue'));
    await act(async () => {
      await detail.press(await detail.getByRole('tab', { name: 'Comments' }));
    });

    await expect(detail.getByText(
      '0 comment(s) read. 2 row(s) on the pages read could not be understood.',
    )).resolves.toMatchObject({ content: expect.any(String) });
    await expect(detail.getByText(
      'GitHub offered another page in a form this build will not follow, so this list stops here.',
    )).resolves.toMatchObject({ content: expect.any(String) });
  });

  it('shows current review, request, check and conversation facts from independent reads, not the Timeline', async () => {
    answers.comments = {
      kind: 'comments',
      rows: [{
        id: 'github-issue-comment:11',
        author: 'hubber',
        body: 'This normalizer is duplicated.',
        createdAtMs: OBSERVED_AT_MS - 20_000,
      }],
    };
    answers.reviews = {
      kind: 'reviews',
      reviewDecision: 'changes-requested',
      rows: [{
        id: 'PRR_1',
        author: 'octocat',
        body: 'Needs a smaller owner.',
        state: 'CHANGES_REQUESTED',
        submittedAtMs: OBSERVED_AT_MS - 10_000,
      }],
    };
    answers.requests = {
      kind: 'requests',
      rows: [{ kind: 'team', subject: 'Client Platform' }],
    };
    answers.threads = {
      kind: 'threads',
      rows: [{
        id: 'PRRT_1',
        isResolved: false,
        path: 'src/pump.ts',
        line: 42,
        firstReply: { id: 'PRRC_1', author: 'line-reviewer', body: 'The tail is dropped.' },
        replyCount: 1,
        replies: [{ id: 'PRRC_1', author: 'line-reviewer', body: 'The tail is dropped.' }],
      }],
    };
    answers.checks = {
      kind: 'checks',
      headRevision: HEAD_REVISION,
      state: 'resolved',
      rowState: { kind: 'failing', failingCount: 1 },
      rows: [],
      failingCount: 1,
      runningCount: 0,
      passingCount: 0,
      omittedRowCount: 0,
      projectionTruncated: false,
    };

    const detail = await mountFeedback(launchInput('pull-request', [{
      id: 'github/review-decision',
      importance: 'primary',
      value: { kind: 'status', value: 'Approved', tone: 'success' },
    }, {
      id: 'github/checks',
      importance: 'primary',
      value: { kind: 'status', value: 'All passing', tone: 'success' },
    }]));
    await openFeedback(detail);

    await expect(detail.getByText('Review: Changes requested'))
      .resolves.toEqual({ content: 'Review: Changes requested' });
    await expect(detail.getByText('Reviewed')).resolves.toEqual({ content: 'Reviewed' });
    // Who reviewed scrolls with the stream as its first entry, never as chrome pinned above it.
    expect([...document.querySelectorAll('[role="list"]')]
      .some((stream) => stream.textContent?.includes('Reviewed') && stream.textContent.includes('The tail is dropped.'))).toBe(true);
    await expect(detail.getByText('Needs a smaller owner.'))
      .resolves.toEqual({ content: 'Needs a smaller owner.' });
    // The reviewer row carries GitHub's own review state AND the instant that
    // review was submitted at. `submitted_at` is the only instant a review has —
    // it has no `created_at` — so a row that showed the state alone would drop
    // the one fact that says whether the sign-off predates the head on screen.
    const submittedAt = formatTriageTimestampV1(
      SURFACE_LOCALE,
      OBSERVED_AT_MS - 10_000,
      'relative',
      Date.now(),
    );
    await expect(detail.getByText(`Changes requested \u00b7 ${submittedAt}`))
      .resolves.toEqual({ content: `Changes requested \u00b7 ${submittedAt}` });
    // Who is still awaited is said once, by the Overview's facts and the rail's own request event: no block above the rail.
    await expect(detail.queryByText('Review requested from')).resolves.toBeUndefined();
    await expect(detail.getByText('src/pump.ts:42'))
      .resolves.toEqual({ content: 'src/pump.ts:42' });
    await expect(detail.getByText('The tail is dropped.'))
      .resolves.toEqual({ content: 'The tail is dropped.' });
    await expect(detail.getByText('1 failing')).resolves.toEqual({ content: '1 failing' });
    await expect(detail.getByText('hubber')).resolves.toEqual({ content: 'hubber' });

    expect([...dispatched].sort()).toEqual([
      GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:comments`,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:requests`,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:reviews`,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:threads`,
    ].sort());
  });

  it('resolves the exact conversation from its row without asking for an internal thread id', async () => {
    answers.threads = {
      kind: 'threads',
      rows: [{
        id: 'PRRT_1',
        isResolved: false,
        path: 'src/pump.ts',
        line: 42,
        firstReply: { id: 'PRRC_1', author: 'line-reviewer', body: 'The tail is dropped.' },
        replyCount: 1,
        replies: [{ id: 'PRRC_1', author: 'line-reviewer', body: 'The tail is dropped.' }],
      }],
    };
    const detail = await mountFeedback(launchInput('pull-request'));
    await openFeedback(detail);

    await act(async () => {
      await githubControls.get(detail)!.press('Resolve conversation at src/pump.ts:42');
    });

    expect(mutationInputs).toEqual([{
      v: 1,
      instance: expect.any(Object),
      localRef: {
        kindId: 'pull-request',
        collisionScope: 'github:1296269',
        entryId: '1284',
      },
      routingToken: 'octo-org/example-app',
      threadId: 'PRRT_1',
      resolved: true,
    }]);
    await expect(detail.queryByRole('textbox', { label: 'Review thread ID' }))
      .resolves.toBeUndefined();
  });

  it('publishes one canonical proposal into the exact conversation from its row', async () => {
    answers.threads = {
      kind: 'threads',
      rows: [{
        id: 'PRRT_1',
        isResolved: false,
        path: 'src/pump.ts',
        line: 42,
        firstReply: { id: 'PRRC_1', author: 'line-reviewer', body: 'The tail is dropped.' },
        replyCount: 1,
        replies: [{ id: 'PRRC_1', author: 'line-reviewer', body: 'The tail is dropped.' }],
      }],
    };
    const detail = await mountFeedback(launchInput('pull-request', [], [{
      sessionId: 'session-review-1',
      displayTitle: 'Review this pull request',
    }]));
    await openFeedback(detail);
    await vi.waitFor(async () => {
      expect(await detail.queryByRole('radio', {
        name: 'Please keep the returned error.',
      })).toBeDefined();
    }, { timeout: 5_000 });

    await expect(detail.findByRole('radio', { name: 'Please keep the returned error.' }))
      .resolves.toMatchObject({ state: { checked: true } });
    await act(async () => {
      await githubControls.get(detail)!.press('Post selected reply');
    });

    expect(mutationInputs.at(-1)).toMatchObject({
      threadId: 'PRRT_1',
      publicationPlan: {
        target: {
          providerId: 'github',
          configuredAccountId: 'account-1',
          subtarget: { kindId: 'review-thread', targetId: 'PRRT_1' },
          entryRef: {
            sourceId: `${GITHUB_PLUGIN_ID}/github-forge`,
            kindId: 'pull-request',
            collisionScope: 'github:1296269',
            entryId: '1284',
          },
        },
        baseRevision: null,
        headRevision: null,
        entries: [{
          happierCommentId: 'review-comment-1',
          expectedServerRevision: 3,
          body: 'Please keep the returned error.',
        }],
        verdict: null,
      },
    });
    expect(dispatched.filter((action) => action === 'reviews.comments.list')).toHaveLength(1);
  });

  it('reopens the exact resolved conversation from the same row control', async () => {
    answers.threads = {
      kind: 'threads',
      rows: [{
        id: 'PRRT_2',
        isResolved: true,
        firstReply: { id: 'PRRC_2', author: 'reviewer', body: 'Resolved too early.' },
        replyCount: 1,
        replies: [{ id: 'PRRC_2', author: 'reviewer', body: 'Resolved too early.' }],
      }],
    };
    const detail = await mountFeedback(launchInput('pull-request'));
    await openFeedback(detail);

    expect(githubControls.get(detail)!.presentation('Reopen conversation at Review conversation'))
      .toMatchObject({ disabled: false });
    await act(async () => { await githubControls.get(detail)!.press('Reopen conversation at Review conversation'); });

    expect(mutationInputs).toEqual([expect.objectContaining({
      threadId: 'PRRT_2',
      resolved: false,
    })]);
  });

  it('keeps answered comments and checks when the reviews read cannot be made', async () => {
    answers.comments = {
      kind: 'comments',
      rows: [{
        id: 'github-issue-comment:11',
        author: 'hubber',
        body: 'This normalizer is duplicated.',
        createdAtMs: OBSERVED_AT_MS - 20_000,
      }],
    };
    answers.reviews = {
      kind: 'unavailable',
      failure: { class: 'permission', code: 'github_forbidden' },
    };
    answers.checks = {
      kind: 'checks',
      headRevision: HEAD_REVISION,
      state: 'resolved',
      rowState: { kind: 'failing', failingCount: 1 },
      rows: [],
      failingCount: 1,
      runningCount: 0,
      passingCount: 0,
      omittedRowCount: 0,
      projectionTruncated: false,
    };
    const detail = await mountFeedback(launchInput('pull-request'));
    await openFeedback(detail);

    await expect(detail.getByText('hubber')).resolves.toEqual({ content: 'hubber' });
    await expect(detail.getByText('1 failing')).resolves.toEqual({ content: '1 failing' });
    await expect(detail.getByText('Part of this feedback could not be read'))
      .resolves.toEqual({ content: 'Part of this feedback could not be read' });
  });

  it('keeps review people when the checks read cannot be made', async () => {
    answers.reviews = {
      kind: 'reviews',
      reviewDecision: 'approved',
      rows: [{ id: 'PRR_1', author: 'octocat', body: '', state: 'APPROVED' }],
    };
    answers.checks = {
      kind: 'unavailable',
      failure: { class: 'permission', code: 'github_forbidden' },
    };
    const detail = await mountFeedback(launchInput('pull-request'));
    await openFeedback(detail);

    await expect(detail.getByText('Review: Approved'))
      .resolves.toEqual({ content: 'Review: Approved' });
    await expect(detail.getByText('Part of this feedback could not be read'))
      .resolves.toEqual({ content: 'Part of this feedback could not be read' });
  });

  it('says nothing about approval when the current reviews read reports no decision', async () => {
    const detail = await mountFeedback(launchInput('pull-request'));
    await openFeedback(detail);

    // An unanswered decision stays quiet; it must not invent either verdict.
    await expect(detail.queryByText('Review: Approved')).resolves.toBeUndefined();
    await expect(detail.queryByText('Review: Changes requested')).resolves.toBeUndefined();
    await expect(detail.queryByText('Approved')).resolves.toBeUndefined();
    await expect(detail.queryByText('Reviewed')).resolves.toBeUndefined();
    await expect(detail.queryByText('Review requested from')).resolves.toBeUndefined();
  });

  it('retains the last-known-good review decision when an explicit re-read fails', async () => {
    answers.reviews = {
      kind: 'reviews',
      reviewDecision: 'approved',
      rows: [{ id: 'PRR_1', author: 'octocat', body: '', state: 'APPROVED' }],
    };
    const detail = await mountFeedback(launchInput('pull-request'));
    await openFeedback(detail);
    await expect(detail.getByText('Review: Approved'))
      .resolves.toEqual({ content: 'Review: Approved' });

    answers.reviews = {
      kind: 'unavailable',
      failure: { class: 'permission', code: 'github_forbidden' },
    };
    await refreshPage(detail);

    await expect(detail.getByText('Review: Approved'))
      .resolves.toEqual({ content: 'Review: Approved' });
    await expect(detail.getByText('Part of this feedback could not be read'))
      .resolves.toEqual({ content: 'Part of this feedback could not be read' });
  });

  it('retains the last-known-good checks when an explicit re-read fails', async () => {
    answers.checks = {
      kind: 'checks',
      headRevision: HEAD_REVISION,
      state: 'resolved',
      rowState: { kind: 'failing', failingCount: 1 },
      rows: [],
      failingCount: 1,
      runningCount: 0,
      passingCount: 0,
      omittedRowCount: 0,
      projectionTruncated: false,
    };
    const detail = await mountFeedback(launchInput('pull-request'));
    await openFeedback(detail);
    await expect(detail.getByText('1 failing')).resolves.toEqual({ content: '1 failing' });

    answers.checks = {
      kind: 'unavailable',
      failure: { class: 'permission', code: 'github_forbidden' },
    };
    await refreshPage(detail);

    await expect(detail.getByText('1 failing')).resolves.toEqual({ content: '1 failing' });
    await expect(detail.getByText('Part of this feedback could not be read'))
      .resolves.toEqual({ content: 'Part of this feedback could not be read' });
  });

  it('discloses a known-incomplete check suite instead of reporting nothing wrong', async () => {
    // The read SUCCEEDED — this is not a failed connection — but GitHub did not
    // list the whole suite, so the unread part may be exactly where a failure
    // is. A silent empty plane here reads as "CI is clean".
    answers.checks = {
      kind: 'checks',
      headRevision: HEAD_REVISION,
      state: 'knownIncomplete',
      rows: [],
      omittedRowCount: 0,
      projectionTruncated: false,
    };
    const detail = await mountFeedback(launchInput('pull-request'));
    await openFeedback(detail);

    await expect(detail.getByText('This check suite is larger than GitHub will list'))
      .resolves.toEqual({ content: 'This check suite is larger than GitHub will list' });
    await expect(detail.queryByText(
      'No comment has been left on this pull request, and GitHub reports nothing wrong with it.',
    )).resolves.toBeUndefined();
    // An incomplete read is not a failed one, and the two must not collapse into
    // one banner that sends the reader looking for a connection error.
    await expect(detail.queryByText('Part of this feedback could not be read'))
      .resolves.toBeUndefined();
  });

  it('still reports nothing wrong when the checks read is complete and empty', async () => {
    const detail = await mountFeedback(launchInput('pull-request'));
    await openFeedback(detail);

    await expect(detail.getByText(
      'No comment has been left on this pull request, and GitHub reports nothing wrong with it.',
    )).resolves.toMatchObject({ content: expect.any(String) });
    await expect(detail.queryByText('This check suite is larger than GitHub will list'))
      .resolves.toBeUndefined();
  });

  it('collapses a mobile review thread to its first reply and exact reply count', async () => {
    answers.threads = {
      kind: 'threads',
      rows: [{
        id: 'PRRT_mobile',
        isResolved: false,
        path: 'src/mobile.ts',
        line: 8,
        firstReply: {
          id: 'PRRC_first',
          author: 'first-reviewer',
          body: 'This is the first reply.',
          createdAtMs: OBSERVED_AT_MS - 40_000,
        },
        replyCount: 4,
        replies: [{
          id: 'PRRC_latest',
          author: 'latest-reviewer',
          body: 'This is the latest reply.',
          createdAtMs: OBSERVED_AT_MS - 10_000,
        }],
        previousRepliesCursor: 'older-mobile-replies',
      }],
    };
    const detail = await mountFeedback(launchInput('pull-request'), 'ios');
    await openFeedback(detail);

    await expect(detail.getByText('This is the first reply.'))
      .resolves.toEqual({ content: 'This is the first reply.' });
    await expect(detail.getByText('4 replies')).resolves.toEqual({ content: '4 replies' });
    await expect(detail.queryByText('This is the latest reply.')).resolves.toBeUndefined();
    await expect(detail.queryByRole('button', { name: 'Load earlier replies' }))
      .resolves.toBeUndefined();
  });

  it('re-reads each feedback connection and checks through their existing reader owners', async () => {
    const detail = await mountFeedback(launchInput('pull-request'));
    expect(dispatched).toEqual([]);
    await openFeedback(detail);
    expect(dispatched).toHaveLength(5);
    await refreshPage(detail);

    expect([...dispatched].sort()).toEqual([
      GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview,
      GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:comments`,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:comments`,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:requests`,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:requests`,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:reviews`,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:reviews`,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:threads`,
      `${GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback}:threads`,
    ].sort());
  });

  it.each([
    ['Checks', 'Re-read the checks from GitHub'],
    ['Feedback', 'Re-read this feedback from GitHub'],
  ] as const)('re-reads %s through the page refresh only, once per press while its warm read is pending', async (
    tabName,
    refreshName,
  ) => {
    const detail = await mountFeedback(launchInput('pull-request'));
    await act(async () => {
      await detail.press(await detail.getByRole('tab', { name: tabName }));
    });

    let settleChecks!: (value: JsonValue) => void;
    nextChecksGate = new Promise<JsonValue>((resolve) => {
      settleChecks = resolve;
    });
    await refreshPage(detail);

    // The page's one refresh reaches the panel; the panel draws no second refresh of its own.
    await expect(detail.queryByRole('button', { name: refreshName })).resolves.toBeUndefined();
    await refreshPage(detail);
    expect(dispatched.filter(
      (action) => action === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview,
    )).toHaveLength(2);

    await act(async () => {
      settleChecks(answers.checks);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await refreshPage(detail);
    expect(dispatched.filter((action) => action === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview)).toHaveLength(3);
  });
});
