import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AutomationV3RunListResponseSchema, buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { ActionApprovalRequestCreatedResultSchema, readActionFailurePresentationV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalRequestGetResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { createWorkflowActionTriggerEventDeclarationV1 } from '@happier-dev/protocol/workflows/workflowTriggerEventReferenceV1';
import { startAutomationsEverywhereDeploymentFixture } from '../../src/testkit/automationsEverywhereDeployment';
import { fetchJson } from '../../src/testkit/http';
import { startTeamSetupFFixture, type TeamSetupFFixture } from '../../src/testkit/teamSetupF';
import { waitFor } from '../../src/testkit/timing';
import { runCliJson } from '../../src/testkit/uiE2e/cliJson';

describe('AE.P02.F4-shell-check: command input through the real Machine', () => {
  let fixture: TeamSetupFFixture | undefined;
  afterEach(async () => { await fixture?.stop(); fixture = undefined; }, 0);

  it('delivers literal JSON and environment values, then retains failed shell output through CLI approval reads', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'ae-p02-f4-command-'));
    fixture = await startTeamSetupFFixture({ testDir });
    const account = await fixture.createAccount('actor');
    const machine = await fixture.enrollDaemon(account);
    const payload = { actionId: 'example.deploy', phase: 'before', value: '$(touch injected); "quoted" & literal\nnext line' };
    const result = await account.executeReviewed('machines.command.run', {
      command: process.platform === 'win32'
        ? 'powershell -NoProfile -Command "$inputText = [Console]::In.ReadToEnd(); [Console]::Out.Write($inputText); [Console]::Error.Write($env:HAPPIER_ACTION_ID)"'
        : 'cat; printf "%s" "$HAPPIER_ACTION_ID" >&2',
      stdin: payload,
      env: { HAPPIER_ACTION_ID: payload.actionId },
    }, { externalActionTarget: { kind: 'machine', machineId: machine.target.machineId,
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } });
    expect(result).toMatchObject({ ok: true, result: { exitCode: 0, stdout: JSON.stringify(payload), stderr: payload.actionId } });

    const failedInput = {
      command: process.platform === 'win32'
        ? 'powershell -NoProfile -Command "[Console]::Out.Write(\'partial\'); [Console]::Error.Write([Console]::In.ReadToEnd()); exit 7"'
        : 'printf partial; cat >&2; exit 7',
      stdin: payload,
    };
    const cli = (label: string, args: string[]) => runCliJson({ testDir, cliHomeDir: machine.homeDir,
      serverUrl: fixture!.server.baseUrl, webappUrl: fixture!.server.baseUrl, label,
      env: { ...process.env, NODE_OPTIONS: fixture!.sourceOptions,
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1' },
      launchOptions: { preferSourceEntrypoint: true, skipSharedDepsBuild: true }, acceptedExitCodes: [1],
      args: ['--server-url', fixture!.server.baseUrl, ...args] });
    // The noninteractive CLI hands this deferred request to the app. The
    // deciding person executes it; the original CLI returns its durable receipt.
    const pending = await cli('shell-failure-request', ['actions', 'invoke', 'machines.command.run',
      '--machine-id', machine.target.machineId, '--project-directory', machine.workspaceDir,
      '--input-json', JSON.stringify(failedInput), '--json']);
    expect(pending).toMatchObject({ ok: true });
    const { artifactId } = ActionApprovalRequestCreatedResultSchema.parse(pending.data);
    expect(await account.executeAsPerson('approval.request.decide', { artifactId, decision: 'approve' }))
      .toMatchObject({ ok: true });
    let retained: unknown;
    await waitFor(async () => {
      const read = await account.execute('approval.request.get', { artifactId });
      expect(read.ok).toBe(true);
      if (!read.ok) return false;
      const { request } = ApprovalRequestGetResultV1Schema.parse(read.result);
      retained = request.execution;
      return request.status === 'failed';
    }, { failFast: true, context: 'CLI shell failure is retained after person approval' });
    const expected = { ok: false, errorCode: 'command_failed',
      details: { exitCode: 7, stdout: 'partial', stderr: JSON.stringify(payload) } };
    expect(retained).toMatchObject(expected);
    const reopened = await cli('shell-failure-reopened', ['actions', 'invoke', 'approval.request.get',
      '--input-json', JSON.stringify({ artifactId }), '--json']);
    expect(reopened).toMatchObject({ ok: true, data: { request: { status: 'failed', execution: expected } } });
  }, 0);

  it('runs a saved shell check with the safe Action payload before deploying and refuses its non-zero exit', async () => {
    const setup = await startAutomationsEverywhereDeploymentFixture(await mkdtemp(join(tmpdir(), 'ae-p02-f4-trigger-')));
    fixture = setup.fixture;
    const { actor, machine, invoke, deployInput, docker } = setup;
    const session = await fixture.assertKnownGoodSessionControl(actor, machine);
    const event = createWorkflowActionTriggerEventDeclarationV1('before').event;
    const literal = '$(touch injected); "quoted" & literal\nnext line';
    const privateStderr = 'PRIVATE-COMMAND-STDERR';
    const command = process.platform === 'win32'
      ? 'powershell -NoProfile -Command "[IO.File]::WriteAllText(\'f4.stdin.json\', [Console]::In.ReadToEnd()); [IO.File]::WriteAllText(\'f4.action\', $env:HAPPIER_ACTION_ID); [IO.File]::WriteAllText(\'f4.phase\', $env:HAPPIER_PHASE); [Console]::Error.Write(\'PRIVATE-COMMAND-STDERR\'); exit 7"'
      : 'cat > f4.stdin.json; printf "%s" "$HAPPIER_ACTION_ID" > f4.action; printf "%s" "$HAPPIER_PHASE" > f4.phase; printf PRIVATE-COMMAND-STDERR >&2; exit 7';
    const saved = WorkflowTriggerWriteResultV1Schema.parse(await invoke('workflow.trigger.add', {
      actionApproval: 'automatic',
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      target: { kind: 'inline', definition: { version: 1,
        inputs: [],
        blocks: [{ kind: 'action', id: 'check', actionId: 'machines.command.run', input: {
          command: { kind: 'literal', value: command },
          stdin: { kind: 'object', fields: { actionId: { kind: 'trigger_event', event, path: ['actionId'] },
            phase: { kind: 'trigger_event', event, path: ['phase'] }, literal: { kind: 'literal', value: literal } } },
          env: { kind: 'object', fields: { HAPPIER_ACTION_ID: { kind: 'trigger_event', event, path: ['actionId'] },
            HAPPIER_PHASE: { kind: 'trigger_event', event, path: ['phase'] } } },
        } }],
      } },
      trigger: { kind: 'action', enabled: true, phase: 'before', mode: 'wait', onFailure: 'refuse',
        actionIds: [DEPLOYMENT_DEPLOY_ACTION_ID_V1] },
    }));
    expect(saved.set.target).toMatchObject({ kind: 'inline', definition: { blocks: [{
      input: { command: { kind: 'literal', value: command } },
    }] } });

    const refusal = await actor.executeWithApproval(DEPLOYMENT_DEPLOY_ACTION_ID_V1, deployInput, async artifactId => {
      const read = await actor.execute('approval.request.get', { artifactId });
      expect(read.ok, JSON.stringify(read)).toBe(true);
      if (!read.ok) throw new Error(read.errorCode);
      const { request } = ApprovalRequestGetResultV1Schema.parse(read.result);
      expect(request).toMatchObject({ actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1, status: 'open',
        automaticChecks: { humanApprovalRequired: true, runs: [] } });
      const decision = await actor.executeAsPerson('approval.request.decide', { artifactId, decision: 'approve' });
      expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
      return decision;
    }, {
      defaultSessionId: session.sessionId,
    });
    expect(refusal).toMatchObject({ ok: false, errorCode: 'action_interception_rejected', details: { message: expect.any(String) } });
    if (!refusal || typeof refusal !== 'object' || !('errorCode' in refusal) || !('details' in refusal)) {
      throw new Error('Missing typed shell-check refusal');
    }
    const presentation = readActionFailurePresentationV1(refusal.errorCode, refusal.details);
    expect(presentation).toMatchObject({ kind: 'workflow_refusal', messageTrust: 'workflow_supplied_untrusted', message: expect.any(String) });
    expect(presentation?.message).not.toContain(privateStderr);
    expect(JSON.stringify(refusal)).not.toContain(privateStderr);
    expect(JSON.parse(await readFile(join(machine.workspaceDir, 'f4.stdin.json'), 'utf8')))
      .toEqual({ actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1, phase: 'before', literal });
    expect(await readFile(join(machine.workspaceDir, 'f4.action'), 'utf8')).toBe(DEPLOYMENT_DEPLOY_ACTION_ID_V1);
    expect(await readFile(join(machine.workspaceDir, 'f4.phase'), 'utf8')).toBe('before');
    expect((await docker.readInvocations()).filter(call => call.args[0] === 'compose' && call.args.includes('up'))).toEqual([]);
    const response = await fetchJson<unknown>(`${fixture.server.baseUrl}/v3/automations/${encodeURIComponent(saved.set.automationId)}/runs`, {
      headers: { Authorization: `Bearer ${actor.credentials.token}`,
        ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) },
    });
    expect(response.status).toBe(200);
    const runs = AutomationV3RunListResponseSchema.parse(response.data).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ state: 'failed', errorCode: expect.any(String) });
    expect(runs[0]?.errorCode).toBeTruthy();
    expect(presentation?.message).toContain(runs[0]!.errorCode!);
  }, 0);
});
