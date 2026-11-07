// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { defineUiSurface } from '@happier-dev/plugin-ui';
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
import { afterEach, describe, expect, it } from 'vitest';

import {
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
} from '../../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 } from '../../triage/contribution.js';
import { GITHUB_FILE_VIEWED_ACTION_IDS_V1 } from '../../triage/fileViewedContracts.js';
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
        reviewRevision: { baseSha: BASE, headSha: HEAD, nativeRevision: HEAD },
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

/**
 * The host's Viewed source for one PR, as the app's keyed owner presents it: per-path files, one status, and a
 * write that settles later. It is the host boundary the plugin consumes, not plugin logic.
 */
function createHostViewedSource(
  initial: Readonly<Record<string, ScmFileViewedFile['state']>>,
) {
  const files = new Map<string, ScmFileViewedFile>(
    PATHS.map((path) => [
      path,
      {
        state: initial[path] ?? null,
        pending: false,
        errorCode: null,
      },
    ]),
  );
  const fileListeners = new Map<string, Set<() => void>>();
  const changeListeners = new Set<(path: string) => void>();
  const writes: Array<
    Readonly<{ path: string; viewed: boolean; settle(accepted: boolean): void }>
  > = [];
  const put = (path: string, next: ScmFileViewedFile) => {
    files.set(path, next);
    for (const listener of fileListeners.get(path) ?? []) listener();
    for (const listener of changeListeners) listener(path);
  };
  const snapshot = { status: 'ready' as const, headOid: HEAD, errorCode: null };
  const source: ScmFileViewedSource = {
    getFile: (path) =>
      files.get(path) ?? { state: null, pending: false, errorCode: null },
    subscribeFile: (path, listener) => {
      const set = fileListeners.get(path) ?? new Set();
      set.add(listener);
      fileListeners.set(path, set);
      return () => {
        set.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    subscribeStatus: () => () => {},
    subscribeChanges: (listener) => {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },
    getViewedPaths: () =>
      new Set(
        [...files]
          .filter(([, file]) => file.state === 'viewed')
          .map(([path]) => path),
      ),
    setViewed: (path, viewed) =>
      new Promise<boolean>((resolve) => {
        const before = files.get(path)!;
        put(path, { ...before, pending: true, errorCode: null });
        writes.push({
          path,
          viewed,
          settle: (accepted) => {
            put(
              path,
              accepted
                ? {
                    state: viewed ? 'viewed' : 'unviewed',
                    pending: false,
                    errorCode: null,
                  }
                : {
                    state: before.state,
                    pending: false,
                    errorCode: 'github_write_refused',
                  },
            );
            resolve(accepted);
          },
        });
      }),
    refresh: async () => {},
  };
  return { source, writes };
}

const requests: ScmFileViewedRequest[] = [];
const dispatched: string[] = [];
const mounted: PluginUiTestkit[] = [];

async function mountFiles(
  source: ScmFileViewedSource,
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
      surface: defineUiSurface(context => <SourcePanelActionsFixture scope={scope}>{renderSurface(context)}</SourcePanelActionsFixture>),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({
        scmFileViewed: (request) => {
          requests.push(request);
          return request.comparison === null ? null : source;
        },
      }),
      launchInput: launchInput(),
      handlers: {
        executeAction: async ({ action, input, signal }) => {
          const localId = typeof action === 'string' ? action : action.localId;
          if (localId.startsWith('ui/')) return await invokeSourcePanelFixtureAction(scope, localId, input, fixture.context, signal);
          dispatched.push(localId);
          if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles)
            return FILES_PAGE;
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
  await act(async () => {
    await fixture.press(await fixture.getByRole('tab', { name: 'Files' }));
  });
  return fixture;
}

afterEach(async () => {
  requests.splice(0);
  dispatched.splice(0);
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('GitHub Files panel Viewed marks', () => {
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

  it('draws GitHub’s marks per file and counts them in the panel header', async () => {
    const { source } = createHostViewedSource({
      'src/alpha.ts': 'viewed',
      'src/beta.ts': 'unviewed',
      'src/gamma.ts': 'dismissed',
    });
    const files = await mountFiles(source);
    expect(document.body.textContent).toContain('1 of 4 viewed');
    expect(
      (
        await files.getByRole('checkbox', {
          name: 'alpha.ts, viewed on GitHub',
        })
      ).state?.checked,
    ).toBe(true);
    expect(
      (await files.getByRole('checkbox', { name: 'beta.ts, viewed on GitHub' }))
        .state?.checked,
    ).toBe(false);
    // Dismissed: unchecked, with a quiet note that the file changed after it was viewed.
    expect(
      (
        await files.getByRole('checkbox', {
          name: 'gamma.ts, viewed on GitHub',
        })
      ).state?.checked,
    ).toBe(false);
    expect(document.body.textContent).toContain('Changed since viewed');
    // Unknown: the slot is reserved but offers no checkbox that would read as unviewed.
    await expect(
      files.getByRole('checkbox', { name: 'delta.ts, viewed on GitHub' }),
    ).rejects.toThrow();
  });

  it('saves a toggle with a pending box, without opening the file, and keeps the mark when GitHub refuses', async () => {
    const { source, writes } = createHostViewedSource({
      'src/alpha.ts': 'viewed',
      'src/beta.ts': 'unviewed',
    });
    const files = await mountFiles(source);
    const readsBefore = dispatched.length;
    await act(async () => {
      await files.press(
        await files.getByRole('checkbox', {
          name: 'beta.ts, viewed on GitHub',
        }),
      );
    });
    expect(writes.map(({ path, viewed }) => ({ path, viewed }))).toEqual([
      { path: 'src/beta.ts', viewed: true },
    ]);
    expect(
      (await files.getByRole('checkbox', { name: 'beta.ts, viewed on GitHub' }))
        .state?.busy,
    ).toBe(true);
    // The checkbox is its own control: the row did not open its diff.
    expect(dispatched.slice(readsBefore)).toEqual([]);
    await act(async () => {
      writes[0]!.settle(true);
    });
    expect(
      (await files.getByRole('checkbox', { name: 'beta.ts, viewed on GitHub' }))
        .state?.checked,
    ).toBe(true);
    expect(document.body.textContent).toContain('2 of 4 viewed');

    await act(async () => {
      await files.press(
        await files.getByRole('checkbox', {
          name: 'alpha.ts, viewed on GitHub',
        }),
      );
    });
    await act(async () => {
      writes[1]!.settle(false);
    });
    expect(
      (
        await files.getByRole('checkbox', {
          name: 'alpha.ts, viewed on GitHub',
        })
      ).state?.checked,
    ).toBe(true);
    expect(document.body.textContent).toContain('Not saved to GitHub');
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
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        launchInput: launchInput(),
        handlers: { executeAction: async () => FILES_PAGE },
      })) as PluginUiTestkit;
    });
    mounted.push(fixture);
    await act(async () => {
      await fixture.press(await fixture.getByRole('tab', { name: 'Files' }));
    });
    expect(document.body.textContent).toContain('src/alpha.ts');
    await expect(fixture.getByRole('checkbox')).rejects.toThrow();
    expect(document.body.textContent).not.toContain('of 4 viewed');
  });
});
