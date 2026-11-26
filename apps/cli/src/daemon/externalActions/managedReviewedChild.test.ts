import { MACHINE_REBOOT_ACTION_IDS } from '@happier-dev/protocol/machines/rebootActionIdsV1';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { readHostAdmittedReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { retainVerifiedExternalActionRequester } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  readHostReviewedParentV1,
  type ActionExecutorContext,
} from '@happier-dev/protocol/actions/actionExecutor';
import { createLocalServiceActionConfirmationNonceV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { projectServiceMoveStopInput } from '@/daemon/local/services/actions/projectServiceMoveChildren';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { invokeAdmittedReviewedChild } from './managedReviewedChild';

const selection = { kind: 'manifest' as const, name: 'worker' };
const currentTarget = {
  kind: 'managed_service' as const,
  managedServiceId: 'service',
  machineId: 'incumbent',
  workspaceId: 'workspace',
  cwd: '/old',
  declaration: { workspaceRefId: 'workspace', selection },
};
const destination = {
  kind: 'workers' as const,
  destination: { kind: 'machine' as const, machineId: 'new' },
};
const move = {
  workspace: { serverId: 'home', refId: 'workspace' },
  sourceMachineId: 'source',
  serviceName: 'worker',
  requestId: 'move-1',
  currentTarget,
  destination,
  selectedTarget: { machineId: 'new' },
  desiredPlacement: {
    workspace: { serverId: 'home', refId: 'workspace' },
    serviceName: 'worker',
    expectedRevision: 'absent' as const,
    expected: { kind: 'absent' as const },
    value: { runsOn: destination, unavailable: 'fail' as const },
  },
};
const parent = {
  actionId: 'projects.service.relocate',
  input: structuredClone(move),
};

/** Home-bound Stop ingress whose requester custody opened the Account's own invocation. */
async function receiverContext(
  machineId = 'incumbent',
  actionId = 'localServices.actions.stopManaged',
): Promise<ActionExecutorContext> {
  const target = { kind: 'machine' as const, machineId };
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({
    v: 1,
    token: 'reviewed-move-stop',
    binding: {
      actionId,
      accountId: 'owner',
      custodianAccountId: 'owner',
      requestId: 'request',
      machineId,
      installationId: 'incumbent-installation',
      serverIdentityId: 'home',
      authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain',
      requestEnvelopeDigest: 'a'.repeat(43),
      target,
    },
  });
  const requester = await admitRequesterAccountActionContext({
    authorization,
    credentials: { token: 'reviewed-move-owner', encryption: null },
    serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test',
    isCurrent: async () => true,
  });
  if (!requester) throw new Error('Missing reviewed Move requester custody');
  onTestFinished(() => requester.dispose());
  return {
    externalActionExecutionAuthorization: requester.authorization,
    externalActionTarget: target,
    runtimeAccountId: 'owner',
    defaultSessionMachineId: machineId,
    actionRequestId: 'request',
    surface: 'ui',
  };
}

async function invoke(
  overrides: Partial<Omit<Parameters<typeof invokeAdmittedReviewedChild>[0], 'context'>> & {
    context?: () => Promise<ActionExecutorContext>;
  } = {},
) {
  const { context, ...parameters } = overrides;
  const execute = vi.fn(
    async (_input: unknown, context: ActionExecutorContext) => ({
      ok: true as const,
      result: { parent: readHostReviewedParentV1(context)?.actionId },
    }),
  );
  const result = await invokeAdmittedReviewedChild({
    parent,
    requesterOwnedReview: true,
    actionId: 'localServices.actions.stopManaged',
    actionInput: projectServiceMoveStopInput(move),
    context: await (context ? context() : receiverContext()),
    execute,
    ...parameters,
  });
  return { result, execute };
}

describe('Move original-Stop reviewed child admission', () => {
  beforeEach(async () => {
    const currentness = await createRequesterCurrentnessSocketHarness();
    onTestFinished(() => currentness.close());
    // Home HTTP is the boundary; requester admission and private custody stay real.
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'owner' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      throw new Error('Unexpected reviewed Move Home read');
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('admits the exact incumbent Stop the Move parent reviewed', async () => {
    const { result, execute } = await invoke();
    expect(result).toEqual({
      ok: true,
      result: { parent: 'projects.service.relocate' },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('admits the transported Stop carrying its execution-derived confirmation nonce', async () => {
    const stop = projectServiceMoveStopInput(move);
    const { result, execute } = await invoke({
      actionInput: { ...stop, confirmationNonce: createLocalServiceActionConfirmationNonceV1(stop) },
    });
    expect(result).toEqual({ ok: true, result: { parent: 'projects.service.relocate' } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'a confirmation nonce bound to another request',
      {
        actionInput: {
          ...projectServiceMoveStopInput(move),
          confirmationNonce: createLocalServiceActionConfirmationNonceV1(
            projectServiceMoveStopInput({ ...move, requestId: 'other' }),
          ),
        },
      },
    ],
    [
      'a different service target',
      {
        actionInput: projectServiceMoveStopInput({
          ...move,
          currentTarget: { ...currentTarget, managedServiceId: 'other' },
        }),
      },
    ],
    [
      'a different stop request',
      { actionInput: { ...projectServiceMoveStopInput(move), force: true } },
    ],
    [
      'a different receiving Machine',
      { context: () => receiverContext('other-machine') },
    ],
    [
      'a child the receiver did not recompute',
      {
        actionId: 'localServices.launcher.start' as const,
        context: () => receiverContext('incumbent', 'localServices.launcher.start'),
      },
    ],
    [
      'a Home binding for another Action',
      {
        context: () => receiverContext(
          'incumbent',
          'localServices.launcher.snapshot',
        ),
      },
    ],
    [
      "consent not carried by the Account's own invocation",
      { requesterOwnedReview: false },
    ],
    [
      'an unparseable reviewed parent',
      {
        parent: {
          actionId: 'projects.service.relocate',
          input: { requestId: 'move-1' },
        },
      },
    ],
  ])(
    'refuses %s, leaving ordinary policy to decide',
    async (_name, overrides) => {
      const { result, execute } = await invoke(overrides);
      expect(result).toBeNull();
      expect(execute).not.toHaveBeenCalled();
    },
  );
});


describe('signed native setup child admission', () => {
  it.each(['machines.setup.apply', 'machines.setup.updates.apply', ...MACHINE_REBOOT_ACTION_IDS] as const)('restores the exact %s digest under its own Action identity', async actionId => {
    const actionInput = { homeId: 'home', machineId: 'receiver' };
    const target = { kind: 'machine' as const, machineId: 'receiver' };
    const reviewedChild = { actionId, role: 'native-child', inputDigest: computeActionInputApprovalDigestV1(actionId, actionInput) };
    const authorization = retainVerifiedExternalActionRequester({ isCurrent: async () => true,
      authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-native-child', binding: {
        actionId, accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
        machineId: target.machineId, installationId: 'receiver-installation', serverIdentityId: 'home', target,
        requestId: 'run/child/0', requestEnvelopeDigest: 'a'.repeat(43), accountEncryptionMode: 'plain', admittedMachineRole: 'manage',
        workflowActionOrigin: { runId: '11111111-1111-4111-8111-111111111111', requestId: 'run/child/0', reviewedChild },
      } }),
    });
    const context: ActionExecutorContext = { externalActionExecutionAuthorization: authorization,
      externalActionTarget: target, runtimeAccountId: 'owner', defaultSessionMachineId: target.machineId,
      serverIdentityId: 'home', actionRequestId: 'run/child/0', surface: 'ui' };
    const execute = async (_input: unknown, issued: ActionExecutorContext) => ({ ok: true as const,
      result: readHostAdmittedReviewedChildV1(issued) });
    expect(await invokeAdmittedReviewedChild({ actionId, actionInput, context, requesterOwnedReview: false, execute }))
      .toMatchObject({ ok: true, result: { ...reviewedChild, input: actionInput } });
    expect(await invokeAdmittedReviewedChild({ actionId, actionInput: { ...actionInput, machineId: 'other' }, context,
      requesterOwnedReview: false, execute })).toBeNull();
  });
});
