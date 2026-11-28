import { describe, expect, it, vi } from 'vitest';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { socketRpcCodec } from '@happier-dev/sync-client';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import type { ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { composeBindChildSourcePhaseTestRuntime } from './createProductionDaemonWorkspaceSyncRuntime.testkit';

const socketIo = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: socketIo }));

const contentPolicyInput = {
  v: 1 as const,
  selection: 'all_files' as const,
  extraIgnorePatterns: [],
  extraIncludePatterns: [],
};
const contentPolicy = {
  ...contentPolicyInput,
  policyDigest: computeWorkspaceSyncPolicyDigest(contentPolicyInput),
};
const token = (sub: string) =>
  [
    Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
    Buffer.from(JSON.stringify({ sub })).toString('base64url'),
    'fixture-signature',
  ].join('.');

// Audit F1 (RU2-SIMPLICITY-SETTINGS-PERF-AUDIT-1128): an existing-relationship handoff flushes a relationship
// whose controller is another Machine. The relationship's custody is the admitted requester's own: the flush
// reaches the controller as that requester (Home authenticates the bearer; the controller's requester ingress
// decides ownership), never as the installed Account, and another person's custody is never borrowed.
describe('existing-relationship handoff flush on another controller', () => {
  it.each([
    'person requester',
    'agent Session of the person',
    "another person's relationship",
    'installed owner',
    // Audit F1 review B1: neither shape may fall back to the installed Account's custody.
    'guest without Machine admission',
    'agent Session of the installed owner',
  ] as const)(
    'flushes under the requester custody that holds the relationship (%s)',
    async (scenario) => {
      // Every Machine RPC the SOURCE sends to the remote controller, with the Account Home authenticated it as.
      const controllerCalls: Array<
        Readonly<{ method: string; accountId: string | null }>
      > = [];
      const rows: ProjectAccountRowV1[] = [];
      const http = createProjectAccountRowsHttpBoundary(rows);
      const fixture = await composeBindChildSourcePhaseTestRuntime({
        socketIo,
        separateTargetParent: true,
        readAdditionalHttpPostResponse: async (url, body) =>
          url.includes('/v1/account/project-rows/')
            ? await http(url, body)
            : undefined,
        handleAdditionalSocketAck: async (payload, bearer) => {
          if (
            !payload ||
            typeof payload !== 'object' ||
            !('method' in payload) ||
            typeof payload.method !== 'string' ||
            !('params' in payload) ||
            !payload.method.startsWith('target-parent:')
          )
            return undefined;
          const method = payload.method.slice('target-parent:'.length);
          controllerCalls.push({
            method,
            accountId: bearer ? readAccountIdFromToken(bearer) : null,
          });
          if (method !== RPC_METHODS.DAEMON_WORKSPACE_SYNC_FLUSH)
            return undefined;
          const decoded = await socketRpcCodec.decodeRequestParams(
            { mode: 'plain' },
            payload.params,
            payload.method,
          );
          const endpoint = {
            connected: true,
            scanned: true,
            scanProblemCount: 0,
            transitionProblemCount: 0,
          };
          return {
            ok: true,
            result: await socketRpcCodec.encodeResponse(
              { mode: 'plain' },
              {
                status: {
                  relationshipId: (decoded.params as { relationshipId: string })
                    .relationshipId,
                  controllerMachineId: 'target-parent',
                  state: 'watching',
                  alphaPath: fixture.sourcePath,
                  betaPath: fixture.targetPath,
                  mode: 'keep_both_in_sync',
                  endpointStates: { alpha: endpoint, beta: endpoint },
                  conflictCount: 0,
                  lastCycleObservedAtMs: 1,
                },
              },
              decoded.callId,
            ),
          };
        },
      });
      expect(fixture.targetRef.machineId).toBe('target-parent');
      const relationship = {
        v: 1 as const,
        relationshipId: 'person-link-on-remote-controller',
        controllerMachineId: fixture.targetRef.machineId,
        alphaWorkspaceRefId: fixture.targetRef.id,
        betaWorkspaceRefId: fixture.sourceRef.id,
        mode: 'keep_both_in_sync' as const,
        contentPolicy,
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
      };
      // The person's retained custody of their own link on this SOURCE: their rows and their credentials.
      // Its signed TARGET port is the network boundary (as in the retained-requester recovery test).
      const personCredentials = { token: token('person'), encryption: null };
      let snapshot = {
        source: 'network',
        workspaceRefs: [fixture.sourceRef, fixture.targetRef],
        relationships: [relationship],
        graphRevision: 1,
        loadedAtMs: 1,
        organizations: [],
        rows: [],
        scopeKey: 'person-scope',
      } as unknown as ActiveProjectAccountRowsSnapshot;
      const operationId = relationship.relationshipId;
      if (scenario !== 'installed owner') {
        fixture.parent.handoffAdapter.retainPrivateExecution!({
          phase: 'relationship',
          input: {
            operationId,
            accountServerId: fixture.serverId,
            action: {
              kind: 'relationship',
              relationshipId: operationId,
              flushBeforeCommit: false,
            },
            sourceMachineId: fixture.sourceRef.machineId,
            sourceWorkspaceRefId: fixture.sourceRef.id,
            sourceRootPath: fixture.sourcePath,
            targetMachineId: fixture.targetRef.machineId,
            targetWorkspaceRefId: fixture.targetRef.id,
            targetRootPath: fixture.targetPath,
          },
          execution: {
            credentials: personCredentials,
            accountRowsCustody: {
              serverId: fixture.serverId,
              accountId: 'person',
              serverHttpBaseUrl: 'https://bind-child-home.invalid',
              isCurrent: async () => true,
            },
            getSnapshot: () => snapshot,
            replaceSnapshot: async (next) => {
              snapshot = next;
            },
            callTargetPhase: async () => ({
              v: 1,
              bootstrapOperationId: operationId,
              targetWorkspaceRefId: fixture.targetRef.id,
              state: 'ready',
              created: false,
              rootFingerprint: 'a'.repeat(64),
              policyDigest: contentPolicy.policyDigest,
            }),
            assertTransferCurrent: async () => undefined,
            release: async () => undefined,
          },
        });
        await fixture.parent.handoffAdapter.bindPrivateExecutionRelationship!(
          operationId,
          operationId,
        );
      }
      const actorAccountId =
        scenario === "another person's relationship"
          ? 'other-person'
          : scenario === 'installed owner' ||
              scenario === 'agent Session of the installed owner'
            ? 'owner'
            : 'person';
      const agentSessionId =
        scenario === 'agent Session of the person'
          ? 'person-agent-session'
          : scenario === 'agent Session of the installed owner'
            ? 'owner-agent-session'
            : null;
      const context: RpcHandlerContext = {
        signal: new AbortController().signal,
        callerAuthority: 'present_user',
        ...(scenario === 'guest without Machine admission'
          ? {
              // A guest's requester Session reached without raw Machine admission (the shape a replay or
              // Workflow child can carry): the guest's Account is known, Home's admission is not.
              requesterSessionBootstrap: {
                credentials: personCredentials,
                attribution: {
                  serverId: fixture.serverId,
                  accountId: 'person',
                  machineId: fixture.sourceRef.machineId,
                  installationId: 'parent-installation',
                },
                serverHttpBaseUrl: 'https://bind-child-home.invalid',
              },
            }
          : {
              machineAdmission: {
                actorAccountId,
                custodianAccountId: 'owner',
                machineId: fixture.sourceRef.machineId,
                installationId: 'parent-installation',
                role: actorAccountId === 'owner' ? 'manage' : 'use',
                encryptionMode: 'plain',
              },
              verifyMachineAdmissionCurrent: async () => true,
            }),
        ...(agentSessionId
          ? {
              // The Agent Session origin Home signs onto an Agent's RPC (SessionActionRpcOriginV1).
              sessionActionOrigin: {
                v: 1,
                caller: {
                  kind: 'session',
                  sessionId: agentSessionId,
                  starterDepth: 0,
                  turnDepth: 0,
                },
                sourceTurnId: 'agent-turn',
                callerPermissionMode: null,
                requestId: `${agentSessionId}-request`,
              },
            }
          : {}),
      } as RpcHandlerContext;
      const errorShape = (error: unknown) =>
        error && typeof error === 'object'
          ? {
              code: Reflect.get(error, 'code'),
              rpcErrorCode: Reflect.get(error, 'rpcErrorCode'),
              message: Reflect.get(error, 'message'),
            }
          : error;
      // The handoff's existing-relationship action, as the session.handoff coordinator prepares it.
      const settled = await fixture.parent.handoffAdapter
        .prepare(
          {
            operationId: `handoff-${actorAccountId}-${scenario.length}`,
            accountServerId: fixture.serverId,
            action: {
              kind: 'relationship',
              relationshipId: relationship.relationshipId,
              flushBeforeCommit: true,
            },
            sourceMachineId: fixture.sourceRef.machineId,
            sourceWorkspaceRefId: fixture.sourceRef.id,
            sourceRootPath: fixture.sourcePath,
            targetMachineId: fixture.targetRef.machineId,
            targetWorkspaceRefId: fixture.targetRef.id,
            targetRootPath: fixture.targetPath,
          },
          undefined,
          context,
        )
        .then(
          (prepared) => ({ prepared }),
          (error: unknown) => ({ error: errorShape(error) }),
        );
      const evidence = JSON.stringify({ settled, controllerCalls });
      if (scenario === 'guest without Machine admission') {
        // No admitted requester custody: refused before anything reaches the controller, never as the installed Account.
        expect(settled, evidence).toMatchObject({
          error: { code: 'relationship_not_owned' },
        });
        expect(controllerCalls, evidence).toEqual([]);
        return;
      }
      if (scenario === 'agent Session of the installed owner') {
        // The same Agent Session asking the controller to FLUSH directly is refused by the requester ingress;
        // the handoff hop settles with that same refusal and sends nothing as the installed Account.
        const direct = await fixture.parent.workspaceSync
          .forRequester!(context)
          .then((service) =>
            service.controller.flush(
              relationship.relationshipId,
              new AbortController().signal,
            ),
          )
          .then(
            (status) => ({ status }),
            (error: unknown) => ({ error: errorShape(error) }),
          );
        const directEvidence = JSON.stringify({ direct, settled, controllerCalls });
        expect(direct, directEvidence).toMatchObject({
          error: { rpcErrorCode: 'relationship_not_owned' },
        });
        expect(settled, directEvidence).toMatchObject({
          error: { code: 'relationship_not_owned' },
        });
        expect(controllerCalls, directEvidence).toEqual([]);
        return;
      }
      if (scenario === "another person's relationship") {
        // The person's link is not this requester's: refused before anything reaches the controller.
        expect(settled, evidence).toMatchObject({
          error: { code: 'relationship_not_owned' },
        });
        expect(controllerCalls, evidence).toEqual([]);
        return;
      }
      if (scenario === 'installed owner') {
        // The installed owner's own context keeps today's installed custody (no requester capture is involved);
        // its relationship is not in the installed rows here, so it settles as not ready without a controller call.
        expect(settled, evidence).toMatchObject({
          error: { code: 'relationship_not_ready' },
        });
        expect(controllerCalls, evidence).toEqual([]);
        return;
      }
      expect(settled, evidence).toMatchObject({
        prepared: {
          kind: 'relationship',
          relationshipId: relationship.relationshipId,
          status: {
            relationshipId: relationship.relationshipId,
            state: 'watching',
          },
        },
      });
      // Nothing reaches the controller as the installed Account: the TARGET bootstrap goes through the
      // requester's own signed TARGET port, and the flush (Audit F1) goes out under the requester's bearer.
      expect(controllerCalls, evidence).toEqual([
        {
          method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_FLUSH,
          accountId: 'person',
        },
      ]);
    },
  );
});
