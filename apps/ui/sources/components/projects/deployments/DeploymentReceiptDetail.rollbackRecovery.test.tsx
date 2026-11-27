import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1, projectDeploymentReceiptFactsV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentEnvironmentHeaderV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import {
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionResponseEnvelopeV1Schema,
} from '@happier-dev/protocol/actions/externalActionApi';
import { resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { DEPLOYMENT_ROLLBACK_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentRollbackInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentReviewV1Schema } from '@happier-dev/protocol/deployments/deploymentReviewV1';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { act, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderAccountScreen } from '@/dev/testkit/render/renderAccountScreen';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
const router = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock());
vi.mock('expo-router', () => router.module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary(socket => {
  configureConnectedServerSocketBoundary(socket);
  socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
    if (event === SOCKET_RPC_EVENTS.CALL && payload && typeof payload === 'object' && 'method' in payload
      && typeof payload.method === 'string' && payload.method.endsWith(`:${ACTION_OPERATION_RPC_METHODS_V2.list}`)) {
      // No effect has been admitted, so the controller has no operation to recover.
      return { ok: true, result: ActionOperationListV1ResponseSchema.parse({ items: [], nextCursor: null }) };
    }
    return {};
  });
});
await loadSyncSingletonForTests();
const { DeploymentReceiptDetail } = await import('./DeploymentReceiptDetail');
const { createDeploymentActions } = await import('./deploymentActions');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createUiActionAutomationPortV1 } = await import('@/sync/ops/actions/actionAutomations');
const { ModalProvider } = await import('@/modal');
await import('@/sync/ops/actions/defaultActionExecutor');

afterEach(async () => {
  standardCleanup();
  await homes.reset();
});

it('rejoins the signed rollback from a succeeded Receipt after the controller review response is lost', async () => {
  const actionId = DEPLOYMENT_ROLLBACK_ACTION_ID_V1;
  const path = `/v1/actions/${actionId}`;
  const homeId = `srv_${'a'.repeat(32)}`;
  const accountId = 'account-owner';
  const serverId = await homes.addHome({ name: 'Rollback Home', serverUrl: 'https://rollback-recovery.test',
    serverIdentityId: homeId, accountId, currentAccount: true });
  const detail = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId: homeId }) });
  const { environment } = detail;
  const runtime = detail.targetLinks[0]!.targetLink;
  // Two successful deploys, with the older release selected and kept for rollback.
  const serving = createDeploymentReceiptDetailV1();
  if (serving.content.sourceIntent.kind !== 'repository') throw new Error('Expected a repository deployment');
  const retained = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({
    id: 'retained-release', requestKey: 'retained-deploy-press', actionOperationId: 'retained-deploy-operation',
    contentArtifactId: 'retained-deploy-content', requestedAtMs: 900, startedAtMs: 901, settledAtMs: 902,
  }), content: { ...serving.content, sourceIntent: { ...serving.content.sourceIntent, sha: 'b'.repeat(40) } } });
  const controller = createDeploymentReadControllerV1({ scope: { serverId: homeId, accountId, projectSourceId: environment.projectSourceId }, transport: {
    listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
    readEnvironment: async () => ({ ok: true, value: detail }),
    listHistory: async () => ({ ok: true, value: { ok: true, nextCursor: null, items: [serving, retained].map(row => ({
      ...row.deployment, source: projectDeploymentReceiptFactsV1(row).source,
    })) } }),
    readReceipt: async (_scope, _environmentId, id) => ({ ok: true, value: id === retained.deployment.id ? retained : serving }),
  } });
  const account = await captureLazyActionAccountContext(serverId);
  let screen: Awaited<ReturnType<typeof renderAccountScreen>> | undefined;
  try {
    homes.answer(serverId, `GET /v1/deployments/environments/${environment.id}`, { body: {
      ok: true, environment, targetLinks: [runtime],
    } });
    homes.answer(serverId, `GET ${AUTOMATION_ACTION_INDEX_HTTP_PATH_V1}`, {
      body: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }),
    });
    const review = DeploymentReviewV1Schema.parse({
      environment: { id: environment.id, name: detail.content.name },
      revision: { kind: 'repository', sha: 'b'.repeat(40) }, rollbackData: 'keep', inspection: 'complete',
      services: [{ name: 'app', replicas: null, resources: { cpus: null, memory: null }, restartPolicy: null,
        healthcheck: 'absent', ports: [], mounts: [] }], risks: [],
      target: { engine: 'native', requiresAwakeComputerAndDockerDesktop: false, domains: 'notDetermined' },
    });
    const effect = vi.fn(async () => ({ ok: true as const, environmentId: environment.id, revision: 2,
      deploymentId: 'rollback-release', deploymentRevision: 1, state: 'succeeded' as const }));
    const runOperation = vi.fn<NonNullable<ActionExecutorDeps['runActionOperation']>>(
      async ({ execute, context }) => execute(context),
    );
    const receiver = createActionExecutor(createActionExecutorBoundaryFixture({
      actionAutomations: createUiActionAutomationPortV1(account),
      resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: environment.id } }),
      // Installed controller's preparation and effect ports. Protocol admission and review generation stay real.
      prepareDeploymentAction: async ({ input, context }) => {
        const publication = context.externalActionExecutionAuthorization?.binding.deploymentCandidatePublication;
        return { input: DeploymentRollbackInputV1Schema.parse({ ...input, expectedRevision: environment.revision,
          targetLinkId: runtime.id, expectedTargetLinkRevision: runtime.revision,
          contentArtifactId: publication?.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 }), preview: review };
      },
      deploymentAction: effect,
      runActionOperation: runOperation,
    }));
    const boundary = await answerExternalActionAccountForHome(homes, serverId, {
      actionId, machineId: environment.controllerMachineId, installationId: 'installation-a', tokenEpoch: 0,
      deploymentSource: { id: environment.projectSourceId, revision: 1 },
      failure: result => ActionExecuteFailureSchema.safeParse(result).data ?? null,
      async execute(input, transport) {
        const result = await receiver.execute(actionId, input, {
          surface: transport.invocation.surface,
          authority: resolveInvocationAuthority({ credential: 'account', surface: transport.invocation.surface, actionId }),
          actionCaller: transport.invocation.caller,
          presentUserConfirmation: transport.invocation.presentUserConfirmation,
          serverId, serverIdentityId: homeId, runtimeAccountId: accountId, actionRequestId: transport.requestId,
          externalActionTarget: transport.target, externalActionExecutionAuthorization: transport.authorization,
          originalActionEnvelope: transport.envelope,
        });
        return result.ok ? result.result : result;
      },
    });
    let lost: ReturnType<typeof ExternalActionResponseEnvelopeV1Schema.parse> | undefined;
    let issuedBody: string | undefined;
    homes.answer(serverId, `POST ${path}`, { async select(_input, request) {
      // The controller already answered HTTP 200. Drop delivery after dispatch,
      // and let Home rejoin the recorded result if it sees that exact request again.
      if (lost && request.init?.body === issuedBody) return { body: lost };
      const response = await boundary.handle(new URL(request.url), request.init);
      if (!response) throw new Error('Expected the rollback HTTP response');
      const body: unknown = await response.json();
      if (!lost && response.ok) {
        lost = ExternalActionResponseEnvelopeV1Schema.parse(body);
        if (typeof request.init?.body !== 'string') throw new Error('Expected serialized signed rollback request');
        issuedBody = request.init.body;
        return { dispatchThenFail: true };
      }
      return { status: response.status, body };
    } });
    const actions = createDeploymentActions(account.accountLifetime, environment.projectSourceId);
    const requestReview = vi.fn();
    const openReceipt = vi.fn();
    const mounted = screen = await renderAccountScreen(<ModalProvider>
      <DeploymentReceiptDetail controller={controller} environmentId={environment.id} deploymentId={retained.deployment.id}
        environmentName={detail.content.name} demand={{ mounted: true, visible: true, focused: true }}
        accountId={accountId} serverId={serverId} readLogs={null} onBack={() => {}} rollback={actions.rollback}
        cancel={null} deploy={null} phone={false} linkPath={null}
        review={{ pendingId: null, request: requestReview, open() {} }} onOpenReceipt={openReceipt} />
    </ModalProvider>);
    const rollback = 'project-deployments.receipt.rollback';
    const refusal = 'project-deployments.outcome.refused.other';
    const retry = `${refusal}.action`;
    const approve = 'actions.confirmation-review.decision-approve';
    const waitForControl = (testId: string) => act(async () => {
      await waitForTestEvent(mounted.subscribe, () => mounted.findByTestId(testId), control => control !== null);
    });

    await waitForControl(rollback);
    await mounted.pressByTestIdAsync(rollback);
    await waitForControl(refusal);
    expect(lost).toMatchObject({ execution: { ok: false, errorCode: 'action_interactive_review_required', details: { review: expect.any(Object) } } });
    const [first] = homes.requestsFor(path);
    const issued = ExternalActionExecutionAuthorizationRequestV1Schema.parse(first?.input);
    expect(issued.envelope).toMatchObject({ requestId: lost?.requestId, input: {
      serverId: homeId, environmentId: environment.id, deploymentId: retained.deployment.id, requestKey: lost?.requestId,
    } });
    expect(homes.requestsFor(path)).toHaveLength(1);
    expect(homes.artifacts(serverId).list()).toEqual([]);
    expect(runOperation).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
    expect(mounted.findByTestId(approve)).toBeNull();
    expect(mounted.findByTestId(retry), mounted.getTextContent()).not.toBeNull();

    await mounted.pressByTestIdAsync(retry);
    await waitForControl(approve);
    const attempts = homes.requestsFor(path);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.input).toEqual(first?.input);
    expect(homes.artifacts(serverId).list()).toEqual([]);
    expect(requestReview).not.toHaveBeenCalled();
    expect(runOperation).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
    expect(openReceipt).not.toHaveBeenCalled();
    await mounted.pressByTestIdAsync('actions.confirmation-review.decision-reject');
    await waitForControl(refusal);
  } finally {
    await screen?.unmount();
    controller.retire();
    account.dispose();
  }
});
