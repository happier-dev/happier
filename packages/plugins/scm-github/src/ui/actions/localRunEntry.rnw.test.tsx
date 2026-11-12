// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { createForgeCiAdapterV1, createForgeCiReadsV1 } from '@happier-dev/forge-ci/runtime';
import { ForgeCiRunDetailView, type ForgeCiBindingV1 } from '@happier-dev/forge-ci/ui';
import { Button, defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { ForgeCiActionInputSchemasV1, ForgeCiRunV1Schema, type ForgeCiOperationIdV1 } from '@happier-dev/triage-protocol/ci/v1';
import { createForgeCiConformanceVectorsV1 } from '@happier-dev/triage-protocol/ci/testing/v1';
import { PluginError, type PluginContributionRef } from '@happier-dev/plugin-sdk';
import { LOCAL_ACT_ACTION_IDS, LocalActRunFormInputV1Schema } from '../../actions/local/contracts.js';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { githubLocalRunOpenIntentV1 } from './localRunEntry.js';
import { useGithubLocalRunOpenV1 } from '../forge/actions/localRun.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the supplied local action in the shared default job panel', () => {
  it('settles a local-form refusal as typed guest state without an unhandled rejection or automatic replay', async () => {
    const settlements: unknown[] = [];
    const inputs: unknown[] = [];
    let available = false;
    let fixture: PluginUiTestkit | undefined;
    const surfaceContext = createSurfaceContextFixture({
      target: { kind: 'project', projectKey: 'project-workflows',
        checkout: { id: 'checkout', serverId: 'home', machineId: 'primary', rootPath: '/repo',
          label: null, createdAtMs: 1, lastOpenedAtMs: null } },
    });
    try {
      await act(async () => {
        fixture = await createPluginUiTestkit({
          identity: { instanceId: 'local-refusal', mountNonce: 'local-refusal' },
          authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
          surfaceContext,
          adapter: createPluginUiRnwSemanticSurfaceAdapter({}),
          surface: defineUiSurface(context => {
            const open = useGithubLocalRunOpenV1(context);
            return <Button title="Open local form" onPress={async () => {
              settlements.push(await open?.({ workflowPath: '.github/workflows/ci.yml' }));
            }} />;
          }),
          handlers: { executeAction: async ({ action, input }) => {
            expect(action).toEqual({ pluginId: GITHUB_PLUGIN_ID, localId: LOCAL_ACT_ACTION_IDS.form });
            inputs.push(LocalActRunFormInputV1Schema.parse(input));
            if (!available) throw new PluginError({ code: 'unavailable', retryable: false,
              diagnostics: [{ code: 'plugin_surface_client_action_unavailable', severity: 'error' }] });
            return { kind: 'opened', mountId: 'form-mount' };
          } },
        });
      });
      if (!fixture) throw new Error('Missing mounted surface');
      await fixture.press(await fixture.getByRole('button', { name: 'Open local form' }));
      expect(settlements).toEqual([expect.objectContaining({ status: 'error', code: 'unavailable', retryable: false,
        diagnostics: [{ code: 'plugin_surface_client_action_unavailable', severity: 'error' }] })]);
      await act(async () => {
        for (let n = 0; n < 10; n++) await fixture!.updateSurface({ ...surfaceContext, textScale: n % 2 ? 1 : 1.1 });
      });
      expect(inputs).toHaveLength(1);
      available = true;
      await fixture.press(await fixture.getByRole('button', { name: 'Open local form' }));
      expect(settlements[1]).toEqual({ status: 'success', requestId: expect.any(String), result: { kind: 'opened', mountId: 'form-mount' } });
      expect(inputs).toEqual([0, 1].map(() => ({ operation: { kind: 'open', seed: {
        target: { kind: 'project', projectId: 'project-workflows' },
        workspace: { serverId: 'home', workspaceId: 'checkout', machineId: 'primary', rootPath: '/repo' },
        workflowPath: '.github/workflows/ci.yml',
      } } })));
    } finally {
      await act(async () => { await fixture?.dispose(); });
    }
  });

  it('opens the same strict form from admitted run/job facts without starting a process or acquiring more CI context', async () => {
    const native = createForgeCiConformanceVectorsV1().github;
    const run = ForgeCiRunV1Schema.parse({ ...native.run, headSha: 'a'.repeat(40), workflow: { id: 'ci', path: '.github/workflows/ci.yml' } });
    const actionRefs = Object.fromEntries(Object.keys(ForgeCiActionInputSchemasV1).map(operation => [
      operation, { pluginId: GITHUB_PLUGIN_ID, localId: operation },
    ])) as Record<ForgeCiOperationIdV1, PluginContributionRef>;
    const calls: string[] = [];
    const adapter = createForgeCiAdapterV1({ actionRefs, invoke: async action => {
      calls.push(action.localId);
      if (action.localId === 'readRun') return { kind: 'value', value: run };
      if (action.localId === 'listJobs') return { kind: 'value', value: {
        rows: [native.job], omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null,
      } };
      return { kind: 'unsupported', reason: 'Not requested by this fixture' };
    } });
    const reads = createForgeCiReadsV1({ adapter, scopeKey: 'local-entry' });
    const ci: ForgeCiBindingV1 = { reads, adapter, actionRefs, account: null, about: { forgeName: 'GitHub' } };
    const workspace = { serverId: 'home', workspaceId: 'checkout', machineId: 'primary', rootPath: '/repo' };
    const target = { kind: 'project', projectId: 'project-workflows' } as const;
    const opened: unknown[] = [];
    let fixture: PluginUiTestkit | undefined;
    try {
      await act(async () => {
        fixture = await createPluginUiTestkit({
          identity: { instanceId: 'local-entry', mountNonce: 'local-entry' },
          authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
          surfaceContext: createSurfaceContextFixture(),
          adapter: createPluginUiRnwSemanticSurfaceAdapter({}),
          surface: defineUiSurface(context => <ForgeCiRunDetailView
            ci={ci} selection={native.job.ref.selection} presentation="pane"
            selectedJobId={native.job.ref.jobId} onOpenJob={() => undefined}
            renderJobAction={({ run, job }) => <Button title="Open local form" onPress={() => {
              const intent = githubLocalRunOpenIntentV1({ target, workspace,
                ...(run.workflow?.path === undefined ? {} : { workflowPath: run.workflow.path }),
                ...(run.headSha === undefined ? {} : { sourceHeadSha: run.headSha }),
                // A native id/name is deliberately not accepted as a YAML key without a parsed definition.
                yamlJobId: job.ref.jobId,
              });
              void context.hostApi.executeAction({ pluginId: GITHUB_PLUGIN_ID, localId: LOCAL_ACT_ACTION_IDS.form }, intent);
            }} />}
          />),
          handlers: { executeAction: async ({ action, input }) => {
            if (typeof action !== 'object') throw new Error('Expected qualified Action');
            calls.push(action.localId);
            opened.push(LocalActRunFormInputV1Schema.parse(input));
            return { kind: 'opened', mountId: 'form-mount' };
          } },
        });
      });
      if (!fixture) throw new Error('Missing mounted surface');
      const control = await fixture.getByRole('button', { name: 'Open local form' });
      expect(opened).toHaveLength(0);
      const readsBeforeOpen = calls.filter(id => id !== LOCAL_ACT_ACTION_IDS.form);
      await fixture.press(control);
      expect(opened).toEqual([{ operation: { kind: 'open', seed: { target, workspace,
        workflowPath: '.github/workflows/ci.yml', sourceHeadSha: 'a'.repeat(40),
      } } }]);
      expect(calls.filter(id => id !== LOCAL_ACT_ACTION_IDS.form)).toEqual(readsBeforeOpen);
      expect(calls.filter(id => id === LOCAL_ACT_ACTION_IDS.form)).toHaveLength(1);
      expect(calls).not.toContain(LOCAL_ACT_ACTION_IDS.run);
      expect(calls).not.toContain('projects.compute.exec');
      expect(calls).not.toContain('readTrigger');
      expect(calls).not.toContain('readJob');
    } finally {
      await act(async () => { await fixture?.dispose(); reads.retire(); });
    }
  });
});
