// @vitest-environment jsdom
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { afterEach, describe, expect, it } from 'vitest';

import { BITBUCKET_PLUGIN_ID } from '../../bitbucketContracts.js';
import { BITBUCKET_TRIAGE_DETAIL_ACTION_IDS } from '../../triage/source/detailContracts.js';

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
  /** A scripted answer per invocation, for cases whose contract is a sequence of reads. */
  scripted?: (localId: string, signal: AbortSignal) => JsonValue | undefined | Promise<JsonValue>,
): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-162', mountNonce: 'fixture-mount-162' },
      authorPlugin: { id: BITBUCKET_PLUGIN_ID, version: '0.0.0' },
      surface: renderSurface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput,
      handlers: {
        executeAction: async ({ action, signal }) => {
          const localId = (action as Readonly<{ localId?: string }>).localId ?? '';
          return scripted?.(localId, signal) ?? results[localId] ?? ({
            kind: 'unavailable',
            failure: { class: 'transient', code: 'unset' },
          } as unknown as JsonValue);
        },
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
  it('composes host Activity as a story while keeping native activity records', async () => {
    const detail = await mountDetail({ ...FIXTURE.detailInput, panel: 'activity' } as unknown as JsonValue, {
      [BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listActivity]: {
        kind: 'activity', rows: [{ key: 'approval-1', kind: 'approval', rawKind: 'approval', actor: 'Mara', summary: 'Source-only approval.' }],
        omittedRowCount: 0, projectionTruncated: false,
      },
    });
    await expect(detail.getByRole('heading', { name: 'Activity' })).resolves.toBeDefined();
    await expect(detail.getByText('Source-only approval.')).resolves.toBeDefined();
    await expect(detail.queryByRole('tab')).resolves.toBeUndefined();
  });
  it('renders the host Overview as the ask and changes story, without a source tab strip', async () => {
    const detail = await mountDetail({ ...FIXTURE.detailInput, panel: 'overview' } as unknown as JsonValue);
    await expect(detail.getByRole('heading', { name: 'The ask' })).resolves.toBeDefined();
    await expect(detail.getByRole('heading', { name: 'What changed' })).resolves.toBeDefined();
    await expect(detail.queryByRole('tab')).resolves.toBeUndefined();
    await expect(detail.queryByRole('heading', { name: 'Builds' })).resolves.toBeUndefined();
  });
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
        description: '## Provider-fresh rich description\n\n**Complete body**, beyond the list summary.',
        descriptionTruncated: false,
        observation: {
          ...FIXTURE.getResult,
          snapshot: {
            ...FIXTURE.getResult.snapshot,
            summary: 'Provider-fresh pull request description',
          },
        },
      } as unknown as JsonValue,
    });

    // The semantic RNW adapter collapses whitespace; Markdown's isolated fallback remains literal.
    await expect(detail.getByText('## Provider-fresh rich description **Complete body**, beyond the list summary.'))
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

  it('keeps the native Overview description through a failed refresh and retained revisit', async () => {
    if (FIXTURE.getResult.kind !== 'present') throw new Error('fixture must be present');
    let reads = 0;
    const detail = await mountDetail(FIXTURE.detailInput as unknown as JsonValue, {}, (localId) => {
      if (localId !== BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readOverview) return undefined;
      reads += 1;
      return reads === 1 ? {
        kind: 'overview',
        observedAtMs: 1_780_000_000_000,
        observation: FIXTURE.getResult as unknown as JsonValue,
        description: 'Retained native description',
        descriptionTruncated: false,
      } : { kind: 'unavailable', failure: { class: 'transient', code: 'offline' } };
    });
    await expect(detail.getByText('Retained native description')).resolves.toBeDefined();
    await detail.press(await detail.getByRole('button', { name: 'Re-read this overview from Bitbucket' }));
    expect(reads).toBe(2);
    await expect(detail.getByText('Retained native description')).resolves.toBeDefined();
    await detail.press(await detail.getByRole('tab', { name: 'Activity' }));
    await detail.press(await detail.getByRole('tab', { name: 'Overview' }));
    expect(reads).toBe(2);
    await expect(detail.getByText('Retained native description')).resolves.toBeDefined();
  });

  it('retains settled diffstat pages when returning to Diff without another provider read', async () => {
    let reads = 0;
    const detail = await mountDetail(FIXTURE.detailInput as unknown as JsonValue, {}, (localId) => {
      if (localId !== BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readDiff) return undefined;
      reads += 1;
      if (reads > 2) return { kind: 'unavailable', failure: { class: 'transient', code: 'offline' } };
      return {
        kind: 'diff',
        files: [{ path: `src/page-${reads}.ts`, status: 'modified', linesAdded: 2, linesRemoved: 1 }],
        omittedRowCount: 0,
        projectionTruncated: false,
        ...(reads === 1 ? {
          continuation: 'diffstat-page-2',
          raw: { kind: 'available', text: 'diff --git a/retained.ts b/retained.ts', truncated: false },
        } : {}),
      };
    });
    await detail.press(await detail.getByRole('tab', { name: 'Diff' }));
    await detail.press(await detail.getByRole('button', { name: 'Show more changed files' }));
    await expect(detail.getByText('src/page-2.ts')).resolves.toBeDefined();
    await detail.press(await detail.getByRole('tab', { name: 'Activity' }));
    await detail.press(await detail.getByRole('tab', { name: 'Diff' }));
    expect(reads).toBe(2);
    await expect(detail.getByText('src/page-1.ts')).resolves.toBeDefined();
    await expect(detail.getByText('src/page-2.ts')).resolves.toBeDefined();
    await expect(detail.getByText('diff --git a/retained.ts b/retained.ts')).resolves.toBeDefined();
  });

  it('abandons an inactive Diff page and allows that same position on return', async () => {
    const page = (path: string, continuation?: string): JsonValue => ({
      kind: 'diff',
      files: [{ path, status: 'modified', linesAdded: 1, linesRemoved: 0 }],
      omittedRowCount: 0,
      projectionTruncated: false,
      ...(continuation === undefined ? {} : { continuation }),
    });
    let reads = 0;
    let pendingSignal: AbortSignal | undefined;
    let finishPending: ((value: JsonValue) => void) | undefined;
    const detail = await mountDetail(FIXTURE.detailInput as unknown as JsonValue, {}, (localId, signal) => {
      if (localId !== BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readDiff) return undefined;
      reads += 1;
      if (reads === 1) return page('settled.ts', 'next-diffstat');
      if (reads === 2) {
        pendingSignal = signal;
        return new Promise<JsonValue>((resolve) => { finishPending = resolve; });
      }
      return page('retried.ts');
    });
    await detail.press(await detail.getByRole('tab', { name: 'Diff' }));
    await detail.press(await detail.getByRole('button', { name: 'Show more changed files' }));
    await detail.press(await detail.getByRole('tab', { name: 'Activity' }));
    expect(pendingSignal?.aborted).toBe(true);
    await detail.press(await detail.getByRole('tab', { name: 'Diff' }));
    expect(reads).toBe(2);
    await expect(detail.getByText('settled.ts')).resolves.toBeDefined();
    await detail.press(await detail.getByRole('button', { name: 'Show more changed files' }));
    await expect(detail.getByText('retried.ts')).resolves.toBeDefined();
    await act(async () => { finishPending?.(page('obsolete.ts')); });
    await expect(detail.queryByText('obsolete.ts')).resolves.toBeUndefined();
    expect(reads).toBe(3);
  });

  it('retries the page a Show more press failed on, and keeps rows through a failed refresh', async () => {
    const activityPage = (actor: string, continuation?: string): JsonValue => ({
      kind: 'activity',
      rows: [{ key: `approval:${actor}`, kind: 'approval', rawKind: 'approval', actor }],
      omittedRowCount: 0,
      projectionTruncated: false,
      ...(continuation === undefined ? {} : { continuation }),
    } as unknown as JsonValue);
    const unavailable = (code: string): JsonValue => ({
      kind: 'unavailable',
      failure: { class: 'transient', code },
    } as unknown as JsonValue);

    let activityReads = 0;
    const detail = await mountDetail(FIXTURE.detailInput as unknown as JsonValue, {}, (localId) => {
      if (localId !== BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listActivity) return undefined;
      activityReads += 1;
      if (activityReads === 1) return activityPage('Reviewer One', 'activity-page-2');
      if (activityReads === 2) return unavailable('bitbucket-later-page-failed');
      if (activityReads === 3) return activityPage('Reviewer Two');
      return unavailable('bitbucket-refresh-failed');
    });

    await detail.press(await detail.getByRole('tab', { name: 'Activity' }));
    await expect(detail.getByText('Approved · Reviewer One')).resolves.toBeDefined();

    // The second page fails. The control stays mounted and enabled, so pressing it again must
    // actually retry that position rather than exit on a position the walk never consumed.
    await detail.press(await detail.getByRole('button', { name: 'Show more activity' }));
    await expect(detail.getByText('Approved · Reviewer One')).resolves.toBeDefined();
    await detail.press(await detail.getByRole('button', { name: 'Show more activity' }));
    await expect(detail.getByText('Approved · Reviewer Two')).resolves.toBeDefined();
    expect(activityReads).toBe(3);

    // An explicit refresh is a warm replacement: a refresh that fails must not leave the reader
    // with an empty panel where the last-known-good walk was.
    await detail.press(await detail.getByRole('button', {
      name: 'Re-read this activity from Bitbucket',
    }));
    expect(activityReads).toBe(4);
    await expect(detail.getByText('Approved · Reviewer One')).resolves.toBeDefined();
    await expect(detail.getByText('Approved · Reviewer Two')).resolves.toBeDefined();
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
