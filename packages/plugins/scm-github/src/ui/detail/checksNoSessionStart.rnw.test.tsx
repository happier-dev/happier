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

/**
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

function emptyFeedbackAnswer(kind: string): JsonValue {
  return { kind, rows: [] } as JsonValue;
}

const mounted: PluginUiTestkit[] = [];

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the mounted GitHub Checks plane Session-start boundary', () => {
  it('mounts the provider facts and zero Session-start controls', async () => {
    let detail!: PluginUiTestkit;
    await act(async () => {
      detail = await createPluginUiTestkit({
        identity: {
          pluginId: GITHUB_PLUGIN_ID,
          pluginVersion: '0.0.0',
          viewId: 'github-triage-detail',
          generation: 'github-triage-checks-mount',
        },
        surface: renderSurface,
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        launchInput: launchInput(),
        handlers: {
          executeAction: async ({ action, input: actionInput }) => {
            const localId = (action as { localId: string }).localId;
            if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback) {
              // The default Feedback tab composes five reads; none is this
              // test's subject, so each answers empty rather than loading.
              const connection = (actionInput as { connection: string }).connection;
              if (connection === 'checks') {
                return {
                  kind: 'checks',
                  headRevision: HEAD_REVISION,
                  state: 'none',
                  rows: [],
                  omittedRowCount: 0,
                  projectionTruncated: false,
                } as JsonValue;
              }
              return emptyFeedbackAnswer(connection);
            }
            if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readChecks) {
              return failingChecksAnswer();
            }
            if (action === 'reviews.comments.list') {
              return { items: [], cursor: null } as JsonValue;
            }
            throw new Error(`unexpected action ${localId}`);
          },
        },
      }) as PluginUiTestkit;
    });
    mounted.push(detail);

    await act(async () => {
      await detail.press(await detail.getByRole('tab', { name: 'Checks' }));
    });

    // Positive control: the plane really mounted the provider facts, so the
    // absence assertions below are about controls, not about an empty panel.
    await expect(detail.getByText('build')).resolves.toBeDefined();

    // The boundary itself: the source detail body offers no way to start,
    // seed or open a Session. Every Session route for this entry belongs to
    // the aggregate's common header and its configurable action controls.
    await expect(detail.queryByRole('button', { name: 'Fix CI in a Session' }))
      .resolves.toBeUndefined();
    await expect(detail.queryByRole('button', { name: 'Fix CI Session opened' }))
      .resolves.toBeUndefined();
    await expect(detail.queryByText('Fix CI in a Session')).resolves.toBeUndefined();
  });
});
