import axios from 'axios';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { AccountSettingsSchema, ApprovalRequestV2Schema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { ArtifactJsonUpdateHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactMutationHttpV1';
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
  { actionId: 'projects.sources.update', actionArgs: { sourceId: 'source', expectedRevision: 1, patch: { name: 'Edited' } }, failed: false, restrictedCredential: false, deliveryFailure: 'before_lookup' },
  { actionId: 'projects.sources.update', actionArgs: { sourceId: 'source', expectedRevision: 1, patch: { name: 'Edited' } }, failed: false, restrictedCredential: false, deliveryFailure: 'during_lookup' },
  { actionId: 'projects.sources.update', actionArgs: { sourceId: 'source', expectedRevision: 1, patch: { name: 'Edited' } }, failed: false, restrictedCredential: false, deliveryFailure: 'before_pending' },
  { actionId: 'projects.sources.update', actionArgs: { sourceId: 'source', expectedRevision: 1, patch: { name: 'Edited' } }, failed: false, restrictedCredential: false, deliveryFailure: 'lost_ack' },
  { actionId: 'projects.sources.update', actionArgs: { sourceId: 'source', expectedRevision: 1, patch: { name: 'Edited' } }, failed: false, restrictedCredential: false, standaloneCredential: 'terminal' },
  { actionId: 'projects.sources.update', actionArgs: { sourceId: 'source', expectedRevision: 1, patch: { name: 'Edited' } }, failed: false, restrictedCredential: false, standaloneCredential: 'account' },
  { actionId: 'projects.sources.update', actionArgs: { sourceId: 'source', expectedRevision: 1, patch: { name: 'Edited' } }, failed: false, restrictedCredential: false, encryptionMode: 'e2ee' },
  { actionId: 'deployments.teardown', actionArgs: { environmentId: 'environment', requestKey: 'teardown', removeEnvironment: true }, failed: false, restrictedCredential: false },
  { actionId: 'deployments.environments.create', actionArgs: { requestKey: 'restricted-create', contentArtifactId: 'definition',
    contentHeaderVersion: 1, contentBodyVersion: 1 }, failed: false, restrictedCredential: true },
] as const).map(scenario => ({ encryptionMode: 'plain' as const, ...scenario })))('settles $actionId delivery with its own credential custody ($encryptionMode, $restrictedCredential, $deliveryFailure)', async scenario => {
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
  const deliveryFailure = 'deliveryFailure' in scenario ? scenario.deliveryFailure : undefined;
  const pendingAdmission = vi.fn(async (request: Parameters<typeof origin.machineAdmissionTransport>[0]) => {
    if (deliveryFailure === 'before_pending') return { status: 'rejected', code: 'session_input_target_unavailable' } as const;
    const receipt = await origin.machineAdmissionTransport(request);
    if (deliveryFailure === 'lost_ack') throw new Error('socket closed after dispatch');
    return receipt;
  });
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
    if (deliveryFailure === 'before_lookup' && new URL(url).pathname === '/v2/sessions') {
      return { status: 200, data: { sessions: [], nextCursor: null, hasNext: false } };
    }
    if (url.endsWith('/v1/artifacts/approval')) return { status: 200, data: artifact };
    if (url.endsWith(`/messages/by-local-id/${encodeURIComponent('approval-result:approval')}`)) {
      if (deliveryFailure === 'during_lookup') throw Object.assign(new axios.AxiosError('Session not found'), {
        response: { status: 404, data: { error: 'Session not found' } },
      });
      const retainedContent = origin.readRetainedContent('approval-result:approval');
      if (!retainedContent) throw Object.assign(new axios.AxiosError('Message not found'), {
        response: { status: 404, data: { error: 'Message not found' } },
      });
      return { status: 200, data: { message: { id: 'delivered-outcome', seq: 1, localId: 'approval-result:approval',
        content: retainedContent, createdAt: 2, updatedAt: 2 } } };
    }
    if (deliveryFailure === 'before_lookup' && url.includes(`/v2/sessions/${sessionId}`)) {
      return { status: 404, data: { error: 'Session not found' } };
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
    if (deliveryFailure === 'before_lookup' && url.endsWith('/v2/sessions/lookup-by-tags')) {
      return { status: 200, data: { sessions: [] } };
    }
    if (url.endsWith('/v1/artifacts/read')) return { status: 200, data: artifactReadResponse(body,
      id => id === artifact.id ? artifact : null).data };
    if (url.endsWith('/v1/artifacts/approval')) {
      const updated = ArtifactJsonUpdateHttpInputV1Schema.parse(body);
      if (updated.expectedHeaderVersion !== artifact.headerVersion || updated.expectedBodyVersion !== artifact.bodyVersion) {
        return { status: 200, data: { success: false, error: 'version-mismatch' } };
      }
      artifact = { ...artifact, header: updated.header ?? artifact.header, body: updated.body ?? artifact.body,
        headerVersion: artifact.headerVersion + 1, bodyVersion: artifact.bodyVersion + 1 };
      return { status: 200, data: { success: true, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } };
    }
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
  const initialArtifact = { id: 'approval', ownerAccountId: accountId, access: 'owner', encryptionMode: mode, publicAudience: 'none',
    dataEncryptionKey: resource.dataEncryptionKey ?? ARTIFACT_PLAIN_DATA_KEY_MARKER,
    header: sealArtifact(buildApprovalRequestArtifactHeaderV1(stored)),
    body: sealArtifact({ body: JSON.stringify(stored) }),
    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2 };
  let artifact = initialArtifact;
  const deps = createCliActionDeps({ credentials, token, ...sessionCrypto, sessionId: '', serverId,
    serverIdentityId: serverId, serverHttpBaseUrl: 'https://approval-home.test' });
  const verifyExecutionAuthorization: VerifyExternalActionExecutionAuthorization = input =>
    verifyExternalActionExecutionAuthorizationCurrent({ ...input, privateKey: installation.secretKey,
      installationId: 'installation', serverHttpBaseUrl: 'https://approval-home.test' });
  const receiver = createActionExecutor(createCliActionDeps({ credentials, token, ...sessionCrypto,
    sessionId: '', serverId, serverIdentityId: serverId, serverHttpBaseUrl: 'https://approval-home.test',
    externalActionMachineInstallationId: 'installation', externalActionMachineRequestPrivateKey: installation.secretKey,
    machineAdmissionTransport: pendingAdmission,
  }));
  const receivingExecute = vi.spyOn(receiver, 'execute');
  const outcomeReplayArtifacts = origin.replayArtifacts;
  const executor = 'standaloneCredential' in scenario
    ? createCliActionExecutorFromCredentials({ credentials, serverId, serverIdentityId: serverId,
      serverApiUrl: 'https://approval-home.test',
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: AccountSettingsSchema.parse({}) }) })
    : mode === 'e2ee' ? receiver : createActionExecutor(deps);
  if (deliveryFailure) {
    const result = await receiver.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, {
      surface: 'cli', authority: 'present_user', runtimeAccountId: accountId, serverId, serverIdentityId: serverId,
    });
    expect(result).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true },
      delivery: deliveryFailure === 'lost_ack'
        ? { status: 'outcomeUnknown', code: 'machine_admission_acknowledgement_failed' }
        : { status: 'rejected', code: 'session_input_target_unavailable' } } });
    expect(pendingAdmission).toHaveBeenCalledTimes(deliveryFailure === 'before_pending' || deliveryFailure === 'lost_ack' ? 1 : 0);
    expect([...delivered]).toEqual(deliveryFailure === 'lost_ack' ? ['approval-result:approval'] : []);
    return;
  }
  let recordedDelivery: unknown;
  if (canRelay) {
    // The hosting origin has its authenticated Machine transport. Settle its
    // already-recorded outcome before the standalone deciding CLI rejoins it.
    const originResult = await receiver.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, {
      surface: 'cli', authority: 'present_user', runtimeAccountId: accountId, serverId, serverIdentityId: serverId,
    });
    expect(originResult).toMatchObject({ ok: true, result: { status, delivery: { status: 'accepted' } } });
    if (!originResult.ok || !originResult.result || typeof originResult.result !== 'object' || !('delivery' in originResult.result)) {
      throw new Error('Missing original delivery receipt');
    }
    recordedDelivery = originResult.result.delivery;
    sessionActive = false;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await executor.execute('approval.request.decide', {
      artifactId: 'approval', decision: 'approve' }, { surface: 'cli', authority: 'present_user', runtimeAccountId: accountId,
      serverId, serverIdentityId: serverId });
    expect(transportFailures).toEqual([]);
    // The run record answers the decision; a restricted credential's refused
    // delivery is its own receipt beside it, never the decision's failure.
    expect(result, JSON.stringify(result)).toMatchObject(canRelay
      ? { ok: true, result: { status, delivery: recordedDelivery } }
      : { ok: true, result: { status, delivery: { status: 'rejected', code: 'session_input_target_unavailable' } } });
  }
  for (const authored of admittedInputs) {
    if (authored.content.type !== 'text') throw new Error('Expected outcome text');
    expect(JSON.parse(authored.content.text)).toMatchObject({ actionId, status: failed ? 'failed' : 'executed' });
  }
  expect([...delivered]).toEqual(canRelay ? ['approval-result:approval'] : []);
  expect(origin.readMachineAdmissionRequests()).toBe(canRelay ? 1 : 0);
  if ('standaloneCredential' in scenario) {
    // Both standalone principals read the saved delivery without reaching the origin again.
    expect(outcomeReplayArtifacts).toEqual([]);
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
    // Exercise recovery when Session input exists and its delivery receipt was never saved.
    artifact = initialArtifact;
    // A matching localId is insufficient when the retained result differs.
    origin.setRetainedContent('approval-result:approval', sealSessionStoredContent({ ...sessionCrypto, payload: {
      ...originalInput, content: { type: 'text', text: 'different outcome' },
    } }));
    expect(await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, {
      surface: 'cli', authority: 'present_user', runtimeAccountId: accountId, serverId, serverIdentityId: serverId,
    })).toMatchObject({ ok: true, result: { status, delivery: { status: 'rejected', code: 'session_input_idempotency_conflict' } } });
    // Never reinterpret a plain envelope as the E2EE Session's retained input.
    artifact = initialArtifact;
    origin.setRetainedContent('approval-result:approval', { t: 'plain', v: originalInput });
    const plainEnvelope = await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, {
      surface: 'cli', authority: 'present_user', runtimeAccountId: accountId, serverId, serverIdentityId: serverId,
    });
    expect(plainEnvelope).toMatchObject({ ok: true, result: { status } });
    expect(['rejected', 'outcomeUnknown']).toContain(plainEnvelope.ok
      && (plainEnvelope.result as { delivery?: { status?: string } }).delivery?.status);
    expect(admittedInputs).toEqual([originalInput]);
    expect(origin.readMachineAdmissionRequests()).toBe(1);
  }
  });
});

it.each(['same', 'cross', 'offline', 'legacy', 'approve'] as const)('delivers a deferred approval result (%s)', async placement => {
  const { socketRpcCodec } = await import('@happier-dev/sync-client');
  const { buildApprovalExecutionOriginV1 } = await import('@happier-dev/protocol/actions/executor/approvalOrigins');
  const { RPC_METHODS } = await import('@happier-dev/protocol/rpc/methods');
  const { registerApprovalRpcHandlers } = await import('@/rpc/handlers/approvals');
  const { createRequesterCurrentnessSocketHarness } = await import('@/testkit/backends/requesterCurrentnessSocketHarness');
  const { createOriginDaemonApprovalOutcomePublisher } = await import('./publishOutcome');
  const accountId = 'requester', serverId = 'srv_delivery_repro', sessionId = 'asking-session';
  const sourceMachine = 'machine-x', targetMachine = placement === 'same' ? sourceMachine : 'machine-y';
  const actionId = 'deployments.templates.instantiate';
  const actionArgs = { mode: 'apply', serverId, machineId: targetMachine, projectSourceId: 'source',
    templateRef: { sourceId: 'apps', itemId: 'web', version: '1',
      ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
    environment: { kind: 'create', requestKey: 'install', name: 'Web', controllerMachineId: targetMachine,
      protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers' },
    target: { kind: 'new', installationId: 'installed' }, destination: { kind: 'stored' }, bindings: [],
    domainBindings: [{ templateDomainId: 'web', hostname: 'web.example.test' }] };
  const caller = { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 } as const;
  const target = { kind: 'machine', machineId: targetMachine } as const;
  const requestId = 'original-fixture';
  const envelope = { v: 1, requestId, target, input: actionArgs } as const;
  const approving = placement === 'approve';
  const { signExternalActionApprovalInputV1, computeExternalActionRequestEnvelopeDigestV1 } = await import('@happier-dev/protocol/actions/externalActionExecutionAuthorization');
  const { projectDeploymentPreparationAdmissionV1 } = await import('@happier-dev/protocol/deployments/deploymentPreparationAdmissionV1');
  const { default: nacl } = await import('tweetnacl');
  const installation = nacl.sign.keyPair();
  const executionOriginV1 = buildApprovalExecutionOriginV1({ actionId, input: actionArgs, targetSessionId: null,
    context: { surface: 'agent', authority: 'account_automation', serverId, serverIdentityId: serverId,
      runtimeAccountId: accountId, defaultSessionId: sessionId,
      defaultSessionMachineId: approving ? targetMachine : sourceMachine,
      actionRequestId: requestId, actionCaller: caller,
      ...(approving ? {
        externalActionTarget: target, originalActionEnvelope: envelope, callerPermissionMode: null,
        sessionInputSource: { via: 'action', sourceSessionId: sessionId, sourceTurnId: 'source-turn' },
        externalActionExecutionAuthorization: { v: 1, token: 'fixture-approval-origin', binding: {
          serverIdentityId: serverId, accountId, authentication: { kind: 'account', tokenEpoch: 0 },
          accountEncryptionMode: 'plain', machineId: targetMachine, actionId, requestId, target,
          custodianAccountId: 'target-owner', installationId: actionArgs.target.installationId,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
          deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, actionArgs),
          sessionActionOrigin: { v: 1, caller, sourceTurnId: 'source-turn', callerPermissionMode: null, requestId },
          sessionActionSource: { machineId: sourceMachine, installationId: 'source-installation' },
        } },
        signExternalActionApprovalInput: ({ authorization, input, actionId, target }) =>
          signExternalActionApprovalInputV1({ authorizationToken: authorization.token, input, actionId, target,
            privateKey: installation.secretKey }),
      } : {}) } });
  expect(executionOriginV1).toMatchObject({ machineId: targetMachine, caller: { sessionId } });
  expect(executionOriginV1?.requesterSessionMachineId).toBe(sourceMachine);
  let online = placement !== 'offline';
  const outcomeStatus = approving ? 'executed' : 'rejected';
  if (placement === 'legacy' && executionOriginV1) Reflect.deleteProperty(executionOriginV1, 'requesterSessionMachineId');
  const { decideApprovalRequestTransition, settleApprovalRequestReplayInputs } = await import('@happier-dev/protocol/approvals/approvalRequestTransition');
  let stored = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'agent', sessionId }, requestedSurface: 'agent', approval: { flow: 'deferred', result: 'required' },
    actionId, actionArgs, summary: 'Fixture approval', executionOriginV1 });
  const credentials = { token: 'fixture', encryption: null, credentialProvenance: 'stored_session' as const };
  const transport = await createRequesterCurrentnessSocketHarness();
  onTestFinished(() => transport.close());
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    const machineId = url.endsWith(sourceMachine) ? sourceMachine : targetMachine;
    return { status: 200, data: { machine: { id: machineId, kind: 'persistent', active: true,
      storageMode: 'plain', access: { custodian: { accountId: machineId === sourceMachine ? accountId : 'target-owner',
        displayName: 'Fixture' }, role: machineId === sourceMachine ? 'manage' : 'use', resourceMode: 'plain', accessState: 'ready' } } } };
  });
  const inputs: unknown[] = [];
  const store = { approvalsGet: async () => stored,
    approvalsUpdate: async ({ request, expectedStatus }: { request: unknown; expectedStatus?: typeof stored.status }) => {
      const next = ApprovalRequestV2Schema.parse(request);
      const transition = decideApprovalRequestTransition(stored, next, { expectedStatus });
      if (!transition.ok) return transition;
      stored = next;
      return { ok: true } as const;
    } };
  const receiver = createActionExecutor({ ...store, sessionSendMessage: async ({ sessionId, localId, message }) => {
    inputs.push({ sessionId, localId, outcome: JSON.parse(message) });
    return { status: 'accepted', localId };
  } });
  let receiverAccount = { accountId, serverId, serverIdentityId: serverId };
  const handlers = new Map<string, Parameters<Parameters<typeof registerApprovalRpcHandlers>[0]['rpcHandlerManager']['registerHandler']>[1]>();
  registerApprovalRpcHandlers({ actionExecutor: { ...receiver, replayApprovedApprovalRequest: (args, ingress) =>
    receiver.replayApprovedApprovalRequest({ ...args, currentAccount: receiverAccount }, ingress) },
    rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } } });
  const destinations: string[] = [];
  const replay = handlers.get(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED)!;
  const receive = (machineId: string, custodianAccountId: string, params: unknown) =>
    replay(params, { callerAuthority: 'present_user', signal: new AbortController().signal,
      machineAdmission: { actorAccountId: accountId, custodianAccountId, machineId, installationId: 'installation',
        role: custodianAccountId === accountId ? 'manage' : 'use', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true });
  transport.server.on('connection', socket => socket.on('rpc-call', async (
    packet: { method: string; params: unknown }, acknowledge: (value: unknown) => void,
  ) => {
    const codec = { mode: 'plain' } as const;
    const decoded = await socketRpcCodec.decodeRequestParams(codec, packet.params, packet.method);
    const machineId = packet.method.split(':')[0]!;
    destinations.push(machineId);
    if (!online && machineId === sourceMachine) {
      acknowledge({ ok: false, error: 'RPC target unavailable', errorCode: 'target_unavailable' });
      return;
    }
    const outcome = await receive(machineId, machineId === sourceMachine ? accountId : 'target-owner', decoded.params);
    acknowledge({ ok: true, result: await socketRpcCodec.encodeResponse(codec, outcome, decoded.callId) });
  }));
  const artifactId = 'approval-fixture';
  const effectDestinations: string[] = [];
  const decider = createActionExecutor({ ...store, approvalRequestOutcomePublication: createOriginDaemonApprovalOutcomePublisher({
    credentials, serverUrl: transport.serverUrl,
  }), ...(approving ? {
    // The remote effect boundary returns the terminal execution acknowledgement.
    // Its signed effect cannot author input for the unrelated asking Session.
    approvalRequestApprovedReplay: async ({ request }) => {
      effectDestinations.push(request.executionOriginV1!.machineId!);
      const execution = { executedAtMs: 3, ok: true, result: { ok: true } } as const;
      stored = ApprovalRequestV2Schema.parse({ ...settleApprovalRequestReplayInputs(stored), status: 'executed', updatedAtMs: 3,
        decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' }, execution });
      return { ok: true as const, result: { ok: true, status: 'executed', execution } };
    },
  } : {}) });
  const decision = { artifactId, decision: approving ? 'approve' : 'reject' };
  const context = { surface: approving ? 'ui' : 'cli', authority: 'present_user',
    runtimeAccountId: accountId, serverId, serverIdentityId: serverId } as const;
  const decide = () => decider.execute('approval.request.decide', decision, context);
  const first = await decide();
  if (placement === 'legacy') {
    expect(first).toMatchObject({ ok: true, result: { status: 'rejected', delivery: {
      status: 'rejected', failureCause: { errorCode: 'requester_account_material_unavailable' },
    } } });
    expect(destinations).toEqual([targetMachine]);
    expect(inputs).toEqual([]);
    return;
  }
  if (placement === 'offline') {
    expect(first).toMatchObject({ ok: true, result: { status: 'rejected', delivery: {
      status: 'rejected', failureCause: { errorCode: 'target_unavailable', phase: 'approval.result.delivery' },
    } } });
    expect(stored.delivery).toMatchObject({ status: 'rejected' });
    expect(destinations).toEqual([sourceMachine]);
    expect(inputs).toEqual([]);
    online = true;
  }
  const result = placement === 'offline' ? await decide() : first;
  expect(result).toMatchObject({ ok: true, result: {
    status: outcomeStatus, delivery: { status: 'accepted', localId: 'approval-result:approval-fixture' },
  } });
  expect(stored.delivery).toMatchObject({ status: 'accepted' });
  const savedDecision = stored.decision;
  expect(await decide()).toEqual(result);
  expect(stored.decision).toEqual(savedDecision);
  expect(destinations).toEqual(placement === 'offline' ? [sourceMachine, sourceMachine] : [sourceMachine]);
  expect(effectDestinations).toEqual(approving ? [targetMachine] : []);
  if (placement === 'cross') {
    await expect(receive(targetMachine, 'target-owner', { artifactId }))
      .resolves.toMatchObject({ ok: false, errorCode: 'requester_account_material_unavailable' });
    await expect(receive('machine-z', accountId, { artifactId }))
      .resolves.toMatchObject({ ok: false, errorCode: 'approval_context_unavailable' });
    receiverAccount = { ...receiverAccount, serverIdentityId: 'srv_other_home' };
    await expect(receive(sourceMachine, accountId, { artifactId }))
      .resolves.toMatchObject({ ok: false, errorCode: 'approval_context_unavailable' });
    receiverAccount = { ...receiverAccount, serverIdentityId: serverId, accountId: 'other-account' };
    await expect(receive(sourceMachine, accountId, { artifactId }))
      .resolves.toMatchObject({ ok: false, errorCode: 'approval_context_unavailable' });
  }
  expect(inputs).toMatchObject([{ sessionId, localId: 'approval-result:approval-fixture', outcome: { status: outcomeStatus } }]);
});
