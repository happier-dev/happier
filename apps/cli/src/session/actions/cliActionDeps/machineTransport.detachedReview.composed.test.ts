import { expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { REVIEW_HUMAN_ACTION_IDS_V1, REVIEW_START_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ReviewHumanActionStateV1Schema } from '@happier-dev/protocol/reviews/reviewHumanV1';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { configuration } from '@/configuration';
import { retainVerifiedExternalActionRequester } from '@/daemon/agentIsolation/verifiedExternalActionRequester';
import { registerScmHandlers } from '@/rpc/handlers/scm';
import { createSessionBoundScmAction } from '@/scm/actions/sessionBoundAction';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
import { createTestGitScmBackendRegistry } from '@/scm/rpc/__tests__/testRpcHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEmptyActionAutomationPort } from '@/testkit/actionTransportDeps';
import { createInMemoryReviewRecordPortV1 } from '../../../../../../packages/protocol/src/reviews/reviewArtifactV1.testkit';
import { GITLAB_PLUGIN_ID, GITLAB_TRIAGE_DETAIL_ACTION_IDS } from '../../../../../../packages/plugins/scm-gitlab/src/triage/contribution';
import { createCliMachineActionTransport } from './machineTransport';

it.each(['installed Home', 'foreign Home'] as const)('captures the GitLab head and title only for the %s on direct detached Review start', async home => {
  await withTempDir('detached-review-', async cwd => {
    const machineId = 'machine';
    const installationId = 'installation';
    const accountId = 'owner';
    const serverId = configuration.activeServerId;
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.fixture`;
    const target = { kind: 'machine', machineId, project: { machineId, directory: cwd } } as const;
    const authorization = retainVerifiedExternalActionRequester({
      authorization: ExternalActionExecutionAuthorizationV1Schema.parse({
        v: 1, token: 'admitted-review-start',
        binding: { accountId, custodianAccountId: accountId, authentication: { kind: 'account', tokenEpoch: 0 },
          accountEncryptionMode: 'plain', serverIdentityId: home === 'installed Home' ? serverId : 'foreign-home', machineId, installationId,
          admittedMachineRole: 'manage', actionId: REVIEW_START_ACTION_ID_V1, requestId: 'detached-review-start',
          requestEnvelopeDigest: 'a'.repeat(43), target },
      }),
      isCurrent: async () => true,
    });
    const rpc = new RpcHandlerManager({
      scopePrefix: machineId, encryptionMode: 'plain', logger: () => {},
      authorizeRequest: request => authorizeMachineRpcRequest(request, {
        machineId, resolveHomeServerIdentityId: async () => serverId, resolveCustodianAccountId: async () => accountId,
        resolveInstallationId: () => installationId, verifyMachineAdmission: async () => false,
      }),
    });
    // The native receiver owns the capture and storage. Its default executor has
    // no contributed Action invoker of its own, as on the signed daemon route.
    registerScmHandlers(rpc, cwd, { machineId, actionExecutor: createActionExecutor({
      actionAutomations: createEmptyActionAutomationPort(accountId),
      scmActionExecute: input => executeScmActionOperation({
        ...input, actionContext: input.context, workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots', roots: [cwd] },
        registry: createTestGitScmBackendRegistry(),
      }),
    }) });
    const credentials = { token, encryption: null };
    const machineActionDirectTargetTransport = { machineId, invoke: rpc.invokeLocal.bind(rpc) };
    const transport = createCliMachineActionTransport({ credentials, machineActionDirectTargetTransport,
      externalActionMachineInstallationId: installationId, externalActionMachineRequestPrivateKey: new Uint8Array(32),
      serverId, serverIdentityId: serverId });
    const records = createInMemoryReviewRecordPortV1();
    const locator = { providerId: 'gitlab', repository: 'https://gitlab.example.test/qa/fixture', number: 7 };
    const sourceAction = { action: { pluginId: GITLAB_PLUGIN_ID, localId: GITLAB_TRIAGE_DETAIL_ACTION_IDS.listChanges },
      input: { v: 1, entryRef: { kindId: 'merge-request', entryId: '7' }, sourceInstanceId: 'fixture' } };
    const headOid = 'b'.repeat(40);
    const baseOid = 'c'.repeat(40);
    const title = 'MR !7 Restore fixture sign-in';
    const url = `${locator.repository}/-/merge_requests/7`;
    const person = { kind: 'person', principal: { kind: 'account', accountId }, required: true } as const;
    const unexpected = () => { throw new Error('A detached Review must not select a Session'); };
    let sourceRead = false;
    const executor = createActionExecutor({
      actionAutomations: createEmptyActionAutomationPort(accountId),
      scmActionExecute: createSessionBoundScmAction({ credentials, token, serverId, serverIdentityId: serverId,
        machineActionDirectTargetTransport, externalActionMachineInstallationId: installationId }, {
        ...transport, normalizeStringValue: value => typeof value === 'string' ? value : null,
        invokeSessionPullRequestBinding: unexpected, readTransportSessionOwnerMetadata: unexpected,
        readCurrentMachineControlIdentity: async () => ({ machineId, host: null, homeDir: cwd }),
        resolveServerRequestHeaders: unexpected, resolveTransportForSession: unexpected,
      }),
      // The configured source Action is the forge boundary. Review, source
      // dispatch, native Machine transport and comparison capture are real.
      invokeContributedAction: async request => {
        sourceRead = true;
        expect(request.action).toEqual(sourceAction.action);
        expect(request.input).toEqual({ ...sourceAction.input, comparison: true });
        expect(request.requiredDangerLevel).toBe('safe');
        return { ok: true, result: { kind: 'changedFiles', rows: [], omittedRowCount: 0, projectionTruncated: false,
          comparison: { title, url, locator, beforeOid: baseOid, baseOid, headOid, freshness: 'current',
            totalFileCount: 0, enumeratedFileCount: 0, inventory: 'complete', content: 'complete', reasons: [] } } };
      },
      reviewRecords: () => records,
      homeDomainAction: async ({ actionId, input }) => {
        expect(actionId).toBe(REVIEW_HUMAN_ACTION_IDS_V1.setReviewers);
        const { reviewId } = input as { reviewId: string };
        return ReviewHumanActionStateV1Schema.parse({ reviewId, roundOrdinal: 1, requests: [], verdicts: [], needsYou: {
          reviewId, roundOrdinal: 1, reason: 'review_needs_you', needsYou: true, requestedVerdict: true,
          pendingDecisions: false, canSubmitVerdict: true,
        } });
      },
    });
    const started = await executor.execute(REVIEW_START_ACTION_ID_V1, {
      target: { kind: 'detached' }, cwd, instructions: 'Review the changed files.', reviewers: [person],
      source: { kind: 'pullRequest', locator: { ...locator, headOid, baseOid, sourceAction } },
    }, { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, serverId, serverIdentityId: serverId,
      externalActionTarget: target, externalActionExecutionAuthorization: authorization, runtimeAccountId: accountId,
      actionRequestId: 'detached-review-start',
    });
    if (home === 'foreign Home') {
      expect(started, JSON.stringify(started)).toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });
      expect(sourceRead).toBe(false);
      return;
    }
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true, result: { sessionId: null, reviewRound: { reviewId: expect.any(String) } } });
    if (!started.ok) return;
    const result = started.result as { reviewRound: { reviewId: string } };
    expect.soft(result).toMatchObject({ reviewTarget: { locator, headOid, url } });
    expect(await records.read(result.reviewRound.reviewId)).toMatchObject({ title });
  });
});
