import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ApprovalRequestGetResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { MachineAccessGrantsListResponseV1Schema, type MachineAccessGrantSetInputV1 } from '@happier-dev/protocol/machines/machineAccessV1';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { readAccountIdFromToken } from '../../../../apps/cli/src/cloud/decodeJwtPayload';
import { startProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { runCliJson } from '../../src/testkit/uiE2e/cliJson';
import { waitFor } from '../../src/testkit/timing';
import { fetchJson } from '../../src/testkit/http';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';

describe('AE.P02 approved effect', () => {
  let fixture: Awaited<ReturnType<typeof startProjectDaemonFixture>> | undefined;
  afterEach(async () => { await fixture?.stop(); fixture = undefined; }, 0);


  it('continues the real CLI Account effect with a visible Skip when its own check has an assignment but no invoking Machine', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'ae-p02-no-machine-'));
    fixture = await startProjectDaemonFixture({ testDir,
      serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const actor = await fixture.createAccount('actor');
    const machine = await fixture.enrollDaemon(actor, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const linkCheck = () => actor.executeAsPerson('workflow.trigger.add', {
      actionApproval: 'automatic', project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      target: { kind: 'inline', definition: { version: 1, inputs: [], blocks: [
        { kind: 'action', id: 'check', actionId: 'machines.command.run', input: {
          command: { kind: 'literal', value: process.platform === 'win32'
            ? 'powershell -NoProfile -Command "[IO.File]::WriteAllText(\'r24-check.txt\', \'check\'); exit 7"'
            : 'printf check > r24-check.txt; exit 7' },
        } },
      ] } },
      trigger: { kind: 'action', phase: 'before', mode: 'wait', onFailure: 'refuse', enabled: true,
        actionIds: ['account.name.set'] },
    });
    const cliHomeDir = join(testDir, 'no-machine-home');
    const { serverId: cliServerId } = await seedCliAuthForTestAccount({ cliHome: cliHomeDir,
      serverUrl: fixture.server.baseUrl, auth: actor.auth, mode: 'dataKey' });
    // The shared auth fixture seeds a fake local Machine for daemon tests;
    // this independent signed-in device deliberately has no local Machine.
    const settingsPath = join(cliHomeDir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ ...JSON.parse(await readFile(settingsPath, 'utf8')),
      machineIdByServerId: {}, machineIdConfirmedByServerByServerId: {} }));
    const cli = (label: string, args: string[]) => runCliJson({ testDir, cliHomeDir,
      serverUrl: fixture!.server.baseUrl, webappUrl: fixture!.server.baseUrl, label,
      env: { ...process.env, NODE_OPTIONS: fixture!.sourceOptions,
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1' },
      launchOptions: { preferSourceEntrypoint: true, skipSharedDepsBuild: true },
      args: ['--server-url', fixture!.server.baseUrl, ...args] });
    expect(await cli('no-machine-auth', ['auth', 'status', '--json'])).toMatchObject({ ok: true,
      data: { authenticated: true, machineRegistered: false, daemonRunning: false } });
    const readApproval = async (artifactId: string) => {
      const result = await actor.execute('approval.request.get', { artifactId });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      return ApprovalRequestGetResultV1Schema.parse(result.result).request;
    };
    const control = await cli('no-machine-control', ['actions', 'invoke', 'account.name.set',
      '--server-id', cliServerId,
      '--input-json', JSON.stringify({ name: 'R24 Account control' }), '--json']);
    expect(control).toMatchObject({ ok: true });
    const baseline = ActionApprovalRequestCreatedResultSchema.parse(control.data);
    expect(await actor.executeAsPerson('approval.request.decide', { artifactId: baseline.artifactId, decision: 'approve' }))
      .toMatchObject({ ok: true });
    await waitFor(async () => (await readApproval(baseline.artifactId)).status === 'executed',
      { failFast: true, context: 'Known-good no-Machine CLI Account effect settles' });
    expect(await actor.executeAsPerson('account.profile.get', {})).toMatchObject({ ok: true, result: { name: 'R24 Account control' } });

    const linked = await linkCheck();
    expect(linked.ok, JSON.stringify(linked)).toBe(true);
    if (!linked.ok) throw new Error(linked.errorCode);
    const saved = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
    const pending = await cli('no-machine-effect', ['actions', 'invoke', 'account.name.set',
      '--server-id', cliServerId,
      '--input-json', JSON.stringify({ name: 'R24 Account effect' }), '--json']);
    expect(pending).toMatchObject({ ok: true });
    const { artifactId } = ActionApprovalRequestCreatedResultSchema.parse(pending.data);
    const request = await readApproval(artifactId);
    expect(request.executionOriginV1).not.toHaveProperty('machineId');
    expect(request.executionOriginV1).not.toHaveProperty('target');
    expect(request.automaticChecks).toMatchObject({ selected: [], runs: [], notices: [{
      code: 'action_automation_skipped', reason: 'machineRequired', automationId: saved.set.automationId,
      triggerId: saved.triggerId,
    }] });
    expect(await actor.executeAsPerson('approval.request.decide', { artifactId, decision: 'approve' })).toMatchObject({ ok: true });
    await waitFor(async () => (await readApproval(artifactId)).status === 'executed',
      { failFast: true, context: 'No-Machine Account effect continues after the visible check Skip' });
    expect(await actor.executeAsPerson('account.profile.get', {})).toMatchObject({ ok: true, result: { name: 'R24 Account effect' } });
    expect((await readApproval(artifactId)).automaticChecks).toMatchObject({ selected: [], runs: [] });
    await expect(access(join(machine.workspaceDir, 'r24-check.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 0);

  it('selects a newly saved unscoped before check on the real CLI command and refuses its original effect after approval', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'ae-p02-command-before-'));
    fixture = await startProjectDaemonFixture({ testDir,
      serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const actor = await fixture.createAccount('actor');
    const machine = await fixture.enrollDaemon(actor, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const cli = (label: string, command: string) => runCliJson({ testDir, cliHomeDir: machine.homeDir,
      serverUrl: fixture!.server.baseUrl, webappUrl: fixture!.server.baseUrl, label,
      env: { ...process.env, NODE_OPTIONS: fixture!.sourceOptions,
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1', HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1' },
      launchOptions: { preferSourceEntrypoint: true, skipSharedDepsBuild: true },
      args: ['--server-url', fixture!.server.baseUrl, 'actions', 'invoke', 'machines.command.run',
        '--machine-id', machine.target.machineId, '--project-directory', machine.workspaceDir,
        '--input-json', JSON.stringify({ command }), '--json'] });
    const readApproval = async (artifactId: string) => {
      const result = await actor.execute('approval.request.get', { artifactId });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.errorCode);
      return ApprovalRequestGetResultV1Schema.parse(result.result).request;
    };
    // Establish the real command/approval path before adding the check, also
    // warming the daemon's initially empty Account index.
    const control = await cli('before-command-control', 'echo control');
    expect(control).toMatchObject({ ok: true });
    const baseline = ActionApprovalRequestCreatedResultSchema.parse(control.data);
    expect(await actor.executeAsPerson('approval.request.decide', { artifactId: baseline.artifactId, decision: 'approve' }))
      .toMatchObject({ ok: true });
    await waitFor(async () => (await readApproval(baseline.artifactId)).status === 'executed',
      { failFast: true, context: 'Known-good CLI command approval settles' });

    const check = process.platform === 'win32'
      ? 'powershell -NoProfile -Command "[IO.File]::WriteAllText(\'seed-check-ran.txt\', \'check\'); exit 7"'
      : 'printf check > seed-check-ran.txt; exit 7';
    const effect = process.platform === 'win32'
      ? 'powershell -NoProfile -Command "[IO.File]::WriteAllText(\'seed-effect.txt\', \'effect\')"'
      : 'printf effect > seed-effect.txt';
    const linked = await actor.executeAsPerson('workflow.trigger.add', {
      actionApproval: 'automatic', project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      target: { kind: 'inline', definition: { version: 1, inputs: [], blocks: [
        { kind: 'action', id: 'check', actionId: 'machines.command.run',
          input: { command: { kind: 'literal', value: check } } },
      ] } },
      trigger: { kind: 'action', phase: 'before', mode: 'wait', onFailure: 'refuse', enabled: true,
        actionIds: ['machines.command.run'] },
    });
    expect(linked.ok, JSON.stringify(linked)).toBe(true);
    if (!linked.ok) throw new Error(linked.errorCode);
    const saved = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
    const freshIndex = await fetchJson<unknown>(`${fixture.server.baseUrl}${AUTOMATION_ACTION_INDEX_HTTP_PATH_V1}`, {
      headers: { Authorization: `Bearer ${actor.auth.token}` },
    });
    expect(freshIndex.status).toBe(200);
    expect(ActionAutomationIndexV1Schema.parse(freshIndex.data).rows).toContainEqual(expect.objectContaining({
      automationId: saved.set.automationId, triggerId: saved.triggerId, phase: 'before',
    }));
    const invoked = await cli('before-command-request', effect);
    expect(invoked).toMatchObject({ ok: true });
    const pending = ActionApprovalRequestCreatedResultSchema.parse(invoked.data);
    expect(await readApproval(pending.artifactId)).toMatchObject({ status: 'open', automaticChecks: {
      selected: [expect.objectContaining({ automationId: saved.set.automationId, triggerId: saved.triggerId })],
      runs: [], humanApprovalRequired: true,
    } });
    expect(await actor.executeAsPerson('approval.request.decide', { artifactId: pending.artifactId, decision: 'approve' }))
      .toMatchObject({ ok: true });
    await waitFor(async () => (await readApproval(pending.artifactId)).status === 'failed',
      { failFast: true, context: 'Failing before command refuses the approved original Action' });
    expect(await readApproval(pending.artifactId)).toMatchObject({ execution: {
      ok: false, errorCode: 'action_interception_rejected',
    }, automaticChecks: { phase: 'refused', runs: [expect.any(Object)], results: [expect.objectContaining({ outcome: 'failed' })] } });
    expect(await readFile(join(machine.workspaceDir, 'seed-check-ran.txt'), 'utf8')).toBe('check');
    await expect(access(join(machine.workspaceDir, 'seed-effect.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 0);

  it('resumes an approved deferred Machine grant with an empty check selection and settles its receipt', async () => {
    let observingDecision = false;
    const observeBoundary = (phase: string, request: Readonly<{ method: string; path: string; statusCode: number | null }>) => {
      if (observingDecision) console.info('Approved effect HTTP boundary', {
        phase, method: request.method, path: new URL(request.path, 'http://fixture').pathname, status: request.statusCode,
      });
    };
    fixture = await startProjectDaemonFixture({
      testDir: await mkdtemp(join(tmpdir(), 'ae-p02-approved-effect-')),
      serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' },
      requestObservation: {
        onRequestStart: request => observeBoundary('request', request),
        beforeForwardResponse: request => observeBoundary('response', request),
      },
    });
    const actor = await fixture.createAccount('custodian');
    expect((await fixture.claimHomeOwner(actor)).result.status).toBe('claimed');
    const machine = await fixture.enrollDaemon(actor, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const madeTeam = await actor.executeAsPerson('teams.create', { v: 1, name: 'Approved Machine users',
      requestKey: randomUUID(), initialOwnerAccountId: readAccountIdFromToken(actor.credentials.token) });
    expect(madeTeam.ok, JSON.stringify(madeTeam)).toBe(true);
    if (!madeTeam.ok) throw new Error(madeTeam.errorCode);
    const principal = { kind: 'team' as const, teamId: TeamSummaryV1Schema.parse(madeTeam.result).id };

    const invoked = await actor.execute('machines.access.grant.set', {
      ...machine.target, principal, level: 'view',
    } satisfies MachineAccessGrantSetInputV1, { machineId: machine.target.machineId });
    expect(invoked.ok, JSON.stringify(invoked)).toBe(true);
    if (!invoked.ok) throw new Error(invoked.errorCode);
    const pending = ActionApprovalRequestCreatedResultSchema.parse(invoked.result);
    const readApproval = async () => {
      const read = await actor.execute('approval.request.get', { artifactId: pending.artifactId });
      expect(read.ok, JSON.stringify(read)).toBe(true);
      if (!read.ok) throw new Error(read.errorCode);
      return ApprovalRequestGetResultV1Schema.parse(read.result).request;
    };
    expect(await readApproval()).toMatchObject({ status: 'open', approval: { flow: 'deferred' },
      automaticChecks: { selected: [], runs: [], humanApprovalRequired: true } });

    observingDecision = true;
    const decided = await actor.executeAsPerson('approval.request.decide', {
      artifactId: pending.artifactId, decision: 'approve',
    });
    const receipt = await readApproval();
    expect(receipt).toMatchObject({ status: 'executed', execution: { ok: true },
      automaticChecks: { phase: 'passed', selected: [], runs: [] } });
    expect(decided.ok, JSON.stringify(decided)).toBe(true);
    const grants = await actor.execute('machines.access.grants.list', machine.target);
    expect(grants.ok, JSON.stringify(grants)).toBe(true);
    if (!grants.ok) throw new Error(grants.errorCode);
    expect(MachineAccessGrantsListResponseV1Schema.parse(grants.result).grants)
      .toContainEqual(expect.objectContaining({ principal, level: 'view' }));
  }, 0);
});
