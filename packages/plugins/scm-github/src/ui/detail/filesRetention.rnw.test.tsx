// @vitest-environment jsdom
import { act } from 'react';
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

const SOURCE_CONTRIBUTION = Object.freeze({
  pluginId: GITHUB_PLUGIN_ID,
  localId: 'github-forge',
});

const OBSERVED_AT_MS = 1_760_000_700_000;

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
        facts: [],
      },
      viewer: { involvement: ['reviewRequested'] },
    },
    linkedSessions: [],
  } as JsonValue;
}

function changedFilePage(paths: readonly string[], continuation: string | null): JsonValue {
  return {
    kind: 'changedFiles',
    rows: paths.map((path) => ({
      path,
      status: 'modified',
      additions: 3,
      deletions: 1,
      changes: 4,
      diffAvailable: true,
    })),
    omittedRowCount: 0,
    projectionTruncated: false,
    ...(continuation === null ? {} : { continuation }),
  } as JsonValue;
}

const FIRST_PAGE = changedFilePage(['src/alpha.ts', 'src/beta.ts'], 'github-files-page-2');
const SECOND_PAGE = changedFilePage(['src/gamma.ts'], null);

const dispatched: string[] = [];
const mounted: PluginUiTestkit[] = [];

/**
 * Holds the SECOND changed-files page in flight, so a leave can be taken while
 * the walk is mid-request rather than settled.
 *
 * A real leave aborts the interval, and the request the host had already
 * dispatched settles afterwards against a signal nobody is listening to. This
 * gate is the only way to place the leave inside that window from a test: the
 * handler is the transport, and the transport is exactly what has to be slow.
 */
let secondPageGate: Promise<void> | null = null;

function openSecondPageGate(): () => void {
  let release!: () => void;
  secondPageGate = new Promise<void>((resolve) => { release = resolve; });
  return release;
}

async function mountDetail(): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        pluginId: GITHUB_PLUGIN_ID,
        pluginVersion: '0.0.0',
        viewId: 'github-triage-detail',
        generation: 'github-files-retention-mount',
      },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: launchInput(),
      handlers: {
        executeAction: async ({ action, input }) => {
          const localId = (action as { localId: string }).localId;
          dispatched.push(localId);
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles) {
            const continuation = (input as { continuation?: string }).continuation;
            if (continuation === undefined) return FIRST_PAGE;
            if (secondPageGate !== null) await secondPageGate;
            return SECOND_PAGE;
          }
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listTimeline) {
            // Rows, not an empty page: a discard panel that had nothing to keep
            // would restart under any retention rule, and would not tell the two
            // rules apart.
            return {
              kind: 'timeline',
              rows: [{
                id: 'github-timeline-event:900001',
                kind: 'labeled',
                rawKind: 'labeled',
                atMs: OBSERVED_AT_MS - 60_000,
                actor: 'octocat',
                summary: 'needs-review',
              }],
              omittedRowCount: 0,
              projectionTruncated: false,
            };
          }
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readChecks) {
            return {
              kind: 'checks',
              headRevision: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
              state: 'none',
              rows: [],
              omittedRowCount: 0,
              projectionTruncated: false,
            };
          }
          throw new Error(`unexpected action ${localId}`);
        },
      },
    }) as PluginUiTestkit;
  });
  mounted.push(fixture);
  return fixture;
}

async function openTab(detail: PluginUiTestkit, name: string): Promise<void> {
  await act(async () => {
    await detail.press(await detail.getByRole('tab', { name }));
  });
}

async function pressLoadMore(detail: PluginUiTestkit): Promise<void> {
  await act(async () => {
    await detail.press(await detail.getByRole('button', { name: 'Load more files' }));
  });
}

function readCount(localId: string): number {
  return dispatched.filter((id) => id === localId).length;
}

afterEach(async () => {
  dispatched.splice(0);
  secondPageGate = null;
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

/**
 * The Files panel is the ONE GitHub detail panel that declares `retain`, and the
 * declaration has to buy something a reader can feel.
 *
 * A pull request may change up to three thousand files, so a reader who walked
 * to page nine and stepped into Checks to see why a build failed has spent nine
 * provider pages of GitHub's rate budget. Returning them to page one — with the
 * rows they had gone, their place in the list gone, and nine pages owed to GitHub
 * again — is the whole cost of the walk charged twice for one glance away.
 *
 * The counter-case is in the same file on purpose: Timeline declares `discard`,
 * and it must still restart. That is what proves retention is read from the tab
 * declaration rather than applied to every panel.
 */
describe('the mounted GitHub Files panel across a tab leave', () => {
  it('keeps the pages a reader walked and asks GitHub for none of them again', async () => {
    const detail = await mountDetail();
    await openTab(detail, 'Files');
    await expect(detail.getByText('2 changed file(s) read.'))
      .resolves.toEqual({ content: '2 changed file(s) read.' });

    await pressLoadMore(detail);
    await expect(detail.getByText('3 changed file(s) read.'))
      .resolves.toEqual({ content: '3 changed file(s) read.' });
    expect(readCount(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles)).toBe(2);

    await openTab(detail, 'Checks');
    await openTab(detail, 'Files');

    // Every row from both pages is still on screen, at the same position in the
    // same reading order, and GitHub was asked for nothing.
    await expect(detail.getByText('3 changed file(s) read.'))
      .resolves.toEqual({ content: '3 changed file(s) read.' });
    await expect(detail.getByText('src/alpha.ts')).resolves.toEqual({ content: 'src/alpha.ts' });
    await expect(detail.getByText('src/gamma.ts')).resolves.toEqual({ content: 'src/gamma.ts' });
    expect(readCount(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles)).toBe(2);
  });

  it('re-asks the page that was in flight at the leave, instead of staying pending forever', async () => {
    const detail = await mountDetail();
    await openTab(detail, 'Files');
    await expect(detail.getByText('2 changed file(s) read.'))
      .resolves.toEqual({ content: '2 changed file(s) read.' });

    // Page two is dispatched and then held, so the reader steps away while the
    // walk is mid-request.
    const releaseSecondPage = openSecondPageGate();
    await pressLoadMore(detail);
    expect(readCount(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles)).toBe(2);

    await openTab(detail, 'Checks');
    // The held request settles after the leave, against the interval's aborted
    // signal — so the walk never learns its outcome and stays `pending`.
    releaseSecondPage();
    await act(async () => { await Promise.resolve(); });

    await openTab(detail, 'Files');

    // Without the re-ask the retained panel is stuck for good: `loadMore` and
    // `refresh` both early-return while `pending` is set, so a reader who
    // glanced away mid-page has no way back to the rest of the files.
    expect(readCount(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles)).toBe(3);
    await expect(detail.getByText('3 changed file(s) read.'))
      .resolves.toEqual({ content: '3 changed file(s) read.' });
    await expect(detail.getByText('src/gamma.ts')).resolves.toEqual({ content: 'src/gamma.ts' });

    // Usable again, not merely unstuck: the panel's own explicit re-read is
    // offered and lands, which it cannot do while a page is still in flight.
    await act(async () => {
      await detail.press(await detail.getByRole('button', {
        name: 'Re-read the changed files from GitHub',
      }));
    });
    expect(readCount(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles)).toBe(4);
    await expect(detail.getByText('2 changed file(s) read.'))
      .resolves.toEqual({ content: '2 changed file(s) read.' });
  });

  it('still restarts a panel that declares discard', async () => {
    const detail = await mountDetail();
    await openTab(detail, 'Timeline');
    // Settled with a row in hand: the leave must discard something for the two
    // lifetimes to be told apart at all.
    await expect(detail.getByText('1 event(s) read.'))
      .resolves.toEqual({ content: '1 event(s) read.' });
    expect(readCount(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listTimeline)).toBe(1);

    await openTab(detail, 'Checks');
    await openTab(detail, 'Timeline');

    expect(readCount(GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listTimeline)).toBe(2);
  });
});
