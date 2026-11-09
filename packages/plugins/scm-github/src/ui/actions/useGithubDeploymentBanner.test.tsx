// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { defineUiSurface, Text, usePluginHostApi } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createForgeCiAdapterV1, createForgeCiReadsV1 } from '@happier-dev/forge-ci/runtime';
import type { ForgeCiRunV1 } from '@happier-dev/triage-protocol/ci/v1';
import { createForgeCiConformanceVectorsV1 } from '@happier-dev/triage-protocol/ci/testing/v1';
import { decodeGithubPendingDeploymentsV1 } from '../../actions/deploymentReviews.js';
import { GITHUB_CI_ACTION_REFS_V1 } from './model.js';
import { useGithubDeploymentBannerV1 } from './useGithubDeploymentBanner.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const native = createForgeCiConformanceVectorsV1().github;
const repository = native.repository;
const waiting = (id: string): ForgeCiRunV1 => ({ ...native.run, ref: { ...native.run.ref, runId: id },
  currentAttempt: { run: { ...native.run.ref, runId: id }, attemptId: '2', number: 2 },
  state: { phase: 'waiting', outcome: null, outcomeBucket: 'pending', nativeLabel: 'waiting' } });
const page = { omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null };

describe('visible pending deployment banner demand', () => {
  it('shares exact reads with review, ignores unrelated rows, retains failure truth and releases removed/retired candidates', async () => {
    const selected = waiting('81');
    const other = waiting('82');
    const pending = decodeGithubPendingDeploymentsV1([
      { environment: { id: 42, name: 'production' }, current_user_can_approve: true, reviewers: [] },
      { environment: { id: 43, name: 'restricted' }, current_user_can_approve: false, reviewers: [] },
    ], { repository, runId: '81' });
    const calls: Array<{ operation: string; runId: string | undefined }> = [];
    let unavailable = false;
    let rows = pending;
    let heldSignal: AbortSignal | undefined;
    let model!: ReturnType<typeof useGithubDeploymentBannerV1>;
    let change!: React.Dispatch<React.SetStateAction<readonly ForgeCiRunV1[]>>;
    let enabled!: React.Dispatch<React.SetStateAction<boolean>>;
    let reads!: ReturnType<typeof createForgeCiReadsV1>;
    let fixture: PluginUiTestkit | undefined;
    const unrelated = Array.from({ length: 1000 }, (_, index): ForgeCiRunV1 => ({ ...native.run, ref: { ...native.run.ref, runId: String(1000 + index) } }));
    function Body({ signal }: { signal: AbortSignal }) {
      const host = usePluginHostApi();
      const [runs, setRuns] = React.useState<readonly ForgeCiRunV1[]>([...unrelated, selected, other]);
      const [active, setActive] = React.useState(false);
      change = setRuns;
      enabled = setActive;
      const owner = React.useMemo(() => {
        const adapter = createForgeCiAdapterV1({ actionRefs: GITHUB_CI_ACTION_REFS_V1,
          invoke: (action, input, options) => host.executeAction(action, input, options) });
        return createForgeCiReadsV1({ adapter, scopeKey: 'banner' });
      }, [host]);
      reads = owner;
      React.useEffect(() => () => owner.retire(), [owner]);
      model = useGithubDeploymentBannerV1({ reads: owner, repository, runs, enabled: active, signal });
      return <Text value={`pending:${model.entries.length};unknown:${model.unavailable.length}`} />;
    }
    try {
      await act(async () => {
        fixture = await createPluginUiTestkit({ identity: { instanceId: 'deployment-banner', mountNonce: 'deployment-banner' },
          authorPlugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
          surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
          surface: defineUiSurface(context => <Body signal={context.signal} />),
          handlers: { executeAction: async ({ action, input, signal }): Promise<JsonValue> => {
            if (typeof action !== 'object') throw new Error('Expected qualified Action');
            const request = input as { runId?: string };
            calls.push({ operation: action.localId, runId: request.runId });
            if (action.localId !== GITHUB_CI_ACTION_REFS_V1.listDeployments.localId) throw new Error('Unexpected non-pending read');
            if (request.runId === '83') {
              heldSignal = signal;
              return new Promise<JsonValue>(resolve => signal.addEventListener('abort', () => resolve({ kind: 'unavailable', failure: { class: 'transient', code: 'cancelled' } }), { once: true }));
            }
            if (request.runId === '82' || unavailable) return { kind: 'unavailable', failure: { class: 'permission', code: 'github_pending_denied' } };
            return { kind: 'value', value: { ...page, rows } };
          } } });
      });
      expect(calls).toHaveLength(0);
      await act(async () => enabled(true));
      expect(calls.map(call => call.runId).sort()).toEqual(['81', '82']);
      await fixture!.getByText('pending:1;unknown:1');
      expect(model.entries[0]).toEqual({ run: selected, approval: pending[0] });
      expect(model.unavailable[0]).toMatchObject({ run: other, failure: { code: 'github_pending_denied' } });
      expect(calls.map(call => call.runId).sort()).toEqual(['81', '82']);
      const same = model.entries[0];
      const admittedApproval = same!.approval;
      // Neither waiting-only queries nor a refused pending read establish a
      // foreground polling lifecycle or retry loop.
      vi.useFakeTimers();
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      vi.useRealTimers();
      expect(calls).toHaveLength(2);
      // The already-presented review surface borrows the same canonical query;
      // another demand never executes another pending-environment acquisition.
      const review = reads.acquire('listDeployments', { repository, runId: '81' });
      await act(async () => change([...unrelated.slice().reverse(), selected, other]));
      expect(model.entries[0]).toBe(same);
      expect(calls).toHaveLength(2);
      unavailable = true;
      await act(async () => { await model.refresh(); });
      await fixture!.getByText('pending:1;unknown:2');
      expect(model.entries[0]?.approval).toBe(admittedApproval);
      expect(model.unavailable.find(value => value.run.ref.runId === '81')?.failure?.code).toBe('github_pending_denied');
      expect(calls).toHaveLength(4);
      unavailable = false;
      rows = [];
      await act(async () => { await model.refresh(); });
      await fixture!.getByText('pending:0;unknown:1');
      expect(model.entries).toHaveLength(0);
      review.release();
      await act(async () => change(unrelated));
      await fixture!.getByText('pending:0;unknown:0');
      const before = calls.length;
      await act(async () => { await model.refresh(); });
      expect(calls).toHaveLength(before);
      await act(async () => change([waiting('83')]));
      expect(heldSignal?.aborted).toBe(false);
      await act(async () => change(unrelated));
      expect(heldSignal?.aborted).toBe(true);
      await act(async () => change([selected]));
      await fixture!.getByText('pending:0;unknown:0');
      const refreshAfterRetirement = model.refresh;
      const beforeRetirement = calls.length;
      await act(async () => reads.retire());
      await fixture!.getByText('pending:0;unknown:1');
      expect(model.unavailable[0]?.reason).toBe('retired');
      await act(async () => { await fixture!.retire(); });
      await refreshAfterRetirement();
      expect(calls).toHaveLength(beforeRetirement);
    } finally { vi.useRealTimers(); await act(async () => { await fixture?.dispose(); }); }
  });
});
