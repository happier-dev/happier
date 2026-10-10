import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import {
  computeExternalActionRequestEnvelopeDigestV1,
  signExternalActionApprovalInputV1,
  verifyExternalActionApprovalInputV1,
} from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import sodium from 'libsodium-wrappers';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

// Metro's lazy module loader is the boundary here; the real Action front door still executes.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
  return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
const nativeRpc = vi.hoisted(() => ({
  replay: null as ((artifactId: string) => Promise<unknown>) | null,
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
  const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
  return createServerScopedMachineRpcBoundaryMock(async (request) => {
    if (request.method !== RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED || !nativeRpc.replay) {
      throw new Error(`Unexpected native RPC: ${request.method}`);
    }
    expect(request.machineId).toBe('devbox');
    const payload = request.payload as { artifactId: string };
    return await nativeRpc.replay(payload.artifactId);
  });
});
installApprovalCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetScopedHomeActionExecutorsForTests } =
  await import('@/sync/ops/actions/scopedHomeActionExecutor');
beforeEach(async () => {
  nativeRpc.replay = null;
  await harness.reset();
  resetScopedHomeActionExecutorsForTests();
});
afterEach(() => standardCleanup());

const preset = (id: string, name: string) => ({
  id,
  homeId: 'srv_build',
  revision: 2,
  name,
  owner: { kind: 'account', accountId: 'owner' },
  recipe: {
    provider: { pluginId: 'custom.compute', localId: 'native' },
    schemaVersion: 1,
    name,
    choices: {},
  },
  controller: { machineId: 'controller', installationId: 'installation' },
  environment: {
    toolchain: { adapterId: 'mise', config: '[tools]' },
    setupScript: 'npm ci\nnpm run build',
  },
});

describe('Set up from a preset (D53)', () => {
  it('asks from Set up, preserves the choice after denial, and opens the approved setup output', async () => {
    let phase = 'save Home';
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    let sheetError: unknown;
    let approvalStates = (): unknown => [];
    onTestFailed(() => {
      console.error('Machine environment acceptance phase:', phase, {
        requests: harness.requests.map(request => request.path),
        error: sheetError,
        approvals: approvalStates(),
      });
    });
    const home = await harness.addHome({
      name: 'Build',
      serverUrl: 'https://build.example',
      serverIdentityId: 'srv_build',
      accountId: 'owner',
      currentAccount: true,
    });
    approvalStates = () => harness.artifacts(home).list().map(artifact => {
      const request = StoredApprovalRequestSchema.parse(JSON.parse(harness.artifacts(home).readPlainBody(artifact.id)!));
      return { status: request.status, execution: request.execution };
    });
    const serverId = resolveServerProfileScopeIdForIdentifier(home);
    phase = 'activate approval Account policy';
    await harness.requireUiApproval(home, 'machines.environment.apply');
    harness.answer(home, '/v1/machines', {
      body: [createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner' })],
    });
    harness.answer(home, '/v1/machines/presets/list', {
      body: {
        kind: 'listed',
        presets: [preset('web', 'Web box'), preset('build', 'Build box')],
      },
    });
    phase = 'load native policy and Artifact owners';
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { isApprovalExecutionOriginCurrentForAccountContext } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { writeApprovalRequestArtifact } = await import('@/sync/ops/actions/approvalArtifactWriter');
    const { readOriginalAccountActionAuthentication } = await import('@/sync/api/externalActionAccountTransport');
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    phase = 'capture native Account';
    const account = await captureLazyActionAccountContext(home);
    onTestFinished(() => account.dispose());
    phase = 'initialize installation signer';
    await sodium.ready;
    const installationKey = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(12));
    const applied: unknown[] = [];
    const output = { operationId: 'environment-operation', terminalId: 'environment-output' };
    // The remote process is represented by its real policy/approval executor. Only
    // its OS setup operation and HTTP/RPC transport are substituted here.
    const nativeDeps = {
      machineEnvironmentApply: async ({ input }) => {
        applied.push(input);
        return output;
      },
      approvalsCreate: async ({ request }) => ({
        artifactId: await account.createArtifact(buildApprovalRequestArtifactHeaderV1(request), JSON.stringify(request)),
      }),
      approvalsGet: async ({ artifactId }) => {
        const artifact = await account.fetchArtifact(artifactId);
        if (!artifact?.header || typeof artifact.body !== 'string') return null;
        const parsed = approvalArtifactBodyMatchesHeaderV1(artifact.header, artifact.body);
        return parsed?.family === 'built_in' ? parsed.request : null;
      },
      approvalsUpdate: async ({ artifactId, request }) => {
        const result = await writeApprovalRequestArtifact({
          artifactId, request, read: account.fetchArtifact,
          write: (basis, header, body) => account.updateArtifact(artifactId, header, body, basis),
        });
        if (result.ok) publishHomeAccountChange(serverId, [artifactId]);
        return result;
      },
      isApprovalExecutionOriginCurrent: async ({ origin, request }) => {
        account.assertCurrent();
        const authorization = origin.externalActionExecutionAuthorization;
        return isApprovalExecutionOriginCurrentForAccountContext({ origin, accountServerId: home, accountId: account.accountId })
          && origin.machineId === 'devbox'
          && authorization?.binding.installationId === 'test-installation'
          && Boolean(origin.externalActionInputSignature && origin.target && verifyExternalActionApprovalInputV1({
            authorizationToken: authorization.token, actionId: 'machines.environment.apply', input: request.actionArgs,
            target: origin.target, publicKey: installationKey.publicKey, signature: origin.externalActionInputSignature,
          }));
      },
    } satisfies Partial<ActionExecutorDeps>;
    // Unrelated executor ports are deliberately absent at this native process boundary.
    const nativeExecutor = createActionExecutor(nativeDeps as ActionExecutorDeps);
    nativeRpc.replay = artifactId => nativeExecutor.replayApprovedApprovalRequest({ artifactId, callerAuthority: 'present_user' });
    harness.answer(home, '/v1/actions/machines.environment.apply', {
      select: async (input) => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
        const authentication = readOriginalAccountActionAuthentication(account.credentials.token);
        if (!authentication || envelope.target?.kind !== 'machine') throw new Error('Expected an ordinary Account machine invocation');
        const authorization = { v: 1 as const, token: 'native-environment-authorization', binding: {
          accountId: 'owner', authentication, serverIdentityId: 'srv_build', machineId: 'devbox',
          custodianAccountId: 'owner', installationId: 'test-installation', actionId: 'machines.environment.apply' as const,
          requestId: envelope.requestId, target: envelope.target,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } };
        const execution = await nativeExecutor.execute('machines.environment.apply', envelope.input, {
          surface: 'ui', authority: 'present_user', serverId: home, serverIdentityId: 'srv_build', runtimeAccountId: 'owner',
          actionRequestId: envelope.requestId, externalActionTarget: envelope.target,
          externalActionExecutionAuthorization: authorization,
          signExternalActionApprovalInput: ({ actionId, input, target, authorization }) => signExternalActionApprovalInputV1({
            actionId, input, target, authorizationToken: authorization.token, privateKey: installationKey.privateKey,
          }),
        });
        return { body: { v: 1, requestId: envelope.requestId, actionId: 'machines.environment.apply', execution } };
      },
    });
    phase = 'load apply sheet';
    const { MachineEnvironmentApplySheet } =
      await import('./MachineEnvironmentApplySheet');
    const { Modal } = await import('@/modal');
    const { ActionOperationDetailModal } = await import('@/components/inbox/actionOperations/ActionOperationDetailModal');
    const onClose = vi.fn();
    // The Action front door first resolves the target machine through the Home; choosing never gets that far.
    const frontDoorReads = () =>
      harness.requests.filter((request) => request.path === '/v1/machines');
    phase = 'mount apply sheet';
    screen = await renderScreen(
      <MachineEnvironmentApplySheet
        serverId={serverId}
        machineId="devbox"
        machineName="devbox"
        onClose={onClose}
        setChrome={vi.fn()}
        {...({} as never)}
      />,
    );
    const mounted = screen;
    phase = 'load preset choices';
    await waitForHomeGovernance(() =>
      expect(
        mounted.tree.findAll(node => node.props?.testID === 'machine-environment-apply.preset:build').length,
      ).toBeGreaterThan(0),
    );
    const run = () =>
      mounted.tree.findAll(
        (node) =>
          node.props?.testID === 'machine-environment-apply.run' &&
          typeof node.props.onPress === 'function',
      )[0]!;
    const observedError = () => mounted.tree.findAll(
      node => node.props?.testID === 'machine-environment-apply.error'
        && typeof node.props.diagnosticCode === 'string',
    )[0]?.props.diagnosticCode;
    // Two presets: nothing is chosen yet, so nothing can run.
    expect(run().props.disabled).toBe(true);
    const row = mounted.tree.findAll(
      (node) =>
        node.props?.testID === 'machine-environment-apply.preset:build' &&
        typeof node.props.onPress === 'function',
    )[0]!;
    await act(async () => row.props.onPress());
    // Choosing reveals the labelled facts and sends nothing.
    const chosenRow = mounted.tree.findAll(
      (node) => node.props?.testID === 'machine-environment-apply.preset:build' && typeof node.props.subtitle === 'string',
    )[0]!;
    expect(chosenRow.props.subtitle).toContain('\n');
    expect(chosenRow.props.subtitle).toContain('2');
    expect(frontDoorReads()).toHaveLength(0);
    expect(run().props.disabled).toBe(false);
    phase = 'submit Set up and observe Ask';
    await act(async () => run().props.onPress());
    await flushHookEffects();
    sheetError = observedError();
    expect(mounted.findByTestId('machine-environment-apply.approval')).not.toBeNull();
    const artifacts = harness.artifacts(home);
    const deniedId = artifacts.list()[0]!.id;
    const expectedInput = { homeId: 'srv_build', machineId: 'devbox', presetId: 'build', presetRevision: 2 };
    expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(deniedId)!))).toMatchObject({
      status: 'open', actionId: 'machines.environment.apply', actionArgs: expectedInput,
      executionOriginV1: { authority: 'present_user', surface: 'ui', accountId: 'owner', machineId: 'devbox' },
    });
    expect(applied).toEqual([]);
    expect(run().props.disabled).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(Modal.show).not.toHaveBeenCalled();
    phase = 'deny in Inbox';
    await expect(decideApprovalAsInbox(home, deniedId, 'reject')).resolves.toMatchObject({ ok: true, result: { status: 'rejected' } });
    // The HTTP persistence fixture has no socket. Deliver the Home's existing,
    // content-free Artifact wake so the mounted exact-Home reader refetches it.
    await act(async () => publishHomeAccountChange(serverId, [deniedId]));
    phase = 'observe denied result on apply sheet';
    await flushHookEffects();
    sheetError = observedError();
    expect(mounted.findHostByTestId('machine-environment-apply.error-diagnostic-approval_rejected')).not.toBeNull();
    expect(applied).toEqual([]);
    expect(mounted.findByTestId('machine-environment-apply.approval')).toBeNull();
    expect(run().props.disabled).toBe(false);
    expect(chosenRow.props.selected).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(Modal.show).not.toHaveBeenCalled();

    phase = 'retry Set up';
    await act(async () => run().props.onPress());
    await flushHookEffects();
    expect(artifacts.list()).toHaveLength(2);
    const approvedId = artifacts.list()[1]!.id;
    phase = 'approve and replay at exact native machine';
    await expect(decideApprovalAsInbox(home, approvedId, 'approve')).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
    phase = 'open setup output';
    await flushHookEffects();
    expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
      component: ActionOperationDetailModal, props: { serverId, operationId: output.operationId },
    }));
    expect(applied).toEqual([expectedInput]);
    expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(approvedId)!))).toMatchObject({
      status: 'executed', execution: { ok: true, result: output },
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await mounted.unmount();
  });
});
