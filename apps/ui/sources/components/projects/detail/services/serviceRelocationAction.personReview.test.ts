import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import tweetnacl from 'tweetnacl';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import {
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionRequestEnvelopeV1Schema,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { deriveWorkspaceSyncRelationshipId } from '@happier-dev/protocol/workspaces/workspaceSyncAdmissionV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import {
  PROJECT_ACCOUNT_ROWS_ROUTE_V1,
  ProjectAccountRowV1Schema,
} from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { ProjectServiceRelocateInputV1Schema } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      renderCustomModals: true,
    }).module,
);

// Replaced: Home HTTP/device credentials and Socket.IO (system boundaries); at the SOURCE, its Move
// child preparation and relocation effect (the real ones run in the CLI composed journey
// executeExternalAction.filesystemApprovals.composed.test.ts). Real: the Services Move caller, the
// UI front door and default executor, the mounted review and its Approve press, the UI Account
// transport with the person's Machine custody and sealed confirmation (target included), and the
// receiving executor's confirmation admission, review builder and strict digest comparison.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const { ModalProvider } = await import('@/modal');
const { getActiveServerSnapshot } =
  await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } =
  await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { createFrontDoorRuntimeActionExecutor } =
  await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { executeServiceRelocationAction } =
  await import('./serviceRelocationAction');

const homeId = 'srv_person_move';
const actionId = 'projects.service.relocate';
let serverId = 'home';
beforeEach(async () => {
  await homes.reset();
  serverId = await homes.addHome({
    name: 'Move Home',
    serverUrl: 'https://person-move.test',
    serverIdentityId: homeId,
    accountId: 'owner',
    currentAccount: true,
  });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
});
afterEach(async () => {
  standardCleanup();
  await homes.reset();
});

describe('a person’s own service Move through the SOURCE’s carried review', () => {
  it('review → confirm → moved: the confirm reaches the SOURCE bound to the review and target the person saw', async () => {
    const installation = tweetnacl.sign.keyPair.fromSeed(
      new Uint8Array(32).fill(7),
    );
    const source = {
      ...createPlainMachineRowFixture({
        id: 'source-machine',
        accountId: 'owner',
      }),
      installationId: 'source-installation',
      installationPublicKey: encodeBase64(installation.publicKey),
    };
    homes.answer(serverId, '/v1/machines', { body: [source] });
    homes.answer(serverId, `/v1/machines/${source.id}`, {
      body: { machine: source },
    });
    const key = {
      kind: 'workspace-ref' as const,
      serverId: homeId,
      id: 'source-ref',
    };
    homes.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, {
      body: {
        status: 'listed',
        coverage: 'complete',
        rows: [
          ProjectAccountRowV1Schema.parse({
            key,
            revision: 1,
            content: {
              t: 'plain',
              v: {
                key,
                value: {
                  id: key.id,
                  serverId: homeId,
                  machineId: source.id,
                  rootPath: '/source',
                  createdAtMs: 1,
                },
              },
            },
          }),
        ],
      },
    });
    const workspace = { serverId: homeId, refId: key.id };
    const destination = {
      kind: 'workers' as const,
      destination: { kind: 'machine' as const, machineId: 'worker-machine' },
    };
    const request = ProjectServiceRelocateInputV1Schema.parse({
      workspace,
      sourceMachineId: source.id,
      serviceName: 'web',
      requestId: 'person-move',
      currentTarget: {
        kind: 'managed_service',
        managedServiceId: 'native-web',
        machineId: source.id,
        workspaceId: key.id,
        cwd: '/source',
        declaration: {
          workspaceRefId: key.id,
          selection: { kind: 'manifest', name: 'web' },
        },
      },
      destination,
      selectedTarget: { machineId: 'worker-machine' },
      desiredPlacement: {
        workspace,
        serviceName: 'web',
        expectedRevision: 'absent',
        expected: { kind: 'absent' },
        value: { runsOn: destination, unavailable: 'fail' },
      },
    });
    // The SOURCE's preparation adds what only it inspects; the UI cannot rebuild this review.
    const setupReview = {
      reviewedEffect: { v: 1, purpose: 'setup' },
      reviewedEffectDigest: 'source-setup',
    };

    const moves: unknown[] = [];
    const daemon = createActionExecutor({
      readActionsSettings: () =>
        normalizeActionsSettingsV1({
          v: 1,
          actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } },
        }),
      prepareHostReviewedChildren: async (preparation) =>
        preparation.actionId !== actionId
          ? null
          : {
              input: { ...(preparation.input as object), setupReview },
              children: [],
            },
      runtimeActionExecute: async (args) => {
        moves.push(args.input);
        return {
          status: 'accepted',
          operation: {
            version: 1,
            operationId: 'move-operation',
            revision: 1,
            actionId,
            state: 'accepted',
            scope: { accountId: 'owner', machineId: source.id },
            title: 'Move web',
            requestId: request.requestId,
            createdAt: 1,
            cancellation: 'supported',
          },
        };
      },
      approvalsCreate: async () => {
        throw new Error(
          'a person’s own press never creates a self-approval Artifact',
        );
      },
    });
    homes.answer(serverId, `/v1/actions/${actionId}/execution-authorization`, {
      select: (body) => {
        const issued =
          ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        return {
          body: ExternalActionExecutionAuthorizationV1Schema.parse({
            v: 1,
            token: 'source-home-root',
            binding: {
              accountId: 'owner',
              authentication: { kind: 'account', tokenEpoch: 0 },
              serverIdentityId: homeId,
              machineId: source.id,
              installationId: source.installationId,
              custodianAccountId: 'owner',
              accountEncryptionMode: 'plain',
              actionId,
              requestId: issued.envelope.requestId,
              target: issued.envelope.target,
              requestEnvelopeDigest:
                computeExternalActionRequestEnvelopeDigestV1(issued.envelope),
              // Home binds the SOURCE checkout a Move reads from (projectWorkspaceSyncAdmissionInputV1).
              workspaceSyncAdmission: {
                relationshipId: deriveWorkspaceSyncRelationshipId(issued.envelope.requestId),
                sourceWorkspaceRefId: key.id,
                source: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: source.id,
                  installationId: source.installationId, role: 'manage', encryptionMode: 'plain' },
              },
            },
          }),
        };
      },
    });
    const received: Array<{
      target: unknown;
      confirmation?: { reviewDigest?: string; target?: unknown } | undefined;
      result: { ok: boolean; errorCode?: string; reviewDigest?: string };
    }> = [];
    homes.answer(serverId, `/v1/actions/${actionId}`, {
      select: async (body) => {
        const sealed =
          ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
        const relayed = sealed.success
          ? sealed.data
          : {
              envelope: ExternalActionRequestEnvelopeV1Schema.parse(body),
              executionAuthorization: null,
            };
        const invocation = relayed.executionAuthorization
          ? openExternalActionRequesterAccountContextV1({
              authorization: relayed.executionAuthorization,
              purpose: { kind: 'external_action' },
              machineId: source.id,
              installationId: source.installationId,
              serverIdentityId: homeId,
              installationPrivateKey: installation.secretKey,
              includeInvocation: true,
            })?.invocation
          : // Home's root for an Account-authenticated UI press: the present person, as the host.
            {
              surface: 'ui' as const,
              authority: 'present_user' as const,
              caller: { kind: 'host' as const },
            };
        if (!invocation) throw new Error('missing requester invocation');
        const confirmation =
          'presentUserConfirmation' in invocation
            ? invocation.presentUserConfirmation
            : undefined;
        const execution = await daemon.execute(
          actionId,
          relayed.envelope.input,
          {
            surface: invocation.surface,
            authority: invocation.authority,
            actionCaller: invocation.caller,
            serverId: homeId,
            runtimeAccountId: 'owner',
            actionRequestId: relayed.envelope.requestId,
            externalActionTarget: relayed.envelope.target,
            ...(confirmation ? { presentUserConfirmation: confirmation } : {}),
          },
        );
        const details = execution.ok
          ? undefined
          : (execution.details as { reviewDigest?: string } | undefined);
        received.push({
          target: relayed.envelope.target,
          confirmation,
          result: execution.ok
            ? { ok: true }
            : {
                ok: false,
                errorCode: execution.errorCode,
                ...(details?.reviewDigest
                  ? { reviewDigest: details.reviewDigest }
                  : {}),
              },
        });
        return {
          body: {
            v: 1,
            actionId,
            requestId: relayed.envelope.requestId,
            execution: execution.ok
              ? { ok: true, result: execution.result }
              : {
                  ok: false,
                  errorCode: execution.errorCode,
                  error: execution.error,
                  ...(execution.details ? { details: execution.details } : {}),
                },
          },
        };
      },
    });

    const screen = await renderScreen(React.createElement(ModalProvider));
    let moving!: ReturnType<typeof executeServiceRelocationAction>;
    act(() => {
      moving = executeServiceRelocationAction({
        execute: createFrontDoorRuntimeActionExecutor(),
        request,
        confirmed: true,
        context: {
          surface: 'ui',
          serverId,
          runtimeAccountId: 'owner',
          actionRequestId: 'person-press',
        },
        admission: { expectedAccountId: 'owner', onApprovalPending: () => {} },
      });
    });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    await vi.waitFor(() =>
      expect(screen.getTextContent()).toContain('Move service'),
    );
    await screen.pressByTestIdAsync(
      'actions.confirmation-review.decision-approve',
    );
    const outcome = await moving;

    expect(outcome, JSON.stringify({ outcome, received })).toMatchObject({
      status: 'accepted',
      operation: { operationId: 'move-operation' },
    });
    expect(received.map((entry) => entry.result.ok)).toEqual([false, true]);
    const [review, confirm] = received;
    expect(review?.result.errorCode).toBe('action_interactive_review_required');
    // The SOURCE admitted the confirm: same digest it carried, same target the request was addressed to.
    expect(confirm?.confirmation).toMatchObject({
      reviewDigest: review?.result.reviewDigest,
      target: confirm?.target,
    });
    expect(moves).toEqual([
      expect.objectContaining({ requestId: request.requestId, setupReview }),
    ]);
    await screen.unmount();
  });
});
