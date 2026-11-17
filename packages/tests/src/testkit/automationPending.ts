import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { AutomationV3RunListResponseSchema, buildAccountStoredContentCompatibilityHttpHeadersV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';
import { ApprovalQueueListResultV1Schema, ApprovalRequestGetResultV1Schema } from '@happier-dev/protocol/approvals/approvalRequestPublicRead';
import { startTeamSetupFFixture } from './teamSetupF';
import { fetchJson } from './http';
import { waitFor } from './timing';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';

const literal = (value: string) => `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`;

/** User-authored command gate substitutes no internal Action or Run owner. */
export async function startAutomaticCheckFixture(mode: 'wait' | 'notify', onFailure?: 'refuse' | 'ask', fails = false, requestingAgent = false) {
  const directory = await mkdtemp(join(tmpdir(), 'ae-p02-pending-'));
  const fixture = await startTeamSetupFFixture({ testDir: directory, observeActionRequests: true,
    serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
  try {
    const actor = await fixture.createAccount('actor');
    const machine = await fixture.enrollDaemon(actor, { env: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
    const session = await fixture.assertKnownGoodSessionControl(actor, machine);
    const gate = join(machine.workspaceDir, 'release-check');
    const effectPath = join(machine.workspaceDir, 'effect');
    const check = process.platform === 'win32'
      ? `powershell -NoProfile -Command "while (!(Test-Path ${literal(gate)})) { Start-Sleep -Milliseconds 50 }; exit ${fails ? 7 : 0}"`
      : `while [ ! -f ${literal(gate)} ]; do sleep 0.05; done; exit ${fails ? 7 : 0}`;
    const effect = process.platform === 'win32'
      ? `powershell -NoProfile -Command "[IO.File]::WriteAllText(${literal(effectPath)}, 'effect'); [Console]::Write('effect')"`
      : `printf effect > ${literal(effectPath)}; printf effect`;
    const linked = await actor.executeAsPerson('workflow.trigger.add', {
      // The fixture person authorizes this command check at link time. Omitting
      // this keeps the Workflow leaf at its ordinary Ask, even in notify mode.
      actionApproval: 'automatic',
      target: { kind: 'inline', definition: { version: 1, blocks: [
        { kind: 'action', id: 'check', actionId: 'machines.command.run',
          input: { command: { kind: 'literal', value: check } } },
      ] } }, project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
      trigger: { kind: 'action', phase: 'before', mode, ...(onFailure ? { onFailure } : {}), enabled: true,
        actionIds: ['machines.command.run'] } });
    expect(linked.ok, JSON.stringify(linked)).toBe(true);
    if (!linked.ok) throw new Error(linked.errorCode);
    const saved = WorkflowTriggerWriteResultV1Schema.parse(linked.result);
    const agentContext = { surface: 'agent' as const, authority: 'account_automation' as const,
      actionCaller: { kind: 'session' as const, sessionId: session.sessionId, starterDepth: 0, turnDepth: 0 },
      defaultSessionId: session.sessionId, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
        'machines.command.run': ['agent'],
        'approval.request.decide': ['agent'],
      } }) };
    const context = { ...(requestingAgent ? agentContext : {}), defaultSessionId: session.sessionId, presentUserConfirmation: { actionId: 'machines.command.run' as const },
      externalActionTarget: { kind: 'machine' as const, machineId: machine.target.machineId,
        project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } };
    return { ...fixture, actor, machine, saved, effectPath, context, agentContext,
      invoke: () => actor.execute('machines.command.run', { command: effect }, context),
      async invokePending() {
        const lifetime = new AbortController();
        const invocation = actor.execute('machines.command.run', { command: effect }, { ...context, signal: lifetime.signal });
        let artifactId: string | undefined;
        await waitFor(async () => {
          const listed = await actor.execute('approval.request.list', { actionId: 'machines.command.run', status: 'open' });
          if (!listed.ok) throw new Error(listed.errorCode);
          const row = ApprovalQueueListResultV1Schema.parse(listed.result).items[0];
          artifactId = row?.artifactId;
          return artifactId !== undefined;
        }, { context: 'Automatic pending approval from the admitted Action call' });
        if (!artifactId) throw new Error('pending_approval_unavailable');
        return { artifactId, invocation, detach: () => lifetime.abort(new Error('requester_executor_restarted')) };
      },
      release: () => writeFile(gate, 'release'),
      async runs() {
        const result = await fetchJson<unknown>(`${fixture.server.baseUrl}/v3/automations/${encodeURIComponent(saved.set.automationId)}/runs`, {
          headers: { Authorization: `Bearer ${actor.credentials.token}`,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) } });
        expect(result.status).toBe(200);
        return AutomationV3RunListResponseSchema.parse(result.data).runs;
      },
      async approval(artifactId: string) {
        const result = await actor.execute('approval.request.get', { artifactId });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (!result.ok) throw new Error(result.errorCode);
        return ApprovalRequestGetResultV1Schema.parse(result.result).request;
      },
    };
  } catch (error) { await fixture.stop(); throw error; }
}

/** Source-compatible observation while the new optional arm is introduced. */
export function hasAutomaticCheckPhase(request: object, phase: string): boolean {
  return 'automaticChecks' in request && request.automaticChecks !== null && typeof request.automaticChecks === 'object'
    && 'phase' in request.automaticChecks && request.automaticChecks.phase === phase;
}
