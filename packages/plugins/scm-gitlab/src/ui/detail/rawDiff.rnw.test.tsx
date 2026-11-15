// @vitest-environment jsdom
import React, { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriagePostMutationCompletionProvider } from '@happier-dev/triage-sources/ui';
import { afterEach, describe, expect, it } from 'vitest';

import {
  GITLAB_CONNECTED_ACCOUNT_PURPOSE,
  GITLAB_PLUGIN_ID,
  GITLAB_TRIAGE_DETAIL_ACTION_IDS,
} from '../../triage/contribution.js';
import { renderSurface } from '../renderSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = Object.freeze({ pluginId: GITLAB_PLUGIN_ID, localId: 'gitlab-forge' });
const INSTANCE = Object.freeze({
  v: 1,
  instance: Object.freeze({ source: SOURCE, sourceInstanceId: '9d2a6b1e-6c1a-4b7d-9f31-1d4a6c8b2e70' }),
  binding: Object.freeze({
    purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
    account: Object.freeze({
      service: Object.freeze({ pluginId: GITLAB_PLUGIN_ID, localId: 'gitlab-account' }),
      accountId: 'account-1',
    }),
  }),
  localInstanceKey: 'gitlab-com',
  configuration: Object.freeze({ v: 1, token: 'gitlab-configuration-token-v1' }),
});

const LAUNCH_INPUT = {
  v: 1,
  instance: INSTANCE,
  observation: {
    entryRef: {
      source: SOURCE,
      kindId: 'merge-request',
      collisionScope: 'gitlab.com:group/project',
      entryId: '412',
    },
    observedAtMs: 1_760_000_700_000,
    locator: {
      v: 1,
      webUrl: 'https://gitlab.com/group/project/-/merge_requests/412',
      displayPath: 'group/project !412',
      routingToken: 'group/project',
    },
    snapshot: {
      v: 1,
      title: 'Review the raw evidence',
      scopeLabel: 'group/project',
      state: { presentation: 'active', nativeLabel: 'Opened' },
      facts: [],
    },
    viewer: { involvement: ['reviewRequested'] },
  },
  linkedSessions: [],
} as unknown as JsonValue;

const mounted: PluginUiTestkit[] = [];

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

const RAW_DIFF = [
  'diff --git a/src/provider.ts b/src/provider.ts',
  '--- a/src/provider.ts',
  '+++ b/src/provider.ts',
  '@@ -1,2 +1,2 @@',
  ' export const provider = 1;',
  '-export const before = 1;',
  '+export const providerAfter = 2;',
  'diff --git a/src/other.ts b/src/other.ts',
  '--- a/src/other.ts',
  '+++ b/src/other.ts',
  '@@ -1 +1 @@',
  '-export const other = 1;',
  '+export const otherAfter = 2;',
  '',
].join('\n');

const FILES_LIST = 'ul[aria-label="Files this GitLab merge request changes"]';

/** A read settles over a few host turns; wait for what it draws rather than for a fixed count of turns. */
async function settle(drawn: () => boolean): Promise<void> {
  for (let turn = 0; turn < 20 && !drawn(); turn += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}
const settleFiles = () => settle(() => document.querySelector(FILES_LIST) !== null);
const bodyText = () => document.body.textContent ?? '';

async function pressFile(detail: PluginUiTestkit, path: string): Promise<void> {
  const file = (await detail.queryAllByRole('button')).find(button => button.name?.startsWith(path));
  expect(file, path).toBeDefined();
  await act(async () => { await detail.press(file!); });
}

async function mountFiles(dispatched: string[]): Promise<PluginUiTestkit> {
  let detail!: PluginUiTestkit;
  await act(async () => {
    detail = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-193', mountNonce: 'fixture-mount-193' },
      authorPlugin: { id: GITLAB_PLUGIN_ID, version: '0.0.0' },
      surface: (context) => (
        <TriagePostMutationCompletionProvider onComplete={async () => {}}>
          {renderSurface(context) as React.ReactNode}
        </TriagePostMutationCompletionProvider>
      ),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: LAUNCH_INPUT,
      handlers: {
        executeAction: async ({ action }) => {
          const localId = (action as Readonly<{ localId?: string }>).localId ?? '';
          dispatched.push(localId);
          if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.listChanges) {
            return {
              kind: 'changes',
              rows: [
                { path: 'src/provider.ts', newFile: false, renamedFile: false, deletedFile: false, lines: { additions: 1, deletions: 1 } },
                { path: 'src/other.ts', newFile: true, renamedFile: false, deletedFile: false },
              ],
              // A deployment that does not state its diff limits is GitLab's normal answer, not a warning.
              diffLimitStatus: 'unknown',
              omittedRowCount: 0,
              projectionTruncated: false,
            } as unknown as JsonValue;
          }
          if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.readRawDiff) {
            return { kind: 'rawDiff', text: RAW_DIFF, truncated: false } as unknown as JsonValue;
          }
          return { kind: 'unavailable', failure: { class: 'transient', code: 'unset' } } as unknown as JsonValue;
        },
      },
    });
  });
  mounted.push(detail);
  return detail;
}

describe('the mounted GitLab Files panel', () => {
  it('draws the shared Files rows, with line counts and no warning for a deployment that states no diff limits', async () => {
    const dispatched: string[] = [];
    const detail = await mountFiles(dispatched);
    await detail.press(await detail.getByRole('tab', { name: 'Changes' }));
    await settleFiles();
    const list = document.querySelector(FILES_LIST);
    expect(list).not.toBeNull();
    const content = list!.textContent ?? '';
    expect(content).toContain('src/provider.ts');
    expect(content).toContain('+1');
    expect(content).toContain('Added');
    // The tab counts the files; its normal state carries no caveat banner and no evidence button.
    expect(document.body.textContent).not.toContain('Changed files');
    expect(document.body.textContent).not.toContain('Diff-limit status unknown');
    expect(document.body.textContent).not.toContain('Load raw diff evidence');
    // Each file keeps the shared row menu.
    expect(list!.querySelectorAll('[aria-label="More actions"]')).toHaveLength(2);
  });

  it('opens one file in place from one diff read, and reads nothing until a file opens', async () => {
    const dispatched: string[] = [];
    const detail = await mountFiles(dispatched);
    await detail.press(await detail.getByRole('tab', { name: 'Changes' }));
    await settleFiles();
    expect(dispatched).not.toContain(GITLAB_TRIAGE_DETAIL_ACTION_IDS.readRawDiff);

    await pressFile(detail, 'src/provider.ts');
    await settle(() => bodyText().includes('providerAfter'));
    expect(bodyText()).toContain('providerAfter');
    expect(bodyText()).not.toContain('otherAfter');

    await pressFile(detail, 'src/other.ts');
    await settle(() => bodyText().includes('otherAfter'));
    expect(bodyText()).toContain('otherAfter');
    expect(dispatched.filter((id) => id === GITLAB_TRIAGE_DETAIL_ACTION_IDS.readRawDiff)).toHaveLength(1);
  });
});
