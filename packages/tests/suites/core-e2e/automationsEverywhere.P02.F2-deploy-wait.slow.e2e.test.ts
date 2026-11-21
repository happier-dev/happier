import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AutomationV3RunListResponseSchema,
  buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalRequestGetResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import type { AutomationActionTrigger } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { connectExternalMcp, parseToolJson, type ExternalMcpClient, type ExternalMcpTransport } from '../../src/testkit/externalMcp';
import { fetchJson } from '../../src/testkit/http';
import { repoRootDir } from '../../src/testkit/paths';
import type { TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { startAutomationsEverywhereDeploymentFixture } from '../../src/testkit/automationsEverywhereDeployment';
import { waitFor } from '../../src/testkit/timing';

describe('AE.P02.F2-deploy-wait', () => {
  let fixture: TeamSetupFFixture | undefined;
  let mcp: Readonly<{ client: ExternalMcpClient; transport: ExternalMcpTransport }> | undefined;
  afterEach(async () => {
    await mcp?.client.close();
    await mcp?.transport.close();
    mcp = undefined;
    await fixture?.stop();
    fixture = undefined;
    vi.unstubAllEnvs();
  }, 0);

  it('runs no check after Deny, refuses a failed check, and deploys once after a passing check', async () => {
    const { fixture: running, actor, machine, deployInput, docker, invoke } = await startAutomationsEverywhereDeploymentFixture(
      await mkdtemp(join(tmpdir(), 'ae-p02-f2-')));
    fixture = running;
    const session = await fixture.assertKnownGoodSessionControl(actor, machine);
    vi.stubEnv('NODE_OPTIONS', fixture.sourceOptions);
    mcp = await connectExternalMcp({ cliEntrypoint: resolve(repoRootDir(), 'apps/cli/src/index.ts'),
      sessionId: session.sessionId, cliHome: machine.homeDir, serverBaseUrl: fixture.actionServerApiUrl });

    async function attachCheck(exitCode: number, filter?: AutomationActionTrigger['filter']) {
      const saved = WorkflowTriggerWriteResultV1Schema.parse(await invoke('workflow.trigger.add', {
        actionApproval: 'automatic',
        project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
        target: { kind: 'inline', definition: { version: 1, blocks: [{ kind: 'action', id: 'check',
          actionId: 'machines.command.run', input: { command: { kind: 'literal', value: `exit ${exitCode}` } } }] } },
        trigger: { kind: 'action', enabled: true, phase: 'before', mode: 'wait', onFailure: 'refuse',
          actionIds: [DEPLOYMENT_DEPLOY_ACTION_ID_V1], ...(filter ? { filter } : {}) },
      }));
      return saved;
    }
    async function runs(automationId: string) {
      const response = await fetchJson<unknown>(`${fixture!.server.baseUrl}/v3/automations/${encodeURIComponent(automationId)}/runs`, {
        headers: { Authorization: `Bearer ${actor.credentials.token}`,
          ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
      });
      expect(response.status).toBe(200);
      return AutomationV3RunListResponseSchema.parse(response.data).runs;
    }
    async function readApproval(artifactId: string) {
      return ApprovalRequestGetResultV1Schema.parse(await invoke('approval.request.get', { artifactId })).request;
    }
    async function begin() {
      const pending = mcp!.client.callTool({ name: 'action_execute', arguments: { actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1,
        input: deployInput } });
      let artifactId: string | undefined;
      // Some hosts return the ordinary pending receipt; others retain the live
      // MCP call. Both must expose the same persisted request to the CLI.
      let reply: Awaited<typeof pending> | undefined;
      let failure: unknown;
      void pending.then(value => { reply = value; }, error => { failure = error; });
      await waitFor(async () => {
        if (failure) throw failure;
        if (reply) {
          const parsed = ActionApprovalRequestCreatedResultSchema.safeParse(parseToolJson(reply));
          if (parsed.success) { artifactId = parsed.data.artifactId; return true; }
          throw new Error(`Deploy did not ask: ${JSON.stringify(reply)}`);
        }
        const listed = await invoke('approval.request.list', { status: 'open', actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1 });
        if (!listed || typeof listed !== 'object' || !('items' in listed) || !Array.isArray(listed.items)) return false;
        const item: unknown = listed.items[0];
        if (!item || typeof item !== 'object' || !('artifactId' in item) || typeof item.artifactId !== 'string') return false;
        artifactId = item.artifactId;
        return true;
      }, { failFast: true, context: 'MCP deployment asks the present person' });
      if (!artifactId) throw new Error('Missing deployment approval');
      return { artifactId, pending };
    }
    const activations = async () => (await docker.readInvocations()).filter(call => call.args[0] === 'compose' && call.args.includes('up'));
    const failed = await attachCheck(7);
    const denied = await begin();
    expect(await runs(failed.set.automationId)).toEqual([]);
    expect(await activations()).toEqual([]);
    await invoke('approval.request.decide', { artifactId: denied.artifactId, decision: 'reject' });
    expect((await readApproval(denied.artifactId)).status).toBe('rejected');
    expect(await runs(failed.set.automationId)).toEqual([]);
    await denied.pending;

    fixture.takeRequestObservations();
    const refused = await begin();
    const beforeApproval = await readApproval(refused.artifactId);
    const refusedArgs = beforeApproval.actionArgs;
    expect(beforeApproval).toMatchObject({ status: 'open', automaticChecks: { humanApprovalRequired: true, runs: [] } });
    expect(beforeApproval).not.toHaveProperty('automaticChecks.humanDecision');
    expect(await runs(failed.set.automationId)).toEqual([]);
    await invoke('approval.request.decide', { artifactId: refused.artifactId, decision: 'approve' });
    await waitFor(async () => (await readApproval(refused.artifactId)).execution?.errorCode === 'action_interception_rejected',
      { failFast: true, context: 'Failed check settles the original deployment request' });
    const failedRuns = await runs(failed.set.automationId);
    expect(failedRuns).toHaveLength(1);
    expect(failedRuns[0]?.state).toBe('failed');
    const refusedRead = await readApproval(refused.artifactId);
    expect(refusedRead.status).toBe('failed');
    expect(refusedRead).toMatchObject({ automaticChecks: { phase: 'refused',
      humanDecision: { kind: 'approve', authority: 'present_user' },
      runs: [{ automationId: failed.set.automationId, triggerId: failed.triggerId, runId: failedRuns[0]!.id }],
    } });
    expect(refusedRead.actionArgs).toEqual(refusedArgs);
    expect(refusedRead.execution).toMatchObject({ ok: false, errorCode: 'action_interception_rejected', details: { message: expect.any(String) } });
    const details = refusedRead.execution && 'details' in refusedRead.execution ? refusedRead.execution.details : undefined;
    if (!details || typeof details !== 'object' || !('message' in details) || typeof details.message !== 'string') {
      throw new Error('Failed check has no safe reason in the CLI approval read');
    }
    expect(failedRuns[0]?.errorCode).toEqual(expect.any(String));
    // A command without an authored final-output binding uses the terminal
    // code as its safe reason; stdout/stderr do not become refusal text.
    expect(details.message).toContain(failedRuns[0]!.errorCode!);
    expect(await activations()).toEqual([]);
    const refusedReply = await refused.pending;
    const deferred = ActionApprovalRequestCreatedResultSchema.safeParse(parseToolJson(refusedReply));
    const atMcp = deferred.success
      ? ApprovalRequestGetResultV1Schema.parse(parseToolJson(await mcp.client.callTool({ name: 'action_execute', arguments: {
          actionId: 'approval.request.get', input: { artifactId: refused.artifactId },
        } }))).request.execution
      : parseToolJson(refusedReply);
    if (!deferred.success) expect(refusedReply.isError).toBe(true);
    expect(atMcp).toMatchObject({ errorCode: 'action_interception_rejected', details: { message: details.message } });
    const observations = fixture.takeRequestObservations();
    expect(observations.filter(entry => entry.method === 'POST' && entry.path === `/v1/artifacts/${refused.artifactId}`)).toHaveLength(2);

    await invoke('workflow.trigger.remove', { automationId: failed.set.automationId, triggerId: failed.triggerId });
    const passed = await attachCheck(0);
    const skipped = await attachCheck(7, { v: 1, all: [{ op: 'eq', field: '/phase', value: 'after' }] });
    const approved = await begin();
    const approvalBeforeChecks = await readApproval(approved.artifactId);
    expect(approvalBeforeChecks.automaticChecks?.selected).toEqual(expect.arrayContaining([
      expect.objectContaining({ automationId: passed.set.automationId, triggerId: passed.triggerId }),
      expect.objectContaining({ automationId: skipped.set.automationId, triggerId: skipped.triggerId }),
    ]));
    expect(await runs(passed.set.automationId)).toEqual([]);
    await invoke('approval.request.decide', { artifactId: approved.artifactId, decision: 'approve' });
    await waitFor(async () => (await readApproval(approved.artifactId)).execution?.ok === true,
      { failFast: true, context: 'Passing check resumes the original deploy' });
    expect(await runs(passed.set.automationId)).toMatchObject([{ state: 'succeeded' }]);
    expect(await runs(skipped.set.automationId)).toEqual([]);
    const completed = await readApproval(approved.artifactId);
    expect(completed.actionArgs).toEqual(approvalBeforeChecks.actionArgs);
    expect(completed).toMatchObject({ automaticChecks: { phase: 'passed',
      humanDecision: { kind: 'approve', authority: 'present_user' },
      notices: expect.arrayContaining([expect.objectContaining({ code: 'action_automation_skipped',
        reason: 'conditionNotMatched', automationId: skipped.set.automationId, triggerId: skipped.triggerId })]),
    } });
    await approved.pending;
    await waitFor(async () => (await activations()).length === 1, { context: 'Exactly one real daemon deployment effect' });
    expect(await activations()).toHaveLength(1);
  }, 0);
});
