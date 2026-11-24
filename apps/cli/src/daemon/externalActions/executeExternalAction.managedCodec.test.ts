import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '@happier-dev/protocol';
import { readActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema, projectDeploymentPreparationAdmissionV1,
  projectExternalActionManagedAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { sealExternalActionRequestV2, openExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { sealManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { ManagedMachineEnrollmentIdentityV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { prepareInstalledRequesterAccountActionContext, prepareRequesterAccountActionContext } from '../sessionEncryption/requesterAccountActionProjection';
import { readRequesterAccountActionTransportContext } from '../sessionEncryption/requesterAccountActionContext';
import * as installationStore from '@/daemon/identity/store';
import { logger } from '@/ui/logger';
import { executeExternalAction } from './executeExternalAction';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';

const enrollmentIdentity = ManagedMachineEnrollmentIdentityV1Schema.parse({
  kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user',
  role: 'server', adminAccessAtCreation: 'preauthorized',
});

// Diagnostics contain only typed outcome fields, never decrypted private data.
function refusalDiagnostic(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(null);
  const cause = 'failureCause' in value ? readActionFailureCauseV1(value.failureCause) : null;
  return JSON.stringify({
    ...('kind' in value ? { kind: value.kind } : {}),
    ...('ok' in value ? { ok: value.ok } : {}),
    ...('errorCode' in value ? { errorCode: value.errorCode } : {}),
    ...(cause ? { failureCause: { phase: cause.phase, errorClass: cause.errorClass, errorCode: cause.errorCode } } : {}),
  });
}

describe('managed controller invocation codec', () => {
  it.each((['plain', 'e2ee'] as const).flatMap(accountEncryptionMode =>
    (['machines.managed.inspect', 'machines.managed.acquire', 'machines.managed.bootstrap.retry'] as const)
      .map(actionId => ({ accountEncryptionMode, actionId }))))('opens only the fresh codec and retains the custodian executor ($accountEncryptionMode, $actionId)', async ({ accountEncryptionMode, actionId }) => {
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'company' })).toString('base64url')}.signature`, encryption: null };
    const target = { kind: 'machine' as const, machineId: 'company-controller' };
    const homeId = 'srv_managed_home';
    const actionInput: JsonValue = actionId === 'machines.managed.acquire'
      ? { enrollmentIdentity, selection: { kind: 'one-off' as const, homeId,
        controller: { machineId: target.machineId, installationId: 'company-installation' },
        launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } }
      : { homeId, managedId: 'member-resource', ...(actionId === 'machines.managed.bootstrap.retry' ? { expectedIntentRevision: 1 } : {}) };
    const authentication = { kind: 'account' as const, tokenEpoch: 1 };
    const binding = { serverIdentityId: homeId, accountId: 'member', authentication,
      actionId, requestId: 'codec-inspect', target };
    const material = { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) };
    const envelope = ExternalActionRequestEnvelopeSchema.parse(accountEncryptionMode === 'e2ee'
      ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, input: actionInput, randomBytes: tweetnacl.randomBytes })
      : { v: 1 as const, requestId: binding.requestId, target, input: actionInput });
    const authorization = sealManagedControllerActionCodecV1({ authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-managed-root', binding: {
      ...binding, custodianAccountId: 'company', accountEncryptionMode,
      machineId: target.machineId, installationId: 'company-installation',
      ...(actionId !== 'machines.managed.acquire' ? { managedAdmission: projectExternalActionManagedAdmissionV1(actionId, actionInput) } : {}),
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } }), material, invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' },
      installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
    // This codec-only harness has no native creation-review adapter. Keep its
    // demanded child policy explicit, so the root still exercises its UI default.
    const rawSettings = { actionsSettingsV1: { v: 1, approvalWaivedSurfaces: {
      'machines.setup.adminAccess.set': ['ui'], 'machines.agentIsolation.set': ['ui'],
    } } };
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(rawSettings), rawSettings, settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const custodianSettings = getActiveAccountSettingsSnapshot();
    const createExecutor = (token = credentials.token) => createCliActionExecutor({ credentials: { ...credentials, token }, token, mode: 'plain', ctx: null,
      sessionId: 'cli-global', serverId: 'profile', serverIdentityId: homeId, serverHttpBaseUrl: 'https://managed-home.test',
      externalActionMachineInstallationId: 'company-installation', externalActionMachineRequestPrivateKey: installation.secretKey,
      pluginActionExecutionOwner: 'current_process',
    });
    const executor = createExecutor();
    const run = (current: boolean, received = authorization, surface: 'ui' | 'cli' = 'ui', includeHttp = true, selectedExecutor = executor) => executeExternalAction({ actionId, envelope,
      principal: { accountId: 'member', authority: 'present_user', authentication },
      ...(surface === 'cli' ? { surface } : {}),
      ...(includeHttp ? { currentServerHttpBaseUrl: 'https://managed-home.test' } : {}),
      currentMachineId: target.machineId, currentAccountId: 'company', currentServerId: 'profile',
      currentInstallationId: 'company-installation', executionAuthorization: received,
      externalActionMachineRequestPrivateKey: installation.secretKey,
      verifyExecutionAuthorization: async () => current,
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials }), executor: selectedExecutor,
      // The real requester owner cannot open a codec as Account credentials.
      prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
        purpose: { kind: 'external_action' }, machineId: target.machineId, installationId: 'company-installation',
        installationPrivateKey: installation.secretKey, serverId: 'profile', serverIdentityId: homeId,
        serverHttpBaseUrl: 'https://managed-home.test', isCurrent: async () => current,
        createExecutor: () => executor }),
    });
    const http: { method: 'GET' | 'POST'; pathname: string }[] = [];
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      http.push({ method: 'GET', pathname: new URL(String(url), 'https://managed-home.test').pathname });
      throw new Error('Unexpected Account read');
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
      http.push({ method: 'POST', pathname: new URL(String(url), 'https://managed-home.test').pathname });
      if (url.endsWith('/verify')) return { status: 200, data: { ok: true } };
      throw new Error('Unexpected Artifact write');
    });
    try {
      const result = await run(true);
      expect(result.kind, refusalDiagnostic(result)).toBe('response');
      if (result.kind !== 'response') throw new Error('Expected a controller Action response');
      const execution = envelope.v === 2 ? openExternalActionResponseV2({ envelope: result.response,
        request: envelope, binding, material }) : 'execution' in result.response ? result.response.execution : null;
      // The retained real custodian executor has no native managed adapter in
      // this harness. Reaching its typed refusal proves decryption and dispatch.
      expect(execution).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
      expect(await run(false)).toMatchObject({ kind: 'invalid_request',
        errorCode: envelope.v === 2 ? 'invalid_encrypted_envelope' : 'invalid_envelope' });
      expect(await run(true, { ...authorization, requesterAccountContext: undefined })).toMatchObject({ kind: 'invalid_request' });
      if (actionId !== 'machines.managed.inspect') {
        const cli = sealManagedControllerActionCodecV1({ authorization, material,
          invocation: { caller: { kind: 'host' }, surface: 'cli', authority: 'present_user' },
          installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
        const absent = sealManagedControllerActionCodecV1({ authorization, material,
          installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
        const otherToken = `fixture.${Buffer.from(JSON.stringify({ sub: 'other-company' })).toString('base64url')}.signature`;
        // Signed CLI approval is supported. Acquire must still never borrow the
        // controller Account's private Artifact custody through origin hints.
        // The rightful requester approval path is covered at the store owner.
        const expectedRefusalCode = actionId === 'machines.managed.acquire'
          ? 'credential_scope_denied' : 'approval_origin_unavailable';
        const observed = [];
        for (const variant of [
          { name: 'cli origin', execute: () => run(true, cli, 'cli') },
          { name: 'absent origin', execute: () => run(true, absent) },
          { name: 'missing Home HTTP', execute: () => run(true, authorization, 'ui', false) },
          { name: 'other custodian Account', execute: () => run(true, authorization, 'ui', true, createExecutor(otherToken)) },
        ]) {
          const start = http.length;
          const asked = await variant.execute();
          const execution = asked.kind !== 'response' ? null : envelope.v === 2
            ? openExternalActionResponseV2({ envelope: asked.response, request: envelope, binding, material })
            : 'execution' in asked.response ? asked.response.execution : null;
          const outcome: unknown = JSON.parse(refusalDiagnostic(execution));
          observed.push({ name: variant.name, kind: asked.kind, outcome, http: http.slice(start) });
        }
        const diagnostics = JSON.stringify(observed);
        for (const item of observed) {
          expect(item.kind, diagnostics).toBe('response');
          expect(item.outcome, diagnostics).toMatchObject({ ok: false, errorCode: expectedRefusalCode });
        }
      }
      expect(get).not.toHaveBeenCalled();
      expect(post.mock.calls.every(([url]) => url.endsWith('/verify'))).toBe(true);
      expect(getActiveAccountSettingsSnapshot()).toBe(custodianSettings);
    } finally { get.mockRestore(); post.mockRestore(); resetActiveAccountSettingsSnapshotForTests(); }
  });

  // A member's Setup Plan Workflow leaf on another person's Machine carries only the codec.
  // The receiver opens the member's own copies with the Run's retained custody, never the custodian's.
  it.each(['run custody held', 'run custody absent'] as const)('gives a foreign reviewed Setup leaf its Run requester custody (%s)', async scenario => {
    const { createRequesterCurrentnessSocketHarness } = await import('@/testkit/backends/requesterCurrentnessSocketHarness');
    const channel = await createRequesterCurrentnessSocketHarness();
    const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1, installationId: 'owner-installation',
      createdAt: 1, publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') });
    const fixtureToken = (sub: string) => `fixture.${Buffer.from(JSON.stringify({ sub, tokenEpoch: 1,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const owner = { token: fixtureToken('owner'), encryption: null };
    const member = { token: fixtureToken('member'), encryption: null };
    const homeId = 'srv_setup_home';
    const serverHttpBaseUrl = 'https://setup-home.test';
    const target = { kind: 'machine' as const, machineId: 'owner-machine' };
    const runId = 'member-setup-run';
    const requestId = `${runId}/native-setup/0`;
    const authentication = { kind: 'account' as const, tokenEpoch: 1 };
    const actionInput: JsonValue = { homeId, machineId: target.machineId, targets: [{ homeId, machineId: target.machineId,
      desiredRevision: 0, recipePlans: [], sources: [{ kind: 'direct', setup: {} }] }] };
    const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId, target, input: actionInput });
    const authorization = sealManagedControllerActionCodecV1({ authorization: ExternalActionExecutionAuthorizationV1Schema.parse({
      v: 1, token: 'home-setup-leaf-root', binding: { accountId: 'member', custodianAccountId: 'owner', authentication,
        serverIdentityId: homeId, machineId: target.machineId, installationId: 'owner-installation', accountEncryptionMode: 'plain',
        actionId: 'machines.setup.apply', requestId, target, workflowActionOrigin: { runId, requestId },
        deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('machines.setup.apply', actionInput),
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } }),
      material: { type: 'dataKey', machineKey: tweetnacl.randomBytes(32) },
      installationPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes });
    const seen: (string | null)[] = [];
    const executor = { execute: async (_actionId: string, _input: unknown, context?: import('@happier-dev/protocol').ActionExecutorContext) => {
      seen.push(readRequesterAccountActionTransportContext(context?.externalActionExecutionAuthorization)?.credentials.token ?? null);
      return { ok: false as const, errorCode: 'captured', error: 'captured' };
    } };
    const custodyReads: string[] = [];
    let released = 0;
    const refusals: unknown[] = [];
    vi.spyOn(logger, 'warnLocalFile').mockImplementation((_tag, detail) => { refusals.push(detail); });
    // Only Home HTTP and installed custody storage are boundaries; ingress, admission and projection stay real.
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const pathname = new URL(String(url)).pathname;
      if (config?.headers?.Authorization !== `Bearer ${member.token}`) throw new Error(`Unexpected non-member read ${pathname}`);
      if (pathname === '/v1/account/profile') return { status: 200, data: { id: 'member' } };
      if (pathname === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (pathname === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      throw new Error(`Unexpected member read ${pathname}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async url => {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      throw new Error(`Unexpected Home write ${String(url)}`);
    });
    try {
      const result = await executeExternalAction({ actionId: 'machines.setup.apply', envelope,
        principal: { accountId: 'member', authority: 'present_user', authentication, workflowActionOrigin: { runId, requestId } },
        currentServerHttpBaseUrl: serverHttpBaseUrl, currentMachineId: target.machineId, currentAccountId: 'owner',
        currentServerId: 'profile', currentInstallationId: 'owner-installation', executionAuthorization: authorization,
        externalActionMachineRequestPrivateKey: keys.secretKey, verifyExecutionAuthorization: async () => true,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: owner }), executor,
        prepareRequesterAccountContext: request => prepareInstalledRequesterAccountActionContext({ authorization: request.authorization,
          purpose: request.purpose ?? { kind: 'external_action' }, machineId: target.machineId, serverId: 'profile',
          serverHttpBaseUrl, ownCredentials: owner,
          resolveWorkflowRunRequesterCustody: async (id, attribution) => {
            custodyReads.push(id);
            return scenario === 'run custody held' && id === runId && attribution.accountId === 'member'
              ? { credentials: member, attribution, serverHttpBaseUrl, getBoundSessionId: () => runId,
                isCurrent: async () => true, release: async () => { released += 1; } } : null;
          },
          resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: target.machineId, serverIdentityId: homeId }),
          createExecutor: () => executor }) });
      expect(result.kind, `${refusalDiagnostic(result)} ${JSON.stringify(refusals)}`).toBe('response');
      expect(custodyReads).toEqual([runId]);
      // Held: the leaf runs on the member's own sign-in. Absent: codec only, so the opener refuses typed.
      expect(seen).toEqual([scenario === 'run custody held' ? member.token : null]);
      if (scenario === 'run custody held') expect(released).toBe(1);
    } finally { await channel.close(); vi.restoreAllMocks(); }
  });
});
