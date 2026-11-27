import { rm } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  invokeHostReviewedChildV1,
  type ActionExecutorContext,
} from '@happier-dev/protocol/actions/actionExecutor';
import {
  ExternalActionExecutionAuthorizationV1Schema,
  type ExternalActionExecutionAuthorizationV1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { ScmStatusSnapshotResponseSchema } from '@happier-dev/protocol/scm';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { retainVerifiedExternalActionRequester } from '@/daemon/agentIsolation/verifiedExternalActionRequester';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { createTestGitScmBackendRegistry } from '@/scm/rpc/__tests__/testRpcHarness';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { runWithRealGitScmRuntime } from '../../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import { createCliMachineActionTransport } from './machineTransport';

const token = `e30.${Buffer.from(
  JSON.stringify({
    sub: 'owner',
    tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' },
  }),
).toString('base64url')}.fixture`;

// Live cut 53 (REVIEW-START-DISPATCH-LIVE-1127, request 7be112b5): the browser's
// mounted Triage Review Start reached the daemon as action.invoke with retained
// requester custody. The Triage Action runs as that root's reviewed action_invoke
// child, whose authorization is the reviewed-child descriptor copy. Its native
// review.start then ran Session-placed SCM with the inherited target cleared and
// refused not_authenticated before any Machine RPC was sent.
it.each([
  'owner-person', 'owner-automation', 'unretained', 'other-machine', 'foreign-home', 'non-member',
] as const)(
  "spends a reviewed action.invoke child's %s requester custody for targetless Session-placed SCM",
  async (source) =>
    runWithRealGitScmRuntime(async () => {
      const repository = createLocalScmRepositoryFixture({
        executable: 'git',
        repoMode: '.git',
        prefix: 'happier-reviewed-child-scm-',
      });
      try {
        const rpc = new RpcHandlerManager({
          scopePrefix: 'machine',
          encryptionMode: 'plain',
          logger: () => {},
          authorizeRequest: (request) =>
            authorizeMachineRpcRequest(request, {
              machineId: 'machine',
              resolveHomeServerIdentityId: async () => 'home',
              resolveCustodianAccountId: async () => 'owner',
              resolveInstallationId: () => 'installation',
              verifyMachineAdmission: async () => false,
            }),
        });
        const filesystem = createFilesystemEffectAdmission({
          resolveHomeServerIdentityId: async () => 'home',
          resolveHostIdentity: async () => ({
            machineId: 'machine',
            installationId: 'installation',
            custodianAccountId: 'owner',
          }),
        });
        registerScmHandlers(rpc, repository.rootPath, {
          machineId: 'machine',
          registry: createTestGitScmBackendRegistry(),
          selectWorkspaceSource: filesystem.selectWorkspaceSource,
          admitWorkspaceSource: filesystem.rpc,
          resolveRequester: filesystem.resolveRpcRequester,
        });
        const target = { kind: 'machine', machineId: 'machine' } as const;
        const accountId = source === 'non-member' ? 'non-member' : 'owner';
        const serverIdentityId = source === 'foreign-home' ? 'other-home' : 'home';
        const authority = source === 'owner-automation' ? 'account_automation' : 'present_user';
        const admitted = ExternalActionExecutionAuthorizationV1Schema.parse({
          v: 1,
          token: 'admitted-review-start',
          binding: {
            accountId,
            custodianAccountId: 'owner',
            authentication: { kind: 'account', tokenEpoch: 0 },
            accountEncryptionMode: 'plain',
            serverIdentityId,
            machineId: 'machine',
            installationId: 'installation',
            actionId: 'action.invoke',
            requestId: 'review-start',
            requestEnvelopeDigest: 'a'.repeat(43),
            target,
          },
        });
        // Home HTTP is a network boundary; this request reads only the local repository.
        Object.defineProperty(admitted, 'requesterHttpProjection', {
          enumerable: false,
          value: Object.freeze({
            accountId,
            serverId: serverIdentityId,
            serverIdentityId,
            serverHttpBaseUrl: 'https://home.test',
            accountEncryptionMode: 'plain',
            isCurrent: async () => true,
            createRequestHeaders: async () => null,
          }),
        });
        const authorization: ExternalActionExecutionAuthorizationV1 =
          source === 'unretained'
            ? admitted
            : retainVerifiedExternalActionRequester({
                authorization: admitted,
                isCurrent: async () => true,
              });
        const action = {
          pluginId: 'happier.triage',
          localId: 'sessions/start-pull-request-review-v1',
        };
        const root: ActionExecutorContext = {
          surface: 'plugin',
          authority,
          runtimeAccountId: accountId,
          actionRequestId: 'review-start',
          externalActionExecutionAuthorization: authorization,
          externalActionTarget: target,
        };
        const reviewed = await invokeHostReviewedChildV1<{
          context: ActionExecutorContext;
        }>({
          parent: { actionId: 'action.invoke', input: { action, input: {} } },
          context: root,
          child: { action, role: 'action_invoke', input: {} },
          admittedReview: { action, role: 'action_invoke', surface: 'plugin' },
          execute: async (_input, context) => ({ context }),
        });
        if (!('context' in reviewed))
          throw new Error(
            `Expected the reviewed child: ${JSON.stringify(reviewed)}`,
          );
        // The executor's Session-bound SCM branch clears the inherited Machine target.
        const child: ActionExecutorContext = {
          ...reviewed.context,
          defaultSessionId: 'session-1',
          externalActionTarget: undefined,
        };
        const transport = createCliMachineActionTransport({
          credentials: { token, encryption: null },
          externalActionMachineInstallationId: 'installation',
          externalActionMachineRequestPrivateKey: new Uint8Array(32),
          machineActionDirectTargetTransport: {
            machineId: 'machine',
            invoke: rpc.invokeLocal.bind(rpc),
          },
        });
        const machineId = source === 'other-machine' ? 'another-machine' : 'machine';
        const call = transport.callMachineAction({
          machineId,
          method: 'scm.status.snapshot',
          effectActionId: 'scm.status.snapshot',
          exactMachine: true,
          authority,
          context: child,
          request: createTargetedActionRpcRequestV1(
            { cwd: repository.rootPath, detail: 'facts', outcomeVersion: 1, operationStateVersion: 1 },
            { kind: 'machine', machineId, project: { machineId, directory: repository.rootPath } },
            child,
          ),
        });
        if (source === 'owner-person' || source === 'owner-automation') {
          const result = await call;
          expect(ScmStatusSnapshotResponseSchema.parse(result)).toMatchObject({
            success: true,
            snapshot: { repo: { isRepo: true } },
          });
        } else if (source === 'foreign-home' || source === 'non-member') {
          await expect(call).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN, effectAttempted: false });
        } else {
          await expect(call).rejects.toMatchObject({
            code: 'not_authenticated',
          });
        }
      } finally {
        await rm(repository.rootPath, { recursive: true, force: true });
      }
    }),
);
