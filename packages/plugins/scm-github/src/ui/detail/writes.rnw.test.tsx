// @vitest-environment jsdom
// The package compiles JSX with the classic runtime, so `React` must be in scope.
import React, { act } from 'react';
import { Animated } from 'react-native';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { ActionApprovalRequestCreatedResult } from '@happier-dev/plugin-sdk/actions';
import { createReviewCommentLinkedIssueIdV1 } from '@happier-dev/plugin-sdk/reviews';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { HAPPIER_MOTION_V1 } from '@happier-dev/plugin-ui/components';
import { TriageEvidenceDisclosureProvider, TriagePostMutationCompletionProvider,
  type TriageDetailPrimaryWriteHostV1, type TriageDetailPrimaryWriteV1 } from '@happier-dev/triage-sources/ui';
import { SessionPullRequestNativeStatusV1Schema, TriageDetailSurfaceInputV1Schema,
  type TriageDetailSurfaceInputV1, type TriagePullRequestStatusV1 } from '@happier-dev/triage-protocol/v1';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import {
  GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1,
  GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1,
} from '../../triage/contribution.js';

import { renderSurface } from '../renderSurface.js';
import { buildGithubPullRequestOperationsV1 } from '../../triage/pullRequestOperations.js';
import { GithubCapabilitiesResultV1Schema, GithubOverviewResultV1Schema } from '../../triage/detail/contracts.js';
import { GithubPullRequestMergeResultV1Schema, GithubPullRequestNativeMergeResultV1Schema,
  GithubPullRequestMarkReadyResultV1Schema } from '../../triage/mutations/contracts.js';
import { GITHUB_WRITE_REFUSAL_COPY_V1, withGithubOperationOutcomeV1 } from '../../triage/mutations/outcome.js';
import { projectGithubRepositoryCapabilities } from '../../triage/capabilities.js';
import { readTriageActivityNextV1 } from '../../../../triage/src/ui/detail/activityAgent.js';

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
  panel?: 'overview' | 'actions',
): JsonValue {
  return {
    v: 1,
    ...(panel === undefined ? {} : { panel }),
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
        webUrl: kindId === 'issue'
          ? 'https://github.com/octo-org/example-app/issues/1284'
          : 'https://github.com/octo-org/example-app/pull/1284',
        displayPath: 'octo-org/example-app#1284',
        routingToken: 'octo-org/example-app',
      },
      snapshot: {
        v: 1,
        title: 'Consolidate the duplicated normalizer',
        scopeLabel: 'octo-org/example-app',
        state,
        facts: [],
        ...(kindId === 'pull-request' ? {
          reviewRevision: {
            baseSha: '1b0847af63d5c1e299f2c1a7d4b6e08f3a5c9d2e',
            headSha: OBSERVED_HEAD,
            nativeRevision: OBSERVED_HEAD,
          },
        } : {}),
      },
      viewer: { involvement: ['reviewRequested'] },
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
    state: { presentation: 'resolved', nativeLabel: 'Merged' },
    facts: [],
  },
  viewer: { involvement: ['reviewRequested'] },
} as const;

/** The production capability projector's own operation set: relationship Actions carry no capability preflight. */
const FIXTURE_OPERATIONS: Readonly<Record<string, JsonValue>> = projectGithubRepositoryCapabilities({
  kind: 'readable', repositoryId: '1296269', repositoryKey: 'octo-org/example-app',
  mergeSettings: { merge: true, squash: true, rebase: true }, archived: false, hasIssues: true,
}).operations;

const recorded: { action: unknown; input: unknown }[] = [];
const mounted: PluginUiTestkit[] = [];
let nextResult: JsonValue = { kind: 'applied', effect: 'changed', observation: APPLIED_OBSERVATION };
let nextActionGate: Promise<JsonValue> | null = null;
let nextOverviewGate: Promise<JsonValue> | null = null;
let nextActionError: unknown | null = null;
let completedMutations = 0;
let nextCapabilities: JsonValue = {
  kind: 'capabilities',
  mergeSettings: { merge: true, squash: true, rebase: true },
  operations: { ...FIXTURE_OPERATIONS },
  mergeMethods: { merge: { kind: 'available' }, squash: { kind: 'available' }, rebase: { kind: 'available' } },
};

/** Host transport fixture uses the production offer owner, never a UI fallback. */
function overviewFixture(launch: TriageDetailSurfaceInputV1): JsonValue {
  const overview = GithubOverviewResultV1Schema.parse(nextOverview);
  if (overview.kind !== 'overview' || overview.kindId !== 'pull-request' || overview.pullRequestStatus !== undefined) return nextOverview;
  const capabilities = GithubCapabilitiesResultV1Schema.parse(nextCapabilities);
  const instance = launch.instance;
  if ('source' in instance.binding && instance.binding.source === 'accountData') {
    throw new Error('The GitHub fixture requires a native or Connected Account binding.');
  }
  const status: TriagePullRequestStatusV1 = { kind: 'status', observedAtMs: overview.observedAtMs,
    checks: null, review: null, facts: [],
    merge: { state: overview.draft ? 'blocked' : 'unknown', blocker: overview.draft ? 'Draft pull request' : null,
      draft: overview.draft, nativeState: overview.draft ? 'DRAFT' : 'UNKNOWN' },
    branch: overview.headBranch === undefined || overview.baseBranch === undefined ? null : {
      head: overview.headBranch, base: overview.baseBranch,
      ...(overview.headRevision === undefined ? {} : { headRevision: overview.headRevision }) },
  };
  const operations = buildGithubPullRequestOperationsV1({
    target: { instance: { ...instance, binding: instance.binding }, localRef: {
      kindId: launch.observation.entryRef.kindId, collisionScope: launch.observation.entryRef.collisionScope,
      entryId: launch.observation.entryRef.entryId,
    }, routingToken: launch.observation.locator.routingToken ?? '' },
    state: launch.observation.snapshot.state, headRevision: launch.observation.snapshot.reviewRevision?.headSha,
    overview, capabilities: capabilities.kind === 'capabilities' ? capabilities : null, status,
  });
  return projectNativeJsonValueForTransport({ ...overview, pullRequestStatus: {
    ...status, ...(operations === undefined ? {} : { operations }),
  } });
}
let nextOverview: JsonValue = {
  kind: 'overview',
  kindId: 'pull-request',
  observedAtMs: 1_760_000_800_000,
  title: 'Consolidate the duplicated normalizer',
  state: 'open',
  draft: false,
  merged: false,
  author: 'octocat',
  body: 'Keeps one normalization owner.',
  webUrl: 'https://github.com/octo-org/example-app/pull/1284',
  labels: [],
  assignees: [],
  milestone: null,
  headBranch: 'normalizer',
  baseBranch: 'main',
  requestedReviewers: [],
  headRevision: OBSERVED_HEAD,
  additions: 8,
  deletions: 3,
  branchUpdateEligibility: 'behind',
};

async function mountDetail(
  state: Readonly<{ presentation: string; nativeLabel: string }>,
  kindId: 'pull-request' | 'issue' = 'pull-request',
  linkedSessions: readonly JsonValue[] = [],
  primaryWrite?: TriageDetailPrimaryWriteHostV1,
  panel?: 'overview' | 'actions',
): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  const launch = launchInput(state, kindId, linkedSessions, panel ?? (primaryWrite === undefined ? undefined : 'overview'));
  const parsedLaunch = TriageDetailSurfaceInputV1Schema.parse(launch);
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-202', mountNonce: 'fixture-mount-202' },
      authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      surface: (context) => (
        <TriagePostMutationCompletionProvider
          onComplete={async () => { completedMutations += 1; }}
        >
          {/* The SDK surface produces an opaque host element, not a React node. */}
          {primaryWrite === undefined ? renderSurface(context) as React.ReactNode
            : <TriageEvidenceDisclosureProvider disclosure={{ available: false, disclose: async () => ({ kind: 'inert' }), primaryWrite }}>
              {renderSurface(context) as React.ReactNode}
            </TriageEvidenceDisclosureProvider>}
        </TriagePostMutationCompletionProvider>
      ),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
      launchInput: launch,
      handlers: {
        executeAction: async ({ action, input }) => {
          if (typeof action === 'object' && action !== null
            && 'localId' in action
            && action.localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readCapabilities) {
            return nextCapabilities;
          }
          recorded.push({ action, input });
          if (typeof action === 'object' && action !== null
            && 'localId' in action
            && action.localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview) {
            return nextOverviewGate === null ? overviewFixture(parsedLaunch) : await nextOverviewGate;
          }
          if (nextActionError !== null) throw nextActionError;
          if (action === 'reviews.comments.list') {
            return {
              items: [{
                id: 'review-comment-1',
                body: 'The implementation is ready to merge.',
                serverRevision: 3,
                anchor: { kind: 'line', filePath: 'src/index.ts', line: 12, side: 'after' },
                snapshot: {
                  kind: 'text',
                  selectedLines: ['return ready;'],
                  beforeContext: [],
                  afterContext: [],
                  selectedLinesHash: 'selected-hash',
                  contextWindowHash: 'context-hash',
                  capturedAt: 1_760_000_000_000,
                  fileLength: 20,
                  source: 'committed',
                  commitSha: OBSERVED_HEAD,
                  isUncommitted: false,
                  isUntracked: false,
                  truncated: false,
                  hasBidiControls: false,
                  likelyMinified: false,
                  diffContext: {
                    side: 'after',
                    baseSha: '1b0847af63d5c1e299f2c1a7d4b6e08f3a5c9d2e',
                    headSha: OBSERVED_HEAD,
                  },
                },
                linkedRefs: [{
                  kind: kindId === 'issue' ? 'issue' : 'pullRequest',
                  ...(kindId === 'issue' ? {
                    id: createReviewCommentLinkedIssueIdV1({
                      source: SOURCE_CONTRIBUTION,
                      kindId,
                      collisionScope: 'github:1296269',
                      entryId: '1284',
                    }),
                  } : {}),
                  url: kindId === 'issue'
                    ? 'https://github.com/octo-org/example-app/issues/1284'
                    : 'https://github.com/octo-org/example-app/pull/1284',
                }],
              }],
              cursor: null,
            } as JsonValue;
          }
          const result = nextActionGate === null ? nextResult : await nextActionGate;
          // This genuine host Action boundary returns the same source-produced
          // outcome as the registered Action; malformed native fixtures stay malformed.
          const localId = typeof action === 'object' && action !== null && 'localId' in action ? action.localId : null;
          const schema = localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMerge ? GithubPullRequestMergeResultV1Schema
            : localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMarkReady ? GithubPullRequestMarkReadyResultV1Schema
              : localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestEnqueue
                || localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestDequeue
                || localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestAutoMergeSet ? GithubPullRequestNativeMergeResultV1Schema : null;
          const native = schema?.safeParse(result);
          return native?.success ? projectNativeJsonValueForTransport(withGithubOperationOutcomeV1(native.data)) : result;
        },
      },
    }) as PluginUiTestkit;
  });
  await vi.waitFor(async () => {
    expect(await fixture.queryByText('Checking repository permissions…')).toBeUndefined();
  });
  mounted.push(fixture);
  return fixture;
}

async function mountWritableDetail(...args: Parameters<typeof mountDetail>): Promise<PluginUiTestkit> {
  const detail = await mountDetail(...args);
  await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Re-read this overview from GitHub' })); });
  return detail;
}

function withPropertyChoices(): void {
  const overview = GithubOverviewResultV1Schema.parse(nextOverview);
  if (overview.kind !== 'overview') throw new Error('Expected an overview fixture');
  nextOverview = projectNativeJsonValueForTransport({ ...overview,
    assignees: ['octocat'], labels: ['bug'],
    propertyChoices: {
      assignees: { kind: 'available', choices: [{ login: 'octocat' }, { login: 'hubot' }] },
      labels: { kind: 'available', choices: ['bug', 'enhancement'] },
    },
  });
}

function typePropertySearch(property: 'assignees' | 'labels', query: string): void {
  const search = document.querySelector<HTMLInputElement>(`[data-testid="github-pr-${property}.${property}.value.search"]`);
  expect(search, 'the shared property choice search is present').not.toBeNull();
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setValue.call(search, query);
  search!.dispatchEvent(new Event('input', { bubbles: true }));
}

async function waitForPublicationProposalRead(
  detail: PluginUiTestkit,
  role: 'checkbox' | 'radio' = 'checkbox',
): Promise<void> {
  try {
    await vi.waitFor(async () => {
      expect(await detail.queryByRole(role, {
        name: 'The implementation is ready to merge.',
      })).toBeDefined();
    }, { timeout: 5_000 });
  } catch (error) {
    const status = {
      loading: await detail.queryByText('Reading review proposals…') !== undefined,
      failed: await detail.queryByText('Review proposals are unavailable') !== undefined,
      empty: await detail.queryByText('No proposed review comment is linked to this pull request yet.') !== undefined
        || await detail.queryByText('No proposed review comment is linked to this entry yet.') !== undefined,
      listCalls: recorded.filter(({ action }) => action === 'reviews.comments.list').length,
    };
    throw new Error(`proposal read did not expose its returned item: ${JSON.stringify(status)}`, {
      cause: error,
    });
  }
}

afterEach(async () => {
  recorded.splice(0);
  completedMutations = 0;
  nextCapabilities = {
    kind: 'capabilities',
    mergeSettings: { merge: true, squash: true, rebase: true },
    operations: { ...FIXTURE_OPERATIONS },
    mergeMethods: { merge: { kind: 'available' }, squash: { kind: 'available' }, rebase: { kind: 'available' } },
  };
  nextResult = { kind: 'applied', effect: 'changed', observation: APPLIED_OBSERVATION };
  nextOverview = {
    kind: 'overview',
    kindId: 'pull-request',
    observedAtMs: 1_760_000_800_000,
    title: 'Consolidate the duplicated normalizer',
    state: 'open',
    draft: false,
    merged: false,
    author: 'octocat',
    body: 'Keeps one normalization owner.',
    webUrl: 'https://github.com/octo-org/example-app/pull/1284',
    labels: [],
    assignees: [],
    milestone: null,
    headBranch: 'normalizer',
    baseBranch: 'main',
    requestedReviewers: [],
    headRevision: OBSERVED_HEAD,
    additions: 8,
    deletions: 3,
    branchUpdateEligibility: 'behind',
  };
  nextActionGate = null;
  nextOverviewGate = null;
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
 * The header-prop cases use its existing Overview demand. Other cases leave
 * detail reads cold until the reader activates or refreshes the relevant panel.
 */
describe('the mounted GitHub write controls', () => {
  it('does not republish the source primary write on equal host context renders', async () => {
    const offered: { current: TriageDetailPrimaryWriteV1 | null } = { current: null };
    const offer = vi.fn((value: TriageDetailPrimaryWriteV1 | null) => { offered.current = value; });
    const detail = await mountDetail({ presentation: 'active', nativeLabel: 'Open' }, 'pull-request', [], { offer });
    await vi.waitFor(() => expect(offered.current).toMatchObject({ id: 'merge', disabledReason: null }));
    const current = offered.current;
    const publications = offer.mock.calls.length;
    await act(async () => {
      for (let index = 0; index < 3; index += 1) await detail.updateSurface(createSurfaceContextFixture());
    });
    expect(offered.current).toBe(current);
    expect(offer).toHaveBeenCalledTimes(publications);
    expect(recorded.filter(({ action }) => typeof action === 'object' && action !== null
      && 'localId' in action && action.localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview)).toHaveLength(1);
  });

  it('keeps host approval distinct from an unreadable native answer through the shared primary adapter', async () => {
    const animation = vi.spyOn(Animated, 'timing');
    nextResult = { kind: 'approval_request_created', artifactId: 'merge-approval',
      actionId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMerge } satisfies ActionApprovalRequestCreatedResult;
    const detail = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });
    await act(async () => {
      await detail.press(await detail.getByRole('radio', { name: 'Create a merge commit' }));
      await detail.press(await detail.getByRole('button', { name: 'Merge pull request' }));
    });
    expect(await detail.getByText('Approval requested')).toBeDefined();
    expect(await detail.queryByText('This answer could not be read')).toBeUndefined();
    expect(animation).not.toHaveBeenCalled();
    expect(completedMutations).toBe(0);
  });

  it.each([true, false])('forwards the source-owned offer variant unchanged with display head %s rather than reconstructing merge policy or inputs', async (displayHead) => {
    const offered: { current: TriageDetailPrimaryWriteV1 | null } = { current: null };
    const input = { v: 1, instance: CONFIGURED_INSTANCE,
      localRef: { kindId: 'pull-request', collisionScope: 'github:1296269', entryId: '1284' },
      routingToken: 'octo-org/example-app', headRevision: OBSERVED_HEAD, mergeMethod: 'squash',
      commitTitle: 'Source-projected merge title' };
    const actionRef = { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMerge };
    if (nextOverview === null || typeof nextOverview !== 'object' || Array.isArray(nextOverview)) throw new Error('Overview fixture');
    nextOverview = { ...nextOverview, pullRequestStatus: {
      kind: 'status', observedAtMs: 100, checks: null, review: null,
      merge: { state: 'unknown', blocker: null, nativeState: 'UNKNOWN', draft: false },
      branch: { head: 'topic', base: 'main', ...(displayHead ? { headRevision: OBSERVED_HEAD } : {}) }, facts: [],
      operations: { readiness: 'unknown', unmetRequirements: [], alternatives: [], primary: {
        id: 'merge', title: 'Merge', disabledReason: null, actionRef,
        variants: [{ id: 'squash', method: { title: 'Squash and merge' }, input }],
      } },
    } };
    await mountDetail({ presentation: 'active', nativeLabel: 'Open' }, 'pull-request', [], {
      offer: value => { offered.current = value; },
    });
    await vi.waitFor(() => expect(offered.current).toMatchObject({ actionRef, disabledReason: null,
      methods: [{ id: 'squash', title: 'Squash and merge' }] }));
    expect(offered.current?.inputFor?.('squash')).toEqual(input);
    expect(offered.current?.inputFor?.('merge')).toBeNull();
    const writes = () => recorded.filter(({ action }) => typeof action === 'object' && action !== null
      && 'localId' in action && action.localId === actionRef.localId);
    await act(async () => { await offered.current?.execute(); });
    expect(writes()).toHaveLength(0);
    await act(async () => { await offered.current?.execute('squash'); });
    expect(writes()).toEqual([{ action: actionRef, input }]);
    const shown = offered.current;
    nextOverview = { kind: 'unavailable', failure: { class: 'transient', code: 'native-read-failed' } };
    await act(async () => { await shown?.readRequirements?.(); });
    expect(offered.current?.nativeStatus?.kind).toBe('stale');
    expect(shown?.inputFor?.('squash')).toBeNull();
    await act(async () => { await shown?.execute('squash'); });
    expect(writes()).toHaveLength(1);
  });

  it('offers the shared native status and successful clock to the header without another status read', async () => {
    const offered: { current: TriageDetailPrimaryWriteV1 | null } = { current: null };
    const offer = (value: TriageDetailPrimaryWriteV1 | null) => { offered.current = value; };
    if (nextOverview === null || typeof nextOverview !== 'object' || Array.isArray(nextOverview)) throw new Error('Overview fixture');
    const native = { kind: 'status', observedAtMs: 100, checks: null, review: null,
      merge: { state: 'unknown', blocker: null, nativeState: 'UNKNOWN', draft: false },
      branch: { head: 'topic', base: 'main', headRevision: OBSERVED_HEAD }, facts: [] };
    nextOverview = { ...nextOverview, pullRequestStatus: native };
    await mountDetail({ presentation: 'active', nativeLabel: 'Open' }, 'pull-request', [], { offer });
    await vi.waitFor(() => expect(offered.current).toMatchObject({
      nativeStatus: { kind: 'current', checkedAtMs: 100, value: native },
    }));
    const first = offered.current?.nativeStatus;
    // Native facts without admitted offers remain readable, never executable.
    expect(offered.current?.actionRef).toBeUndefined();
    expect(offered.current?.inputFor).toBeUndefined();
    expect(SessionPullRequestNativeStatusV1Schema.safeParse(first).success).toBe(true);
    expect(recorded.filter(({ action }) => typeof action === 'object' && action !== null
      && 'localId' in action && action.localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview)).toHaveLength(1);
    if (nextOverview === null || typeof nextOverview !== 'object' || Array.isArray(nextOverview)) throw new Error('Overview fixture');
    nextOverview = { ...nextOverview, pullRequestStatus: { ...native, observedAtMs: 200 } };
    await act(async () => { await offered.current?.readRequirements?.(); });
    const refreshed = offered.current?.nativeStatus;
    expect(refreshed).toMatchObject({ kind: 'current', checkedAtMs: 200, value: { observedAtMs: 100 } });
    if (first?.kind !== 'current' || refreshed?.kind !== 'current') throw new Error('Current native status required');
    expect(refreshed.value).toBe(first.value);
    const failure = { class: 'transient', code: 'read-failed' } as const;
    nextOverview = { kind: 'unavailable', failure };
    await act(async () => { await offered.current?.readRequirements?.(); });
    const stale = offered.current?.nativeStatus;
    expect(stale).toMatchObject({ kind: 'stale', checkedAtMs: 200, failure });
    expect(SessionPullRequestNativeStatusV1Schema.safeParse(stale).success).toBe(true);
    if (stale?.kind !== 'stale') throw new Error('Stale native status required');
    expect(stale.value).toBe(first.value);
    expect(recorded.filter(({ action }) => typeof action === 'object' && action !== null
      && 'localId' in action && action.localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview)).toHaveLength(3);
    expect(recorded).not.toEqual(expect.arrayContaining([expect.objectContaining({
      action: expect.objectContaining({ localId: 'entries/read-pull-request-status-v1' }),
    })]));
  });

  it('retires an uncertain offer until an explicit successful native refresh without replaying it', async () => {
    const offered: { current: TriageDetailPrimaryWriteV1 | null } = { current: null };
    nextResult = { kind: 'uncertain' };
    await mountDetail({ presentation: 'active', nativeLabel: 'Open' }, 'pull-request', [], {
      offer: value => { offered.current = value; },
    });
    await vi.waitFor(() => expect(offered.current).toMatchObject({ id: 'merge', disabledReason: null,
      methods: expect.arrayContaining([expect.objectContaining({ id: 'squash' })]) }));
    const shown = offered.current;
    const writes = () => recorded.filter(({ action }) => typeof action === 'object' && action !== null
      && 'localId' in action && action.localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMerge);
    await act(async () => { await shown?.execute('squash'); });
    expect(offered.current?.disabledReason).toEqual(expect.any(String));
    expect(shown?.inputFor?.('squash')).toBeNull();
    await act(async () => { await shown?.execute('squash'); });
    expect(writes()).toHaveLength(1);
    if (nextOverview === null || typeof nextOverview !== 'object' || Array.isArray(nextOverview)) throw new Error('Overview fixture');
    const successfulOverview = nextOverview;
    nextOverview = { kind: 'unavailable', failure: { class: 'transient', code: 'refresh-failed' } };
    await act(async () => { await offered.current?.readRequirements?.(); });
    expect(offered.current?.disabledReason).toEqual(expect.any(String));
    expect(writes()).toHaveLength(1);
    nextOverview = { ...successfulOverview, observedAtMs: 1_760_000_800_001 };
    await act(async () => { await offered.current?.readRequirements?.(); });
    expect(offered.current?.disabledReason).toBeNull();
    expect(writes()).toHaveLength(1);
    expect(shown?.inputFor?.('squash')).toBeNull();
    await act(async () => { await shown?.execute('squash'); });
    expect(writes()).toHaveLength(1);
    expect(recorded.filter(({ action }) => typeof action === 'object' && action !== null
      && 'localId' in action && action.localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview)).toHaveLength(3);
  });

  it('does not let an earlier pending refresh clear a later uncertain write', async () => {
    const offered: { current: TriageDetailPrimaryWriteV1 | null } = { current: null };
    await mountDetail({ presentation: 'active', nativeLabel: 'Open' }, 'pull-request', [], {
      offer: value => { offered.current = value; },
    });
    await vi.waitFor(() => expect(offered.current).toMatchObject({ id: 'merge', disabledReason: null }));
    const shown = offered.current;
    const successfulRead = overviewFixture(TriageDetailSurfaceInputV1Schema.parse(
      launchInput({ presentation: 'active', nativeLabel: 'Open' }, 'pull-request', [], 'overview'),
    ));
    let settleWrite!: (value: JsonValue) => void;
    let settleRead!: (value: JsonValue) => void;
    nextActionGate = new Promise(resolve => { settleWrite = resolve; });
    nextOverviewGate = new Promise(resolve => { settleRead = resolve; });
    let writing: Promise<void> | undefined;
    let reading: Promise<void> | undefined;
    await act(async () => { writing = shown?.execute('squash'); });
    expect(offered.current?.pending).toBe(true);
    await act(async () => { reading = offered.current?.readRequirements?.(); });
    await act(async () => { settleWrite({ kind: 'uncertain' }); await writing; });
    expect(offered.current?.disabledReason).toEqual(expect.any(String));
    await act(async () => { settleRead(successfulRead); await reading; });
    expect(offered.current?.disabledReason).toEqual(expect.any(String));
    expect(shown?.inputFor?.('squash')).toBeNull();
    expect(recorded.filter(({ action }) => typeof action === 'object' && action !== null
      && 'localId' in action && action.localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMerge)).toHaveLength(1);
  });

  it('offers no settled readiness until the initial overview read finishes', async () => {
    const offered: { current: TriageDetailPrimaryWriteV1 | null } = { current: null };
    let settleRead!: (value: JsonValue) => void;
    nextOverviewGate = new Promise(resolve => { settleRead = resolve; });
    await mountDetail({ presentation: 'active', nativeLabel: 'Open' }, 'pull-request', [], {
      offer: value => { offered.current = value; },
    });
    expect(offered.current).not.toBeNull();
    expect(offered.current?.readiness).toBeUndefined();
    expect(readTriageActivityNextV1(offered.current, false)).toBeNull();
    const successfulRead = overviewFixture(TriageDetailSurfaceInputV1Schema.parse(
      launchInput({ presentation: 'active', nativeLabel: 'Open' }, 'pull-request', [], 'overview'),
    ));
    await act(async () => { settleRead(successfulRead); });
    await vi.waitFor(() => expect(offered.current?.readiness).toBeDefined());
    expect(readTriageActivityNextV1(offered.current, false)).toEqual(expect.any(String));
  });

  it('does not keep reporting a read after an overview settles without operation offers', async () => {
    const launched = TriageDetailSurfaceInputV1Schema.parse(
      launchInput({ presentation: 'active', nativeLabel: 'Open' }, 'pull-request', [], 'overview'),
    );
    const overview = GithubOverviewResultV1Schema.parse(overviewFixture(launched));
    if (overview.kind !== 'overview' || overview.kindId !== 'pull-request' || !overview.pullRequestStatus) {
      throw new Error('Expected native status');
    }
    const { operations: _operations, ...status } = overview.pullRequestStatus;
    nextOverview = projectNativeJsonValueForTransport({ ...overview, pullRequestStatus: status });
    const offered: { current: TriageDetailPrimaryWriteV1 | null } = { current: null };
    await mountDetail({ presentation: 'active', nativeLabel: 'Open' }, 'pull-request', [], {
      offer: value => { offered.current = value; },
    });
    expect(offered.current?.nativeStatus?.kind).toBe('current');
    expect(offered.current?.disabledReason).not.toBe('Reading the current pull request…');
    expect(offered.current?.readiness).toBeUndefined();
  });

  it('offers an unavailable native failure without inventing a successful value or clock', async () => {
    const offered: { current: TriageDetailPrimaryWriteV1 | null } = { current: null };
    const failure = { class: 'permission', code: 'credentials-expired' } as const;
    nextOverview = { kind: 'unavailable', failure };
    await mountDetail({ presentation: 'active', nativeLabel: 'Open' }, 'pull-request', [], {
      offer: (value) => { offered.current = value; },
    });
    await vi.waitFor(() => expect(offered.current).toMatchObject({ nativeStatus: { kind: 'unavailable', failure } }));
    expect(offered.current?.nativeStatus).not.toHaveProperty('checkedAtMs');
    expect(offered.current?.nativeStatus).not.toHaveProperty('value');
  });

  it('reads no exact overview on mount and offers Update Branch only after GitHub reports behind', async () => {
    const detail = await mountDetail({ presentation: 'active', nativeLabel: 'Open' });

    expect(recorded.filter(({ action }) => typeof action === 'object' && action !== null
      && 'localId' in action
      && action.localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview)).toHaveLength(0);
    expect(await detail.queryByRole('button', { name: 'Update branch' })).toBeUndefined();

    await act(async () => {
      await detail.press(await detail.getByRole('button', {
        name: 'Re-read this overview from GitHub',
      }));
    });

    expect(recorded.filter(({ action }) => typeof action === 'object' && action !== null
      && 'localId' in action
      && action.localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview)).toHaveLength(1);
    await expect(detail.getByRole('button', { name: 'Update branch' }))
      .resolves.toMatchObject({ role: 'button' });
  });

  it('does not offer Update Branch when the exact provider overview reports not-behind', async () => {
    nextOverview = {
      ...(nextOverview as Readonly<Record<string, JsonValue>>),
      branchUpdateEligibility: 'not-behind',
    } as JsonValue;
    const detail = await mountDetail({ presentation: 'active', nativeLabel: 'Open' });

    await act(async () => {
      await detail.press(await detail.getByRole('button', {
        name: 'Re-read this overview from GitHub',
      }));
    });

    expect(await detail.queryByRole('button', { name: 'Update branch' })).toBeUndefined();
  });

  it('disables only operations and merge methods GitHub explicitly rules out', async () => {
    nextCapabilities = {
      kind: 'capabilities',
      mergeSettings: { merge: true, squash: false, rebase: true },
      operations: { ...FIXTURE_OPERATIONS },
      mergeMethods: {
        merge: { kind: 'available' },
        squash: { kind: 'unavailable', code: 'repository_unsupported' },
        rebase: { kind: 'available' },
      },
    };
    const enabled = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });
    await vi.waitFor(async () => {
      expect(await enabled.queryByRole('radio', { name: 'Create a merge commit' })).toBeDefined();
    });
    expect(await enabled.queryByRole('radio', { name: 'Squash and merge' })).toBeUndefined();

    nextCapabilities = {
      kind: 'capabilities',
      mergeSettings: { merge: false, squash: false, rebase: false },
      operations: { ...FIXTURE_OPERATIONS },
      mergeMethods: {
        merge: { kind: 'unavailable', code: 'repository_unsupported' },
        squash: { kind: 'unavailable', code: 'repository_unsupported' },
        rebase: { kind: 'unavailable', code: 'repository_unsupported' },
      },
    };
    const noMergeMethod = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });
    expect((await noMergeMethod.getByRole('button', { name: 'Merge pull request' })).state?.disabled)
      .toBe(true);
    expect(await noMergeMethod.queryByText('No enabled merge method has been reported by GitHub.'))
      .toBeDefined();

    nextCapabilities = {
      kind: 'capabilities',
      mergeSettings: { merge: true, squash: true, rebase: true },
      operations: Object.fromEntries(Object.keys(FIXTURE_OPERATIONS)
        .map((key) => [key, { kind: 'denied', code: 'repository_archived' }])),
      mergeMethods: {
        merge: { kind: 'denied', code: 'repository_archived' },
        squash: { kind: 'denied', code: 'repository_archived' },
        rebase: { kind: 'denied', code: 'repository_archived' },
      },
    };
    const denied = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });
    expect((await denied.getByRole('button', { name: 'Merge pull request' })).state?.disabled)
      .toBe(true);
    expect((await denied.getByRole('button', { name: 'Close pull request' })).state?.disabled)
      .toBe(true);
    expect((await denied.getByRole('button', { name: 'Submit review' })).state?.disabled)
      .toBe(true);
  });

  it('keeps independently available review controls when closing is denied', async () => {
    nextCapabilities = {
      kind: 'capabilities',
      mergeSettings: { merge: true, squash: true, rebase: true },
      operations: {
        ...{ ...FIXTURE_OPERATIONS },
        pullRequestClose: { kind: 'unavailable', code: 'repository_unsupported' },
      },
      mergeMethods: {
        merge: { kind: 'available' },
        squash: { kind: 'available' },
        rebase: { kind: 'available' },
      },
    };

    const detail = await mountDetail({ presentation: 'active', nativeLabel: 'Open' });

    await expect(detail.getByRole('button', { name: 'Submit review' }))
      .resolves.toMatchObject({ role: 'button' });
    await expect(detail.getByRole('button', { name: 'Close pull request' }))
      .resolves.toMatchObject({ role: 'button', state: { disabled: true } });
    expect(await detail.queryByText('This repository does not support this change.'))
      .toBeDefined();
  });

  it('lets the confirmed Action report the provider permission failure', async () => {
    nextResult = {
      kind: 'failed',
      failure: { class: 'permission', code: 'github_forbidden' },
    };
    const detail = await mountDetail({ presentation: 'active', nativeLabel: 'Open' });

    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Close pull request' }));
    });

    await expect(detail.getByText('Not carried out'))
      .resolves.toEqual({ content: 'Not carried out' });
    await expect(detail.getByText('GitHub could not complete this change.'))
      .resolves.toEqual({ content: 'GitHub could not complete this change.' });
    await expect(detail.queryByText('GitHub could not complete this change. (github_forbidden)'))
      .resolves.toBeUndefined();
  });

  it('keeps the lifecycle glyph static while merge is pending or refused', async () => {
    let settle!: (value: JsonValue) => void;
    const animation = vi.spyOn(Animated, 'timing');
    const detail = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });
    nextActionGate = new Promise<JsonValue>((resolve) => { settle = resolve; });

    await act(async () => {
      await detail.press(await detail.getByRole('radio', { name: 'Create a merge commit' }));
    });
    const merge = await detail.getByRole('button', { name: 'Merge pull request' });
    const press = detail.press(merge);
    await Promise.resolve();
    expect(animation).not.toHaveBeenCalled();
    settle({ kind: 'refused', reason: 'not_mergeable' });
    await act(async () => { await press; });
    expect(animation).not.toHaveBeenCalled();
  });

  it('keeps the lifecycle glyph static for uncertain and definite dispatch failures', async () => {
    const animation = vi.spyOn(Animated, 'timing');
    const uncertain = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });
    nextResult = { kind: 'uncertain' };
    await act(async () => {
      await uncertain.press(await uncertain.getByRole('radio', { name: 'Create a merge commit' }));
      await uncertain.press(await uncertain.getByRole('button', { name: 'Merge pull request' }));
    });
    expect(animation).not.toHaveBeenCalled();

    const failed = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });
    nextActionError = new PluginError({ code: 'github_unavailable', message: 'GitHub refused the request.' });
    await act(async () => {
      await failed.press(await failed.getByRole('radio', { name: 'Create a merge commit' }));
      await failed.press(await failed.getByRole('button', { name: 'Merge pull request' }));
    });
    expect(animation).not.toHaveBeenCalled();
  });

  it('starts the restrained signature only after an authoritative merged observation arrives', async () => {
    const animation = vi.spyOn(Animated, 'timing');
    const detail = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });

    expect(animation).not.toHaveBeenCalled();
    await act(async () => {
      await detail.press(await detail.getByRole('radio', { name: 'Create a merge commit' }));
      await detail.press(await detail.getByRole('button', { name: 'Merge pull request' }));
    });

    expect(animation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      duration: HAPPIER_MOTION_V1.slowMs,
    }));
    expect((await detail.getByRole('button', { name: 'Merge pull request' })).state?.disabled)
      .toBe(true);
  });

  it('does not celebrate an already-satisfied merge but still reconciles the exact observation', async () => {
    const animation = vi.spyOn(Animated, 'timing');
    nextResult = { kind: 'applied', effect: 'alreadySatisfied', observation: APPLIED_OBSERVATION };
    const detail = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });

    await act(async () => {
      await detail.press(await detail.getByRole('radio', { name: 'Create a merge commit' }));
      await detail.press(await detail.getByRole('button', { name: 'Merge pull request' }));
    });

    expect(animation).not.toHaveBeenCalled();
    expect(completedMutations).toBe(1);
    expect((await detail.getByRole('button', { name: 'Merge pull request' })).state?.disabled)
      .toBe(true);
  });

  it('does not let another entry\'s confirmed merge drive this entry\'s signature', async () => {
    const animation = vi.spyOn(Animated, 'timing');
    nextResult = {
      kind: 'applied',
      effect: 'changed',
      observation: {
        ...APPLIED_OBSERVATION,
        localRef: { ...APPLIED_OBSERVATION.localRef, entryId: '9999' },
      },
    } as JsonValue;
    const detail = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });

    await act(async () => {
      await detail.press(await detail.getByRole('radio', { name: 'Create a merge commit' }));
      await detail.press(await detail.getByRole('button', { name: 'Merge pull request' }));
    });

    expect(animation).not.toHaveBeenCalled();
  });

  it('replaces the confirmed merged glyph immediately when reduced motion is enabled', async () => {
    const animation = vi.spyOn(Animated, 'timing');
    const launch = launchInput({ presentation: 'active', nativeLabel: 'Open' });
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'fixture-instance-203', mountNonce: 'fixture-mount-203' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: (context) => renderSurface(context),
        surfaceContext: createSurfaceContextFixture({ reducedMotion: true }),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        launchInput: launch,
        handlers: { executeAction: async ({ action }) => (
          typeof action === 'object' && action !== null && 'localId' in action
            && action.localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readCapabilities
            ? nextCapabilities
            : typeof action === 'object' && action !== null && 'localId' in action
              && action.localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview
              ? overviewFixture(TriageDetailSurfaceInputV1Schema.parse(launch))
            : nextResult
        ) },
      }) as PluginUiTestkit;
    });
    mounted.push(fixture);
    await vi.waitFor(async () => {
      expect(await fixture.queryByText('Checking repository permissions…')).toBeUndefined();
    });
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Re-read this overview from GitHub' })); });
    await act(async () => {
      await fixture.press(await fixture.getByRole('radio', { name: 'Create a merge commit' }));
      await fixture.press(await fixture.getByRole('button', { name: 'Merge pull request' }));
    });

    expect(animation).not.toHaveBeenCalled();
  });

  it('mounts every approved Overview mutation including canonical review publication', async () => {
    if (nextOverview === null || typeof nextOverview !== 'object' || Array.isArray(nextOverview)) throw new Error('Overview fixture');
    nextOverview = { ...nextOverview, draft: true };
    const detail = await mountDetail(
      { presentation: 'active', nativeLabel: 'Draft' },
      'pull-request',
      [{ sessionId: 'session-review-1', displayTitle: 'Review this pull request' }],
    );
    await waitForPublicationProposalRead(detail);
    await act(async () => {
      await detail.press(await detail.getByRole('button', {
        name: 'Re-read this overview from GitHub',
      }));
    });
    // Reviewers is a property row (github.com's sidebar): its controls open in place.
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Reviewers, None' })); });

    for (const name of [
      'Close pull request',
      'Mark ready for review',
      'Update branch',
      'Request review',
      'Withdraw review requests',
      'Submit review',
      'Publish selected comment',
    ]) {
      await expect(detail.getByRole('button', { name })).resolves.toMatchObject({ role: 'button' });
    }
    expect(await detail.queryByRole('button', { name: 'Merge pull request' })).toBeUndefined();
    await expect(detail.getByRole('textbox', { label: 'Reviewer user logins' }))
      .resolves.toMatchObject({ value: '' });
    await expect(detail.getByRole('textbox', { label: 'Reviewer team slugs' }))
      .resolves.toMatchObject({ value: '' });
    await expect(detail.findByRole('checkbox', { name: 'The implementation is ready to merge.' }))
      .resolves.toMatchObject({ state: { checked: true } });
  });

  it('keeps submit-review inert until its comment verdict has a user-authored summary', async () => {
    const detail = await mountDetail(
      { presentation: 'active', nativeLabel: 'Open' },
      'pull-request',
      [{ sessionId: 'session-review-1', displayTitle: 'Review this pull request' }],
    );
    await waitForPublicationProposalRead(detail);
    await expect(detail.findByRole('checkbox', { name: 'The implementation is ready to merge.' }))
      .resolves.toMatchObject({ state: { checked: true } });
    const submit = await detail.getByRole('button', { name: 'Submit review' });
    expect(submit.state?.disabled).toBe(true);
    await expect(act(async () => { await detail.press(submit); })).rejects.toThrow();
    expect(recorded.filter((entry) => typeof entry.action === 'object')).toHaveLength(0);
  });

  it('keeps approve inert until its separate verdict summary is supplied', async () => {
    const detail = await mountDetail(
      { presentation: 'active', nativeLabel: 'Open' },
      'pull-request',
      [{ sessionId: 'session-review-1', displayTitle: 'Review this pull request' }],
    );
    await waitForPublicationProposalRead(detail);
    await act(async () => {
      await detail.press(await detail.findByRole('radio', { name: 'Approve' }));
    });
    const submit = await detail.getByRole('button', { name: 'Submit review' });
    expect(submit.state?.disabled).toBe(true);
    await expect(act(async () => { await detail.press(submit); })).rejects.toThrow();
    expect(recorded.filter((entry) => typeof entry.action === 'object')).toHaveLength(0);
  });

  it('renders exact partial comment counts and the verdict outcome', async () => {
    const detail = await mountDetail(
      { presentation: 'active', nativeLabel: 'Open' },
      'pull-request',
      [{ sessionId: 'session-review-1', displayTitle: 'Review this pull request' }],
    );
    nextResult = {
      kind: 'settled',
      publication: {
        publicationPlanId: 'P'.repeat(43),
        entries: [
          {
            happierCommentId: 'review-comment-1',
            publicationCorrelationId: 'A'.repeat(43),
            outcome: { kind: 'published', externalRef: '991' },
          },
          {
            happierCommentId: 'review-comment-2',
            publicationCorrelationId: 'B'.repeat(43),
            outcome: { kind: 'uncertain' },
          },
        ],
        verdict: {
          publicationCorrelationId: 'V'.repeat(43),
          outcome: { kind: 'published', externalRef: '990' },
        },
      },
    } as JsonValue;
    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Publish selected comment' }));
    });
    await expect(detail.getByText(
      '1/2 review comments published; 1 unconfirmed; 0 not published. Verdict published.',
    )).resolves.toMatchObject({
      content: '1/2 review comments published; 1 unconfirmed; 0 not published. Verdict published.',
    });
    await expect(detail.getByText('Outcome unknown')).resolves.toMatchObject({
      content: 'Outcome unknown',
    });
  });

  it('labels a known failed publication as partial rather than unknown', async () => {
    const detail = await mountDetail(
      { presentation: 'active', nativeLabel: 'Open' },
      'pull-request',
      [{ sessionId: 'session-review-1', displayTitle: 'Review this pull request' }],
    );
    nextResult = {
      kind: 'settled',
      publication: {
        publicationPlanId: 'P'.repeat(43),
        entries: [{
          happierCommentId: 'review-comment-1',
          publicationCorrelationId: 'A'.repeat(43),
          outcome: { kind: 'failed', code: 'github_unprocessable' },
        }],
        verdict: { kind: 'notRequested' },
      },
    } as JsonValue;
    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Publish selected comment' }));
    });
    await expect(detail.getByText('Review partially published')).resolves.toMatchObject({
      content: 'Review partially published',
    });
    await expect(detail.queryByText('Outcome unknown')).resolves.toBeUndefined();
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

  it('never exposes an opaque Session id when its user-facing title is unavailable', async () => {
    const detail = await mountDetail(
      { presentation: 'active', nativeLabel: 'Open' },
      'issue',
      [{ sessionId: 'session-opaque-7f1c' }],
    );
    await act(async () => {
      await detail.press(await detail.getByRole('tab', { name: 'Work Sessions' }));
    });

    await expect(detail.getByRole('button', { name: 'Open Session' }))
      .resolves.toMatchObject({ role: 'button' });
    await expect(detail.queryByText('session-opaque-7f1c')).resolves.toBeUndefined();
  });

  it('omits unread PR member properties and leaves issue properties to their task owner', async () => {
    const overview = GithubOverviewResultV1Schema.parse(nextOverview);
    if (overview.kind !== 'overview') throw new Error('Expected the known PR fixture');
    const { assignees: _assignees, labels: _labels, ...unread } = overview;
    nextOverview = projectNativeJsonValueForTransport(unread);
    const detail = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });
    await expect(detail.queryByRole('button', { name: 'Assignees' })).resolves.toBeUndefined();
    await expect(detail.queryByRole('button', { name: 'Labels' })).resolves.toBeUndefined();
    expect(document.querySelector('[data-testid="github-pr-assignees"]')).toBeNull();
    expect(document.querySelector('[data-testid="github-pr-labels"]')).toBeNull();
    await expect(detail.queryByRole('textbox', { label: 'Assignee usernames' })).resolves.toBeUndefined();
    await expect(detail.queryByRole('textbox', { label: 'Label names' })).resolves.toBeUndefined();
    // An issue is a Triage task: its Assignees and Labels are the task's own editable properties, never a second editor here.
    const issue = await mountDetail({ presentation: 'active', nativeLabel: 'Open' }, 'issue');
    await expect(issue.queryByRole('button', { name: 'Assignees' })).resolves.toBeUndefined();
    await expect(issue.queryByRole('button', { name: 'Labels' })).resolves.toBeUndefined();
  });

  it.each([
    ['assignees', 'Assignees', 'octocat', 'hubot', 'issueAssigneeAdd', { usernames: ['hubot'] }],
    ['assignees', 'Assignees', 'octocat', 'octocat', 'issueAssigneeRemove', { usernames: ['octocat'] }],
    ['labels', 'Labels', 'bug', 'enhancement', 'issueLabelAdd', { labels: ['enhancement'] }],
    ['labels', 'Labels', 'bug', 'bug', 'issueLabelRemove', { label: 'bug' }],
  ] as const)('PR member picker %s sends the exact %s %s → %s delta', async (property, label, current, member, operation, delta) => {
    withPropertyChoices();
    const detail = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });
    const reads = recorded.length;
    await act(async () => { await detail.press(await detail.getByRole('button', { name: `${label}, ${current}` })); });
    await act(async () => { typePropertySearch(property, member.toUpperCase()); });
    expect(recorded).toHaveLength(reads);
    const choices = await detail.getAllByRole('menuitemcheckbox');
    expect(choices).toHaveLength(1);
    expect(choices[0]!.name).toContain(member);
    await act(async () => { await detail.press(choices[0]!); });
    expect(recorded.slice(reads)).toEqual([{
      action: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1[operation] },
      input: { v: 1, instance: CONFIGURED_INSTANCE,
        localRef: { kindId: 'pull-request', collisionScope: 'github:1296269', entryId: '1284' },
        routingToken: 'octo-org/example-app', ...delta },
    }]);
    await expect(detail.queryByRole('textbox', { label: 'Assignee usernames' })).resolves.toBeUndefined();
    await expect(detail.queryByRole('textbox', { label: 'Label names' })).resolves.toBeUndefined();
    expect(completedMutations).toBe(1);
  });

  it('PR member picker displays a known empty set as None', async () => {
    withPropertyChoices();
    const overview = GithubOverviewResultV1Schema.parse(nextOverview);
    if (overview.kind !== 'overview') throw new Error('Expected an overview fixture');
    nextOverview = projectNativeJsonValueForTransport({ ...overview, assignees: [], labels: [] });
    const detail = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });
    await expect(detail.getByRole('button', { name: 'Assignees, None' })).resolves.toBeDefined();
    await expect(detail.getByRole('button', { name: 'Labels, None' })).resolves.toBeDefined();
  });

  it.each(['failed', 'uncertain', 'rejected'] as const)('PR member picker preserves the current value after a %s settlement', async (kind) => {
    withPropertyChoices();
    nextResult = kind === 'uncertain' ? { kind }
      : { kind: 'failed', failure: { class: 'transient', code: 'github_write_failed' } };
    if (kind === 'rejected') nextActionError = new PluginError('denied', 'This change was not approved.');
    const detail = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Assignees, octocat' })); });
    const choice = (await detail.getAllByRole('menuitemcheckbox')).find(item => item.name?.includes('hubot'))!;
    await act(async () => { await detail.press(choice); });
    await expect(detail.getByRole('button', { name: 'Assignees, octocat' })).resolves.toBeDefined();
    await expect(detail.queryByRole('button', { name: 'Assignees, octocat, hubot' })).resolves.toBeUndefined();
    await expect(detail.getByText(kind === 'uncertain' ? 'Outcome unknown' : 'Not carried out')).resolves.toBeDefined();
  });

  it('PR member picker retries a failed directory without hiding the sibling or changing membership', async () => {
    withPropertyChoices();
    const overview = GithubOverviewResultV1Schema.parse(nextOverview);
    if (overview.kind !== 'overview' || overview.propertyChoices === undefined) throw new Error('Expected choices');
    nextOverview = projectNativeJsonValueForTransport({ ...overview, propertyChoices: { ...overview.propertyChoices,
      assignees: { kind: 'unavailable', failure: { class: 'transient', code: 'github_request_failed' } },
    } });
    const detail = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });
    await expect(detail.getByRole('button', { name: 'Labels, bug' })).resolves.toBeDefined();
    await expect(detail.queryByRole('button', { name: 'Assignees, octocat' })).resolves.toBeUndefined();
    withPropertyChoices();
    const reads = recorded.length;
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Retry' })); });
    expect(recorded.slice(reads)).toMatchObject([{
      action: { localId: GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview }, input: { includePropertyChoices: true },
    }]);
    await expect(detail.getByRole('button', { name: 'Assignees, octocat' })).resolves.toBeDefined();
    expect(completedMutations).toBe(0);
  });

  it('PR member picker reads directories only for the active properties surface and settles missing optional choices once', async () => {
    const story = await mountDetail({ presentation: 'active', nativeLabel: 'Open' }, 'pull-request', [], { offer: () => {} });
    const readInputs = () => recorded.filter(({ action }) => typeof action === 'object' && action !== null
      && 'localId' in action && action.localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview).map(({ input }) => input);
    expect(readInputs()).toHaveLength(1);
    expect(readInputs()[0]).not.toHaveProperty('includePropertyChoices');
    await act(async () => { await story.dispose(); });
    mounted.splice(mounted.indexOf(story), 1);
    const actions = await mountDetail({ presentation: 'active', nativeLabel: 'Open' }, 'pull-request', [], undefined, 'actions');
    await vi.waitFor(() => expect(readInputs()).toHaveLength(2));
    expect(readInputs()[1]).toMatchObject({ includePropertyChoices: true });
    await act(async () => {
      for (let update = 0; update < 3; update++) await actions.updateSurface(createSurfaceContextFixture());
    });
    expect(readInputs()).toHaveLength(2);
    expect(completedMutations).toBe(0);
  });

  it('PR member picker keeps an oversized directory unavailable without offering a futile retry', async () => {
    withPropertyChoices();
    const overview = GithubOverviewResultV1Schema.parse(nextOverview);
    if (overview.kind !== 'overview' || overview.propertyChoices === undefined) throw new Error('Expected choices');
    nextOverview = projectNativeJsonValueForTransport({ ...overview, propertyChoices: { ...overview.propertyChoices,
      assignees: { kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'github_property_choices_response_too_large' } },
    } });
    const detail = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });
    await expect(detail.getByRole('button', { name: 'Labels, bug' })).resolves.toBeDefined();
    await expect(detail.queryByRole('button', { name: 'Assignees, octocat' })).resolves.toBeUndefined();
    expect(document.querySelector('[data-testid="github-pr-assignees"]')?.textContent).toContain('octocat');
    await expect(detail.queryByRole('button', { name: 'Retry' })).resolves.toBeUndefined();
  });

  it('mounts issue publication from one existing canonical proposal without inventing identity', async () => {
    const detail = await mountDetail(
      { presentation: 'active', nativeLabel: 'Open' },
      'issue',
      [{ sessionId: 'session-issue-1', displayTitle: 'Investigate this issue' }],
    );
    await waitForPublicationProposalRead(detail, 'radio');
    await expect(detail.findByRole('radio', { name: 'The implementation is ready to merge.' }))
      .resolves.toMatchObject({ state: { checked: true } });
    await expect(detail.findByRole('button', { name: 'Post selected issue comment' }))
      .resolves.toMatchObject({ role: 'button' });

    nextResult = {
      kind: 'settled',
      publication: {
        publicationPlanId: 'C'.repeat(43),
        entries: [{
          happierCommentId: 'review-comment-1',
          publicationCorrelationId: 'B'.repeat(43),
          outcome: { kind: 'published', externalRef: '701' },
        }],
        verdict: { kind: 'notRequested' },
      },
    } as JsonValue;
    await act(async () => {
      await detail.press(await detail.findByRole('button', { name: 'Post selected issue comment' }));
    });
    expect(recorded.at(-1)).toMatchObject({
      action: {
        pluginId: GITHUB_PLUGIN_ID,
        localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.issueComment,
      },
      input: {
        localRef: { kindId: 'issue', entryId: '1284' },
        publicationPlan: {
          target: { subtarget: null, entryRef: { kindId: 'issue', entryId: '1284' } },
          baseRevision: null,
          headRevision: null,
          entries: [{ happierCommentId: 'review-comment-1' }],
          verdict: null,
        },
      },
    });
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

  it('offers no impossible reopen after the authoritative observation says merged', async () => {
    const detail = await mountDetail({ presentation: 'resolved', nativeLabel: 'Merged' });

    await expect(detail.queryByRole('button', { name: 'Reopen pull request' }))
      .resolves.toBeUndefined();
  });

  it('offers reopen for a completed issue', async () => {
    const detail = await mountDetail(
      { presentation: 'resolved', nativeLabel: 'Closed as completed' },
      'issue',
    );

    await expect(detail.getByRole('button', { name: 'Reopen issue' }))
      .resolves.toMatchObject({ role: 'button' });
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

  it('keeps the standalone merge placement subject to the same source-owned disabled offer', async () => {
    if (nextOverview === null || typeof nextOverview !== 'object' || Array.isArray(nextOverview)) throw new Error('Overview fixture');
    nextOverview = { ...nextOverview, pullRequestStatus: {
      kind: 'status', observedAtMs: 100, checks: null, review: null,
      merge: { state: 'blocked', blocker: 'Required checks pending', nativeState: 'BLOCKED', draft: false },
      branch: { head: 'topic', base: 'main', headRevision: OBSERVED_HEAD }, facts: [],
      operations: { readiness: 'blocked', unmetRequirements: [], alternatives: [], primary: {
        id: 'merge', title: 'Merge', disabledReason: 'Required checks pending',
        actionRef: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMerge },
        variants: [{ id: 'squash', method: { title: 'Squash and merge' }, input: {
          v: 1, instance: CONFIGURED_INSTANCE,
          localRef: { kindId: 'pull-request', collisionScope: 'github:1296269', entryId: '1284' },
          routingToken: 'octo-org/example-app', headRevision: OBSERVED_HEAD, mergeMethod: 'squash',
        } }],
      } },
    } };
    const detail = await mountDetail({ presentation: 'active', nativeLabel: 'Open' });
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Re-read this overview from GitHub' })); });
    const chooser = await detail.queryByRole('radio', { name: 'Squash and merge' });
    if (chooser !== undefined) await act(async () => { await detail.press(chooser); });
    const merge = await detail.getByRole('button', { name: 'Merge pull request' });
    expect(merge.state?.disabled).toBe(true);
    await expect(act(async () => { await detail.press(merge); })).rejects.toThrow();
    expect(recorded.filter(({ action }) => typeof action === 'object' && action !== null
      && 'localId' in action && action.localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMerge)).toHaveLength(0);
  });

  it('sends the head the surface showed and the method the reader chose', async () => {
    const detail = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });

    await act(async () => {
      await detail.press(await detail.getByRole('radio', { name: 'Squash and merge' }));
    });
    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Merge pull request' }));
    });

    expect(recorded.filter(({ action }) => typeof action === 'object' && action !== null
      && 'localId' in action && action.localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMerge)).toEqual([{
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
    const detail = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });

    await act(async () => {
      await detail.press(await detail.getByRole('radio', { name: 'Create a merge commit' }));
    });
    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Merge pull request' }));
    });

    const refusal = GITHUB_WRITE_REFUSAL_COPY_V1.head_advanced.fallback;
    await expect(detail.getByText(refusal)).resolves.toEqual({ content: refusal });
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
    nextActionError = new PluginError({
      code: 'timeout',
      message: 'The Action timed out after dispatch.',
    });

    await act(async () => {
      await detail.press(await detail.getByRole('button', { name: 'Close pull request' }));
    });

    expect(completedMutations).toBe(1);
    expect(recorded).toHaveLength(1);
  });

  it('leaves issue closing to the task status menu', async () => {
    const detail = await mountDetail({ presentation: 'active', nativeLabel: 'Open' }, 'issue');

    await expect(detail.queryByRole('button', { name: 'Merge pull request' }))
      .resolves.toBeUndefined();
    // Completed and Not planned are already source-owned task transitions in
    // the detail header. The source section must not offer a second close flow.
    await expect(detail.queryByRole('button', { name: 'Close issue' }))
      .resolves.toBeUndefined();
    await expect(detail.queryByRole('radio', { name: 'Not planned' }))
      .resolves.toBeUndefined();
    expect(recorded).toEqual([]);
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

/**
 * Write parity (DETAIL-R3): each registered GitHub Action is reachable where github.com keeps it, a property row
 * that opens in place onto its own control. These prove reachability and the exact payload; the Actions' own
 * contracts are proved at their owners.
 */
describe('the GitHub write-parity controls', () => {
  it('does not guess notification or pin state before GitHub has supplied it', async () => {
    const detail = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });
    expect(await detail.queryByRole('switch', { name: 'Subscribed' })).toBeUndefined();
    expect(await detail.queryByRole('switch', { name: 'Pinned to the repository' })).toBeUndefined();
  });

  it('uses the observed subscription and the confirmed result for successive switches', async () => {
    nextOverview = { ...(nextOverview as Record<string, JsonValue>), viewerSubscription: 'SUBSCRIBED' };
    nextResult = { kind: 'applied', effect: 'changed', entry: { id: 'PR_node', subscription: 'UNSUBSCRIBED' } };
    const detail = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });
    expect((await detail.getByRole('switch', { name: 'Subscribed' })).state?.checked).toBe(true);
    await act(async () => { await detail.press(await detail.getByRole('switch', { name: 'Subscribed' })); });
    expect((await detail.getByRole('switch', { name: 'Subscribed' })).state?.checked).toBe(false);
    nextResult = { kind: 'applied', effect: 'changed', entry: { id: 'PR_node', subscription: 'SUBSCRIBED' } };
    await act(async () => { await detail.press(await detail.getByRole('switch', { name: 'Subscribed' })); });
    expect((await detail.getByRole('switch', { name: 'Subscribed' })).state?.checked).toBe(true);
    expect(recorded.filter(({ action }) => typeof action === 'object' && action !== null && 'localId' in action
      && (action.localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.entryUnsubscribe
        || action.localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.entrySubscribe)).map(({ action }) => action)).toEqual([
      { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.entryUnsubscribe },
      { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.entrySubscribe },
    ]);
  });

  it('retains the observed subscription when GitHub refuses the change', async () => {
    nextOverview = { ...(nextOverview as Record<string, JsonValue>), viewerSubscription: 'SUBSCRIBED' };
    nextResult = { kind: 'failed', failure: { class: 'permission', code: 'github_permission_denied' } };
    const detail = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });
    await act(async () => { await detail.press(await detail.getByRole('switch', { name: 'Subscribed' })); });
    expect((await detail.getByRole('switch', { name: 'Subscribed' })).state?.checked).toBe(true);
    expect(recorded.some(({ action }) => typeof action === 'object' && action !== null && 'localId' in action
      && action.localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.entryUnsubscribe)).toBe(true);
  });

  // A property row is named by its title and states its current value after it.
  async function openRow(detail: PluginUiTestkit, name: string): Promise<void> {
    const rows = await detail.getAllByRole('button');
    const row = rows.find((candidate) => candidate.name === name || candidate.name?.startsWith(`${name},`)
      || candidate.name?.startsWith(`${name} `));
    if (row === undefined) throw new Error(`no ${name} row in ${JSON.stringify(rows.map((candidate) => candidate.name))}`);
    await act(async () => { await detail.press(row); });
  }

  it('converts an open ready pull request to a draft with only its target', async () => {
    const detail = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Convert to draft' })); });

    const write = recorded.find(({ action }) => typeof action === 'object' && action !== null && 'localId' in action
      && action.localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestConvertToDraft);
    expect(write?.input).toEqual({
      v: 1, instance: CONFIGURED_INSTANCE,
      localRef: { kindId: 'pull-request', collisionScope: 'github:1296269', entryId: '1284' },
      routingToken: 'octo-org/example-app',
    });
  });

  it('opens the title and description editor on the current GitHub text, not the rendered Markdown', async () => {
    const detail = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' });
    await openRow(detail, 'Title and description');

    await expect(detail.getByRole('textbox', { label: 'Title' }))
      .resolves.toMatchObject({ value: 'Consolidate the duplicated normalizer' });
    await expect(detail.getByRole('textbox', { label: 'Description' }))
      .resolves.toMatchObject({ value: 'Keeps one normalization owner.' });
    // Nothing changed yet, so there is nothing to save.
    expect((await detail.getByRole('button', { name: 'Save changes' })).state?.disabled).toBe(true);
  });

  it('clears an issue milestone through the milestone row', async () => {
    nextOverview = {
      kind: 'overview', kindId: 'issue', observedAtMs: 1_760_000_800_000, title: 'Normalizer drops a field',
      state: 'open', labels: [], assignees: [], milestone: 'v1.2', milestoneNumber: 3, issueType: 'Bug', locked: false,
    };
    const detail = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' }, 'issue');
    await openRow(detail, 'Milestone');
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Clear milestone' })); });

    const write = recorded.find(({ action }) => typeof action === 'object' && action !== null && 'localId' in action
      && action.localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.entryMilestoneSet);
    expect(write?.input).toMatchObject({ milestone: null });
  });

  it('locks an unlocked conversation without inventing a reason', async () => {
    nextOverview = {
      kind: 'overview', kindId: 'issue', observedAtMs: 1_760_000_800_000, title: 'Normalizer drops a field',
      state: 'open', labels: [], assignees: [], milestone: null, milestoneNumber: null, locked: false,
    };
    const detail = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' }, 'issue');
    await openRow(detail, 'Conversation');
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Lock conversation' })); });

    const write = recorded.find(({ action }) => typeof action === 'object' && action !== null && 'localId' in action
      && action.localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.entryLock);
    expect(write?.input).not.toHaveProperty('reason');
  });

  it('deletes a merged pull request\'s source branch at the head the reader saw', async () => {
    nextOverview = { ...(nextOverview as Record<string, JsonValue>), state: 'closed', merged: true };
    const detail = await mountWritableDetail({ presentation: 'resolved', nativeLabel: 'Merged' });
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Delete branch' })); });

    const write = recorded.find(({ action }) => typeof action === 'object' && action !== null && 'localId' in action
      && action.localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestHeadBranchDelete);
    expect(write?.input).toMatchObject({ headRevision: OBSERVED_HEAD });
  });

  it('offers an issue its relationships and a pull request its closing references', async () => {
    nextOverview = {
      kind: 'overview', kindId: 'issue', observedAtMs: 1_760_000_800_000, title: 'Normalizer drops a field',
      state: 'open', labels: [], assignees: [], milestone: null, milestoneNumber: null, locked: false,
    };
    const issue = await mountWritableDetail({ presentation: 'active', nativeLabel: 'Open' }, 'issue');
    for (const name of ['Sub-issues', 'Blocked by', 'Blocking', 'Linked pull requests']) {
      await openRow(issue, name);
    }
    for (const name of ['Add sub-issue', 'Remove sub-issue', 'Add blocker', 'Remove blocker',
      'Add blocked issue', 'Remove blocked issue', 'Link pull request', 'Unlink pull request']) {
      await expect(issue.getByRole('button', { name })).resolves.toMatchObject({ role: 'button' });
    }
  });
});
