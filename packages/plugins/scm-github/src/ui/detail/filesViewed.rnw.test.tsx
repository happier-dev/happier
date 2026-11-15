// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { Button, defineUiSurface } from '@happier-dev/plugin-ui';
import type { HappierChangedFilesReviewRequest } from '@happier-dev/plugin-ui/presentation';
import { TriageActivityAgentProvider } from '@happier-dev/triage-sources/ui';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
  ScmFileViewedFile,
  ScmFileViewedRequest,
  ScmFileViewedSource,
} from '@happier-dev/plugin-sdk/scm';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
} from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
} from '../../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 } from '../../triage/contribution.js';
import { GITHUB_FILE_VIEWED_ACTION_IDS_V1 } from '../../triage/fileViewedContracts.js';
import { projectGithubPullRequestOverview } from '../../triage/detail/overview.js';
import { GithubOverviewResultV1Schema } from '../../triage/detail/contracts.js';
import { renderSurface } from '../renderSurface.js';
import { SourcePanelActionsFixture, invokeSourcePanelFixtureAction } from '../../../../triage/src/ui/sourcePanelActions.test-support.js';
import { createTriageEphemeralSharedScopeFixture } from '../../../../triage/src/ui/window/ephemeralSharedScope.test-support.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE_CONTRIBUTION = Object.freeze({
  pluginId: GITHUB_PLUGIN_ID,
  localId: 'github-forge',
});
const BASE = 'a'.repeat(40);
const HEAD = 'b3f1c0a9d2e4f60718293a4b5c6d7e8f90a1b2c3';

function launchInput(withRevision = true): JsonValue {
  return {
    v: 1,
    panel: 'files',
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
        ...(withRevision ? { reviewRevision: { baseSha: BASE, headSha: HEAD, nativeRevision: HEAD } } : {}),
      },
      viewer: { involvement: ['reviewRequested'] },
    },
    linkedSessions: [],
  } as JsonValue;
}

const PATHS = [
  'src/alpha.ts',
  'src/beta.ts',
  'src/gamma.ts',
  'src/delta.ts',
] as const;
const FILES_PAGE = {
  kind: 'changedFiles',
  rows: PATHS.map((path) => ({
    path,
    status: 'modified',
    additions: 3,
    deletions: 1,
    changes: 4,
    diffAvailable: true,
  })),
  omittedRowCount: 0,
  projectionTruncated: false,
} as JsonValue;

/** A host boundary fixture; Viewed mutation and refusal behavior belongs to the app owner. */
function createHostViewedSource(
  initial: Readonly<Record<string, ScmFileViewedFile['state']>>,
  errors: Readonly<Record<string, string>> = {},
) {
  const files = new Map<string, ScmFileViewedFile>(
    PATHS.map(path => [path, { state: initial[path] ?? null, pending: false, errorCode: errors[path] ?? null }]),
  );
  const writes: Array<Readonly<{ path: string; viewed: boolean }>> = [];
  const snapshot = { status: 'ready' as const, headOid: HEAD, errorCode: null };
  let refreshes = 0;
  const source: ScmFileViewedSource = {
    getFile: path => files.get(path) ?? { state: null, pending: false, errorCode: null },
    subscribeFile: () => () => {},
    getSnapshot: () => snapshot,
    subscribeStatus: () => () => {},
    subscribeChanges: () => () => {},
    getViewedPaths: () => new Set([...files].filter(([, file]) => file.state === 'viewed').map(([path]) => path)),
    setViewed: async (path, viewed) => { writes.push({ path, viewed }); return false; },
    refresh: async () => { refreshes++; },
  };
  return { source, writes, refreshes: () => refreshes };
}

const requests: ScmFileViewedRequest[] = [];
const reviews: HappierChangedFilesReviewRequest[] = [];
const dispatched: string[] = [];
const mounted: PluginUiTestkit[] = [];

/** The parent page owns refresh; the plugin joins it through the real public provider. */
function PageFrame({ children }: Readonly<{ children: React.ReactNode }>) {
  const [refreshGeneration, setRefreshGeneration] = React.useState(0);
  return <TriageActivityAgentProvider value={{ events: [], tail: null, refreshGeneration }}>
    <Button title="Refresh page" onPress={() => setRefreshGeneration(value => value + 1)} />
    {children}
  </TriageActivityAgentProvider>;
}

async function mountFiles(
  source: ScmFileViewedSource,
  withRevision = true,
): Promise<PluginUiTestkit> {
  const scope = createTriageEphemeralSharedScopeFixture();
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = (await createPluginUiTestkit({
      identity: {
        instanceId: 'fixture-instance-viewed',
        mountNonce: 'fixture-mount-viewed',
      },
      authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      surface: defineUiSurface(context => <PageFrame><SourcePanelActionsFixture scope={scope}>{renderSurface(context)}</SourcePanelActionsFixture></PageFrame>),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({
        changedFilesReview: true,
        overlays: true,
        observeChangedFilesReview: request => { reviews.push(request); },
        scmFileViewed: (request) => {
          requests.push(request);
          return request.comparison === null ? null : source;
        },
      }),
      launchInput: launchInput(withRevision),
      handlers: {
        executeAction: async ({ action, input, signal }) => {
          const localId = typeof action === 'string' ? action : action.localId;
          if (localId.startsWith('ui/')) return await invokeSourcePanelFixtureAction(scope, localId, input, fixture.context, signal);
          dispatched.push(localId);
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview) {
            return GithubOverviewResultV1Schema.parse({
              kind: 'overview', kindId: 'pull-request', observedAtMs: 1_760_000_700_001,
              ...projectGithubPullRequestOverview({ title: 'Current PR', state: 'open',
                head: { sha: HEAD, ref: 'feature' }, base: { sha: BASE, ref: 'main' } }),
            });
          }
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles) {
            const filePath = (input as { filePath?: string }).filePath;
            return filePath === undefined ? FILES_PAGE : {
              kind: 'changedFiles',
              rows: [{ path: filePath, status: 'modified', additions: 1, deletions: 1, changes: 2, diffAvailable: true,
                evidence: { state: 'available', patch: '@@ -1 +1 @@\n-old\n+new' } }],
              omittedRowCount: 0, projectionTruncated: false,
            } as JsonValue;
          }
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readChecks) {
            return {
              kind: 'checks',
              headRevision: HEAD,
              state: 'none',
              rows: [],
              omittedRowCount: 0,
              projectionTruncated: false,
            };
          }
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listTimeline) {
            return {
              kind: 'timeline',
              rows: [],
              omittedRowCount: 0,
              projectionTruncated: false,
            };
          }
          return {
            kind: 'unavailable',
            failure: { class: 'unknown', code: 'not-in-fixture' },
          };
        },
      },
    })) as PluginUiTestkit;
  });
  mounted.push(fixture);
  return fixture;
}

/** The row's own "⋯" menu trigger: the first More actions control after the row's press target. */
async function rowMenu(files: PluginUiTestkit, path: string) {
  const buttons = await files.queryAllByRole('button');
  const index = buttons.findIndex(button => button.name?.startsWith(path));
  const trigger = buttons.slice(index + 1).find(button => button.name?.startsWith('More actions'));
  expect(trigger).toBeDefined();
  return trigger!;
}

afterEach(async () => {
  requests.splice(0);
  reviews.splice(0);
  dispatched.splice(0);
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('GitHub Files panel Viewed marks', () => {
  it('uses the exact Overview revision when the launch observation has none', async () => {
    const { source } = createHostViewedSource({});
    await mountFiles(source, false);
    expect(dispatched.filter(id => id === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview)).toHaveLength(1);
    expect(requests.at(-1)?.comparison?.endpoints).toEqual({ before: BASE, after: HEAD });
    expect(document.body.textContent).toContain('0 of 4 viewed');
  });

  it('joins the host Viewed owner for this PR head with its own read/set Actions', async () => {
    const { source } = createHostViewedSource({ 'src/alpha.ts': 'viewed' });
    await mountFiles(source);
    const request = requests.at(-1)!;
    expect(request.comparison?.endpoints).toEqual({
      before: BASE,
      after: HEAD,
    });
    expect(request.comparison?.freshness).toBe('current');
    const locator =
      request.comparison?.source.kind === 'pullRequest'
        ? request.comparison.source.locator
        : null;
    expect(locator?.fileViewedActions?.read.action).toEqual({
      pluginId: GITHUB_PLUGIN_ID,
      localId: GITHUB_FILE_VIEWED_ACTION_IDS_V1.read,
    });
    expect(locator?.fileViewedActions?.set.action).toEqual({
      pluginId: GITHUB_PLUGIN_ID,
      localId: GITHUB_FILE_VIEWED_ACTION_IDS_V1.set,
    });
    expect(locator?.headOid).toBe(HEAD);
  });

  it('lists every changed file without mounting the shared review', async () => {
    const { source, writes } = createHostViewedSource({
      'src/alpha.ts': 'viewed',
      'src/beta.ts': 'unviewed',
      'src/gamma.ts': 'dismissed',
    });
    const files = await mountFiles(source);
    expect(reviews).toHaveLength(0);
    const rows = await files.queryAllByRole('button');
    for (const path of PATHS) expect(rows.some(row => row.name?.startsWith(path))).toBe(true);
    expect(writes).toEqual([]);
    expect(dispatched).not.toContain(GITHUB_FILE_VIEWED_ACTION_IDS_V1.read);
    expect(dispatched).not.toContain(GITHUB_FILE_VIEWED_ACTION_IDS_V1.set);
    await act(async () => { await files.press(await rowMenu(files, 'src/alpha.ts')); });
    await act(async () => { await files.press(await files.getByRole('menuitem', { name: 'Mark unviewed' })); });
    expect(writes).toEqual([{ path: 'src/alpha.ts', viewed: false }]);
    // The host owns pending writes and refusals. Its real owner coverage lives in
    // apps/ui/sources/sync/ops/scmDiffSummary/fileViewed.test.ts and review/hunkReview/
    // useHunkReviewController.fileViewed.test.tsx; the List consumes that owner unchanged.
  });

  it('shows each mark on its collapsed row and offers it in the row menu, never inside the open diff', async () => {
    const { source, writes } = createHostViewedSource(
      { 'src/alpha.ts': 'viewed', 'src/beta.ts': 'unviewed', 'src/gamma.ts': 'unviewed' },
      { 'src/gamma.ts': 'github_graphql_response_invalid' },
    );
    const files = await mountFiles(source);
    const row = (path: string) => [...document.querySelectorAll('[aria-expanded]')]
      .find(node => node.textContent?.startsWith(path))!;
    // Above the rows, the reader's progress rather than the tab's count again.
    expect(document.body.textContent).toContain('1 of 4 viewed');
    // Collapsed, the viewed file says so; an unviewed one stays one line.
    expect(row('src/alpha.ts').textContent).toContain('Viewed');
    expect(row('src/beta.ts').textContent).not.toContain('Viewed');
    // A refused write reads as copy, never as GitHub's code.
    expect(row('src/gamma.ts').textContent).toContain('Not saved to GitHub');
    expect(document.body.textContent).not.toContain('github_graphql_response_invalid');

    await act(async () => { await files.press((await files.queryAllByRole('button')).find(button => button.name?.startsWith('src/beta.ts'))!); });
    await vi.waitFor(() => expect(document.body.textContent).toContain('+new'));
    expect(await files.queryAllByRole('button', { name: 'Mark viewed' })).toHaveLength(0);
    // The open diff is named by its row: the path is not drawn a second time above it.
    const body = document.querySelector('[role="group"][aria-label="src/beta.ts"]');
    expect(body).not.toBeNull();
    expect([...body!.querySelectorAll('*')].filter(node => node.textContent === 'src/beta.ts')).toEqual([]);

    await act(async () => { await files.press(await rowMenu(files, 'src/beta.ts')); });
    await act(async () => { await files.press(await files.getByRole('menuitem', { name: 'Mark viewed' })); });
    expect(writes).toEqual([{ path: 'src/beta.ts', viewed: true }]);
  });

  it('refreshes the files and the same host Viewed source through the parent page refresh', async () => {
    const viewed = createHostViewedSource({ 'src/alpha.ts': 'viewed' });
    const files = await mountFiles(viewed.source);
    const readsBefore = dispatched.filter(id => id === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles).length;
    const refreshesBefore = viewed.refreshes();
    await act(async () => { await files.press(await files.getByRole('button', { name: 'Refresh page' })); });
    expect(viewed.refreshes()).toBe(refreshesBefore + 1);
    expect(dispatched.filter(id => id === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles)).toHaveLength(readsBefore + 1);
    expect(reviews).toHaveLength(0);
    expect(viewed.writes).toEqual([]);
  });

  it('keeps the plain file list when the host has no Viewed source', async () => {
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = (await createPluginUiTestkit({
        identity: {
          instanceId: 'fixture-instance-plain',
          mountNonce: 'fixture-mount-plain',
        },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: renderSurface,
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter({ changedFilesReview: true, observeChangedFilesReview: request => { reviews.push(request); } }),
        launchInput: launchInput(),
        handlers: { executeAction: async () => FILES_PAGE },
      })) as PluginUiTestkit;
    });
    mounted.push(fixture);
    expect(document.body.textContent).toContain('src/alpha.ts');
    await expect(fixture.getByRole('checkbox')).rejects.toThrow();
    expect(reviews).toHaveLength(0);
  });
});
