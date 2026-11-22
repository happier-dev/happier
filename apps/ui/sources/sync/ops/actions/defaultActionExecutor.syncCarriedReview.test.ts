import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import {
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionExecutionAuthorizationV1Schema,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import {
  PROJECT_ACCOUNT_ROWS_ROUTE_V1,
  ProjectAccountRowV1Schema,
} from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
// Only the addressed daemon network is replaced; Account capture, relay and confirmation binding stay real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  async () => {
    const { createServerScopedMachineRpcBoundaryMock } =
      await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc.machine);
  },
);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

const homeId = 'srv_sync_review';
const actionId = 'workspace.sync.relationship.create';
let serverId = 'home';
beforeEach(async () => {
  await homes.reset();
  await loadSyncSingletonForTests();
  rpc.machine.mockReset();
  serverId = await homes.addHome({
    name: 'Sync Home',
    serverUrl: 'https://sync-review.test',
    serverIdentityId: homeId,
    accountId: 'owner',
    currentAccount: true,
  });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
});
afterEach(async () => {
  await homes.reset();
});

describe('person Add a machine through the source daemon’s carried review', () => {
  it.each([false, true])(
    'exact replica: review → confirm links on the reviewed request (destination changed: %s)',
    async (destinationChanged) => {
      const installation = tweetnacl.sign.keyPair.fromSeed(
        new Uint8Array(32).fill(21),
      );
      const source = {
        ...createPlainMachineRowFixture({
          id: 'source-machine',
          accountId: 'owner',
        }),
        installationId: 'source-installation',
        installationPublicKey: encodeBase64(installation.publicKey),
      };
      // Another person's Worker with an ordinary Manage grant: Add a machine runs at the source.
      const worker = {
        ...createPlainMachineRowFixture({
          id: 'worker-of-b',
          accountId: 'person-b',
        }),
        access: {
          custodian: { accountId: 'person-b' },
          role: 'manage',
          resourceMode: 'plain',
          accessState: 'ready',
        } as const,
      };
      homes.answer(serverId, '/v1/machines', { body: [source, worker] });
      homes.answer(serverId, `/v1/machines/${source.id}`, {
        body: { machine: source },
      });
      const key = {
        kind: 'workspace-ref' as const,
        serverId: homeId,
        id: 'source-workspace',
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
      const policy = {
        v: 1 as const,
        selection: 'all_files' as const,
        extraIgnorePatterns: [],
        extraIncludePatterns: [],
      };
      const input = {
        v: 1 as const,
        sourceWorkspaceRefId: key.id,
        targetMachineId: worker.id,
        targetPath: '/home/happier/copy',
        mode: 'mirror_exactly' as const,
        destinationIntent: 'materialize_from_source_workspace' as const,
        contentPolicy: {
          ...policy,
          policyDigest: computeWorkspaceSyncPolicyDigest(policy),
        },
      };

      // The source daemon's real protocol executor; its boundaries are the target daemon's destination
      // inspection (which stamps the request's operationId, as workspaceSyncTargetAuthority does) and the link effect.
      const inspections: string[] = [];
      const effects: unknown[] = [];
      const daemon = createActionExecutor({
        sessionHandoffTargetReplacementApprovalPreflight: async (args) => {
          inspections.push(args.operationId);
          const fingerprint =
            destinationChanged && inspections.length > 1 ? 'b' : 'a';
          return {
            type: 'approval_required' as const,
            approval: {
              v: 1 as const,
              consequences: [
                'delete_target_only_files_during_exact_mirror',
              ] as const,
              serverId: homeId,
              machineId: worker.id,
              canonicalRoot: input.targetPath,
              rootFingerprint: fingerprint.repeat(64),
              operationId: args.operationId,
            },
          };
        },
        workspaceSyncRelationshipCreate: async (args) => {
          effects.push(args);
          return {
            v: 1 as const,
            relationshipId: 'relationship-1',
            created: true,
            controllerMachineId: source.id,
            sourceWorkspaceRefId: key.id,
            targetWorkspaceRefId: 'target-ref',
            status: {
              relationshipId: 'relationship-1',
              controllerMachineId: source.id,
              state: 'conflicted' as const,
              alphaPath: '/source',
              betaPath: input.targetPath,
              mode: 'mirror_exactly' as const,
              endpointStates: { alpha: null, beta: null },
              conflictCount: 0,
              lastCycleObservedAtMs: null,
            },
          };
        },
        approvalsCreate: async () => {
          throw new Error(
            'a person’s own press never creates a self-approval Artifact',
          );
        },
      });
      homes.answer(
        serverId,
        `/v1/actions/${actionId}/execution-authorization`,
        {
          select: (body) => {
            const request =
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
                  requestId: request.envelope.requestId,
                  target: request.envelope.target,
                  requestEnvelopeDigest:
                    computeExternalActionRequestEnvelopeDigestV1(
                      request.envelope,
                    ),
                },
              }),
            };
          },
        },
      );
      const relayedRequestIds: string[] = [];
      homes.answer(serverId, `/v1/actions/${actionId}`, {
        select: async (body) => {
          const request =
            ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
          relayedRequestIds.push(request.envelope.requestId);
          const invocation = openExternalActionRequesterAccountContextV1({
            authorization: request.executionAuthorization,
            purpose: { kind: 'external_action' },
            machineId: source.id,
            installationId: source.installationId,
            serverIdentityId: homeId,
            installationPrivateKey: installation.secretKey,
            includeInvocation: true,
          })?.invocation;
          if (!invocation) throw new Error('missing requester invocation');
          const execution = await daemon.execute(
            actionId,
            request.envelope.input,
            {
              surface: invocation.surface,
              authority: invocation.authority,
              actionCaller: invocation.caller,
              serverId: homeId,
              runtimeAccountId: 'owner',
              actionRequestId: request.envelope.requestId,
              externalActionTarget: request.envelope.target,
              ...(invocation.presentUserConfirmation
                ? {
                    presentUserConfirmation: invocation.presentUserConfirmation,
                  }
                : {}),
            },
          );
          return {
            body: {
              v: 1,
              actionId,
              requestId: request.envelope.requestId,
              execution: execution.ok
                ? { ok: true, result: execution.result }
                : {
                    ok: false,
                    errorCode: execution.errorCode,
                    error: execution.error,
                    ...(execution.details
                      ? { details: execution.details }
                      : {}),
                  },
            },
          };
        },
      });

      const reviews: unknown[] = [];
      const executor = createDefaultActionExecutor({
        presentUserActionConfirmation: async (request) => {
          reviews.push(request.preview);
          return true;
        },
      });
      const outcome = await executor.execute(actionId, input, {
        serverId,
        expectedAccountId: 'owner',
        surface: 'ui',
        authority: 'present_user',
        actionRequestId: 'ui-sync-press',
      });

      // The person saw one review whose destination proof belongs to this press, and the confirm replays that press.
      expect(reviews).toMatchObject([
        { handoffTargetReplacementApproval: { operationId: 'ui-sync-press' } },
      ]);
      expect(relayedRequestIds).toEqual(['ui-sync-press', 'ui-sync-press']);
      if (destinationChanged) {
        // A destination that changed after the review runs nothing; the daemon asks again with the new review.
        expect(outcome).toMatchObject({
          ok: false,
          errorCode: 'action_interactive_review_required',
        });
        expect(effects).toHaveLength(0);
        return;
      }
      expect(outcome, JSON.stringify(outcome)).toMatchObject({
        ok: true,
        result: { relationshipId: 'relationship-1', created: true },
      });
      expect(effects).toHaveLength(1);
    },
  );
});
