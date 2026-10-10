import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows';
import * as machineTransport from '@/session/transport/rpc/machineRpc';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createTestWorkflowCoordinator, createInMemoryWorkflowCoordinatorStore } from './workflowCoordinator.testkit';
import { createCoordinatorWorkspaceResolver } from './resolveWorkflowWorkspace';
import { readWorkflowProjectSetupConsentHold } from './stepExecution';
import { createGitWorkflowWorkspaceTestDependencies } from './workflowWorkspace.testkit';

afterEach(() => vi.restoreAllMocks());

describe('Workflow Project setup consent custody', () => {
  it('does not reinterpret changed script invocation review as setup consent', () => {
    expect(readWorkflowProjectSetupConsentHold('projects.script.run', {
      ok: false, errorCode: 'project_script_effect_changed', error: 'project_script_effect_changed',
      details: { kind: 'pendingApproval', reviewedEffectDigest: 'script-effect', reviewedEffect: { commands: [] } },
    })).toBeNull();
  });
  it.each(['project_setup_consent_required', 'project_setup_effect_changed'] as const)
  ('holds %s on the original invocation and Machine, then resumes only after fresh human consent', async code => {
    const store = createInMemoryWorkflowCoordinatorStore();
    const rootPath = await mkdtemp(join(tmpdir(), 'workflow-project-consent-'));
    try {
    const agentTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } } as const;
    const workspaceRef = { workspaceId: 'workspace', serverId: 'home', machineId: 'machine', rootPath };
    const workflow: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: { agentTarget }, blocks: [
      { kind: 'action', id: 'prepare', actionId: 'projects.prepare', input: {
        workspace: { kind: 'literal', value: workspaceRef }, phase: { kind: 'literal', value: 'setup' },
      } },
      { kind: 'step', id: 'after', document: { text: 'after', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
    ] };
    let trusted = false;
    let downstream = false;
    const requests: { actionRequestId?: string; input: unknown }[] = [];
    // Only the external authenticated Machine RPC is stubbed. The CLI Project
    // adapter, invocation policy, workspace resolver and coordinator remain real.
    vi.spyOn(machineTransport, 'callExactMachineRpc').mockImplementation(async ({ request, requestId, machineId }) => {
      expect(machineId).toBe(workspaceRef.machineId);
      requests.push({ actionRequestId: requestId, input: request });
      return trusted ? { kind: 'notRequired', reviewedEffectDigest: 'reviewed' } : {
        ok: false, errorCode: code, error: code,
        details: { kind: 'pendingApproval', code,
          reviewedEffect: { commands: [] }, reviewedEffectDigest: 'reviewed' },
      };
    });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'requester' })).toString('base64url')}.signature`;
    const { executor } = createCliActionExecutorHarness({ token, credentials: { token, encryption: null },
      sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://home.test' });
    const coordinator = createTestWorkflowCoordinator({ store, isAcceptedAuthorizationCurrent: async () => true,
      resolveWorkspace: createCoordinatorWorkspaceResolver({ store,
        projectWorkspace: { machineId: 'machine', directory: rootPath, checkoutRootPath: rootPath },
        scm: createGitWorkflowWorkspaceTestDependencies() }),
      executeStep: async () => { downstream = true; return { kind: 'completed', result: 'after' }; },
      action: { executor, buildContext: async () => ({ surface: 'agent', authority: 'account_automation',
        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'projects.prepare': ['agent'] } }) }),
        observeRun: async () => { throw new Error('no_agent_started'); } },
    });
    const input = { runId: 'run', definition: workflow, inputs: {}, executionTarget: { kind: 'session' as const },
      authorization: { admittedPermissionCeiling: 'default' as const, principal: { kind: 'host' as const } } };
    expect(await coordinator.run(input)).toMatchObject({ state: 'interrupted' });
    const held = store.list().find(row => row.blockId === 'prepare');
    expect(held).toMatchObject({ lifecycle: 'needs_attention', reason: code, attempt: 0,
      workspace: { descriptor: { machineId: 'machine' } }, execution: { kind: 'action', input: { workspace: workspaceRef } } });
    expect(held?.review).toBeUndefined();
    expect(downstream).toBe(false);
    // Resume without consent is not a reviewer grant or an Action waiver.
    expect(await coordinator.run(input)).toMatchObject({ state: 'interrupted' });
    expect(store.list().find(row => row.blockId === 'prepare')?.recordId).toBe(held?.recordId);
    expect(downstream).toBe(false);
    trusted = true;
    expect(await coordinator.run(input)).toMatchObject({ state: 'succeeded' });
    expect(requests.map(request => request.actionRequestId)).toEqual([requests[0]?.actionRequestId, requests[0]?.actionRequestId, requests[0]?.actionRequestId]);
    expect(requests.map(request => request.input)).toEqual([requests[0]?.input, requests[0]?.input, requests[0]?.input]);
    expect(downstream).toBe(true);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
