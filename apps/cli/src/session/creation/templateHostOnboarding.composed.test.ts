import axios, { AxiosHeaders } from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, SessionSpawnNewInputV2Schema, accountSettingsParse } from '@happier-dev/protocol';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, encodeTemplateBirthExecutionAuthorizationV1, TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { SessionPendingTemplateOnboardingRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { SessionOwnerMetadataEnvelopeV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import '@/session/services/createSpawnedSession';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetServerFeaturesClientForTests(); });

it.each([
  { active: false, protocolVersion: 4, path: false, checkout: false }, { active: true, protocolVersion: 4, path: false, checkout: false },
  { active: false, protocolVersion: 4, path: true, checkout: false }, { active: false, protocolVersion: 3, path: false, checkout: false },
  { active: false, protocolVersion: 4, path: true, checkout: true },
])('births and enqueues finite onboarding only with its supported target epoch ($active, v$protocolVersion, path=$path, checkout=$checkout)', async ({ active, protocolVersion, path: authoredPath, checkout }) => {
  const accountId = 'requester';
  const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
  const credentials = { token, encryption: null };
  const checkoutCreationDraft = checkout ? { kind: 'git_worktree' as const, displayName: 'bot', baseRef: 'main', branchMode: 'new' as const } : undefined;
  const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'finite-template-birth',
    executionTarget: { serverId: 'home-a', machineId: 'machine-1' }, directory: authoredPath
      ? { kind: 'path', path: 'C:\\Users\\Remote\\project' } : { kind: 'managed' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    connectedServices: { v: 2, bindingsByServiceId: {} }, memoryEnabled: false,
    ...(checkoutCreationDraft ? { checkoutCreationDraft } : {}),
  });
  const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: 'finite-template-birth',
    target: { kind: 'machine', machineId: 'machine-1' }, input: { creation: input } });
  const machineSetupPlanInput = { homeId: 'home-a', machineId: 'machine-1', mode: 'effects' as const };
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root-proof', binding: {
    accountId, authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
    custodianAccountId: accountId, serverIdentityId: 'home-a', machineId: 'machine-1', installationId: 'installation-1',
    admittedMachineRole: 'manage', templateRequesterSetupAdmission: { kind: 'software',
      planInputDigest: computeActionInputApprovalDigestV1('machines.setup.plan', machineSetupPlanInput) },
    actionId: 'template.instantiate', requestId: envelope.requestId, target: envelope.target,
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  let boundAuthorization = authorization;
  const events: string[] = [];
  const posts: string[] = [];
  let bornSession: Record<string, unknown> | undefined;
  let boundaryFailure: unknown;
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/machines/machine-1') return { status: 200, data: { machine: { id: 'machine-1', active,
      revokedAt: null, replacedByMachineId: null, operationProtocolCapabilitiesRevision: 1,
      operationProtocolCapabilities: { sessionSpawn: { protocolVersions: protocolVersion === 4 ? [1, 2, 3, 4] : [1, 2, 3] }, sessionSpawnPlacementOrigin: { protocolVersions: [1] } } } } };
    if (path === '/v2/sessions/requester-session') return { status: 200, data: { session: bornSession } };
    throw new Error(`Unexpected Home read ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, raw, config) => {
    try {
      const path = new URL(String(url)).pathname;
      posts.push(path);
      if (path === '/v1/sessions') {
        events.push('birth');
        expect(raw).toMatchObject({ templateRequesterAuthorization: { authorization, originalActionEnvelope: envelope } });
        if (!raw || typeof raw !== 'object') throw new Error('Missing birth body');
        boundAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization, token: 'birth-bound-proof',
          binding: { ...authorization.binding, templateRequesterBirth: { sessionId: 'requester-session', creationTag: Reflect.get(raw, 'tag') } } });
        const ownerMetadata = SessionOwnerMetadataEnvelopeV1Schema.parse(Reflect.get(raw, 'ownerMetadata'));
        expect(ownerMetadata).toMatchObject({ t: 'plain', v: {
          system: { sessionCreationCorrespondenceV1: { recipe: { machineSetupPlanInput,
            execution: { directory: input.directory },
            machineSetupExecution: { authorization, originalActionEnvelope: envelope } } } } } });
        if (ownerMetadata.t !== 'plain') throw new Error('Expected plain owner metadata');
        if (!authoredPath) expect(ownerMetadata.v.workspace?.sessionDirectoryV1).toMatchObject({ kind: 'managed' });
        if (checkoutCreationDraft) expect(ownerMetadata.v.system?.sessionCreationCorrespondenceV1?.recipe).toMatchObject({ checkoutCreationDraft });
        expect(ownerMetadata.v.workspace?.path).toBe(authoredPath ? 'C:\\Users\\Remote\\project' : undefined);
        const shared = Reflect.get(raw, 'sharedMetadata');
        if (!shared || typeof shared !== 'object') throw new Error('Missing shared metadata');
        bornSession = { id: 'requester-session', seq: 0, createdAt: 1, updatedAt: 1,
            active: false, activeAt: 1, archivedAt: null, metadataVersion: 1, metadataLayoutVersion: 1,
            metadata: Reflect.get(shared, 'ciphertext'), ownerMetadata, encryptionMode: 'plain', agentState: null,
            agentStateVersion: 0, dataEncryptionKey: null, share: null };
        return { status: 200, headers: { [TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1]: encodeTemplateBirthExecutionAuthorizationV1(boundAuthorization) },
          data: { created: true, session: bornSession } };
      }
      if (path === '/v2/sessions/requester-session/pending/template-onboarding') {
        events.push('onboarding');
        const body = SessionPendingTemplateOnboardingRequestV1Schema.parse(raw);
        expect(body.authorization).toEqual(boundAuthorization);
        expect(body.originalActionEnvelope).toEqual(envelope);
        expect(AxiosHeaders.from(config?.headers).get('Authorization')).toBe(`Bearer ${token}`);
        expect(body.request).toMatchObject({ v: 1, targetMachineId: 'machine-1', requestedAction: { v: 1, kind: 'send_now' }, content: { t: 'plain' } });
        expect(JSON.stringify(body.request.content)).toContain('hostOnboarding');
        expect(events).toEqual(['birth', 'content', 'onboarding']);
        return { status: 200, data: { v: 1, result: { status: 'accepted', localId: body.request.localId } } };
      }
      throw new Error(`Unexpected Home write ${path}`);
    } catch (error) { boundaryFailure = error; throw error; }
  });
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (String(url).endsWith('/v1/account/profile')) return Response.json({ id: accountId });
    if (String(url).endsWith('/v1/features')) return Response.json(FeaturesResponseSchema.parse({ features: {},
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }));
    throw new Error(`Unexpected fetch ${url}`);
  }));
  const executor = createCliActionExecutor({ credentials, token, sessionId: '', mode: 'plain', ctx: null,
    serverId: 'home-a', serverIdentityId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test',
    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ memoryUpkeepInNewBots: false }) }),
  });
  const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
    runtimeAccountId: accountId, serverId: 'home-a', serverIdentityId: 'home-a', actionRequestId: envelope.requestId,
    externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target, originalActionEnvelope: envelope };
  const result = await invokeHostReviewedChildV1({ parent: { actionId: 'template.instantiate', input: { creation: input } }, context,
    child: { action: 'session.spawn_new', role: 'create_bot', input },
    admittedReview: { action: 'session.spawn_new', role: 'create_bot', surface: 'cli' },
    invocationServices: { sessionCreation: { beforeLaunch: async () => { events.push('content'); },
      hostOnboarding: { templateName: 'Helper', templateVersion: '1.0.0' }, machineSetupPlanInput } },
    execute: (childInput, childContext, actionId) => executor.execute(actionId, childInput, childContext),
  });
  expect(boundaryFailure).toBeUndefined();
  if (protocolVersion === 3) {
    expect(result).toMatchObject({ ok: true, result: { type: 'error', code: 'incompatible_target', retryable: false,
      incompatibleTarget: { reason: 'session_spawn_protocol_unavailable' } } });
    expect(posts).toEqual([]);
    return;
  }
  expect(result, JSON.stringify({ result, events, posts })).toMatchObject({ ok: true,
    result: { type: 'success', sessionId: 'requester-session', initialInput: { status: 'accepted' } } });
  expect(posts).toEqual(['/v1/sessions', '/v2/sessions/requester-session/pending/template-onboarding']);
});
