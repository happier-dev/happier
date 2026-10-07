// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { defineUiSurface, Tabs } from '@happier-dev/plugin-ui';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

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
      configuration: { v: 1, token: 'github-configuration-token-v1' },
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
  visible?: () => boolean;
  readCapabilities?: (signal: AbortSignal) => Promise<JsonValue>;
  feedback?: (connection: string) => JsonValue;
  timeline?: (continuation: string | undefined) => JsonValue;
  checks?: JsonValue;
}> = {}): Promise<PluginUiTestkit> {
  let detail!: PluginUiTestkit;
  await act(async () => {
    detail = await createPluginUiTestkit({
      identity: { instanceId: `fixture-instance-panel-${panel}`, mountNonce: `fixture-mount-panel-${panel}` },
      authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      surface: defineUiSurface((context) => {
        const body = renderSurface(typeof panel === 'function' ? {
          ...context, launchInput: { ...(launchInput() as Record<string, JsonValue>), panel: panel() },
        } : context);
        // The SDK artifact boundary returns an opaque UI element; the RNW host requires a real React element.
        if (body !== null && !React.isValidElement(body)) throw new Error('Expected a React-native author surface');
        return options.visible === undefined ? body : <Tabs value={options.visible() ? 'source' : 'session'}
          onValueChange={() => {}} ariaLabel="Detail planes" tabList="host">
          <Tabs.Item value="source" title="Source" retention="retain">{body}</Tabs.Item>
          <Tabs.Item value="session" title="Session" />
        </Tabs>;
      }),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: { ...(launchInput() as Record<string, JsonValue>), panel: typeof panel === 'string' ? panel : panel() } as JsonValue,
      handlers: {
        executeAction: async ({ action, input, signal }) => {
          const localId = (action as { localId: string }).localId;
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
            return overviewAnswer();
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

  it('keeps the failing checks read when GitHub has more check pages than were read', async () => {
    const { failingCount: _failing, runningCount: _running, passingCount: _passing, ...rest } = failingChecksAnswer() as Record<string, JsonValue>;
    const detail = await mountPanel('overview', { checks: { ...rest, state: 'knownIncomplete' } as JsonValue });
    await expect(detail.getByRole('image', { name: '1 failed' })).resolves.toBeDefined();
    await expect(detail.getByText('1 failing so far')).resolves.toBeDefined();
    await expect(detail.getByText('· more checks not read')).resolves.toBeDefined();
    await expect(detail.getByText('build')).resolves.toBeDefined();
  });
});
