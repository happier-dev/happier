// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { defineUiSurface, Tabs } from '@happier-dev/plugin-ui';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriagePostMutationCompletionProvider } from '@happier-dev/triage-sources/ui';
import { afterEach, describe, expect, it } from 'vitest';

import { AZURE_DEVOPS_PLUGIN_ID } from '../../azureDevopsContracts.js';
import { AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS } from '../../triage/detailActions.js';

import { renderSurface } from '../renderSurface.js';

/**
 * What the Files walk owes a reader whose page did not arrive.
 *
 * The reducer keeps the rows already read and keeps the **Show more files**
 * control mounted and enabled beside the failure, so the panel is visibly
 * offering another attempt. Whether that attempt reaches Azure is decided by the
 * walk's own non-advancing guard, and the guard has to tell two positions apart:
 * one this walk consumed, which must never be read twice, and one that failed,
 * which was never read at all.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const FIXTURE = createTriageSourceV1Fixture();

const ITERATIONS_RESULT = {
  kind: 'iterations',
  rows: [{ id: 2, createdAtMs: 200, reason: 'push' }],
  currentIterationId: 2,
  omittedRowCount: 0,
  projectionTruncated: false,
} as unknown as JsonValue;

function changesPage(
  path: string,
  next: Readonly<{ nextSkip: number; nextTop: number }> | null,
): JsonValue {
  return {
    kind: 'iterationChanges',
    iterationId: 2,
    rows: [{ path, changeType: 'edit', isFolder: false }],
    omittedRowCount: 0,
    projectionTruncated: false,
    ...(next === null ? {} : next),
  } as unknown as JsonValue;
}

const PAGE_REFUSED = {
  kind: 'unavailable',
  failure: { class: 'transient', code: 'azure-devops/page-refused' },
} as unknown as JsonValue;

const changeInputs: unknown[] = [];
const mounted: PluginUiTestkit[] = [];
/** Successive answers for the iteration-changes walk, by request order. */
let changesAnswers: readonly JsonValue[] = [];

async function mountDetail(panel?: string, policies?: JsonValue, commits?: JsonValue, rootOptions: Readonly<{
  visible: () => boolean;
  readIterations: (signal: AbortSignal) => Promise<JsonValue>;
}> | null = null): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-161', mountNonce: 'fixture-mount-161' },
      authorPlugin: { id: AZURE_DEVOPS_PLUGIN_ID, version: '0.0.0' },
      surface: defineUiSurface((context) => (
        <TriagePostMutationCompletionProvider onComplete={async () => {}}>
          {rootOptions === null ? renderSurface(context) : <Tabs value={rootOptions.visible() ? 'source' : 'session'}
            onValueChange={() => {}} ariaLabel="Detail planes" tabList="host">
            <Tabs.Item value="source" title="Source" retention="retain">{renderSurface(context)}</Tabs.Item>
            <Tabs.Item value="session" title="Session" />
          </Tabs>}
        </TriagePostMutationCompletionProvider>
      )),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: { ...FIXTURE.detailInput, ...(panel === undefined ? {} : { panel }) } as unknown as JsonValue,
      handlers: {
        executeAction: async ({ action, input, signal }) => {
          const localId = (action as Readonly<{ localId?: string }>).localId ?? '';
          if (localId === AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.readIterations) {
            if (rootOptions !== null) return await rootOptions.readIterations(signal);
            return ITERATIONS_RESULT;
          }
          if (localId === AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.readPolicies && policies !== undefined) return policies;
          if (localId === AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.listCommits && commits !== undefined) return commits;
          if (localId === AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS.listIterationChanges) {
            const index = changeInputs.length;
            changeInputs.push(input);
            return changesAnswers[index] ?? changesPage('/src/tail.ts', null);
          }
          return { kind: 'unavailable', failure: { class: 'transient', code: 'unused' } } as JsonValue;
        },
      },
    });
  });
  mounted.push(fixture);
  return fixture;
}

async function openFiles(detail: PluginUiTestkit): Promise<void> {
  await act(async () => {
    await detail.press(await detail.getByRole('tab', { name: 'Files' }));
  });
}

async function pressShowMore(detail: PluginUiTestkit): Promise<void> {
  await act(async () => {
    await detail.press(await detail.getByRole('button', { name: 'Show more files' }));
  });
}

afterEach(async () => {
  changeInputs.splice(0);
  changesAnswers = [];
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the mounted Azure DevOps Files walk after a refused page', () => {
  it('keeps the settled shared root iteration while the source is hidden', async () => {
    let visible = true;
    let reads = 0;
    const detail = await mountDetail('activity', undefined, {
      kind: 'commits', rows: [], omittedRowCount: 0, projectionTruncated: false,
    }, {
      visible: () => visible,
      readIterations: async () => {
        reads += 1;
        return reads === 1 ? ITERATIONS_RESULT : await new Promise<JsonValue>(() => {});
      },
    });
    await expect(detail.getByText('Iteration 2')).resolves.toBeDefined();
    visible = false;
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    visible = true;
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    // Returning must use the exact settled iteration, not wait for a replacement read.
    await expect(detail.getByText('Iteration 2')).resolves.toBeDefined();
    expect(reads).toBe(1);
  });
  it('pauses the shared root iteration read while the source is hidden', async () => {
    let visible = true;
    const signals: AbortSignal[] = [];
    const detail = await mountDetail('overview', undefined, undefined, {
      visible: () => visible,
      readIterations: async (signal) => {
        signals.push(signal);
        return await new Promise<JsonValue>(() => {});
      },
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    visible = false;
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    visible = true;
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    expect(signals.at(-1)?.aborted).toBe(false);
    await act(async () => { await detail.retire(); });
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
  it('composes host Activity as a story while keeping commits and the shared iteration', async () => {
    const detail = await mountDetail('activity', undefined, {
      kind: 'commits', rows: [{ commitId: 'abc123', comment: 'Source-only commit.', author: 'Mara' }],
      omittedRowCount: 0, projectionTruncated: false,
    });
    await expect(detail.getByRole('heading', { name: 'Activity' })).resolves.toBeDefined();
    await expect(detail.getByText('Source-only commit.')).resolves.toBeDefined();
    await expect(detail.getByText('Iteration 2')).resolves.toBeDefined();
    await expect(detail.queryByRole('tab')).resolves.toBeUndefined();
  });
  it.each([
    ['approved', false, 'Passed'],
    ['rejected', false, '1 failed'],
    ['running', false, 'Running'],
    ['approved', true, null],
    ['future-provider-state', false, null],
  ] as const)('reports only complete, known policy evidence in the story (%s, partial %s)', async (status, evaluationsPartial, label) => {
    const detail = await mountDetail('overview', {
      kind: 'policies', statuses: [],
      evaluations: [{ evaluationId: 'required-policy', status, isBlocking: true, isBuildValidation: true }],
      evaluationsPartial, omittedRowCount: 0, projectionTruncated: false,
    });
    if (label === null) {
      await expect(detail.queryByRole('heading', { name: 'Policies' })).resolves.toBeUndefined();
      await expect(detail.queryByRole('image', { name: 'Passed' })).resolves.toBeUndefined();
    } else {
      await expect(detail.getByRole('heading', { name: 'Policies' })).resolves.toBeDefined();
      await expect(detail.getByRole('image', { name: label })).resolves.toBeDefined();
    }
  });
  it('renders the host Overview story from the current iteration, with no invented policy state', async () => {
    const detail = await mountDetail('overview');
    await expect(detail.getByRole('heading', { name: 'The ask' })).resolves.toBeDefined();
    await expect(detail.getByRole('heading', { name: 'What changed' })).resolves.toBeDefined();
    await expect(detail.getByText('/src/tail.ts')).resolves.toBeDefined();
    await expect(detail.queryByRole('tab')).resolves.toBeUndefined();
    await expect(detail.queryByRole('heading', { name: 'Policies' })).resolves.toBeUndefined();
  });
  it('asks Azure again for the position it refused', async () => {
    changesAnswers = [
      changesPage('/src/first.ts', { nextSkip: 30, nextTop: 30 }),
      PAGE_REFUSED,
      changesPage('/src/second.ts', null),
    ];
    const detail = await mountDetail();
    await openFiles(detail);
    await expect(detail.getByText('/src/first.ts')).resolves.toBeDefined();

    await pressShowMore(detail);
    // Kept, not blanked: the failure sits beside the file already read.
    await expect(detail.getByText('/src/first.ts')).resolves.toBeDefined();
    expect(changeInputs).toHaveLength(2);

    await pressShowMore(detail);

    // The refused position was never read, so the reader's second press must
    // reach it rather than being swallowed by the non-advancing guard.
    expect(changeInputs).toHaveLength(3);
    expect(changeInputs[2]).toMatchObject({ iterationId: 2, skip: 30, top: 30 });
    await expect(detail.getByText('/src/second.ts')).resolves.toBeDefined();
  });

  it('still stops a position Azure served once and then advertised again', async () => {
    changesAnswers = [
      changesPage('/src/first.ts', { nextSkip: 30, nextTop: 30 }),
      changesPage('/src/second.ts', { nextSkip: 30, nextTop: 30 }),
    ];
    const detail = await mountDetail();
    await openFiles(detail);
    await pressShowMore(detail);

    await expect(detail.getByText('/src/second.ts')).resolves.toBeDefined();
    expect(changeInputs).toHaveLength(2);
    // That position DID answer. Re-following it is the loop the walk refuses,
    // and releasing failed positions must not release a consumed one: the walk
    // ends here instead of offering the control again.
    await expect(detail.queryByRole('button', { name: 'Show more files' }))
      .resolves.toBeUndefined();
  });
});
