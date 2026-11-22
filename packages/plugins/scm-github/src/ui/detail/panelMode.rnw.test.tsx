// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createHash } from 'node:crypto';
import { Button, defineUiSurface, Tabs, Text, type MarkdownProps } from '@happier-dev/plugin-ui';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiPageNavigationV1 } from '@happier-dev/plugin-sdk/ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TriageActivityAgentProvider, TriageDetailPanelNavigationProvider, TriageEvidenceDisclosureProvider, type TriageDetailPanelNavigationV1, type TriageDetailPrimaryWriteV1 } from '@happier-dev/triage-sources/ui';
import { projectGithubRepositoryCapabilities } from '../../triage/capabilities.js';
import { GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from '../../triage/contribution.js';
import { activate, activateAccount } from '../../activate.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { encodeGithubTriageConfiguration } from '../../triage/configuration.js';
import { createStubGithubTransport } from '../../triage/testkit/githubTriage.test-support.js';
import { GITHUB_PULL_REQUEST_RESPONSE } from '../../triage/__fixtures__/githubResponses.js';
import { readGithubOverview } from '../../triage/detailOperations.js';
import { GithubOverviewResultV1Schema } from '../../triage/detail/contracts.js';
import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';

import {
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
} from '../../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 } from '../../triage/contribution.js';

import { renderSurface } from '../renderSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

/**
 * (Fixture shared in shape with the Checks Session-start test.)
 * The mounted Checks plane's Session-start boundary (`core/SESSIONS.md` §1).
 *
 * The Triage common header is the sole source-neutral Session-intent owner,
 * and the canonical configurable action path lives in the aggregate's detail
 * region right beside this body. A source detail body therefore mounts zero
 * Session-start controls: it shows GitHub's own facts and nothing that starts,
 * seeds or opens a Session. This test pins that boundary on the one plane that
 * historically carried a provider-local "Fix CI" shortcut, and would catch its
 * reintroduction in any other plane's clothes.
 */

const SOURCE_CONTRIBUTION = Object.freeze({
  pluginId: GITHUB_PLUGIN_ID,
  localId: 'github-forge',
});

const HEAD_REVISION = '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29';

function launchInput(): JsonValue {
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
      configuration: { v: 1, token: encodeGithubTriageConfiguration({ v: 1,
        scope: { kind: 'repository', repositoryKey: 'octo-org/example-app' } })! },
    },
    observation: {
      entryRef: {
        source: SOURCE_CONTRIBUTION,
        kindId: 'pull-request',
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
        state: { presentation: 'active', nativeLabel: 'Open' },
        facts: [],
        reviewRevision: { baseSha: 'a'.repeat(40), headSha: HEAD_REVISION, nativeRevision: HEAD_REVISION },
      },
      viewer: { involvement: [] },
    },
    linkedSessions: [],
  } as JsonValue;
}

/** The failing-check read answer, carrying exactly the evidence a reader sees. */
function failingChecksAnswer(): JsonValue {
  return {
    kind: 'checks',
    rowState: { kind: 'failing', failingCount: 1 },
    headRevision: HEAD_REVISION,
    state: 'resolved',
    rows: [{
      key: 'github-check-run:9003',
      resourceKind: 'check-run',
      name: 'build',
      status: 'completed',
      conclusion: 'failure',
      logExcerpt: 'Typecheck found 2 errors in src/pump.ts.',
    }],
    failingCount: 1,
    runningCount: 0,
    passingCount: 0,
    omittedRowCount: 0,
    projectionTruncated: false,
  } as JsonValue;
}

/** Keep unrelated capability failures out of an Overview refusal case. */
function readableCapabilitiesAnswer(): JsonValue {
  return { kind: 'capabilities', ...projectGithubRepositoryCapabilities({
    kind: 'readable', repositoryId: '1296269', repositoryKey: 'octo-org/example-app',
    mergeSettings: { merge: true, squash: false, rebase: null }, archived: false, hasIssues: true,
  }) };
}

/** GitHub's own pull request, as the exact overview read states it. */
function overviewAnswer(): JsonValue {
  return {
    kind: 'overview',
    kindId: 'pull-request',
    observedAtMs: 1_760_000_800_000,
    title: 'Consolidate the duplicated normalizer',
    state: 'open',
    author: 'octocat',
    createdAtMs: 1_759_990_000_000,
    body: 'Moves rounding to the pricing service.',
    labels: ['performance'],
    assignees: ['hubot'],
    milestone: 'August',
    headBranch: 'frame-pump',
    baseBranch: 'main',
    requestedReviewers: [{ kind: 'user', subject: 'monalisa' }],
    headRevision: HEAD_REVISION,
    additions: 388,
    deletions: 142,
    changedFiles: 17,
    branchUpdateEligibility: 'not-behind',
  } as JsonValue;
}

/** The canonical HTTP testkit runs the actual native-status and operation producer. */
async function withNativeOverviewStatus(answer: JsonValue, checks: JsonValue = failingChecksAnswer()): Promise<JsonValue> {
  const parsed = GithubOverviewResultV1Schema.safeParse(answer);
  if (!parsed.success || parsed.data.kind !== 'overview' || parsed.data.kindId !== 'pull-request'
    || parsed.data.pullRequestStatus !== undefined) return answer;
  const overview = parsed.data;
  const launch = TriageDetailSurfaceInputV1Schema.parse(launchInput());
  const stub = createStubGithubTransport({ respond: request => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/pulls/1284')) return { status: 200, body: { ...GITHUB_PULL_REQUEST_RESPONSE,
      state: overview.state ?? 'open', merged: overview.merged ?? false, draft: overview.draft ?? false,
      mergeable: overview.mergeable ?? null, mergeable_state: overview.mergeableState ?? 'unknown',
      head: { ...GITHUB_PULL_REQUEST_RESPONSE.head, sha: HEAD_REVISION },
      base: { ...GITHUB_PULL_REQUEST_RESPONSE.base, repo: { ...GITHUB_PULL_REQUEST_RESPONSE.base.repo, id: 1296269 } },
    } };
    if (path.includes('/rules/branches/')) return { status: 200, body: [] };
    if (path === '/graphql') return { status: 200, body: { data: { repository: {
      isArchived: false, mergeCommitAllowed: true, squashMergeAllowed: false, rebaseMergeAllowed: false,
      pullRequest: { headRefOid: HEAD_REVISION, reviewDecision: 'APPROVED',
        mergeStateStatus: overview.draft ? 'DRAFT' : (overview.mergeableState ?? 'unknown').toUpperCase(),
        commits: { nodes: [{ commit: { oid: HEAD_REVISION, statusCheckRollup: null } }] },
      },
    } } } };
    return undefined;
  } });
  const { kindId, collisionScope, entryId } = launch.observation.entryRef;
  const native = GithubOverviewResultV1Schema.parse(await readGithubOverview({ v: 1, instance: launch.instance,
    localRef: { kindId, collisionScope, entryId }, routingToken: launch.observation.locator.routingToken }, stub.context));
  if (native.kind !== 'overview' || native.kindId !== 'pull-request') throw new Error('Expected native PR fixture');
  // The Overview Action states the detail's checks from its own rollup read (detailOperations owns that producer).
  const { kind: _checksKind, ...checksView } = checks as Record<string, JsonValue>;
  return projectNativeJsonValueForTransport({ ...overview, pullRequestStatus: native.pullRequestStatus,
    ...(overview.checks === undefined && _checksKind === 'checks' ? { checks: checksView } : {}) });
}

const overviewReads: string[] = [];

function emptyFeedbackAnswer(kind: string): JsonValue {
  return { kind, rows: [] } as JsonValue;
}

const mounted: PluginUiTestkit[] = [];

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
  overviewReads.splice(0);
});

/**
 * Panel mode (r0.42): the Triage detail frame owns the tab strip and asks this
 * body for exactly one panel. The body renders that panel and no tab strip of
 * its own, and its Overview panel is the story rail's source half.
 */
async function mountPanel(panel: string | (() => string), options: Readonly<{
  direct?: boolean;
  admittedReview?: () => Readonly<{ reviewId: string; roundOrdinal: number }> | undefined;
  openedResources?: unknown[];
  navigation?: Array<PluginUiPageNavigationV1 | null>;
  reads?: string[];
  renderMarkdown?: (input: MarkdownProps) => React.ReactElement;
  visible?: () => boolean;
  refreshGeneration?: () => number;
  readCapabilities?: (signal: AbortSignal) => Promise<JsonValue>;
  invokeRead?: (localId: string, input: unknown, signal: AbortSignal) => Promise<JsonValue>;
  rejectRead?: (localId: string) => PluginError | undefined;
  feedback?: (connection: string) => JsonValue | Promise<JsonValue>;
  timeline?: (continuation: string | undefined) => JsonValue | Promise<JsonValue>;
  checks?: JsonValue;
  overview?: JsonValue | Promise<JsonValue>;
  translations?: Readonly<Record<string, string>>;
  primaryWrites?: Array<TriageDetailPrimaryWriteV1 | null>;
  primaryValue?: TriageDetailPrimaryWriteV1 | null;
  writes?: Array<{ localId: string; input: unknown }>;
  /** The Triage frame's panel selection, as its detail body installs it around the source. */
  panelNavigation?: TriageDetailPanelNavigationV1;
  /** Answers one Action before the defaults (a CI write, a changed-files page); `undefined` falls through. */
  onAction?: (localId: string, input: unknown) => JsonValue | undefined;
  changedFilesReview?: boolean;
}> = {}): Promise<PluginUiTestkit> {
  let detail!: PluginUiTestkit;
  const offerPrimaryWrite = (write: TriageDetailPrimaryWriteV1 | null) => { options.primaryWrites?.push(write); };
  await act(async () => {
    detail = await createPluginUiTestkit({
      identity: { instanceId: `fixture-instance-panel-${panel}`, mountNonce: `fixture-mount-panel-${panel}` },
      authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      surface: defineUiSurface((context) => {
        const body = renderSurface({ ...context, launchInput: {
          ...(context.launchInput as Record<string, JsonValue>),
          ...(typeof panel === 'function' ? { panel: panel() } : {}),
          ...(options.admittedReview === undefined ? {} : { admittedReview: options.admittedReview() }),
        } });
        // The SDK artifact boundary returns an opaque UI element; the RNW host requires a real React element.
        if (body !== null && !React.isValidElement(body)) throw new Error('Expected a React-native author surface');
        const content = body === null || options.renderMarkdown === undefined ? body
          : React.cloneElement(body as React.ReactElement<{ presentationHost?: unknown }>, {
            presentationHost: { renderMarkdown: options.renderMarkdown, renderIcon: () => null },
          });
        const offered = options.primaryWrites === undefined && options.primaryValue === undefined ? content : <TriageEvidenceDisclosureProvider disclosure={{
          available: false, disclose: async () => ({ kind: 'inert' }),
          primaryWrite: { value: options.primaryValue, offer: offerPrimaryWrite },
        }}>{options.primaryValue == null ? null : <Button title={options.primaryValue.title}
          disabled={options.primaryValue.disabledReason !== null} busy={options.primaryValue.pending}
          onPress={() => { void options.primaryValue?.execute(); }} />}{content}</TriageEvidenceDisclosureProvider>;
        const activity = options.refreshGeneration === undefined ? offered : <TriageActivityAgentProvider
          value={{ events: [], tail: null, refreshGeneration: options.refreshGeneration() }}>{offered}</TriageActivityAgentProvider>;
        const framed = options.panelNavigation === undefined ? activity
          : <TriageDetailPanelNavigationProvider navigation={options.panelNavigation}>{activity}</TriageDetailPanelNavigationProvider>;
        return options.visible === undefined ? framed : <Tabs value={options.visible() ? 'source' : 'session'}
          onValueChange={() => {}} ariaLabel="Detail planes" tabList="host">
          <Tabs.Item value="source" title="Source" retention="retain">{framed}</Tabs.Item>
          <Tabs.Item value="session" title="Session" />
        </Tabs>;
      }),
      surfaceContext: createSurfaceContextFixture(options.translations === undefined ? {} : {
        locale: 'fr', translations: options.translations,
      }),
      // With `changedFilesReview`, the host's review as its semantic stand-in: Files opens and reads a file as the host does.
      adapter: createPluginUiRnwSemanticSurfaceAdapter(options.changedFilesReview === true ? { changedFilesReview: true } : {}),
      launchInput: { ...(launchInput() as Record<string, JsonValue>), ...(options.direct ? {} : { panel: typeof panel === 'string' ? panel : panel() }) } as JsonValue,
      handlers: {
        openResource: ({ resource }) => { options.openedResources?.push(resource); },
        readResource: async ({ resource }) => {
          if (typeof resource === 'string' || !('hostRead' in resource) || resource.hostRead !== 'review.get')
            throw new PluginError({ code: 'unsupported_method' });
          options.reads?.push('review.get');
          const refusal = options.rejectRead?.('review.get');
          if (refusal) throw refusal;
          const answer = options.onAction?.('review.get', resource.input);
          if (answer === undefined) throw new PluginError({ code: 'unavailable' });
          const value = JSON.stringify(answer);
          const bytes = new TextEncoder().encode(value);
          return { contentType: 'application/json', bytes, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
        },
        watchResource: async ({ resource }) => {
          if (typeof resource === 'string' || !('hostRead' in resource) || resource.hostRead !== 'review.get')
            throw new PluginError({ code: 'unsupported_method' });
          // A real host acknowledges the current digest before it can push an invalidation.
          const value = JSON.stringify(options.onAction?.('review.get', resource.input));
          if (value === undefined) throw new PluginError({ code: 'unavailable' });
          return { digest: `sha256:${createHash('sha256').update(value).digest('hex')}` };
        },
        ...(options.navigation === undefined ? {} : { setPageNavigation: ({ navigation }: { navigation: PluginUiPageNavigationV1 | null }) => { options.navigation?.push(navigation); } }),
        executeAction: async ({ action, input, signal }) => {
          if (action === 'shell.column.set') {
            const descriptor = options.navigation?.at(-1);
            if (!descriptor) throw new Error('Expected the published page navigation');
            await detail.updateSurface(createSurfaceContextFixture({ page: { columnVisible: true,
              navigation: { pageKind: descriptor.pageKind, presentation: 'top',
                tabIds: descriptor.items.map(item => item.value), request: (input as { tab: string }).tab },
            } }));
            return null;
          }
          const localId = typeof action === 'string' ? action : action.localId;
          options.reads?.push(localId);
          const answered = options.onAction?.(localId, input);
          if (answered !== undefined) return answered;
          const refusal = options.rejectRead?.(localId);
          if (refusal !== undefined) throw refusal;
          if (options.invokeRead && (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readCapabilities
            || localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview)) return options.invokeRead(localId, input, signal);
          if (localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMerge || localId === GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMarkReady) {
            options.writes?.push({ localId, input });
            return { kind: 'refused', reason: 'state_changed' };
          }
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readCapabilities && options.readCapabilities !== undefined) return await options.readCapabilities(signal);
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback && options.feedback !== undefined) {
            return options.feedback((input as { connection: string }).connection);
          }
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listTimeline && options.timeline !== undefined) {
            return options.timeline((input as { continuation?: string }).continuation);
          }
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readChecks) return options.checks ?? failingChecksAnswer();
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview) {
            overviewReads.push(localId);
            return withNativeOverviewStatus(await (options.overview ?? overviewAnswer()), options.checks ?? failingChecksAnswer());
          }
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listTimeline) return {
            kind: 'timeline',
            rows: [{ id: 'timeline-1', kind: 'unsupported', rawKind: 'provider-specific-event', actor: 'Mara', summary: 'Source-only timeline record.' }],
            omittedRowCount: 0, projectionTruncated: false,
          } as JsonValue;
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles) {
            return {
              kind: 'changedFiles',
              rows: [
                { path: 'src/cart/totals.ts', status: 'modified', additions: 96, deletions: 71, changes: 167, diffAvailable: true },
                { path: 'README.md', status: 'modified', additions: 1, deletions: 0, changes: 1, diffAvailable: true },
              ],
              omittedRowCount: 0,
              projectionTruncated: false,
            } as JsonValue;
          }
          return { kind: 'unavailable', failure: { class: 'transient', code: 'not-under-test' } } as JsonValue;
        },
      },
    });
  });
  mounted.push(detail);
  return detail;
}

describe('the GitHub detail as Triage panels', () => {
  it.each([false, true])('shows the exact admitted Happier Review on the ordinary PR overview (direct=%s)', async direct => {
    const openedResources: unknown[] = [];
    const reads: unknown[] = [];
    let needsDecision = 3;
    const verdict = direct ? '3 constats à trancher' : '3 findings to decide';
    const count = direct ? '7 constats' : '7 findings';
    const needsYou = direct ? 'Besoin de vous' : 'Needs you';
    const decided = direct ? 'Tous les constats sont tranchés' : 'Every finding is decided';
    const open = direct ? 'Ouvrir la revue' : 'Open review';
    const fixture = await mountPanel('overview', { direct, openedResources,
      ...(direct ? { translations: {
        'happier.plugin-ui.review.glance.toDecide.other': '{count} constats à trancher',
        'happier.plugin-ui.review.glance.findingsCount.other': '{count} constats',
        'happier.plugin-ui.review.glance.allDecided': decided,
        'happier.plugin-ui.review.glance.quality': 'Qualité {score}/5',
        'happier.plugin-ui.review.glance.reviewerScores': 'Notes des réviseurs : {scores}',
        'happier.plugin-ui.workStatus.needsYou': needsYou,
        'happier.plugin-ui.review.open': open,
      } } : {}),
      admittedReview: () => ({ reviewId: 'owned-pr-review', roundOrdinal: 1 }),
      onAction: (id, input) => {
        if (id !== 'review.get') return undefined;
        reads.push(input);
        return { review: { reviewId: 'owned-pr-review', state: 'completed', counts: { total: 7, needsDecision } },
          human: { needsYou: { needsYou: true } },
          roundQuality: { roundOrdinal: 1, aggregation: 'median', score: 3.5, reviewers: [{ displayName: 'Claude', score: 2 }, { displayName: 'Codex', score: 5 }] } };
      },
    });
    await expect(fixture.getByText(verdict)).resolves.toBeDefined();
    await expect(fixture.getByText(count)).resolves.toBeDefined();
    await expect(fixture.getByText(needsYou)).resolves.toBeDefined();
    await expect(fixture.getByText(direct ? 'Qualité 3/5' : 'Quality 3/5')).resolves.toBeDefined();
    await expect(fixture.getByText(direct ? 'Notes des réviseurs : Claude 2, Codex 5' : 'Reviewer scores: Claude 2, Codex 5')).resolves.toBeDefined();
    expect(new Set(reads.map(input => JSON.stringify(input)))).toEqual(new Set([JSON.stringify({ reviewId: 'owned-pr-review' })]));
    needsDecision = 0;
    await act(async () => { fixture.invalidateResource({ hostRead: 'review.get', input: { reviewId: 'owned-pr-review' } }, `sha256:${'d'.repeat(64)}`); });
    await expect(fixture.getByText(decided)).resolves.toBeDefined();
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: open })); });
    expect(openedResources).toEqual([{ kind: 'artifact', artifactId: 'owned-pr-review' }]);
  });

  it('does not scan Reviews when this PR has no admitted Review relation', async () => {
    const reads: string[] = [];
    const fixture = await mountPanel('overview', { reads });
    expect(reads).not.toContain('review.get');
    expect(reads).not.toContain('reviews.list');
    expect(await fixture.queryAllByRole('button', { name: 'Open review' })).toHaveLength(0);
  });

  it('clears the prior Review on relation replacement and retries through the page refresh when refused', async () => {
    let reviewId = 'first-pr-review';
    let refused = true;
    let refreshGeneration = 0;
    const fixture = await mountPanel('overview', {
      refreshGeneration: () => refreshGeneration,
      admittedReview: () => ({ reviewId, roundOrdinal: 1 }),
      rejectRead: id => id === 'review.get' && reviewId === 'second-pr-review' && refused
        ? new PluginError({ code: 'permission_denied', message: 'Review access was withdrawn', retryable: false }) : undefined,
      onAction: id => id === 'review.get' && !(reviewId === 'second-pr-review' && refused)
        ? { review: { reviewId, state: 'completed', counts: { total: 7, needsDecision: 3 } }, human: { needsYou: { needsYou: false } } }
        : undefined,
    });
    await expect(fixture.getByText('3 findings to decide')).resolves.toBeDefined();
    reviewId = 'second-pr-review';
    await act(async () => { await fixture.updateSurface(createSurfaceContextFixture()); });
    expect(await fixture.queryByText('3 findings to decide')).toBeUndefined();
    await expect(fixture.getByText('This review didn’t open')).resolves.toBeDefined();
    refused = false;
    refreshGeneration++;
    await act(async () => { await fixture.updateSurface(createSurfaceContextFixture()); });
    await expect(fixture.getByText('3 findings to decide')).resolves.toBeDefined();
  });

  it('publishes direct page Items, honors saved strip order and selects the real Files body from the phone host', async () => {
    const navigation: Array<PluginUiPageNavigationV1 | null> = [];
    const reads: string[] = [];
    const fixture = await mountPanel('overview', { direct: true, navigation, reads, changedFilesReview: true });
    const pageKind = { pluginId: GITHUB_PLUGIN_ID, localId: 'github-detail/pull-request' };
    expect(navigation.at(-1)).toMatchObject({ pageKind, value: 'overview' });
    expect(reads).not.toContain(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles);
    expect(reads).not.toContain(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readChecks);
    await act(async () => { await fixture.updateSurface(createSurfaceContextFixture({ page: { columnVisible: true,
      navigation: { pageKind, presentation: 'top', tabIds: ['files', 'overview'] },
    } })); });
    expect((await fixture.getAllByRole('tab')).map(tab => tab.name)).toEqual(['Files', 'Overview']);
    await act(async () => { await fixture.press(await fixture.getByRole('tab', { name: 'Files' })); });
    expect((await fixture.queryAllByRole('button')).filter(button => button.name?.includes('src/cart/totals.ts'))).not.toHaveLength(0);
    expect(navigation.at(-1)).toMatchObject({ value: 'files' });
    const fileReads = reads.filter(id => id === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles).length;
    await act(async () => { await fixture.updateSurface(createSurfaceContextFixture({ platform: 'ios', page: { columnVisible: true,
      navigation: { pageKind, presentation: 'bottom', tabIds: [], request: 'timeline' },
    } })); });
    expect(await fixture.queryAllByRole('tab')).toHaveLength(0);
    expect(navigation.at(-1)).toMatchObject({ value: 'timeline' });
    await expect(fixture.getByText('Source-only timeline record.')).resolves.toBeDefined();
    expect((await fixture.queryAllByRole('button')).filter(button => button.name?.includes('src/cart/totals.ts'))).toHaveLength(0);
    expect(reads.filter(id => id === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles)).toHaveLength(fileReads);
    expect(reads).not.toContain(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readChecks);
    await act(async () => { await fixture.updateSurface(createSurfaceContextFixture({ platform: 'ios', page: { columnVisible: true } })); });
    expect((await fixture.getAllByRole('tab')).map(tab => tab.name)).toEqual(['Overview', 'Timeline', 'Files', 'Checks', 'Feedback']);
    await expect(fixture.getByText('Source-only timeline record.')).resolves.toBeDefined();
  });

  it('leaves the outer page descriptor with Triage when rendering its source panel', async () => {
    const navigation: Array<PluginUiPageNavigationV1 | null> = [];
    const fixture = await mountPanel('files', { navigation, changedFilesReview: true });
    expect(navigation).toEqual([]);
    expect(await fixture.queryAllByRole('tab')).toHaveLength(0);
    expect((await fixture.queryAllByRole('button')).filter(button => button.name?.includes('src/cart/totals.ts'))).not.toHaveLength(0);
  });

  it.each([null, 'hasIssuesEnabled', 'isArchived', 'mergeCommitAllowed'] as const)('shares complete summary capabilities on fresh detail and keeps REST for unknown parity (missing=%s)', async missing => {
    const stub = createStubGithubTransport({ respond: request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/pulls/1284')) return { status: 200, body: { ...GITHUB_PULL_REQUEST_RESPONSE,
        base: { ...GITHUB_PULL_REQUEST_RESPONSE.base, repo: { ...GITHUB_PULL_REQUEST_RESPONSE.base.repo, id: 1296269 } },
      } };
      if (path === '/repos/octo-org/example-app') return { status: 200, body: {
        id: 1296269, full_name: 'octo-org/example-app', archived: false, has_issues: false,
        allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: true,
      } };
      if (path === '/graphql') return { status: 200, body: { data: { repository: {
        isArchived: missing === 'isArchived' ? undefined : false,
        hasIssuesEnabled: missing === 'hasIssuesEnabled' ? undefined : false,
        mergeCommitAllowed: missing === 'mergeCommitAllowed' ? undefined : true,
        squashMergeAllowed: false, rebaseMergeAllowed: true,
        pullRequest: { headRefOid: HEAD_REVISION, reviewDecision: 'APPROVED',
          commits: { nodes: [{ commit: { oid: HEAD_REVISION, statusCheckRollup: null } }] },
        },
      } } } };
      return undefined;
    } });
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: stub.context.services.http, connectedAccounts: stub.context.services.connectedAccounts,
    } });
    let detail: PluginUiTestkit | undefined;
    try {
      detail = await mountPanel('overview', { invokeRead: async (localId, input, signal) =>
        // The UI Action transport is the system boundary; registration and GitHub readers remain real.
        await kit.invokeAction(localId, input as JsonValue, { signal }) as JsonValue,
      });
      const current = detail;
      await act(async () => {
        await vi.waitFor(() => expect(stub.requests.some(request => new URL(request.url).pathname === '/graphql')).toBe(true));
        await current.updateSurface(createSurfaceContextFixture());
      });
      expect(stub.requests.filter(request => new URL(request.url).pathname === '/repos/octo-org/example-app')).toHaveLength(missing === null ? 0 : 1);
      expect(stub.requests).toHaveLength(missing === null ? 2 : 3); // PR REST stays for mergeable_state.
    } finally {
      if (detail !== undefined) {
        const current = detail;
        await act(async () => { await current.dispose(); });
        mounted.splice(mounted.indexOf(current), 1);
      }
      await kit.dispose();
    }
  });

  it('keeps the header write at detail lifetime without another Overview read when panels change or the body hides', async () => {
    const offered: Array<TriageDetailPrimaryWriteV1 | null> = [];
    const writes: Array<{ localId: string; input: unknown }> = [];
    let panel = 'files';
    let visible = true;
    let capabilitiesReads = 0;
    let resolveOverview!: (value: JsonValue) => void;
    const overview = new Promise<JsonValue>((resolve) => { resolveOverview = resolve; });
    const detail = await mountPanel(() => panel, { primaryWrites: offered, writes, overview, visible: () => visible,
      readCapabilities: async () => {
        capabilitiesReads += 1;
        return { kind: 'capabilities', ...projectGithubRepositoryCapabilities({
          kind: 'readable', repositoryId: '1296269', repositoryKey: 'octo-org/example-app',
          mergeSettings: { merge: true, squash: false, rebase: null }, archived: false, hasIssues: true,
        }) };
      },
    });
    // The header remains visible while a sibling (for example Session) owns the body.
    visible = false;
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    await act(async () => { resolveOverview({ ...(overviewAnswer() as Record<string, JsonValue>),
      draft: false, mergeable: true, mergeableState: 'clean' }); });
    expect(offered.at(-1)).toMatchObject({ title: 'Merge', disabledReason: null, pending: false });
    visible = true;
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    for (const next of ['checks', 'activity', 'overview', 'files']) {
      const before = offered.length;
      panel = next;
      await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
      expect(offered.at(-1)).toMatchObject({ title: 'Merge', disabledReason: null });
      expect(offered.slice(before)).not.toContain(null);
      expect(overviewReads).toHaveLength(1);
      expect(capabilitiesReads).toBe(1);
    }
    const write = offered.at(-1);
    if (!write) throw new Error('Expected a detail-owned primary write');
    visible = false;
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    await act(async () => { await write.execute('merge'); });
    expect(writes).toHaveLength(1);
    await act(async () => { await detail.dispose(); });
    mounted.splice(mounted.indexOf(detail), 1);
    await act(async () => { await write.execute('merge'); });
    expect(writes).toHaveLength(1);
  });
  it.each([false, true])('does not bypass the shared primary write in the source actions panel (draft=%s)', async (draft) => {
    let invoked = 0;
    const detail = await mountPanel('actions', {
      primaryValue: draft ? { title: 'Mark ready for review', disabledReason: null, pending: false,
        execute: async () => { invoked += 1; } } : null,
      readCapabilities: async () => ({ kind: 'capabilities', ...projectGithubRepositoryCapabilities({
        kind: 'readable', repositoryId: '1296269', repositoryKey: 'octo-org/example-app',
        mergeSettings: { merge: true, squash: false, rebase: null }, archived: false, hasIssues: true,
      }) }),
    });
    await expect(detail.queryByRole('button', { name: 'Merge pull request' })).resolves.toBeUndefined();
    if (draft) {
      const ready = await detail.getByRole('button', { name: 'Mark ready for review' });
      await act(async () => { await detail.press(ready); });
      expect(invoked).toBe(1);
    } else await expect(detail.queryByRole('button', { name: 'Mark ready for review' })).resolves.toBeUndefined();
  });
  it('withdraws a primary write when the exact read finds a closed draft', async () => {
    const offered: Array<TriageDetailPrimaryWriteV1 | null> = [];
    await mountPanel('overview', { primaryWrites: offered,
      overview: { ...(overviewAnswer() as Record<string, JsonValue>), state: 'closed', draft: true,
        mergeable: false, mergeableState: 'dirty' },
      readCapabilities: async () => ({ kind: 'capabilities', ...projectGithubRepositoryCapabilities({
        kind: 'readable', repositoryId: '1296269', repositoryKey: 'octo-org/example-app',
        mergeSettings: { merge: true, squash: false, rebase: null }, archived: false, hasIssues: true,
      }) }),
    });
    expect(offered.at(-1)).toBeNull();
  });
  it.each([
    { draft: true, mergeable: true, mergeableState: 'clean', title: 'Mark ready', disabled: false },
    { draft: false, mergeable: false, mergeableState: 'dirty', title: 'Merge', disabled: true },
    { draft: false, mergeable: true, mergeableState: 'blocked', title: 'Merge', disabled: true },
    { draft: false, mergeable: true, mergeableState: 'clean', title: 'Merge', disabled: false },
  ])('offers the source-owned header write truthfully ($mergeableState, draft=$draft)', async ({ title, disabled, ...facts }) => {
    const offered: Array<TriageDetailPrimaryWriteV1 | null> = [];
    const writes: Array<{ localId: string; input: unknown }> = [];
    const exact = { ...(overviewAnswer() as Record<string, JsonValue>), ...facts };
    const detail = await mountPanel('overview', { overview: exact, primaryWrites: offered, writes,
      readCapabilities: async () => ({ kind: 'capabilities', ...projectGithubRepositoryCapabilities({
        kind: 'readable', repositoryId: '1296269', repositoryKey: 'octo-org/example-app',
        mergeSettings: { merge: true, squash: false, rebase: null }, archived: false, hasIssues: true,
      }) }),
    });
    const write = offered.at(-1);
    expect(write).toMatchObject({ title, pending: false });
    expect(write?.disabledReason !== null).toBe(disabled);
    expect(write?.methods?.map((method) => method.id) ?? []).toEqual(facts.draft ? [] : ['merge']);
    expect(overviewReads).toHaveLength(1);
    // Source-only facts/reads remain single-owned on ordinary host context arrivals.
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    expect(overviewReads).toHaveLength(1);
    if (!write) throw new Error('Expected a primary write offer');
    if (!facts.draft) {
      await act(async () => { await write.execute('squash'); });
      expect(writes).toHaveLength(0);
    }
    await act(async () => { await write.execute(facts.draft ? undefined : 'merge'); });
    expect(writes).toHaveLength(disabled ? 0 : 1);
    if (!disabled) expect(writes[0]).toMatchObject({
      localId: facts.draft ? GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMarkReady : GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestMerge,
      input: { headRevision: HEAD_REVISION, ...(facts.draft ? {} : { mergeMethod: 'merge' }) },
    });
  });

  it.each([true, false])('reports an empty description only after a successful exact read (success=%s)', async (success) => {
    const detail = await mountPanel('overview', { readCapabilities: async () => readableCapabilitiesAnswer(), overview: success
      ? { ...(overviewAnswer() as Record<string, JsonValue>), body: '' }
      : { kind: 'unavailable', failure: { class: 'transient', code: 'overview-read-refused' } },
    });
    if (success) await expect(detail.getByText('No description.')).resolves.toBeDefined();
    else {
      expect(document.body.textContent).toContain('GitHub could not complete this read.');
      expect(document.body.textContent).not.toContain('overview-read-refused');
      await expect(detail.queryByText('No description.')).resolves.toBeUndefined();
      await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Details' })); });
      expect(document.body.textContent).toContain('overview-read-refused');
    }
  });

  it('renders a classified read failure through the shared translation owner without diagnostic codes', async () => {
    const detail = await mountPanel('overview', {
      overview: { kind: 'unavailable', failure: { class: 'authentication', code: 'source/unauthorized' } },
      translations: { 'plugins.triage.sourceSettings.failure.authentication': 'Reconnectez cette source.' },
    });
    await expect(detail.getByText('Reconnectez cette source.')).resolves.toBeDefined();
    expect(document.body.textContent).not.toContain('source/unauthorized');
  });

  it.each(['unavailable', 'timeout'])('keeps Overview Action refusal %s and its Request ID behind the shared details disclosure', async (code) => {
    const detail = await mountPanel('overview', { readCapabilities: async () => readableCapabilitiesAnswer(), rejectRead: localId =>
      localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview ? new PluginError({
        code, retryable: false, details: { requestId: 'overview-request-54' },
        diagnostics: [{ code: 'plugin_surface_action_projection_unavailable', severity: 'error' }],
      }) : undefined,
    });
    expect(document.body.textContent).not.toContain('plugin_surface_action_projection_unavailable');
    expect(document.body.textContent).not.toContain('overview-request-54');
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Details' })); });
    expect(document.body.textContent).toContain(code);
    if (code === 'unavailable') {
      expect(document.body.textContent).toContain('plugin_surface_action_projection_unavailable');
      expect(document.body.textContent).toContain('retryable=false');
    }
    expect(document.body.textContent).toContain('Request ID');
    expect(document.body.textContent).toContain('overview-request-54');
  });

  it('discloses the native GitHub read failure and provider Request ID from the real producer', async () => {
    const transport = createStubGithubTransport({ respond: () => ({ status: 403,
      headers: { 'x-github-request-id': 'GH:OVERVIEW:54' }, body: { message: 'Forbidden' } }) });
    const launch = TriageDetailSurfaceInputV1Schema.parse(launchInput());
    const { kindId, collisionScope, entryId } = launch.observation.entryRef;
    const result = await readGithubOverview({ v: 1, instance: launch.instance,
      localRef: { kindId, collisionScope, entryId }, routingToken: launch.observation.locator.routingToken }, transport.context);
    if (result.kind !== 'unavailable') throw new Error('Expected a native GitHub refusal');
    const detail = await mountPanel('overview', { overview: projectNativeJsonValueForTransport(result),
      readCapabilities: async () => readableCapabilitiesAnswer() });
    expect(document.body.textContent).not.toContain('GH:OVERVIEW:54');
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Details' })); });
    expect(document.body.textContent).toContain(result.failure.code);
    expect(document.body.textContent).toContain('GH:OVERVIEW:54');
  });

  it('does not claim empty comments when only the other feedback connections answered', async () => {
    const detail = await mountPanel('activity', {
      feedback: (connection): JsonValue => connection === 'comments'
        ? { kind: 'unavailable', failure: { class: 'transient', code: 'comments-read-refused' } }
        : { kind: connection, rows: [], omittedRowCount: 0, projectionTruncated: false },
      timeline: () => ({ kind: 'unavailable', failure: { class: 'transient', code: 'timeline-read-refused' } }),
    });
    expect(document.body.textContent).toContain('GitHub could not complete this read.');
    expect(document.body.textContent).not.toContain('comments-read-refused');
    await expect(detail.queryByText('0 comment(s) read.')).resolves.toBeUndefined();
    await expect(detail.queryByText('0 event(s) read.')).resolves.toBeUndefined();
    await expect(detail.queryByRole('heading', { name: 'Nothing has been said yet' })).resolves.toBeUndefined();
  });

  it.each([false, true])('keeps Activity dispatch diagnostics and the host retry decision (retryable=%s)', async (retryable) => {
    let failed = true;
    const detail = await mountPanel('activity', {
      rejectRead: () => failed ? new PluginError({
        code: 'unavailable', retryable,
        diagnostics: [{ code: 'plugin_surface_action_projection_unavailable', severity: 'error' }],
      }) : undefined,
    });
    expect(document.body.textContent).toContain('GitHub could not complete this read.');
    expect(document.body.textContent).not.toContain('plugin_surface_action_projection_unavailable');
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Details' })); });
    expect(document.body.textContent).toContain('plugin_surface_action_projection_unavailable');
    expect(document.body.textContent).toContain(`retryable=${retryable}`);
    expect(document.body.textContent).not.toContain('Request ID');
    const retry = await detail.queryByRole('button', { name: 'Retry' });
    expect(retry !== undefined).toBe(retryable);
    if (retry !== undefined) {
      failed = false;
      await act(async () => { await detail.press(retry); });
      await vi.waitFor(() => expect(document.body.textContent).toContain('Source-only timeline record.'));
    }
  });

  it('keeps both Activity read failures and retries only the read the host permits', async () => {
    const calls: string[] = [];
    const detail = await mountPanel('activity', { rejectRead: localId => {
      calls.push(localId);
      return new PluginError({ code: localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listTimeline
        ? 'timeline_unavailable' : 'conversation_unavailable',
      retryable: localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listTimeline });
    } });
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Details' })); });
    expect(document.body.textContent).toContain('conversation_unavailable');
    expect(document.body.textContent).toContain('timeline_unavailable');
    calls.splice(0);
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Retry' })); });
    expect(calls).toEqual([GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listTimeline]);
  });

  it('keeps a root capabilities read across source panels but pauses it while the source is hidden', async () => {
    let visible = true;
    let panel = 'overview';
    const signals: AbortSignal[] = [];
    const detail = await mountPanel(() => panel, { visible: () => visible, readCapabilities: async (signal) => {
      signals.push(signal);
      return await new Promise<JsonValue>(() => {});
    } });
    expect(signals).toHaveLength(1);
    const original = signals[0];
    panel = 'files';
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    expect(signals).toHaveLength(1);
    expect(original?.aborted).toBe(false);
    visible = false;
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    visible = true;
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    expect(signals.at(-1)?.aborted).toBe(false);
    await act(async () => { await detail.retire(); });
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
  it('composes host Activity as one stream with no step marker of its own', async () => {
    const detail = await mountPanel('activity');
    await expect(detail.queryByRole('heading', { name: 'Activity' })).resolves.toBeUndefined();
    await expect(detail.getByText('Source-only timeline record.')).resolves.toBeDefined();
    await expect(detail.getByText('provider-specific-event')).resolves.toBeDefined();
    await expect(detail.getByText('Mara')).resolves.toBeDefined();
    await expect(detail.queryAllByRole('tab')).resolves.toEqual([]);
  });

  it.each(['timeline', 'reviews'] as const)('publishes the initial Activity together after its %s read settles, without rereading on rerender', async delayed => {
    let release!: (value: JsonValue) => void;
    const pending = new Promise<JsonValue>(resolve => { release = resolve; });
    const timeline: JsonValue = { kind: 'timeline', rows: [{ id: 'earlier', kind: 'labeled',
      rawKind: 'labeled', actor: 'Mara', summary: 'Earlier timeline event', atMs: 10 }],
      omittedRowCount: 0, projectionTruncated: false };
    const reads: string[] = [];
    const detail = await mountPanel('activity', { reads, timeline: () => delayed === 'timeline' ? pending : timeline,
      feedback: connection => connection === delayed ? pending : connection === 'comments' ? {
        kind: 'comments', rows: [{ id: 'IC_initial', author: 'Mara', body: 'The conversation answered first.', createdAtMs: 20 }],
        omittedRowCount: 0, projectionTruncated: false,
      } : { kind: connection, rows: [], omittedRowCount: 0, projectionTruncated: false },
    });
    try {
      expect(document.body.textContent).not.toContain('The conversation answered first.');
      await act(async () => { release(delayed === 'timeline' ? timeline : { kind: 'reviews', rows: [],
        omittedRowCount: 0, projectionTruncated: false }); });
      await expect(detail.getByText('The conversation answered first.')).resolves.toBeDefined();
      expect(document.body.textContent).toContain('Earlier timeline event');
      await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
      expect(reads.filter(id => id === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listTimeline)).toHaveLength(1);
    } finally { await act(async () => { release({ kind: delayed, rows: [], omittedRowCount: 0, projectionTruncated: false }); }); }
  });

  it('keeps the published Activity visible while an empty timeline refresh is pending', async () => {
    let release!: (value: JsonValue) => void;
    let timelineReads = 0;
    let refreshGeneration = 0;
    const empty: JsonValue = { kind: 'timeline', rows: [], omittedRowCount: 0, projectionTruncated: false };
    const detail = await mountPanel('activity', {
      refreshGeneration: () => refreshGeneration,
      timeline: () => ++timelineReads === 1 ? empty : new Promise<JsonValue>(resolve => { release = resolve; }),
      feedback: connection => connection === 'comments' ? { kind: 'comments', rows: [{ id: 'IC_retained',
        author: 'Mara', body: 'Keep this conversation visible.', createdAtMs: 20 }], omittedRowCount: 0, projectionTruncated: false }
        : { kind: connection, rows: [], omittedRowCount: 0, projectionTruncated: false },
    });
    try {
      refreshGeneration += 1;
      await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
      expect(document.body.textContent).toContain('Keep this conversation visible.');
    } finally { await act(async () => { release?.(empty); }); }
  });

  it('reads the conversation and the timeline as one chronological Activity stream', async () => {
    const HOUR = 3_600_000;
    const at = (hoursAgo: number) => Date.now() - hoursAgo * HOUR;
    const commentUrl = 'https://github.com/octo-org/example-app/pull/1284#issuecomment-11';
    const timelineCalls: (string | undefined)[] = [];
    const detail = await mountPanel('activity', {
      feedback: (connection) => (connection === 'comments'
        ? {
          kind: 'comments',
          rows: [{ id: 'IC_11', author: 'hubber', body: 'This normalizer is duplicated.', createdAtMs: at(20), url: commentUrl }],
          omittedRowCount: 0, projectionTruncated: false,
        }
        : { kind: connection, rows: [], omittedRowCount: 0, projectionTruncated: false }) as JsonValue,
      timeline: (continuation) => {
        timelineCalls.push(continuation);
        return (continuation === undefined
          ? {
            kind: 'timeline',
            rows: [
              { id: 'github-timeline-event:1', kind: 'forcePushed', rawKind: 'head_ref_force_pushed', actor: 'Mara', atMs: at(30) },
              // GitHub's own record of the remark above: the same permalink, read twice.
              { id: 'github-timeline-event:11', kind: 'commented', rawKind: 'commented', actor: 'hubber', atMs: at(20), webUrl: commentUrl },
              { id: 'github-timeline-event:2', kind: 'labeled', rawKind: 'labeled', actor: 'Mara', summary: 'p1', atMs: at(10) },
            ],
            omittedRowCount: 0, projectionTruncated: false, continuation: 'timeline-page-2',
          }
          : {
            kind: 'timeline',
            rows: [{ id: 'github-timeline-event:3', kind: 'closed', rawKind: 'closed', actor: 'Mara', atMs: at(1) }],
            omittedRowCount: 0, projectionTruncated: false,
          }) as JsonValue;
      },
    });

    await expect(detail.getByText('This normalizer is duplicated.')).resolves.toBeDefined();
    const before = document.body.textContent ?? '';
    const order = ['Force-pushed the head branch', 'This normalizer is duplicated.', 'Added a label'].map((part) => before.indexOf(part));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    // The timeline's record of the remark is not a second remark.
    expect(before.split('Commented').length - 1).toBe(1);

    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Load more events' })); });
    expect(timelineCalls).toEqual([undefined, 'timeline-page-2']);
    const after = document.body.textContent ?? '';
    expect(after.indexOf('Closed')).toBeGreaterThan(after.indexOf('Added a label'));
  });
  it('renders only the requested panel, with no tab strip of its own', async () => {
    const detail = await mountPanel('checks');
    await expect(detail.getByText('build')).resolves.toBeDefined();
    await expect(detail.queryAllByRole('tab')).resolves.toEqual([]);
  });
  it('keeps comment images through the real Activity composition and the public Markdown image bridge', async () => {
    const url = 'https://github.com/user-attachments/assets/screenshot';
    const documents: MarkdownProps[] = [];
    await mountPanel('activity', {
      feedback: connection => connection === 'comments' ? {
        kind: 'comments', rows: [{ id: 'IC_image', author: 'hubber', body: `<img alt="image" src="${url}">`,
          createdAtMs: 1 }], omittedRowCount: 0, projectionTruncated: false,
      } : { kind: connection, rows: [], omittedRowCount: 0, projectionTruncated: false },
      renderMarkdown: input => { documents.push(input); return <Text value={input.value} />; },
    });
    expect(document.body.textContent).toContain('hubber');
    const picture = documents.find(input => input.value.includes(url));
    expect(picture?.value).toBe(`![image](${url})`);
    expect(picture?.images?.resolve(url)).toEqual({ kind: 'remote', url });
    expect(picture?.images?.remoteLoaded).toBe(false);
  });
  it('draws the story rail: the ask, what changed, and the failing checks state in words', async () => {
    const detail = await mountPanel('overview');
    // The story reads GitHub's own overview when it opens; no Re-read control stands in for it.
    expect(overviewReads).toHaveLength(1);
    await expect(detail.queryByRole('button', { name: 'Re-read this overview from GitHub' })).resolves.toBeUndefined();
    await expect(detail.getByRole('heading', { name: 'The ask' })).resolves.toBeDefined();
    await expect(detail.getByText('Moves rounding to the pricing service.')).resolves.toBeDefined();
    // The facts that lived in the key/value block stay, said once each without the block.
    const page = document.body.textContent ?? '';
    for (const fact of ['octocat', 'performance', 'hubot', 'August', 'monalisa', 'frame-pump → main']) expect(page).toContain(fact);
    await expect(detail.queryByText('Requested reviewers')).resolves.toBeUndefined();
    await expect(detail.queryByText('Observed head')).resolves.toBeUndefined();
    await expect(detail.getByRole('heading', { name: 'What changed' })).resolves.toBeDefined();
    // GitHub's own whole-change totals, not the two files read so far.
    await expect(detail.getByText('+388')).resolves.toBeDefined();
    await expect(detail.getByText('in 17 files')).resolves.toBeDefined();
    await expect(detail.getByRole('image', { name: 'src/cart/totals.ts: 96 added, 71 removed' })).resolves.toBeDefined();
    await expect(detail.getByText('15 smaller files')).resolves.toBeDefined();
    // The shared checks step: its marker, its counts, and what failed.
    await expect(detail.getByRole('image', { name: '1 failed' })).resolves.toBeDefined();
    await expect(detail.getByText('1 failing')).resolves.toBeDefined();
    await expect(detail.getByText('· 0 passed')).resolves.toBeDefined();
    await expect(detail.getByText('build')).resolves.toBeDefined();
  });

  it('reads each GitHub resource once per open detail and re-renders tab switches from its one owner', async () => {
    const reads: string[] = [];
    const feedbackReads: string[] = [];
    let panel = 'overview';
    const detail = await mountPanel(() => panel, { reads,
      feedback: (connection) => { feedbackReads.push(connection);
        return { kind: connection, rows: [], omittedRowCount: 0, projectionTruncated: false } as JsonValue; } });
    const settle = async () => { await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); }); };
    await vi.waitFor(() => expect(reads).toContain(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview));
    await settle();
    // Story steps, Files, Checks and Activity all read the same plugin-owned resources; the
    // checks come from the Overview's own read, so no separate checks read is made.
    for (const next of ['files', 'checks', 'activity', 'overview', 'checks', 'activity', 'files', 'overview']) {
      panel = next;
      await settle();
      await settle();
    }
    const count = (id: string) => reads.filter((read) => read === id).length;
    expect({
      overview: count(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview),
      checks: count(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readChecks),
      files: count(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles),
      timeline: count(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listTimeline),
      feedback: [...feedbackReads].sort(),
    }).toEqual({ overview: 1, checks: 0, files: 1, timeline: 1, feedback: ['comments', 'requests', 'reviews', 'threads'] });
    await expect(detail.getByText('build')).resolves.toBeDefined();
  });

  it('opens Files, Checks and one named file from the story through the frame\'s own panel selection', async () => {
    let panel = 'overview';
    const selected: string[] = [];
    const diffReads: string[] = [];
    const files = ['src/cart/totals.ts', 'src/cart/tax.ts', 'src/cart/discounts.ts', 'src/cart/rounding.ts', 'src/cart/index.ts', 'README.md']
      .map((path, index) => ({ path, status: 'modified', additions: 60 - index * 10, deletions: 5, changes: 65 - index * 10, diffAvailable: true }));
    let detail!: PluginUiTestkit;
    const navigation: TriageDetailPanelNavigationV1 = {
      panels: ['overview', 'activity', 'files', 'checks'],
      select: (next) => { selected.push(next); panel = next; },
    };
    detail = await mountPanel(() => panel, { panelNavigation: navigation, changedFilesReview: true, onAction: (localId, input) => {
      if (localId !== GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles) return undefined;
      const filePath = (input as { filePath?: string }).filePath;
      if (filePath !== undefined) diffReads.push(filePath);
      return { kind: 'changedFiles', rows: files, omittedRowCount: 0, projectionTruncated: false } as JsonValue;
    } });
    const settle = async () => { await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); }); };

    // The step titles open the panel that tells their whole story.
    await act(async () => { await detail.press(await detail.getByRole('link', { name: 'What changed' })); });
    expect(selected).toEqual(['files']);
    panel = 'overview';
    await settle();
    await act(async () => { await detail.press(await detail.getByRole('link', { name: 'Checks' })); });
    expect(selected).toEqual(['files', 'checks']);
    panel = 'overview';
    await settle();

    // "N smaller files" lists every file read so far in place, and says how many GitHub has not listed yet.
    await expect(detail.queryByRole('link', { name: 'README.md' })).resolves.toBeUndefined();
    await act(async () => { await detail.press(await detail.getByRole('button', { name: '13 smaller files' })); });
    await expect(detail.getByRole('link', { name: 'README.md' })).resolves.toBeDefined();
    await expect(detail.getByText('11 more files')).resolves.toBeDefined();

    // A file opens Files on that file: the review reads that file's diff.
    await act(async () => { await detail.press(await detail.getByRole('link', { name: 'src/cart/index.ts' })); });
    expect(selected).toEqual(['files', 'checks', 'files']);
    await settle();
    await vi.waitFor(() => expect(diffReads).toContain('src/cart/index.ts'));
  });

  it('marks each check with its status and re-runs a failed check\'s workflow through the shared CI write', async () => {
    const run = { v: 1, repository: { kind: 'github', deployment: 'https://github.com', repository: 'octo-org/example-app' }, runId: '77' };
    const checks = { ...(failingChecksAnswer() as Record<string, JsonValue>), rows: [
      { key: 'github-check-run:9003', resourceKind: 'check-run', name: 'build', status: 'completed', conclusion: 'failure',
        actions: { selection: { kind: 'attempt', attempt: { run, attemptId: '1' } }, checkRunId: '9003', headSha: HEAD_REVISION } },
      { key: 'github-check-run:9004', resourceKind: 'check-run', name: 'lint', status: 'completed', conclusion: 'success' },
    ], passingCount: 1 } as JsonValue;
    const writes: Array<{ localId: string; input: unknown }> = [];
    const detail = await mountPanel('checks', { checks, onAction: (localId, input) => {
      if (!localId.startsWith('github/actions/run-rerun')) return undefined;
      writes.push({ localId, input });
      return { kind: 'accepted', affected: { repository: run.repository, run } } as JsonValue;
    } });
    await expect(detail.getByRole('image', { name: 'Failed' })).resolves.toBeDefined();
    await expect(detail.getByRole('image', { name: 'Succeeded' })).resolves.toBeDefined();
    // A check GitHub Actions did not run has no workflow to re-run.
    await expect(detail.queryAllByRole('button', { name: 'Re-run failed jobs' })).resolves.toHaveLength(1);
    const before = overviewReads.length;
    await act(async () => { await detail.press(await detail.getByRole('button', { name: 'Re-run failed jobs' })); });
    expect(writes).toEqual([{ localId: 'github/actions/run-rerun-failed',
      input: { repository: run.repository, runId: '77', attempt: '1' } }]);
    // The accepted re-run is read back through the checks' own refresh.
    await vi.waitFor(() => expect(overviewReads.length).toBeGreaterThan(before));
  });

  it('keeps the failing checks read when GitHub has more check pages than were read', async () => {
    const { failingCount: _failing, runningCount: _running, passingCount: _passing, ...rest } = failingChecksAnswer() as Record<string, JsonValue>;
    const detail = await mountPanel('overview', { checks: { ...rest, state: 'knownIncomplete' } as JsonValue });
    await expect(detail.getByRole('image', { name: '1 failed' })).resolves.toBeDefined();
    await expect(detail.getByText('1 failing so far')).resolves.toBeDefined();
    await expect(detail.getByText('· more checks not read')).resolves.toBeDefined();
    await expect(detail.getByText('build')).resolves.toBeDefined();
  });
});
