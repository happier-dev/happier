// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { createForgeCiConformanceVectorsV1 } from '@happier-dev/triage-protocol/ci/testing/v1';
import { PLUGIN_MANIFEST } from '../../../manifest.js';
import { GITHUB_PLUGIN_ID } from '../../../observations/githubProviderContracts.js';
import { GITHUB_CI_ACTION_IDS_V1 } from '../../../actions/actionIds.js';
import { publishGithubDeploymentReviewNoticesV1 } from '../../../actions/deploymentNotices.js';
import { decodeGithubDeploymentReviewLocationV1, GITHUB_DEPLOYMENT_REVIEW_TARGET_ACTION_ID } from '../../../actions/deploymentReviewProtocol.js';
import { renderSurface } from '../renderForgeSurface.js';
import { GithubRunDeploymentReview } from './GithubRunDeploymentReview.js';
import { useGithubCiBindingV1 } from '../../actions/useGithubCiBinding.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Notice = Parameters<PluginInvocationContext['services']['notifications']['send']>[0];
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { await act(async () => { for (const fixture of mounted.splice(0)) await fixture.dispose(); }); });

describe('deployment notice to the existing review page', () => {
  it.each(['target-pending', 'ready'] as const)('withdraws a retained review on renderer retirement while %s', async phase => {
    const renderer = new AbortController();
    const vector = createForgeCiConformanceVectorsV1().github;
    const repository = vector.run.ref.repository;
    const location = { repositoryId: '77', runId: '81', attempt: '2', environmentId: '42' };
    const ref = { ...vector.run.ref, runId: location.runId };
    const run = { ...vector.run, ref, currentAttempt: { run: ref, attemptId: location.attempt, number: 2 }, attemptCount: 2,
      state: { phase: 'waiting', outcome: null, outcomeBucket: 'pending', nativeLabel: 'waiting' } as const };
    let targetSignal: AbortSignal | undefined;
    let settleTarget: ((value: ReturnType<typeof projectNativeJsonValueForTransport>) => void) | undefined;
    const calls: string[] = [];
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: `review-retirement-${phase}`, mountNonce: `review-retirement-${phase}` },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(context => {
          const body = renderSurface({ ...context, signal: renderer.signal });
          if (body !== null && !React.isValidElement(body)) throw new Error('Expected the actual review destination');
          return body;
        }),
        surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination',
          destination: { pluginId: GITHUB_PLUGIN_ID, localId: 'deployment-review' }, container: 'appPage' }, target: { kind: 'app' } }),
        subPath: 'repositories/77/runs/81/attempts/2/environments/42',
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: { watchResource: async () => ({}), executeAction: async ({ action, signal }) => {
          if (typeof action !== 'object') throw new Error('Expected qualified Action');
          calls.push(action.localId);
          if (action.localId === GITHUB_DEPLOYMENT_REVIEW_TARGET_ACTION_ID) {
            targetSignal = signal;
            if (phase === 'target-pending') return new Promise(resolve => { settleTarget = resolve; });
            return projectNativeJsonValueForTransport({ kind: 'ready', repository, location });
          }
          if (action.localId === GITHUB_CI_ACTION_IDS_V1.readRun) return projectNativeJsonValueForTransport({ kind: 'value', value: run });
          if (action.localId === GITHUB_CI_ACTION_IDS_V1.listDeployments) return projectNativeJsonValueForTransport({ kind: 'value', value: {
            rows: [{ id: '42', selection: { kind: 'run', run: ref }, environment: { id: '42', name: 'production' }, eligible: true }],
            omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null,
          } });
          throw new Error(`No effect may run after retirement: ${action.localId}`);
        } },
      });
    });
    mounted.push(fixture);
    if (phase === 'ready') await fixture.findByRole('checkbox', { name: 'production', state: { checked: true } });
    await act(async () => { renderer.abort(); });
    // Completed host invocations release their signal forwarding; only an
    // outstanding target read still owns cancellable transport work.
    if (phase === 'target-pending') expect(targetSignal?.aborted).toBe(true);
    await act(async () => { settleTarget?.(projectNativeJsonValueForTransport({ kind: 'ready', repository, location })); });
    expect(await fixture.queryByRole('button', { name: 'Approve and deploy' })).toBeUndefined();
    if (phase === 'target-pending') expect(calls).toEqual([GITHUB_DEPLOYMENT_REVIEW_TARGET_ACTION_ID]);
  });

  it('reviews only the current run-summary attempt and an eligible environment through the same form', async () => {
    const vector = createForgeCiConformanceVectorsV1().github;
    const repository = vector.run.ref.repository;
    const ref = { ...vector.run.ref, runId: '93' };
    const run = { ...vector.run, ref, currentAttempt: { run: ref, attemptId: '5', number: 5 }, attemptCount: 5,
      state: { phase: 'waiting', outcome: null, outcomeBucket: 'pending', nativeLabel: 'waiting' } as const };
    const calls: { id: string; input: unknown }[] = [];
    function RunSummaryReview() {
      const binding = useGithubCiBindingV1(repository);
      return <GithubRunDeploymentReview reads={binding.reads} repository={repository} run={run} />;
    }
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: 'run-summary-review', mountNonce: 'run-summary-review' },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(() => <RunSummaryReview />),
        surfaceContext: createSurfaceContextFixture(),
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        // Only the public host transport is replaced: the run-summary component,
        // shared binding/read owner, eligibility hook and form all remain real.
        handlers: { watchResource: async () => ({}), executeAction: async ({ action, input }) => {
          if (typeof action !== 'object') throw new Error('Expected qualified provider Action');
          calls.push({ id: action.localId, input });
          if (action.localId === GITHUB_CI_ACTION_IDS_V1.readRun) return projectNativeJsonValueForTransport({ kind: 'value', value: run });
          if (action.localId === GITHUB_CI_ACTION_IDS_V1.listDeployments) return projectNativeJsonValueForTransport({ kind: 'value', value: {
            rows: [{ id: '41', selection: { kind: 'run', run: ref }, environment: { id: '41', name: 'restricted' }, eligible: false },
              { id: '42', selection: { kind: 'run', run: ref }, environment: { id: '42', name: 'production' }, eligible: true },
              { id: '43', selection: { kind: 'run', run: ref }, environment: { id: '43', name: 'staging' }, eligible: true }],
            omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null,
          } });
          if (action.localId === GITHUB_CI_ACTION_IDS_V1.approveDeployment) return projectNativeJsonValueForTransport({
            kind: 'outcome_unknown', affected: { repository, run: ref, environmentIds: ['43'] },
          });
          throw new Error(`Unexpected provider read: ${action.localId}`);
        } },
      });
    });
    mounted.push(fixture);
    await fixture.findByRole('checkbox', { name: 'production', state: { checked: true } });
    expect(calls.map(call => call.id).sort()).toEqual([GITHUB_CI_ACTION_IDS_V1.readRun, GITHUB_CI_ACTION_IDS_V1.listDeployments].sort());
    await act(async () => { await fixture.press(await fixture.getByRole('checkbox', { name: 'staging' })); });
    await act(async () => { await fixture.press(await fixture.getByRole('checkbox', { name: 'production' })); });
    const textarea = document.querySelector('textarea');
    if (!textarea) throw new Error('Expected the same deployment comment field');
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setValue.call(textarea, 'Reviewing this attempt only.'); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: 'Approve and deploy' })); });
    expect(calls.filter(call => call.id === GITHUB_CI_ACTION_IDS_V1.approveDeployment)).toEqual([{
      id: GITHUB_CI_ACTION_IDS_V1.approveDeployment,
      input: { repository, runId: '93', attempt: '5', environmentIds: ['43'], comment: 'Reviewing this attempt only.' },
    }]);
    expect((await fixture.getByRole('button', { name: 'Approve and deploy' })).state?.disabled).toBe(true);
  });

  it.each(['approve', 'reject'] as const)('opens the real declared destination and sends one exact %s with a comment, never replaying an uncertain answer', async decision => {
    const notices: Notice[] = [];
    // Notification delivery and the mounted host Action transport are the genuine process boundaries.
    const context = { signal: new AbortController().signal, services: { notifications: {
      send: async (notice: Notice) => { notices.push(notice); return { deliveries: [], replayed: false }; },
    } } } as unknown as PluginInvocationContext;
    expect(await publishGithubDeploymentReviewNoticesV1({
      current: [{ repositoryId: '77', runId: '81', attempt: '2', environmentId: '42', environmentName: 'production', eligible: true }],
      previous: [], manifest: PLUGIN_MANIFEST, observationId: 'checkpoint:1', isCurrent: async () => true,
    }, context)).toEqual({ kind: 'published' });
    expect(notices).toHaveLength(1);
    const page = notices[0]!.page;
    if (!page) throw new Error('The real publisher must provide an exact page destination');
    const location = decodeGithubDeploymentReviewLocationV1(page.subPath);
    if (!location) throw new Error('The published destination must be a valid environment locator');
    const vector = createForgeCiConformanceVectorsV1().github;
    const repository = vector.run.ref.repository;
    const ref = { ...vector.run.ref, runId: location.runId };
    const run = { ...vector.run, ref, currentAttempt: { run: ref, attemptId: location.attempt, number: 2 }, attemptCount: 2,
      state: { phase: 'waiting', outcome: null, outcomeBucket: 'pending', nativeLabel: 'waiting' } };
    const calls: { id: string; input: unknown }[] = [];
    const reviews: { id: string; input: unknown }[] = [];
    let fixture!: PluginUiTestkit;
    await act(async () => {
      fixture = await createPluginUiTestkit({
        identity: { instanceId: `deployment-${decision}`, mountNonce: `deployment-${decision}` },
        authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
        surface: defineUiSurface(context => {
          const body = renderSurface(context);
          if (body !== null && !React.isValidElement(body)) throw new Error('Expected the real native review page');
          return body;
        }),
        surfaceContext: createSurfaceContextFixture({ mount: { kind: 'destination',
          destination: { pluginId: GITHUB_PLUGIN_ID, localId: page.pageId }, container: 'appPage' }, target: { kind: 'app' } }),
        subPath: page.subPath,
        adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: { watchResource: async () => ({}), executeAction: async ({ action, input }) => {
          if (typeof action !== 'object') throw new Error('Expected qualified provider Action');
          calls.push({ id: action.localId, input });
          if (action.localId === GITHUB_DEPLOYMENT_REVIEW_TARGET_ACTION_ID) return projectNativeJsonValueForTransport({ kind: 'ready', repository, location });
          if (action.localId === GITHUB_CI_ACTION_IDS_V1.readRun) return projectNativeJsonValueForTransport({ kind: 'value', value: run });
          if (action.localId === GITHUB_CI_ACTION_IDS_V1.listDeployments) return projectNativeJsonValueForTransport({ kind: 'value', value: {
            rows: [{ id: '42', selection: { kind: 'run', run: ref }, environment: { id: '42', name: 'production' }, eligible: true }],
            omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null,
          } });
          if (action.localId === GITHUB_CI_ACTION_IDS_V1.approveDeployment || action.localId === GITHUB_CI_ACTION_IDS_V1.rejectDeployment) {
            reviews.push({ id: action.localId, input });
            return projectNativeJsonValueForTransport({ kind: 'outcome_unknown', affected: { repository, run: { v: 1, repository, runId: '81' }, environmentIds: ['42'] } });
          }
          throw new Error(`Unexpected provider read: ${action.localId}`);
        } },
      });
    });
    mounted.push(fixture);
    await fixture.findByRole('button', { name: 'Approve and deploy' });
    // The only environment is a live choice, not a locked one: unchecking it is how the person holds the answer.
    expect((await fixture.getByRole('checkbox', { name: 'production' })).state?.disabled).not.toBe(true);
    expect(calls.map(call => call.id).sort()).toEqual([GITHUB_DEPLOYMENT_REVIEW_TARGET_ACTION_ID,
      GITHUB_CI_ACTION_IDS_V1.readRun, GITHUB_CI_ACTION_IDS_V1.listDeployments].sort());
    expect(calls.find(call => call.id === GITHUB_DEPLOYMENT_REVIEW_TARGET_ACTION_ID)?.input).toEqual({ location: page.subPath });
    const textarea = document.querySelector('textarea');
    if (!textarea) throw new Error('Expected the existing comment field');
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setValue.call(textarea, 'Reviewed the exact environment.'); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
    const label = decision === 'approve' ? 'Approve and deploy' : 'Reject';
    await act(async () => { await fixture.press(await fixture.getByRole('button', { name: label })); });
    expect(reviews).toEqual([{ id: GITHUB_CI_ACTION_IDS_V1[decision === 'approve' ? 'approveDeployment' : 'rejectDeployment'],
      input: { repository, runId: '81', attempt: '2', environmentIds: ['42'], comment: 'Reviewed the exact environment.' } }]);
    expect((await fixture.getByRole('button', { name: label })).state?.disabled).toBe(true);
    expect(reviews).toHaveLength(1);
  });
});
