import { rm } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import axios from 'axios';
import {
  createActionExecutor,
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
import { ScmComparisonCaptureOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import {
  readContextRetainedVerifiedExternalActionRequester,
  retainVerifiedExternalActionRequester,
} from '@/daemon/agentIsolation/verifiedExternalActionRequester';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { createTestGitScmBackendRegistry } from '@/scm/rpc/__tests__/testRpcHarness';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { runWithRealGitScmRuntime } from '../../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import { createPluginActionCallerMaterializationFixture } from '@/plugins/runtime/invocation/services/actionCaller.testkit';
import { createEmptyActionAutomationPort } from '@/testkit/actionTransportDeps';
import { createCliMachineActionTransport } from './machineTransport';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { projectRequesterAccountActionAuthorization } from '@/daemon/sessionEncryption/requesterAccountActionProjection';

const token = `e30.${Buffer.from(
  JSON.stringify({
    sub: 'owner',
    tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' },
  }),
).toString('base64url')}.fixture`;
const sessionId = 'c222222222222222222222222';

// Live cut 53 (REVIEW-START-DISPATCH-LIVE-1127, request 7be112b5): the browser's
// mounted Triage Review Start reached the daemon as action.invoke with retained
// requester custody. The Triage Action runs as that root's reviewed action_invoke
// child, whose authorization is the reviewed-child descriptor copy. Its native
// review.start then rebuilds the context in the Actions service. Cut 54 showed
// that the next reviewed child lost the original requester during that rebuild.
it.each([
  'owner-person', 'owner-automation', 'unretained', 'copied-authorization', 'other-machine', 'foreign-home', 'non-member',
  'owner-comparison', 'unretained-comparison', 'non-member-comparison',
] as const)(
  "spends a reviewed action.invoke child's %s requester custody for targetless Session-placed SCM",
  async (source) =>
    runWithRealGitScmRuntime(async () => {
      const repository = createLocalScmRepositoryFixture({
        executable: 'git',
        repoMode: '.git',
        prefix: 'happier-reviewed-child-scm-',
      });
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
      env.patch({ HAPPIER_HOME_DIR: repository.rootPath, HAPPIER_ACTIVE_SERVER_ID: 'home' });
      reloadConfiguration();
      try {
        // Home HTTP is the boundary: the fixture owns this selected Session.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
          const path = new URL(String(url)).pathname;
          if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
          } };
          if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
          if (path.endsWith(`/sessions/${sessionId}`)) return { status: 200, data: {
            session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', machineId: 'machine',
              metadata: JSON.stringify({ path: repository.rootPath }), share: null }),
          } };
          return { status: 404, data: {} };
        });
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
        const registry = createTestGitScmBackendRegistry();
        registerScmHandlers(rpc, repository.rootPath, {
          machineId: 'machine',
          registry,
          // Compose native semantics directly, as the SCM placement harness does.
          // Protected Session access still reads Home through the real transport.
          actionExecutor: createActionExecutor({ scmActionExecute: input => executeScmActionOperation({
            ...input, actionContext: input.context, workingDirectory: repository.rootPath,
            accessPolicy: { kind: 'osUser' }, registry,
            authorizeSession: async selected => selected !== undefined && (await fetchSessionById({
              reason: 'session-action', token, sessionId: selected, serverUrl: 'https://home.test',
            }))?.id === selected,
          }) }),
          selectWorkspaceSource: filesystem.selectWorkspaceSource,
          admitWorkspaceSource: filesystem.rpc,
          resolveRequester: filesystem.resolveRpcRequester,
        });
        const target = { kind: 'machine', machineId: 'machine' } as const;
        const accountId = source === 'non-member' || source === 'non-member-comparison' ? 'non-member' : 'owner';
        const serverIdentityId = source === 'foreign-home' ? 'other-home' : 'home';
        const authority = source === 'owner-automation' ? 'account_automation' : 'present_user';
        const wireAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({
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
        const admitted = await projectRequesterAccountActionAuthorization({
          authorization: wireAuthorization, serverIdentityId,
          bootstrap: {
            credentials: { token, encryption: null },
            attribution: { accountId, serverId: serverIdentityId, machineId: 'machine', installationId: 'installation' },
            serverHttpBaseUrl: 'https://home.test', isCurrent: async () => true,
          },
        });
        if (!admitted) throw new Error('Fixture requester Account custody was unavailable');
        const authorization: ExternalActionExecutionAuthorizationV1 =
          source === 'unretained' || source === 'unretained-comparison'
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
        const parent = { actionId: 'action.invoke', input: { action, input: {} } };
        const reviewed = await invokeHostReviewedChildV1<{
          context: ActionExecutorContext;
        }>({
          parent,
          context: root,
          child: { action, role: 'action_invoke', input: {} },
          admittedReview: { action, role: 'action_invoke', surface: 'plugin' },
          execute: async (_input, context) => ({ context }),
        });
        if (!('context' in reviewed))
          throw new Error(
            `Expected the reviewed child: ${JSON.stringify(reviewed)}`,
          );
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
        const comparison = source === 'owner-comparison' || source === 'unretained-comparison' || source === 'non-member-comparison';
        const callScm = (method: typeof RPC_METHODS.SCM_STATUS_SNAPSHOT | typeof RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE,
          input: unknown, context: ActionExecutorContext) => {
          return transport.callMachineAction({
            machineId,
            method,
            effectActionId: method,
            exactMachine: true,
            authority,
            context,
            ...(comparison ? { authorization: { kind: 'session.write' as const, sessionId } } : {}),
            request: createTargetedActionRpcRequestV1(
              input,
              { kind: 'machine', machineId, project: { machineId, directory: repository.rootPath } },
              context,
            ),
          });
        };
        let call: ReturnType<typeof callScm> | undefined;
        const service = createPluginInvocationActionsService({
          seed: {
            plugin: { id: action.pluginId, version: '1.0.0' },
            ...createPluginActionCallerMaterializationFixture(action.pluginId, { machineId: 'machine' }),
            surface: 'plugin',
            occurrenceId: 'triage-occurrence',
            approvalContext: reviewed.context,
            reviewedParent: parent,
            ...(source === 'copied-authorization' ? {
              externalActionContext: {
                authority,
                actionRequestId: 'review-start',
                serverId: 'home',
                serverIdentityId: 'home',
                externalActionTarget: target,
                // Descriptor copies preserve the HTTP projection but cannot
                // spend the original proof held by another authorization.
                externalActionExecutionAuthorization: Object.defineProperties(
                  { ...authorization },
                  Object.getOwnPropertyDescriptors(reviewed.context.externalActionExecutionAuthorization ?? authorization),
                ),
              },
            } : {}),
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
          },
          actionExecutor: createActionExecutor({
            actionAutomations: createEmptyActionAutomationPort(accountId),
            reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex' }] }),
            resolveApiTokenGrantSessionMachineId: async () => 'machine',
            scmActionExecute: async ({ actionId, input, context }) => {
              if (actionId !== RPC_METHODS.SCM_STATUS_SNAPSHOT && actionId !== RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE) {
                throw new Error('Fixture ends after the SCM read');
              }
              if (comparison) {
                expect(actionId).toBe(RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE);
                expect(context.externalActionTarget).toBeUndefined();
                expect(readContextRetainedVerifiedExternalActionRequester(context)?.authorization)
                  .toBe(source === 'unretained-comparison' ? undefined : authorization);
              }
              const request = actionId === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE ? input
                : { cwd: repository.rootPath, detail: 'facts', outcomeVersion: 1, operationStateVersion: 1 };
              call = callScm(actionId, request, context);
              return await call;
            },
          }),
          invokeContributedAction: async () => { throw new Error('Unexpected contributed Action'); },
        });
        // This probe ends at SCM. Creating a Review Workflow is the loaded-runtime check.
        const review = await service.execute('review.start', {
          sessionId,
          instructions: 'Review the selected changes.',
          changeType: 'committed',
          reviewers: [{ kind: 'engine', engineId: 'codex' }],
          ...(comparison ? {
            cwd: repository.rootPath,
            source: { kind: 'pullRequest', locator: {
              providerId: 'example-forge', repository: 'example/reviews-fixture', number: 1,
              baseOid: repository.headCommit, headOid: repository.headCommit,
            } },
          } : {}),
        }).catch((error: unknown) => error);
        if (!call) throw new Error('Review Start did not reach its SCM read', { cause: review });
        if (source === 'owner-comparison') {
          const output = await call;
          const result = ScmComparisonCaptureOutputSchema.parse(output);
          expect(result, JSON.stringify(result)).toMatchObject({
            success: true,
            comparison: {
              source: { kind: 'pullRequest', locator: {
                providerId: 'example-forge', repository: 'example/reviews-fixture', number: 1,
                baseOid: repository.headCommit, headOid: repository.headCommit,
              } },
              repository: { rootPath: repository.rootPath },
            },
          });
        } else if (source === 'owner-person' || source === 'owner-automation') {
          const result = await call;
          expect(ScmStatusSnapshotResponseSchema.parse(result)).toMatchObject({
            success: true,
            snapshot: { repo: { isRepo: true } },
          });
        } else if (source === 'foreign-home' || source === 'non-member' || source === 'non-member-comparison') {
          await expect(call).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN, effectAttempted: false });
        } else {
          await expect(call).rejects.toMatchObject({
            code: 'not_authenticated',
          });
        }
      } finally {
        vi.restoreAllMocks();
        env.restore();
        reloadConfiguration();
        await rm(repository.rootPath, { recursive: true, force: true });
      }
    }),
);
