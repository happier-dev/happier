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

describe('the mounted GitLab raw-diff evidence read', () => {
  it('does not read on first paint and renders labelled raw text after the user asks', async () => {
    const dispatched: string[] = [];
    let detail!: PluginUiTestkit;
    await act(async () => {
      detail = await createPluginUiTestkit({
        identity: {
          pluginId: GITLAB_PLUGIN_ID,
          pluginVersion: '0.0.0',
          viewId: 'gitlab-detail',
          generation: 'gitlab-raw-diff',
        },
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
                rows: [{
                  path: 'src/provider.ts',
                  newFile: false,
                  renamedFile: false,
                  deletedFile: false,
                  collapsed: false,
                  tooLarge: false,
                }],
                diffLimitStatus: 'reported',
                omittedRowCount: 0,
                projectionTruncated: false,
              } as unknown as JsonValue;
            }
            if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.readRawDiff) {
              return {
                kind: 'rawDiff',
                text: 'diff --git a/src/provider.ts b/src/provider.ts',
                truncated: false,
              } as unknown as JsonValue;
            }
            return {
              kind: 'unavailable',
              failure: { class: 'transient', code: 'unset' },
            } as unknown as JsonValue;
          },
        },
      });
    });
    mounted.push(detail);

    expect(dispatched).not.toContain(GITLAB_TRIAGE_DETAIL_ACTION_IDS.readRawDiff);
    await detail.press(await detail.getByRole('tab', { name: 'Changes' }));
    await expect(detail.getByText('src/provider.ts')).resolves.toBeDefined();
    expect(dispatched).not.toContain(GITLAB_TRIAGE_DETAIL_ACTION_IDS.readRawDiff);

    await detail.press(await detail.getByRole('button', { name: 'Load raw diff evidence' }));
    await expect(detail.getByText('Raw diff evidence · returned as text by GitLab'))
      .resolves.toBeDefined();
    await expect(detail.getByText('diff --git a/src/provider.ts b/src/provider.ts'))
      .resolves.toBeDefined();
    expect(dispatched.filter((id) => id === GITLAB_TRIAGE_DETAIL_ACTION_IDS.readRawDiff))
      .toHaveLength(1);
  });
});
