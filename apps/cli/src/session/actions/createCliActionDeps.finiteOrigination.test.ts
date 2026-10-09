import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createCliActionDeps } from './createCliActionDeps';
import * as machineTransport from '@/session/transport/rpc/machineRpc';
import nacl from 'tweetnacl';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { ExternalActionRequestEnvelopeV2Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { prepareExternalActionRequesterAccountAuthorization } from '@/api/externalActionExecutionAuthorization';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodeStoredCredentials } from '@/persistence';

afterEach(() => vi.restoreAllMocks());

describe('original CLI Account finite Project admission', () => {
  it('originates machine environment apply from its exact public input through own Account Home proof without an outer target flag', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 7,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    const input = { homeId: 'srv_finite_home', machineId: 'guest', presetId: 'preset', presetRevision: 4 };
    const machine = { id: 'guest', kind: 'persistent', active: true, installationId: 'guest-installation', revokedAt: null,
      replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
      access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
    vi.spyOn(axios, 'get').mockImplementation(async url => url.endsWith('/v1/account/encryption')
      ? { status: 200, data: { mode: 'plain', updatedAt: 1 } }
      : url.endsWith('/v1/machines/guest') ? { status: 200, data: { machine } } : { status: 200, data: [machine] });
    let delivered = false;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(carrier.envelope);
      expect(envelope).toEqual({ v: 1, requestId: 'environment-request', target: { kind: 'machine', machineId: 'guest' }, input });
      if (url.endsWith('/execution-authorization')) return { status: 200, data: { v: 1, token: 'exact-home-root', binding: {
        accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 7 }, accountEncryptionMode: 'plain',
        serverIdentityId: input.homeId, custodianAccountId: 'owner', machineId: 'guest', installationId: 'guest-installation',
        actionId: 'machines.environment.apply', requestId: envelope.requestId, target: envelope.target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } } };
      expect(url).toBe('https://home-a.test/v1/actions/machines.environment.apply');
      expect(carrier.executionAuthorization.token).toBe('exact-home-root');
      delivered = true;
      return { status: 200, data: { v: 1, actionId: 'machines.environment.apply', requestId: envelope.requestId,
        execution: { ok: true, result: { operationId: 'actual-environment-operation' } } } };
    });
    const owner = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
      externalActionClient: true, serverId: 'home-a', serverIdentityId: input.homeId, serverApiUrl: 'https://home-a.test',
      actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
    expect(await owner.execute('machines.environment.apply', input, { surface: 'cli', actionRequestId: 'environment-request',
      presentUserConfirmation: { actionId: 'machines.environment.apply' } })).toEqual({ ok: true, result: { operationId: 'actual-environment-operation' } });
    expect(delivered).toBe(true);
  });
  it('keeps hosted finite work on its existing typed Session transport and refuses an unbound ambient caller', async () => {
    const token = 'incumbent-session-credential';
    const authorization = { kind: 'session.write' as const, sessionId: 'source-session' };
    const input = { workspace: { serverId: 'home-a', workspaceId: 'checkout', machineId: 'guest', rootPath: '/repo' }, phase: 'setup' };
    const result = { kind: 'notRequired', reviewedEffectDigest: 'reviewed' };
    const http = vi.spyOn(axios, 'post').mockRejectedValue(new Error('ambient_account_ingress'));
    const rpc = vi.spyOn(machineTransport, 'callExactMachineRpc').mockImplementation(async request => {
      expect(request).toMatchObject({ authorization, requestId: 'session-request', machineId: 'guest', request: input });
      return result;
    });
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: 'source-session',
      mode: 'plain', ctx: null, serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.test' });
    const context = { surface: 'agent' as const, authority: 'account_automation' as const, actionRequestId: 'session-request',
      actionCaller: { kind: 'session' as const, sessionId: authorization.sessionId, starterDepth: 0, turnDepth: 0 } };
    expect(await deps.projectAction!({ actionId: 'projects.prepare', input,
      context: { ...context, rpcSessionAuthorization: authorization } })).toEqual(result);
    rpc.mockClear();
    expect(await deps.projectAction!({ actionId: 'projects.prepare', input, context }))
      .toEqual({ ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' });
    expect(rpc).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
  });
  it('consumes the canonical requester disclosure and private carrier for a foreign stopped finite target', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob', tokenEpoch: 7,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
    const input = { workspace: { serverId: 'home-a', workspaceId: 'checkout', machineId: 'alice-guest', rootPath: '/repo' }, phase: 'setup' };
    const machine = { id: 'alice-guest', kind: 'persistent', active: false, installationId: 'alice-installation',
      installationPublicKey: encodeBase64(installation.publicKey), revokedAt: null, replacedByMachineId: null,
      dataEncryptionKey: null, runnerContentKeyBinding: null,
      access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
    const result = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed' };
    let disclosed = false;
    let dispatched = false;
    let credentialCurrent = true;
    let retireDuringDisclosure = false;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/v1/machines/alice-guest')) return { status: 200, data: { machine } };
      expect(url).toBe('https://home-a.test/v1/machines');
      return { status: 200, data: [machine] };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(carrier.envelope);
      expect(envelope).toEqual({ v: 1, requestId: 'foreign-finite-request', target: { kind: 'machine', machineId: 'alice-guest' }, input });
      if (url.endsWith('/execution-authorization')) return { status: 200, data: { v: 1, token: 'exact-home-root', binding: {
        accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 }, accountEncryptionMode: 'plain',
        serverIdentityId: 'srv_finite_home', custodianAccountId: 'alice', machineId: 'alice-guest', installationId: 'alice-installation',
        actionId: 'projects.prepare', requestId: envelope.requestId, target: envelope.target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } } };
      expect(url).toBe('https://home-a.test/v1/actions/projects.prepare');
      expect(disclosed).toBe(true);
      expect(openExternalActionRequesterAccountContextV1({ authorization: carrier.executionAuthorization,
        purpose: { kind: 'external_action' }, machineId: 'alice-guest', installationId: 'alice-installation',
        serverIdentityId: 'srv_finite_home', installationPrivateKey: installation.secretKey })).toEqual(encodeStoredCredentials(credentials));
      expect(JSON.stringify(body)).not.toContain(token);
      dispatched = true;
      return { status: 200, data: { v: 1, actionId: 'projects.prepare', requestId: envelope.requestId, execution: { ok: true, result } } };
    });
    const owner = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentialCurrent ? credentials : null,
      externalActionClient: true, serverId: 'home-a', serverIdentityId: 'srv_finite_home', serverApiUrl: 'https://home-a.test',
      actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) },
      onRequesterSessionCredentialDisclosure: async disclosure => {
        expect(disclosure).toMatchObject({ accountId: 'bob', machineId: 'alice-guest', fullSignIn: true, hostCanInspectLocalProcess: true });
        expect(dispatched).toBe(false);
        disclosed = true;
        if (retireDuringDisclosure) credentialCurrent = false;
        return true;
      } });
    expect(await owner.execute('projects.prepare', input, { surface: 'cli', actionRequestId: 'foreign-finite-request',
      presentUserConfirmation: { actionId: 'projects.prepare' } })).toEqual({ ok: true, result });
    expect(dispatched).toBe(true);
    retireDuringDisclosure = true;
    dispatched = false;
    expect(await owner.execute('projects.prepare', input, { surface: 'cli', actionRequestId: 'foreign-finite-request',
      presentUserConfirmation: { actionId: 'projects.prepare' } })).toMatchObject({ ok: false });
    expect(dispatched).toBe(false);
  });
  it('keeps terminal identity in the protected requester authorization instead of sealing an Account alias', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'terminal-owner', tokenEpoch: 4,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
    const keys = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(6));
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const material = { type: 'dataKey' as const, machineKey: keys.secretKey };
    const input = { workspace: { serverId: 'home-a', workspaceId: 'checkout', machineId: 'guest', rootPath: '/private-repo' }, phase: 'setup' };
    const binding = { serverIdentityId: 'srv_finite_home', accountId: 'terminal-owner', authentication: { kind: 'terminal' as const, tokenEpoch: 4 },
      actionId: 'projects.prepare' as const, requestId: 'terminal-protected-request', target: { kind: 'machine' as const, machineId: 'guest' } };
    let returnedAccountAlias = false;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      if (url.endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
      expect(url).toBe('https://home-a.test/v1/actions/projects.prepare/execution-authorization');
      const envelope = ExternalActionRequestEnvelopeV2Schema.parse((body as Readonly<{ envelope: unknown }>).envelope);
      expect(openExternalActionRequestV2({ envelope, binding, material })).toEqual({ input });
      return { status: 200, data: { v: 1, token: 'home-terminal-origin', binding: {
        ...binding, machineId: 'guest', installationId: 'guest-installation', custodianAccountId: 'terminal-owner', accountEncryptionMode: 'e2ee',
        ...(returnedAccountAlias ? { authentication: { kind: 'account', tokenEpoch: 4 } } : {}),
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } } };
    });
    const request = { actionId: binding.actionId, input, requestId: binding.requestId, target: binding.target, machineId: 'guest',
      accountId: binding.accountId, accountEncryptionMode: 'e2ee' as const, tokenEpochHint: 4,
      token, material, serverId: 'home-a', serverIdentityId: binding.serverIdentityId,
      serverHttpBaseUrl: 'https://home-a.test', installationId: 'guest-installation', privateKey: installation.secretKey };
    const result = await prepareExternalActionRequesterAccountAuthorization(request);
    expect(result?.binding).toMatchObject({ authentication: { kind: 'terminal', tokenEpoch: 4 }, accountId: binding.accountId });
    returnedAccountAlias = true;
    expect(await prepareExternalActionRequesterAccountAuthorization(request)).toBeNull();
  });
  it('carries an ordinary stored terminal CLI request to Home without depending on a local daemon', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'terminal-owner', tokenEpoch: 4,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
    const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
    const input = { workspace: { serverId: 'home-a', workspaceId: 'checkout', machineId: 'sleeping-guest', rootPath: '/repo' }, phase: 'setup' };
    const result = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed' };
    let credentialCurrent = true;
    let retireDuringInventory = false;
    const machine = { id: input.workspace.machineId, kind: 'persistent', active: false,
      installationId: 'guest-installation', revokedAt: null, replacedByMachineId: null,
      dataEncryptionKey: null, runnerContentKeyBinding: null,
      access: { custodian: { accountId: 'terminal-owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url === 'https://home-a.test/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url === `https://home-a.test/v1/machines/${machine.id}`) return { status: 200, data: { machine } };
      expect(url).toBe('https://home-a.test/v1/machines');
      if (retireDuringInventory) credentialCurrent = false;
      return { status: 200, data: [machine] };
    });
    let delivered = 0;
    const posts = vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      expect(config?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
      const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(carrier.envelope);
      expect(envelope).toEqual({ v: 1, requestId: 'terminal-request', target: { kind: 'machine', machineId: input.workspace.machineId }, input });
      if (url.endsWith('/execution-authorization')) return { status: 200, data: { v: 1, token: 'home-terminal-origin', binding: {
        accountId: 'terminal-owner', authentication: { kind: 'terminal', tokenEpoch: 4 }, accountEncryptionMode: 'plain',
        serverIdentityId: 'srv_finite_home', custodianAccountId: 'terminal-owner', machineId: machine.id, installationId: machine.installationId,
        actionId: 'projects.prepare', requestId: envelope.requestId, target: envelope.target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } } };
      expect(url).toBe('https://home-a.test/v1/actions/projects.prepare');
      expect(config?.timeout).toBeUndefined();
      expect(carrier.executionAuthorization).toMatchObject({ token: 'home-terminal-origin', binding: { authentication: { kind: 'terminal', tokenEpoch: 4 } } });
      delivered += 1;
      return { status: 200, data: { v: 1, actionId: 'projects.prepare', requestId: 'terminal-request', execution: { ok: true, result } } };
    });
    let terminalApprovalWaived = false;
    const owner = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentialCurrent ? credentials : null,
      externalActionClient: true, serverId: 'home-a', serverIdentityId: 'srv_finite_home', serverApiUrl: 'https://home-a.test',
      actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1,
        ...(terminalApprovalWaived ? { approvalWaivedSurfaces: { 'projects.prepare': ['cli'] } } : {}) }) } });
    expect(await owner.execute('projects.prepare', input, { surface: 'cli', actionRequestId: 'terminal-needs-approval',
      presentUserConfirmation: { actionId: 'projects.prepare' } })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(posts).not.toHaveBeenCalled();
    terminalApprovalWaived = true;
    expect(await owner.execute('projects.prepare', input, { surface: 'cli', actionRequestId: 'terminal-request',
      presentUserConfirmation: { actionId: 'projects.prepare' } })).toEqual({ ok: true, result });
    expect(delivered).toBe(1);
    const requestsBeforeRetirement = posts.mock.calls.length;
    retireDuringInventory = true;
    expect(await owner.execute('projects.prepare', input, { surface: 'cli', actionRequestId: 'retired-terminal-request',
      presentUserConfirmation: { actionId: 'projects.prepare' } })).toMatchObject({ ok: false });
    expect(posts.mock.calls).toHaveLength(requestsBeforeRetirement);
    expect(delivered).toBe(1);
  });
  it('uses the current Account mode and correlated protected envelope without disclosing E2EE input', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'encrypted-owner', tokenEpoch: 3,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const keys = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(6));
    const material = { type: 'dataKey' as const, machineKey: keys.secretKey };
    const input = { workspace: { serverId: 'home-a', workspaceId: 'checkout', machineId: 'guest', rootPath: '/private-repo' }, phase: 'setup' };
    const binding = { serverIdentityId: 'srv_finite_home', accountId: 'encrypted-owner', authentication: { kind: 'account' as const, tokenEpoch: 3 },
      actionId: 'projects.prepare' as const, requestId: 'encrypted-request', target: { kind: 'machine' as const, machineId: 'guest' } };
    const machine = { id: 'guest', kind: 'persistent', active: false, installationId: 'installation', revokedAt: null,
      replacedByMachineId: null, dataEncryptionKey: 'sealed-key', runnerContentKeyBinding: null,
      access: { custodian: { accountId: 'encrypted-owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'e2ee', accessState: 'ready' } };
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url === 'https://home-a.test/v1/account/encryption') return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      if (url === 'https://home-a.test/v1/machines/guest') return { status: 200, data: { machine } };
      expect(url).toBe('https://home-a.test/v1/machines');
      return { status: 200, data: [machine] };
    });
    const result = { kind: 'notRequired', reviewedEffectDigest: 'reviewed' };
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const envelope = ExternalActionRequestEnvelopeV2Schema.parse(carrier.envelope);
      expect(JSON.stringify(body)).not.toContain('/private-repo');
      expect(openExternalActionRequestV2({ envelope, binding, material })).toEqual({ input });
      if (url.endsWith('/execution-authorization')) return { status: 200, data: { v: 1, token: 'home-encrypted-origin', binding: {
        ...binding, accountEncryptionMode: 'e2ee', custodianAccountId: 'encrypted-owner', machineId: machine.id,
        installationId: machine.installationId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } } };
      expect(url).toBe('https://home-a.test/v1/actions/projects.prepare');
      expect(carrier.executionAuthorization).toMatchObject({ token: 'home-encrypted-origin', binding: { authentication: binding.authentication } });
      return { status: 200, data: prepareExternalActionResponseV2({ binding, material, request: envelope,
        executedMachineId: 'guest', execution: { ok: true, result }, randomBytes: length => new Uint8Array(length).fill(8) }).response };
    });
    const deps = createCliActionDeps({ token, credentials: { token, encryption: { type: 'dataKey', publicKey: keys.publicKey, machineKey: keys.secretKey } },
      sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'home-a', serverIdentityId: 'srv_finite_home', serverHttpBaseUrl: 'https://home-a.test' });
    expect(await deps.projectAction!({ actionId: 'projects.prepare', input,
      context: { surface: 'cli', authority: 'present_user', actionRequestId: binding.requestId } })).toEqual(result);
    expect(await deps.projectAction!({ actionId: 'projects.prepare', input,
      context: { surface: 'agent', authority: 'account_automation', actionRequestId: binding.requestId } }))
      .toEqual({ ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' });
  });
  it('keeps the installed receiver on its incumbent direct finite owner', async () => {
    const http = vi.spyOn(axios, 'post').mockRejectedValue(new Error('recursive_home_ingress'));
    const invoke = vi.fn(async () => ({ kind: 'notRequired', reviewedEffectDigest: 'reviewed' }));
    const deps = createCliActionDeps({ token: 'installed-token', sessionId: 'receiver', mode: 'plain', ctx: null,
      serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.test',
      machineActionDirectTargetTransport: { machineId: 'guest', invoke } });
    expect(await deps.projectAction!({ actionId: 'projects.prepare',
      input: { workspace: { serverId: 'home-a', workspaceId: 'checkout', machineId: 'guest', rootPath: '/repo' }, phase: 'setup' },
      context: { surface: 'rpc', authority: 'account_automation', actionRequestId: 'original-finite-request' } }))
      .toEqual({ kind: 'notRequired', reviewedEffectDigest: 'reviewed' });
    expect(http).not.toHaveBeenCalled();
  });
  it.each(['projects.prepare', 'projects.script.run', 'projects.compute.exec'] as const)(
    'keeps the original %s request at Home while the exact guest is stopped', async (actionId) => {
      const token = `header.${Buffer.from(JSON.stringify({ sub: 'finite-owner', tokenEpoch: 2,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
      const workspace = { serverId: 'home-a', workspaceId: 'checkout', machineId: 'sleeping-guest', rootPath: '/repo' };
      const input = actionId === 'projects.prepare' ? { workspace, phase: 'setup' }
        : actionId === 'projects.script.run' ? { workspace, selection: { kind: 'named', name: 'check' }, choice: { kind: 'primary' } }
        : { workspace, executable: 'make', argv: ['check'], cwd: '/repo', choice: { kind: 'primary' } };
      const result = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed' };
      const rawGuest = vi.spyOn(machineTransport, 'callExactMachineRpc').mockRejectedValue(new Error('guest_offline'));
      const requests: unknown[] = [];
      const machine = { id: workspace.machineId, kind: 'persistent', active: false,
        installationId: 'guest-installation', revokedAt: null, replacedByMachineId: null,
        dataEncryptionKey: null, runnerContentKeyBinding: null,
        access: { custodian: { accountId: 'finite-owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
      vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
        expect(config?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
        if (url === 'https://home-a.test/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (url === `https://home-a.test/v1/machines/${machine.id}`) return { status: 200, data: { machine } };
        expect(url).toBe('https://home-a.test/v1/machines');
        return { status: 200, data: [machine] };
      });
      vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
        expect(config?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
        const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(carrier.envelope);
        expect(envelope).toEqual({ v: 1, requestId: 'original-finite-request', target: { kind: 'machine', machineId: workspace.machineId }, input });
        if (url.endsWith('/execution-authorization')) return { status: 200, data: { v: 1, token: 'home-original-finite-origin', binding: {
          accountId: 'finite-owner', authentication: { kind: 'account', tokenEpoch: 2 }, accountEncryptionMode: 'plain',
          serverIdentityId: 'srv_finite_home', custodianAccountId: 'finite-owner', machineId: machine.id, installationId: machine.installationId,
          actionId, requestId: envelope.requestId, target: envelope.target,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } } };
        expect(url).toBe(`https://home-a.test/v1/actions/${actionId}`);
        expect(config?.timeout).toBeUndefined();
        expect(carrier.executionAuthorization).toMatchObject({ token: 'home-original-finite-origin' });
        requests.push(envelope);
        return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: envelope.requestId,
          execution: { ok: true, result } }) };
      });
      const signal = new AbortController().signal;
      const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: 'cli-global',
        mode: 'plain', ctx: null, serverId: 'home-a', serverIdentityId: 'srv_finite_home', serverHttpBaseUrl: 'https://home-a.test' });
      expect(await deps.projectAction!({ actionId, input,
        context: { surface: 'cli', authority: 'present_user', actionRequestId: 'original-finite-request', signal } })).toEqual(result);
      expect(requests).toHaveLength(1);
      expect(rawGuest).not.toHaveBeenCalled();
    });
});
