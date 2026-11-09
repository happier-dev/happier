import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import nacl from 'tweetnacl';
import { createActionExecutor, ScmDiffSummaryGenerateOutputSchema, type ActionExecutorContext } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { signExternalActionApprovalInputV1, verifyScmRefineSavedSessionV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createScmDiffSummaryResultOperations, createUiAccountActionTransport } from '@happier-tests/ui-scm-refine-admission';
import { createCliActionDeps } from '../../../../apps/cli/src/session/actions/createCliActionDeps';
import { executeScmActionOperation } from '../../../../apps/cli/src/scm/actions/executeScmActionOperation';
import { scmDiffSummaryResultStore } from '../../../../apps/cli/src/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { configuration, reloadConfiguration } from '../../../../apps/cli/src/configuration';
import { createUnavailableActionTransportDeps } from '../../../../apps/cli/src/testkit/actionTransportDeps';
import { createSessionRecordFixture } from '../../../../apps/cli/src/testkit/backends/sessionFixtures';
import { fetchSessionById } from '../../../../apps/cli/src/session/transport/http/sessionsHttp';
import { installAxiosFastifyAdapter } from '../../../../apps/cli/src/testkit/http/axiosAdapter';
import { withTempDir } from '../../../../apps/cli/src/testkit/fs/tempDir';
import { runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { decodeBase64, decrypt, encodeBase64, encryptLegacy } from '../../../../apps/cli/src/api/encryption';
import { UserMessageSchema } from '../../../../apps/cli/src/api/types';
import { SessionInputRequestV1Schema, SessionMessageMetaSchema, settleSessionInputRequestV1,
  settleSessionMessageProvenanceV1, withSessionInputAuthorityV1 } from '@happier-dev/protocol';
import { createReducer, normalizeRawMessage, reducer } from '@happier-dev/session-core';
import { readMessageDisplayText } from '@happier-dev/session-core/messages';
import { createPendingMessageFixture, resolveExecutionRunVisibleMessages,
  resolvePendingMessageContentPresentation } from '@happier-tests/ui-scm-refine-admission';

afterEach(() => { vi.unstubAllEnvs(); reloadConfiguration(); });

it('admits the UI saved-reading Refine through Account relay and protected Machine input', async () => {
  await withTempDir('happier-ui-refine-', async cwd => {
    vi.stubEnv('HAPPIER_HOME_DIR', cwd);
    reloadConfiguration();
    const serverId = configuration.activeServerId;
    const sessionId = 'c123456789012345678901234';
    const machineId = 'refine-machine';
    const accountId = 'refine-account';
    const origin = 'http://ui-refine-home.test';
    const secret = new Uint8Array(32).fill(21);
    const tokenPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${tokenPart({ alg: 'none' })}.${tokenPart({ sub: accountId, tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })}.signature`;
    const credentials = { token, credentialProvenance: 'stored_session' as const,
      encryption: { type: 'legacy' as const, secret } };
    const rawSession = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'e2ee',
      metadata: encodeBase64(encryptLegacy({ machineId, path: cwd }, secret)) });
    const output = ScmDiffSummaryGenerateOutputSchema.parse({ success: true, sourceKey: 'comparison', runId: 'saved-run',
      metadata: { source: { kind: 'workingTree' }, sourceKey: 'comparison' },
      comparison: { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: cwd }, endpoints: {},
        inventory: { state: 'complete', files: [], reasons: [] } }, requestedOutputs: ['walkthrough'],
      outputs: { walkthrough: { state: 'complete', value: { title: 'Saved', intro: '', stops: [], otherChangeRefs: [] } } },
      analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } });
    const saved = await scmDiffSummaryResultStore.create({ cwd, sessionId, output });
    const installation = nacl.sign.keyPair();
    const app = fastify();
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'e2ee', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v1/account/encryption', async () => ({ mode: 'e2ee', updatedAt: 1 }));
    app.get(`/v2/sessions/${sessionId}`, async () => ({ session: rawSession }));
    // The HTTP Pending boundary does not admit an SCM root as a direct send.
    // The approved child purpose belongs to authenticated Machine Pending.
    app.setNotFoundHandler(async (_request, reply) => reply.code(403).send({ error: 'forbidden' }));
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin });
    const admitted: string[] = [];
    const relayed: string[] = [];
    const boundaryFailures: unknown[] = [];
    const run = { runId: 'saved-run', callId: 'call', sidechainId: 'sidechain',
      intent: 'scm_diff_summary', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
      status: 'running', turnInFlight: false, startedAtMs: 1, lifecycle: { v: 1, state: 'current' },
      interaction: { kind: 'retained_agent_session.v1', capabilities: { open: ['create', 'resume'], delivery: ['newTurn'], cancel: true } } };
    try {
      const cliDeps = createCliActionDeps({ token, credentials, sessionId, mode: 'e2ee', rawSession,
        ctx: { encryptionKey: secret, encryptionVariant: 'legacy' }, serverId, serverHttpBaseUrl: origin,
        serverIdentityId: 'srv_ui_refine', externalActionMachineInstallationId: 'installation',
        externalActionMachineRequestPrivateKey: installation.secretKey,
        invokeBoundSessionRpc: async method => method === SESSION_RPC_METHODS.EXECUTION_RUN_GET
          ? { run } : { ok: false, errorCode: 'unsupported_method' },
        resolveServerFeaturesSnapshot: () => undefined,
        machineAdmissionTransport: async (request, options) => {
          try {
          expect(verifyScmRefineSavedSessionV1(options!.callerInputAuthorization!, installation.publicKey)).toBe(true);
          expect(request).toMatchObject({ v: 2, sessionId, targetMachineId: machineId,
            recipient: { kind: 'execution_run', runId: 'saved-run' }, requestedAction: { v: 1, kind: 'send_now' } });
          expect(request.localId).toBe(relayed[0]);
          if (request.content.t !== 'encrypted') throw new Error('Expected encrypted input');
          const message = UserMessageSchema.parse(decrypt(secret, 'legacy', decodeBase64(request.content.c)));
          expect(message.meta).toMatchObject({ displayText: 'Shorten it.',
            happierProvenanceV1: { kind: 'host', producer: 'happierApp' },
            happierInputRequestV1: { producer: 'happierApp', caller: { kind: 'host' } } });
          const pending = createPendingMessageFixture({ id: request.localId, localId: request.localId,
            text: message.content.text, displayText: SessionMessageMetaSchema.parse(message.meta).displayText, rawRecord: message });
          expect(resolvePendingMessageContentPresentation(pending).isHostInput).toBe(false);
          expect(readMessageDisplayText(pending) === 'Shorten it.').toBe(true);
          // Machine transport admission is followed by the real Session's protected
          // settlement before the same record is normalized for history/socket readers.
          const inputRequest = SessionInputRequestV1Schema.parse(message.meta?.happierInputRequestV1);
          const inputAdmissionReceipt = { v: 1, issuer: 'authenticatedMachine' } as const;
          const authority = settleSessionInputRequestV1({ request: inputRequest,
            currentSessionPermissionCeiling: 'default', inputAdmissionReceipt });
          const settled = { ...message, meta: { ...withSessionInputAuthorityV1(message.meta ?? {}, authority),
            happierProvenanceV1: settleSessionMessageProvenanceV1({ request: inputRequest,
              requestedProvenance: message.meta?.happierProvenanceV1, inputAdmissionReceipt }) } };
          const normalized = normalizeRawMessage('committed-refine', request.localId, 1, settled);
          if (!normalized) throw new Error('Refine transcript input did not normalize');
          const committed = reducer(createReducer(), [normalized], null).messages;
          const visible = resolveExecutionRunVisibleMessages({ runId: 'saved-run', messages: [], focusedMessages: committed });
          expect(visible.map(row => row.localId)).toEqual([request.localId]);
          const row = visible[0];
          if (row?.kind !== 'user-text') throw new Error('Expected the committed person input');
          expect(readMessageDisplayText(row) === 'Shorten it.').toBe(true);
          expect(row.text.includes(saved.resultId)).toBe(true);
          expect(row.text === 'Shorten it.').toBe(false);
          admitted.push(request.localId);
          return { status: 'accepted', localId: request.localId };
          } catch (error) { boundaryFailures.push(error); throw error; }
        },
      });
      const receiver = createActionExecutor({ ...createUnavailableActionTransportDeps(),
        sessionSendMessage: cliDeps.sessionSendMessage,
        executionRunGet: async () => ({ run }),
        scmActionExecute: args => executeScmActionOperation({ actionId: args.actionId, input: args.input,
          workingDirectory: cwd, sessionId, authorizeSession: async id => Boolean(id && await fetchSessionById({
            reason: 'session-control', token, sessionId: id, serverUrl: origin })),
          actionContext: args.context, executeCanonicalAction: args.executeCanonicalAction }),
      });
      const accountAction = createUiAccountActionTransport({
        account: { serverId, accountId, assertCurrent() {}, assertResultCurrent() {} },
        resolveFallbackMachineId: () => machineId,
        // Home/daemon transport is the boundary. Preserve the invocation actually
        // produced by the UI relay, then run real saved-scope and message admission.
        transport: async request => {
          relayed.push(request.requestId);
          const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: randomUUID(), binding: {
            serverIdentityId: 'srv_ui_refine', accountId, custodianAccountId: accountId,
            authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'e2ee',
            machineId, installationId: 'installation', actionId: request.actionId, requestId: request.requestId,
            requestEnvelopeDigest: 'A'.repeat(43), target: request.target,
          } });
          const context: ActionExecutorContext = { ...request.invocation, actionCaller: request.invocation.caller,
            serverId, defaultSessionId: sessionId, defaultSessionMachineId: machineId,
            externalActionExecutionAuthorization: authorization, externalActionTarget: request.target,
            signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
              actionId: args.actionId, target: args.target, input: args.input, privateKey: installation.secretKey }) };
          const result = await runWithServerHttpBaseUrl(origin, () => receiver.execute(request.actionId, request.payload, context));
          return result.ok ? result.result : result;
        },
      });
      const uiExecutor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
        scmActionExecute: args => accountAction({ ...args, context: { ...args.context, serverId,
          runtimeAccountId: accountId, authority: 'present_user', actionCaller: { kind: 'host' } } }),
      });
      const operations = createScmDiffSummaryResultOperations({ machineId, serverId, accountId,
        shouldContinue: () => true, actionExecutor: uiExecutor });
      const refined = await operations.refine({ cwd, resultId: saved.resultId, expectedRevision: saved.revision,
        output: 'walkthrough', instructions: 'Shorten it.' });
      expect(boundaryFailures).toEqual([]);
      expect(refined, JSON.stringify(refined)).toMatchObject({ success: true, inputId: relayed[0], runId: 'saved-run' });
      expect(relayed).toHaveLength(1);
      expect(admitted).toEqual(relayed);
    } finally { restore(); await app.close(); }
  });
});
