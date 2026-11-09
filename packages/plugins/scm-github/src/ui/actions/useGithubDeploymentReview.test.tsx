// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk';
import { createForgeCiAdapterV1, createForgeCiReadsV1 } from '@happier-dev/forge-ci/runtime';
import { ForgeCiActionInputSchemasV1, type ForgeCiOperationIdV1 } from '@happier-dev/triage-protocol/ci/v1';
import { createForgeCiConformanceVectorsV1 } from '@happier-dev/triage-protocol/ci/testing/v1';
import { useGithubDeploymentReviewV1 } from './useGithubDeploymentReview.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('deployment form data through the mounted public host', () => {
  it('withholds stale and retired review, and makes no history read until it is expanded', async () => {
    const vector = createForgeCiConformanceVectorsV1().github;
    const repository = vector.run.ref.repository;
    const ref = { ...vector.run.ref, runId: '81' };
    const run = { ...vector.run, ref, currentAttempt: { run: ref, attemptId: '2', number: 2 }, attemptCount: 2,
      state: { phase: 'waiting', outcome: null, outcomeBucket: 'pending', nativeLabel: 'waiting' } };
    const calls: string[] = [];
    const actionRefs = Object.fromEntries(Object.keys(ForgeCiActionInputSchemasV1).map(key => [key, { pluginId: 'fixture.forge', localId: key }])) as Record<ForgeCiOperationIdV1, PluginContributionRef>;
    // Action transport is the genuine host boundary; the adapter, query owner,
    // subscriptions and review hook below are all real production logic.
    const adapter = createForgeCiAdapterV1({ actionRefs, invoke: async action => {
      calls.push(action.localId);
      return { kind: 'value', value: action.localId === 'readRun' ? run : {
        rows: action.localId === 'listDeployments' ? [{ id: '42', selection: { kind: 'run', run: ref }, environment: { id: '42', name: 'production' }, eligible: true }] : [],
        omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null,
      } };
    } });
    const reads = createForgeCiReadsV1({ adapter, scopeKey: 'configured-account/monitor-origin' });
    let fixture: PluginUiTestkit | undefined;
    let current: ReturnType<typeof useGithubDeploymentReviewV1> | undefined;
    let changeAttempt!: React.Dispatch<React.SetStateAction<string>>;
    let expandHistory!: React.Dispatch<React.SetStateAction<boolean>>;
    function Body() {
      const [attempt, setAttempt] = React.useState('1');
      const [historyExpanded, setHistoryExpanded] = React.useState(false);
      changeAttempt = setAttempt;
      expandHistory = setHistoryExpanded;
      const model = useGithubDeploymentReviewV1({ reads, repository,
        location: { runId: '81', attempt, environmentId: '42' }, historyExpanded });
      current = model;
      return <Text value={`${model.stale ? 'stale' : 'current'}:${model.canReview ? 'reviewable' : 'not-reviewable'}:${model.history === null ? 'history-closed' : 'history-loaded'}`} />;
    }
    try {
      await act(async () => {
        fixture = await createPluginUiTestkit({ identity: { instanceId: 'deployment-data', mountNonce: 'deployment-data-mount' },
          authorPlugin: { id: 'fixture.forge', version: '0.0.0' }, surface: defineUiSurface(() => <Body />),
          surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(), launchInput: null });
      });
      await fixture!.getByText('stale:not-reviewable:history-closed');
      expect(calls.sort()).toEqual(['listDeployments', 'readRun']);
      expect(current!.reviewAction('approve', ['42'], 'Reviewed.')).toBeNull();
      await act(async () => { changeAttempt('2'); });
      await fixture!.getByText('current:reviewable:history-closed');
      expect(calls).toHaveLength(2);
      expect(current!.reviewAction('approve', ['42'], 'Reviewed.')).toEqual({
        action: { pluginId: 'happier.scm.forge.github', localId: 'github/actions/deployment-approve' },
        input: { repository, runId: '81', attempt: '2', environmentIds: ['42'], comment: 'Reviewed.' },
      });
      expect(current!.reviewAction('reject', ['42'], 'Needs a correction.')).toMatchObject({
        action: { localId: 'github/actions/deployment-reject' }, input: { comment: 'Needs a correction.' },
      });
      for (const ids of [[], ['42', '42'], ['99']]) {
        expect(current!.reviewAction('approve', ids, 'Reviewed.')).toBeNull();
      }
      // Preparing either declarative Action does not execute it or prefetch history.
      expect(calls).toHaveLength(2);
      await act(async () => { expandHistory(true); });
      await fixture!.getByText('current:reviewable:history-loaded');
      expect(calls.filter(operation => operation === 'readDeploymentHistory')).toHaveLength(1);
      await act(async () => { reads.retire(); });
      await fixture!.getByText('current:not-reviewable:history-closed');
      expect(current!.reviewAction('reject', ['42'], 'Needs a correction.')).toBeNull();
    } finally {
      await act(async () => { await fixture?.dispose(); });
      reads.retire();
    }
  });
});
