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

describe('AE.P02.F4-shell-check: command input through the real Machine', () => {
  let fixture: TeamSetupFFixture | undefined;
  afterEach(async () => { await fixture?.stop(); fixture = undefined; }, 0);

  it('delivers structured JSON and declared environment values without interpreting them as shell syntax, then closes stdin', async () => {
    fixture = await startTeamSetupFFixture({ testDir: await mkdtemp(join(tmpdir(), 'ae-p02-f4-command-')) });
    const account = await fixture.createAccount('actor');
    const machine = await fixture.enrollDaemon(account);
    const payload = { actionId: 'example.deploy', phase: 'before', value: '$(touch injected); "quoted" & literal\nnext line' };
    const result = await account.execute('machines.command.run', {
      command: process.platform === 'win32'
        ? 'powershell -NoProfile -Command "$inputText = [Console]::In.ReadToEnd(); [Console]::Out.Write($inputText); [Console]::Error.Write($env:HAPPIER_ACTION_ID)"'
        : 'cat; printf "%s" "$HAPPIER_ACTION_ID" >&2',
      stdin: payload,
      env: { HAPPIER_ACTION_ID: payload.actionId },
    }, { presentUserConfirmation: { actionId: 'machines.command.run' },
      externalActionTarget: { kind: 'machine', machineId: machine.target.machineId,
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } });
    expect(result).toMatchObject({ ok: true, result: { exitCode: 0, stdout: JSON.stringify(payload), stderr: payload.actionId } });

    const failed = await account.execute('machines.command.run', {
      command: process.platform === 'win32'
        ? 'powershell -NoProfile -Command "[Console]::Error.Write([Console]::In.ReadToEnd()); exit 7"'
        : 'cat >&2; exit 7',
      stdin: payload,
    }, { presentUserConfirmation: { actionId: 'machines.command.run' },
      externalActionTarget: { kind: 'machine', machineId: machine.target.machineId,
        project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } });
    expect(failed).toMatchObject({ ok: false, errorCode: 'command_failed',
      details: { exitCode: 7, stdout: '', stderr: JSON.stringify(payload) } });
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

    const result = await actor.execute(DEPLOYMENT_DEPLOY_ACTION_ID_V1, deployInput, {
      defaultSessionId: session.sessionId, presentUserConfirmation: { actionId: DEPLOYMENT_DEPLOY_ACTION_ID_V1 },
    });
    let refusal: unknown = result;
    if (result.ok) {
      const pending = ActionApprovalRequestCreatedResultSchema.parse(result.result);
      await waitFor(async () => {
        const request = ApprovalRequestGetResultV1Schema.parse(await invoke('approval.request.get', { artifactId: pending.artifactId })).request;
        if (!request.execution) return false;
        refusal = request.execution;
        return true;
      }, { failFast: true, context: 'Shell check settles the original deployment request' });
    }
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
