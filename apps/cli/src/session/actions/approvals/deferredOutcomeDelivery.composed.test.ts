import axios from 'axios';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { AccountSettingsSchema, ApprovalRequestV2Schema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { buildTrustedHostSessionInputAdmissionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { artifactReadResponse } from '@/testkit/http/artifactHome';
import { createCliActionDeps } from '../createCliActionDeps';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { executeExternalAction, type VerifyExternalActionExecutionAuthorization } from '@/daemon/externalActions/executeExternalAction';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createDeferredOutcomeDeliveryBoundary } from './deferredOutcomeDelivery.testkit';
import { UserMessageSchema } from '@/api/types';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { configuration } from '@/configuration';
import { createCliActionExecutorFromCredentials } from '../createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encryptWithDataKey } from '@/api/encryption';
import { encryptSessionPayload, sealSessionStoredContent } from '@/session/transport/encryption/sessionEncryptionContext';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// #117 retained a requester cause on each deferred agent approval. That makes
// its host-produced result protected input even for a plain Account.
it.each(([
  { actionId: 'deployments.environments.create', actionArgs: { requestKey: 'create', contentArtifactId: 'definition',
    contentHeaderVersion: 1, contentBodyVersion: 1, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers' }, failed: false, restrictedCredential: false },
  { actionId: 'deployments.templates.instantiate', actionArgs: { mode: 'apply', machineId: 'machine',
    projectSourceId: 'source', templateRef: { sourceId: 'data-services', itemId: 'redis', version: '0.0.0' } }, failed: false, restrictedCredential: false },
  { actionId: 'deployments.domains.add', actionArgs: { environmentId: 'environment', domainId: 'app.invalid',
    expectedRevision: 2, requestKey: 'domain', content: { hostname: 'app.invalid', target: { service: 'web', containerPort: 80 } } }, failed: true, restrictedCredential: false },
  { actionId: 'projects.sources.update', actionArgs: { sourceId: 'source', expectedRevision: 1, patch: { name: 'Edited' } }, failed: false, restrictedCredential: false, standaloneCredential: 'terminal' },
  { actionId: 'projects.sources.update', actionArgs: { sourceId: 'source', expectedRevision: 1, patch: { name: 'Edited' } }, failed: false, restrictedCredential: false, standaloneCredential: 'account' },
  { actionId: 'projects.sources.update', actionArgs: { sourceId: 'source', expectedRevision: 1, patch: { name: 'Edited' } }, failed: false, restrictedCredential: false, encryptionMode: 'e2ee' },
  { actionId: 'deployments.teardown', actionArgs: { environmentId: 'environment', requestKey: 'teardown', removeEnvironment: true }, failed: false, restrictedCredential: false },
  { actionId: 'deployments.environments.create', actionArgs: { requestKey: 'restricted-create', contentArtifactId: 'definition',
    contentHeaderVersion: 1, contentBodyVersion: 1 }, failed: false, restrictedCredential: true },
] as const).map(scenario => ({ encryptionMode: 'plain' as const, ...scenario })))('settles $actionId delivery with its own credential custody ($encryptionMode, $restrictedCredential)', async scenario => {
  await withConfiguredDaemonTestHome({ prefix: 'approval-result-delivery-', env: {
    HAPPIER_SERVER_URL: 'https://approval-home.test', HAPPIER_WEBAPP_URL: 'https://approval-home.test',
    HAPPIER_TOKEN: undefined, HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: undefined,
    HAPPIER_ACCOUNT_SETTINGS_MODE: 'auto', HAPPIER_ACTIONS_SETTINGS_V1: undefined,
  } }, async () => {
  const { actionId, actionArgs, failed } = scenario;
  const authenticationKind = 'standaloneCredential' in scenario ? scenario.standaloneCredential : 'account' as const;
  const canRelay = !scenario.restrictedCredential;
  const mode = scenario.encryptionMode;
  const accountId = 'owner', serverId = configuration.activeServerId, machineId = 'machine', sessionId = 'cmv3approvaldeliveryaaaa';
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0,
    provenance: { v: 1, kind: authenticationKind, authority: authenticationKind === 'terminal' ? 'account_automation' : 'present_user' } })).toString('base64url')}.signature`;
  const secret = new Uint8Array(32).fill(23);
  const credentials = { token, encryption: mode === 'plain' ? null : { type: 'legacy' as const, secret }, credentialProvenance: canRelay ? 'stored_session' as const : 'api_token' as const };
  const sessionCrypto = mode === 'plain' ? { mode, ctx: null } as const
    : { mode, ctx: { encryptionKey: secret, encryptionVariant: 'legacy' as const } } as const;
  let sessionActive = true;
  const origin = await createDeferredOutcomeDeliveryBoundary({ accountId, serverId, serverIdentityId: serverId,
    machineId, sessionId, sessionCrypto, callerAuthority: authenticationKind === 'terminal' ? 'account_automation' : 'present_user',
    readReceiver: () => receiver });
  const { installation, currentness, admittedInputs, delivered } = origin;
  onTestFinished(() => origin.close());
  const lifetime = new AbortController();
  onTestFinished(() => lifetime.abort());
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({ features: {},
    capabilities: { serverIdentity: { serverIdentityId: serverId }, encryption: {
      storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }))));
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: accountId } };
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
    if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 1 } };
    if (url.endsWith('/v1/account/settings') || url.endsWith('/v2/account/settings')) return { status: 200,
      data: { version: 1, content: { t: 'plain', v: AccountSettingsSchema.parse({}) } } };
    if (url.endsWith(`/v1/machines/${machineId}`)) return { status: 200, data: { machine: {
      id: machineId, kind: 'persistent', active: true, installationId: 'installation',
      installationPublicKey: encodeBase64(installation.publicKey), revokedAt: null, replacedByMachineId: null,
      storageMode: 'plain', access: { custodian: { accountId, displayName: 'Owner' }, role: 'manage',
        resourceMode: 'plain', accessState: 'ready' },
    } } };
    if (url.endsWith('/v1/artifacts/approval')) return { status: 200, data: artifact };
    if (url.endsWith(`/messages/by-local-id/${encodeURIComponent('approval-result:approval')}`)) {
      const retainedContent = origin.readRetainedContent('approval-result:approval');
      if (!retainedContent) throw Object.assign(new axios.AxiosError('Message not found'), {
        response: { status: 404, data: { error: 'Message not found' } },
      });
      return { status: 200, data: { message: { id: 'delivered-outcome', seq: 1, localId: 'approval-result:approval',
        content: retainedContent, createdAt: 2, updatedAt: 2 } } };
    }
    if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
      id: sessionId, active: sessionActive, encryptionMode: mode, machineId,
      metadata: sessionCrypto.mode === 'plain' ? JSON.stringify({ machineId })
        : encryptSessionPayload({ ctx: sessionCrypto.ctx, payload: { machineId } }) }) } };
    throw new Error(`Unexpected HTTP path: ${new URL(url).pathname}`);
  });
  const transportFailures: unknown[] = [];
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    try {
    if (url.endsWith('/v1/artifacts/read')) return { status: 200, data: artifactReadResponse(body,
      id => id === artifact.id ? artifact : null).data };
    if (url.endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
    const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
    const envelope = ExternalActionRequestEnvelopeSchema.parse(carrier.success ? carrier.data.envelope : body);
    if (envelope.v !== 1) throw new Error('Plain Account fixture');
    if (url.endsWith('/execution-authorization')) return { status: 200, data: { v: 1, token: 'home-admission', binding: {
      serverIdentityId: serverId, accountId, custodianAccountId: accountId,
      authentication: { kind: authenticationKind, tokenEpoch: 0 }, accountEncryptionMode: 'plain',
      machineId, installationId: 'installation', actionId: 'session.message.send',
      requestId: envelope.requestId, target: envelope.target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } } };
    expect(new URL(url).pathname).toBe('/v1/actions/session.message.send');
    // Only network boundaries are replaced. The receiving external Action,
    // installation-private requester custody and Session input author stay real.
    const received = await executeExternalAction({ actionId: 'session.message.send', envelope,
      principal: { accountId, authority: 'present_user', authentication: { kind: authenticationKind, tokenEpoch: 0 } },
      ...(carrier.success ? { executionAuthorization: carrier.data.executionAuthorization } : {}),
      currentMachineId: machineId, currentAccountId: accountId, currentServerId: serverId,
      ...(envelope.target?.kind === 'session' ? { currentSessionId: sessionId } : {}),
      currentInstallationId: 'installation', currentServerHttpBaseUrl: 'https://approval-home.test',
      externalActionMachineRequestPrivateKey: installation.secretKey,
      verifyExecutionAuthorization,
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: 'https://approval-home.test' }),
      executor: receiver,
      prepareRequesterAccountContext: input => prepareRequesterAccountActionContext({ ...input,
        purpose: { kind: 'external_action' }, machineId, installationId: 'installation',
        installationPrivateKey: installation.secretKey, serverId, serverIdentityId: serverId,
        serverHttpBaseUrl: 'https://approval-home.test',
        isCurrent: () => verifyExecutionAuthorization({ authorization: input.authorization,
          effectActionId: input.authorization.binding.actionId, target: input.authorization.binding.target }),
        isCustodyCurrent: async () => !lifetime.signal.aborted, createExecutor: () => receiver,
      }),
    });
    for (const call of receivingExecute.mock.results) {
      if (call.type === 'throw') transportFailures.push(call.value);
      else if (call.type === 'return') await Promise.resolve(call.value).catch(error => { transportFailures.push(error); });
    }
    if (received.kind !== 'response') throw new Error(`Receiving Action refused: ${received.errorCode}`);
    return { status: 200, data: received.prepared.response };
    } catch (error) { transportFailures.push(error); throw error; }
  });
  const status = failed ? 'failed' : 'executed';
  const stored = ApprovalRequestV2Schema.parse({ v: 2, status, createdAtMs: 1, updatedAtMs: 2,
    createdBy: { surface: 'agent' }, requestedSurface: 'agent', approval: { flow: 'deferred', result: 'required' },
    actionId, actionArgs, summary: 'Reviewed deployment change',
    decision: { kind: 'approve', decidedAtMs: 1, authority: 'present_user' },
    execution: failed ? { executedAtMs: 2, ok: false, errorCode: 'required_fact_unavailable', error: 'required_fact_unavailable' }
      : { executedAtMs: 2, ok: true, result: { ok: true } },
    executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', accountId, serverId, serverIdentityId: serverId,
      sessionId, machineId, caller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
      actionId, requestId: 'original', actionRequestAttributionV1: {
        requestRef: 'original-person-input', requester: { serverId, accountId }, persona: { serverId, sessionId }, origin: null } } });
  const resource = await createResourceDataKey({ credentials, mode });
  const sealArtifact = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
    : encodeBase64(encryptWithDataKey(value, resource.dataKey));
  const artifact = { id: 'approval', ownerAccountId: accountId, access: 'owner', encryptionMode: mode, publicAudience: 'none',
    dataEncryptionKey: resource.dataEncryptionKey ?? ARTIFACT_PLAIN_DATA_KEY_MARKER,
    header: sealArtifact(buildApprovalRequestArtifactHeaderV1(stored)),
    body: sealArtifact({ body: JSON.stringify(stored) }),
    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2 };
  const deps = createCliActionDeps({ credentials, token, ...sessionCrypto, sessionId: '', serverId,
    serverIdentityId: serverId, serverHttpBaseUrl: 'https://approval-home.test' });
  const verifyExecutionAuthorization: VerifyExternalActionExecutionAuthorization = input =>
    verifyExternalActionExecutionAuthorizationCurrent({ ...input, privateKey: installation.secretKey,
      installationId: 'installation', serverHttpBaseUrl: 'https://approval-home.test' });
  const receiver = createActionExecutor(createCliActionDeps({ credentials, token, ...sessionCrypto,
    sessionId: '', serverId, serverIdentityId: serverId, serverHttpBaseUrl: 'https://approval-home.test',
    externalActionMachineInstallationId: 'installation', externalActionMachineRequestPrivateKey: installation.secretKey,
    machineAdmissionTransport: origin.machineAdmissionTransport,
  }));
  const receivingExecute = vi.spyOn(receiver, 'execute');
  const outcomeReplayArtifacts = origin.replayArtifacts;
  const executor = 'standaloneCredential' in scenario
    ? createCliActionExecutorFromCredentials({ credentials, serverId, serverIdentityId: serverId,
      serverApiUrl: 'https://approval-home.test',
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: AccountSettingsSchema.parse({}) }) })
    : mode === 'e2ee' ? receiver : createActionExecutor(deps);
  if (canRelay) {
    // The hosting origin has its authenticated Machine transport. Settle its
    // already-recorded outcome before the standalone deciding CLI rejoins it.
    expect(await receiver.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, {
      surface: 'cli', authority: 'present_user', runtimeAccountId: accountId, serverId, serverIdentityId: serverId,
    })).toMatchObject({ ok: true, result: { status } });
    sessionActive = false;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await executor.execute('approval.request.decide', {
      artifactId: 'approval', decision: 'approve' }, { surface: 'cli', authority: 'present_user', runtimeAccountId: accountId,
      serverId, serverIdentityId: serverId });
    expect(transportFailures).toEqual([]);
    expect(result, JSON.stringify(result)).toMatchObject(canRelay
      ? { ok: true, result: { status } }
      : { ok: false, errorCode: 'session_input_target_unavailable' });
  }
  for (const authored of admittedInputs) {
    if (authored.content.type !== 'text') throw new Error('Expected outcome text');
    expect(JSON.parse(authored.content.text)).toMatchObject({ actionId, status: failed ? 'failed' : 'executed' });
  }
  expect([...delivered]).toEqual(canRelay ? ['approval-result:approval'] : []);
  expect(origin.readMachineAdmissionRequests()).toBe(canRelay ? 1 : 0);
  if ('standaloneCredential' in scenario) {
    // Each standalone rejoin reaches the same origin publisher, regardless of
    // principal, instead of minting another attributed input at the CLI.
    expect(outcomeReplayArtifacts).toEqual([{ artifactId: 'approval' }, { artifactId: 'approval' }]);
  }
  if (canRelay) {
    if (!stored.executionOriginV1) throw new Error('Missing stored execution origin');
    // The native origin already published this localId before the deciding CLI
    // returned. Every rejoin must retain that same canonical protected input.
    const originalInput = buildTrustedHostSessionInputAdmissionV1('mcp', stored.executionOriginV1.actionRequestAttributionV1);
    expect(admittedInputs[0]).toMatchObject({ meta: {
      happierProvenanceV1: originalInput.provenance, happierInputRequestV1: originalInput.request,
    } });
    expect(admittedInputs).toEqual([admittedInputs[0]]);
  }
  if (mode === 'e2ee') {
    const originalInput = UserMessageSchema.parse(admittedInputs[0]);
    // A matching localId is insufficient when the retained result differs.
    origin.setRetainedContent('approval-result:approval', sealSessionStoredContent({ ...sessionCrypto, payload: {
      ...originalInput, content: { type: 'text', text: 'different outcome' },
    } }));
    expect(await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, {
      surface: 'cli', authority: 'present_user', runtimeAccountId: accountId, serverId, serverIdentityId: serverId,
    })).toMatchObject({ ok: false, errorCode: 'session_input_idempotency_conflict' });
    // Never reinterpret a plain envelope as the E2EE Session's retained input.
    origin.setRetainedContent('approval-result:approval', { t: 'plain', v: originalInput });
    expect(await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, {
      surface: 'cli', authority: 'present_user', runtimeAccountId: accountId, serverId, serverIdentityId: serverId,
    })).toMatchObject({ ok: false });
    expect(admittedInputs).toEqual([originalInput]);
    expect(origin.readMachineAdmissionRequests()).toBe(1);
  }
  });
});
