import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import {
  ExternalActionRequestEnvelopeV1Schema,
  ExternalActionResponseEnvelopeV1Schema,
} from '@happier-dev/protocol/actions/externalActionApi';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installOwnMachineApprovalReplayBoundary } from '@/dev/testkit/harness/approvalInbox';

vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
await loadSyncSingletonForTests();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

describe('present-user decision on an Agent-requested Machine Action', () => {
  beforeEach(async () => {
    await harness.reset();
  });
  afterEach(() => {
    standardCleanup();
  });

  const serverIdentityId = 'srv_keeper_home';
  const machineId = 'keeper-machine';
  const sessionId = 'keeper-session';
  const decideContext = (serverId: string) => ({
    surface: 'ui' as const,
    authority: 'present_user' as const,
    serverId,
    defaultSessionId: sessionId,
    actionCaller: { kind: 'host' as const },
  });

  // READY143 keeper journey: an Agent turn asked to run a Project script on its
  // own Machine; the person approves it from the app with no intervening input.
  async function seedKeeperAsk(credential: 'account' | 'terminal') {
    const serverId = await harness.addHome({
      name: 'Keeper Home',
      serverUrl: 'https://keeper.test',
      accountId: 'alice',
      serverIdentityId,
      currentAccount: true,
      ...(credential === 'terminal' ? { credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: 'alice',
        provenance: AuthTokenProvenanceSchema.parse({ v: 1, kind: 'terminal', authority: 'account_automation' }),
        tokenEpoch: 0 })).toString('base64url')}.signature` } } : {}),
    });
    await installOwnMachineApprovalReplayBoundary({
      harness,
      serverId,
      accountId: 'alice',
      machineId,
    });
    const actionArgs = {
      workspace: {
        serverId: serverIdentityId,
        workspaceId: 'keeper-workspace',
        machineId,
        rootPath: '/tmp/keeper',
      },
      selection: {
        kind: 'native',
        source: {
          kind: 'native',
          tool: 'make',
          file: 'Makefile',
          target: 'keeper',
        },
      },
    };
    const request = ApprovalRequestV2Schema.parse({
      v: 2,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId },
      requestedSurface: 'agent',
      origin: {
        kind: 'transcript_tool_call',
        sessionId,
        toolCallId: 'keeper-tool-call',
      },
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'agent',
        approvalProfileId: null,
        caller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
        // The daemon's creator-local profile id differs from this device's.
        serverId: 'daemon-local-profile',
        serverIdentityId,
        accountId: 'alice',
        sessionId,
        machineId,
        callerPermissionMode: 'yolo',
        causalPermissionAuthority: {
          kind: 'admittedSessionInputV1',
          admittedPermissionCeiling: 'yolo',
        },
        sessionInputSource: {
          sourceSessionId: sessionId,
          sourceTurnId: 'keeper-turn',
          sourceInputId: 'keeper-input',
          via: 'action',
        },
        target: { kind: 'machine', machineId },
        actionId: 'projects.script.run',
        requestId: 'keeper-request',
      },
      approval: { flow: 'deferred', result: 'required' },
      actionId: 'projects.script.run',
      actionArgs,
      summary:
        'Run one of the scripts a project declares, on a machine you choose.',
    });
    const { captureLazyActionAccountContext } =
      await import('./actionAccountContext');
    const account = await captureLazyActionAccountContext(serverId);
    let artifactId: string;
    try {
      artifactId = await account.createArtifact(
        buildApprovalRequestArtifactHeaderV1(request),
        JSON.stringify(request),
      );
    } finally {
      account.dispose();
    }
    return { serverId, artifactId };
  }

  it('delivers the approval to the origin daemon instead of refusing it as stale', async () => {
    const { serverId, artifactId } = await seedKeeperAsk('account');
    harness.answer(serverId, '/v1/actions/approval.request.decide', {
      select: (input) => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
        expect(envelope.input).toMatchObject({
          artifactId,
          decision: 'approve',
        });
        return {
          body: ExternalActionResponseEnvelopeV1Schema.parse({
            v: 1,
            actionId: 'approval.request.decide',
            requestId: envelope.requestId,
            execution: { ok: true, result: { ok: true, status: 'executed' } },
          }),
        };
      },
    });

    const result = await createDefaultActionExecutor().execute(
      'approval.request.decide',
      { artifactId, decision: 'approve' },
      decideContext(serverId),
    );

    expect(result).not.toMatchObject({ errorCode: 'approval_stale' });
    expect(
      harness.requestsFor('/v1/actions/approval.request.decide'),
    ).toHaveLength(1);
  });

  // The READY143 client signed in with a CLI identity's terminal credential. It
  // cannot approve as the person, so the Ask stays open for one who can, and the
  // refusal names that fact instead of calling the unchanged request stale.
  it('refuses a terminal sign-in before recording consent and keeps the Ask open', async () => {
    const { serverId, artifactId } = await seedKeeperAsk('terminal');
    const executor = createDefaultActionExecutor();

    const result = await executor.execute(
      'approval.request.decide',
      { artifactId, decision: 'approve' },
      decideContext(serverId),
    );

    expect(result).toMatchObject({ ok: false, errorCode: 'present_user_required', effectAttempted: false });
    expect(harness.requestsFor('/v1/actions/approval.request.decide')).toHaveLength(0);
    expect(await executor.execute('approval.request.get', { artifactId }, decideContext(serverId)))
      .toMatchObject({ ok: true, result: { request: { status: 'open' } } });
  });
});
