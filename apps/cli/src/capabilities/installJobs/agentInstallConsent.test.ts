import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { getAgentCliRuntimeSpec } from '@happier-dev/agents';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { DaemonAgentInstallStartRequestSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createAgentInstallJobOwner } from './agentInstallJobOwner';

it.skipIf(process.platform === 'win32').each(['muse', 'droid', 'fx'] as const)('approving %s installation admits its vendor recipe without a second consent', async agentId => {
  const home = await mkdtemp(join(tmpdir(), 'happier-install-consent-'));
  const bin = join(home, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'bash'), '#!/bin/sh\nexit 0\n');
  await chmod(join(bin, 'bash'), 0o755);
  const spec = getAgentCliRuntimeSpec(agentId);
  let stored: ApprovalRequestV2 | null = null;
  let jobId: string | undefined;
  const owner = createAgentInstallJobOwner({
    env: { HAPPIER_HOME_DIR: home, HOME: home, PATH: bin }, platform: 'linux', arch: 'x64',
    readTrackedSessions: () => [], readRegistry: () => ({ agents: [{ id: spec.id, runtimeSpec: spec, pluginId: `happier.agent.${agentId}` }] }),
    // The vendor process is the system boundary. Never execute an actual installer.
    installerDeps: { execFileWithDeadline: async () => {
      throw Object.assign(new Error('vendor process fixture refused'), { code: 1, stdout: '', stderr: 'vendor process fixture refused' });
    } },
  });
  const executor = createActionExecutor({
    ...createUnavailableActionTransportDeps(),
    approvalsCreate: async ({ request }) => { stored = ApprovalRequestV2Schema.parse(structuredClone(request)); return { artifactId: 'install-approval' }; },
    approvalsGet: async () => structuredClone(stored),
    approvalsUpdate: async ({ request, expectedStatus }) => {
      if (!stored) throw new Error('Missing approval');
      const next = ApprovalRequestV2Schema.parse(request);
      const transition = decideApprovalRequestTransition(stored, next, { expectedStatus });
      if (!transition.ok) return transition;
      stored = structuredClone(next);
      return { ok: true };
    },
    isApprovalExecutionOriginCurrent: async () => true,
    machineAgentInstallStart: async request => {
      const started = owner.start(DaemonAgentInstallStartRequestSchema.parse({ agentId: request.agentId, intent: request.intent, consent: request.consent }));
      if (started.ok) jobId = started.jobId;
      return started;
    },
  });
  const context = { surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' },
    serverId: 'home', machineId: 'machine', actionRequestId: 'install-request' } as const;
  try {
    expect(await executor.execute('machines.agents.install', { machineId: 'machine', agentId, intent: 'install' }, context))
      .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(jobId).toBeUndefined();
    expect(await executor.execute('approval.request.decide', { artifactId: 'install-approval', decision: 'approve' },
      { ...context, surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true, result: { status: 'executed' } });
    if (!jobId) throw new Error('Approval did not admit the install job');
    const terminal = await owner.read({ jobId, cursor: 0, waitForTerminal: true });
    // The deliberate process refusal must survive; consent_required means approval was lost.
    expect(terminal).toMatchObject({ ok: true, done: true, outcome: {
      kind: 'failed', code: 'install_failed', message: expect.stringContaining('vendor process fixture refused'),
    } });
    expect(ApprovalRequestV2Schema.parse(stored).actionArgs).toMatchObject({ consent: { vendorRecipe: true } });
  } finally {
    await owner.shutdown();
    await rm(home, { recursive: true, force: true });
  }
});
