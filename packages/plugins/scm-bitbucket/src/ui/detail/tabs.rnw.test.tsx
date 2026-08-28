// @vitest-environment jsdom
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { afterEach, describe, expect, it } from 'vitest';

import { BITBUCKET_PLUGIN_ID } from '../../bitbucketContracts.js';
import { BITBUCKET_TRIAGE_DETAIL_ACTION_IDS } from '../../triage/source/detailActions.js';

import { renderSurface } from '../renderSurface.js';

/**
 * Which planes the Bitbucket pull-request detail body mounts, proven by mounting it.
 *
 * The Triage common header is the one source-neutral owner of an entry's intent and of its
 * Session relationship (`core/SURFACE.md` §2.2, `sources/SCM.md` §3.7.6). A source contributes
 * capability and provider Actions; it never contributes a second Session surface. `Work Sessions`
 * exists only on a forge's ISSUE composition, "because a PR's Session relationship is already in
 * the aggregate's common header and a second surface for it would be a second owner" — and
 * Bitbucket Cloud has exactly one entry kind, a pull request.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIXTURE = createTriageSourceV1Fixture();
const mounted: PluginUiTestkit[] = [];

async function mountDetail(
  launchInput: JsonValue,
  results: Readonly<Record<string, JsonValue>> = {},
): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        pluginId: BITBUCKET_PLUGIN_ID,
        pluginVersion: '0.0.0',
        viewId: 'bitbucket-triage-detail',
        generation: 'bitbucket-detail-tabs',
      },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput,
      handlers: {
        executeAction: async ({ action }) => results[
          (action as Readonly<{ localId?: string }>).localId ?? ''
        ] ?? ({
          kind: 'unavailable',
          failure: { class: 'transient', code: 'unset' },
        } as unknown as JsonValue),
      },
    });
  });
  mounted.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the mounted Bitbucket pull-request detail tablist', () => {
  it('mounts no source-owned Sessions plane even when the launch input carries linked Sessions', async () => {
    // The linked Sessions are present in the launch input, so a source that still owned a Sessions
    // tab would have every reason to render one. This is what makes the case discriminating: an
    // empty projection would hide the duplicate owner rather than expose it.
    const detail = await mountDetail({
      ...FIXTURE.detailInput,
      linkedSessions: [{ sessionId: 'session-1', displayTitle: 'Repair the poller' }],
    } as unknown as JsonValue);

    await expect(detail.queryByRole('tab', { name: 'Sessions' })).resolves.toBeUndefined();

    const tabs = await detail.getAllByRole('tab');
    expect(tabs.map((tab) => tab.name)).toEqual([
      'Overview',
      'Activity',
      'Diff',
      'Builds',
      'Comments',
    ]);
  });

  it('replaces the launch description with the provider-fresh Overview read', async () => {
    if (FIXTURE.getResult.kind !== 'present') throw new Error('fixture must be present');
    const detail = await mountDetail(FIXTURE.detailInput as unknown as JsonValue, {
      [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readOverview]: {
        kind: 'overview',
        observedAtMs: 1_780_000_000_000,
        observation: {
          ...FIXTURE.getResult,
          snapshot: {
            ...FIXTURE.getResult.snapshot,
            summary: 'Provider-fresh pull request description',
          },
        },
      } as unknown as JsonValue,
    });

    await expect(detail.getByText('Provider-fresh pull request description'))
      .resolves.toBeDefined();
  });

  it('renders both raw diff content and diffstat from the live Diff action', async () => {
    const detail = await mountDetail(FIXTURE.detailInput as unknown as JsonValue, {
      [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readDiff]: {
        kind: 'diff',
        files: [{ path: 'src/provider.ts', status: 'modified', linesAdded: 2, linesRemoved: 1 }],
        omittedRowCount: 0,
        projectionTruncated: false,
        raw: { kind: 'available', text: 'diff --git a/src/provider.ts b/src/provider.ts', truncated: false },
      } as unknown as JsonValue,
    });

    await detail.press(await detail.getByRole('tab', { name: 'Diff' }));
    await expect(detail.getByText('src/provider.ts')).resolves.toBeDefined();
    await expect(detail.getByText('diff --git a/src/provider.ts b/src/provider.ts'))
      .resolves.toBeDefined();
  });

  it('shows when an Action result could not carry Bitbucket\'s next-page position', async () => {
    const detail = await mountDetail(FIXTURE.detailInput as unknown as JsonValue, {
      [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listActivity]: {
        kind: 'activity',
        rows: [{
          key: 'approval:1',
          kind: 'approval',
          rawKind: 'approval',
          actor: 'Reviewer',
        }],
        omittedRowCount: 0,
        projectionTruncated: false,
        incomplete: 'continuationUnavailable',
      } as unknown as JsonValue,
    });

    await detail.press(await detail.getByRole('tab', { name: 'Activity' }));
    await expect(detail.getByText(
      'Bitbucket offered another page, but this build could not carry its position, so this list stops here.',
    )).resolves.toBeDefined();
  });
});
