// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { defineUiSurface, Stack, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import type { ForgeCiRunV1 } from '@happier-dev/triage-protocol/ci/v1';
import { createForgeCiConformanceVectorsV1 } from '@happier-dev/triage-protocol/ci/testing/v1';
import { useGithubRunsCollectionV1 } from './runsCollectionModel.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  await act(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
  });
});

function runs(): readonly ForgeCiRunV1[] {
  const vector = createForgeCiConformanceVectorsV1().github.run;
  const now = Date.now();
  const running: ForgeCiRunV1 = {
    ...vector,
    ref: { ...vector.ref, runId: '1' },
    title: 'Running run',
    state: {
      phase: 'running',
      outcome: null,
      outcomeBucket: 'pending',
      nativeLabel: 'in_progress',
    },
    createdAtMs: now - 10_000,
    startedAtMs: now - 10_000,
    currentAttempt: undefined,
  };
  const done = Array.from({ length: 60 }, (_, index): ForgeCiRunV1 => ({
    ...vector,
    ref: { ...vector.ref, runId: String(index + 2) },
    title: `Settled ${index}`,
    state: {
      phase: 'completed',
      outcome: 'success',
      outcomeBucket: 'passed',
      nativeLabel: 'success',
    },
    createdAtMs: now - (index + 1) * 3_600_000,
    startedAtMs: now - (index + 1) * 3_600_000,
    completedAtMs: now - (index + 1) * 3_600_000 + 60_000,
    currentAttempt: undefined,
  }));
  return [running, ...done];
}

describe('the Actions runs Collection under a live duration', () => {
  it('ticks only the running row’s time leaf; sections and anatomy keep identity', async () => {
    const page = {
      rows: runs(),
      omittedRowCount: 0,
      projectionTruncated: false,
      continuation: null,
      incomplete: null,
    };
    const sections = new Set<unknown>();
    const anatomies = new Set<unknown>();
    let modelRenders = 0;
    const onOpenChange = () => {};
    const translate = (_key: string, fallback: string) => fallback;
    function Body() {
      const { anatomy, model } = useGithubRunsCollectionV1({
        page,
        translate,
        openKey: null,
        onOpenChange,
      });
      modelRenders += 1;
      sections.add(model.sections);
      anatomies.add(anatomy);
      const running = page.rows[0]!;
      return (
        <Stack>
          {anatomy.titleMeta?.(running)}
          <Text value={model.sections.length > 0 ? "rows-ready" : "rows-empty"} />
        </Stack>
      );
    }
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: {
          instanceId: 'runs-collection',
          mountNonce: 'runs-collection-mount',
        },
        authorPlugin: { id: 'fixture.forge', version: '0.0.0' },
        surface: defineUiSurface(() => <Body />),
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        launchInput: null,
      });
    });
    mounted.push(fixture);
    await fixture.getByText('rows-ready');
    const rendersBefore = modelRenders;
    // The running row's time leaf is mounted and ticks each second for these 2.3 s.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_300));
    });
    // The clock lives in the leaf: the list body neither re-renders nor rebuilds its model on ticks.
    expect(modelRenders).toBe(rendersBefore);
    expect(sections.size).toBe(1);
    expect(anatomies.size).toBe(1);
  });
});

describe('the Actions run row facts', () => {
  it('names the workflow under a run only when the title does not already say it', async () => {
    const vector = createForgeCiConformanceVectorsV1().github.run;
    const workflow = { ...vector.workflow!, id: 'wf-deploy' };
    const base: ForgeCiRunV1 = { ...vector, workflow, number: 7, headRef: 'main' };
    const named: ForgeCiRunV1 = { ...base, title: 'Deploy' };
    const own: ForgeCiRunV1 = { ...base, ref: { ...base.ref, runId: '8' }, title: 'Fix the login redirect' };
    const untitled: ForgeCiRunV1 = { ...base, ref: { ...base.ref, runId: '9' }, title: undefined };
    const translate = (_key: string, fallback: string) => fallback;
    const workflowNames = new Map([['wf-deploy', 'Deploy']]);
    function Body() {
      const { anatomy } = useGithubRunsCollectionV1({ page: { rows: [named, own, untitled], continuation: null, incomplete: null },
        translate, workflowNames, openKey: null, onOpenChange: () => {} });
      return (
        <Stack>
          {[named, own, untitled].map((run) => <Text key={run.ref.runId} value={`${run.ref.runId}: ${String(anatomy.description?.(run))}`} />)}
        </Stack>
      );
    }
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'runs-facts', mountNonce: 'runs-facts-mount' },
        authorPlugin: { id: 'fixture.forge', version: '0.0.0' },
        surface: defineUiSurface(() => <Body />),
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        launchInput: null,
      });
    });
    mounted.push(fixture);
    await fixture.getByText(`${named.ref.runId}: #7 · main`);
    await fixture.getByText('8: Deploy #7 · main');
    await fixture.getByText('9: main');
  });
});
