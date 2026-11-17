import axios, { AxiosHeaders } from 'axios';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, projectExternalActionProjectSessionDefaultsAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { resolveManagedSessionDefaults } from '@happier-dev/protocol/teams/managedDefaults';
import { TeamSummaryV1Schema, resolveTeamAdmissionProjectionV1 } from '@happier-dev/protocol/teams/projections';
import { NO_TEAM_CAPABILITIES_V1 } from '@happier-dev/protocol/teams/capabilities';
import { ExternalActionRequesterInvocationV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createPrepareSessionSpawnInput } from './prepareSessionSpawnInput';

// HTTP is the boundary. Preparation, context loading, custody and precedence stay real.
afterEach(() => vi.restoreAllMocks());

it.each(['machine', 'preset', 'unavailable-team'] as const)('prepares public no-box defaults while preserving private preset custody (%s)', async placement => {
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'custodian' })).toString('base64url')}.signature`;
  const keys = nacl.sign.keyPair();
  const projectContext = { projectRef: { serverId: 'home', projectKey: 'private' }, sourceRef: { serverId: 'home', sourceId: 'selected' } };
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root-proof', binding: {
    accountId: 'requester', principalId: 'requester', credentialId: 'pat', grant: API_TOKEN_FULL_GRANT_V1,
    accountEncryptionMode: 'e2ee', custodianAccountId: 'custodian', serverIdentityId: 'home',
    machineId: 'machine', installationId: 'installed', actionId: 'session.spawn_new', requestId: 'birth',
    target: { kind: 'machine', machineId: 'machine' }, requestEnvelopeDigest: 'a'.repeat(43),
    projectSessionDefaultsAdmission: projectExternalActionProjectSessionDefaultsAdmissionV1('session.spawn_new', { projectContext }),
  } });
  const reads: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async () => { throw new Error('private Account GET is unavailable without requester custody'); });
  vi.spyOn(axios, 'post').mockImplementation(async () => { throw new Error('private Account POST is unavailable without requester custody'); });
  vi.spyOn(axios, 'request').mockImplementation(async config => {
    const url = new URL(String(config.url));
    const path = url.pathname + url.search;
    reads.push(url.pathname);
    const headers = AxiosHeaders.from(config.headers);
    expect(headers.has('Authorization')).toBe(false);
    const effectActionId = url.pathname === '/v1/teams/get' ? 'teams.get'
      : url.pathname === '/v1/home/governance/get' ? 'home.governance.get' : 'projects.sources.read';
    expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId,
      target: authorization.binding.target, installationId: 'installed', requestId: 'birth',
      method: String(config.method).toUpperCase(), path, ...(config.data === undefined ? {} : { body: config.data }),
      publicKey: keys.publicKey, signature: String(headers.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER)) })).toBe(true);
    if (url.pathname === '/v1/projects/sources/selected') return { status: 200, data: { ok: true,
      source: { id: 'selected', name: 'Shared', revision: 1, owner: { kind: 'team', teamId: 'team' },
        audience: [], createdByAccountId: 'owner' }, canManage: false,
      sessionDefaults: { revision: 1, defaults: { approvalProfileId: 'project-profile',
        ...(placement === 'preset' ? { placement: { kind: 'preset', homeId: 'home', presetId: 'shared-preset' } } : {}),
        defaultAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } } } };
    if (placement === 'unavailable-team' && url.pathname === '/v1/teams/get') return { status: 200, data: {
      ok: false, errorCode: 'permission_denied', error: 'effect_family', effectAttempted: false } };
    if (url.pathname === '/v1/home/governance/get') throw new Error('optional Home is unreachable');
    if (url.pathname === '/v1/teams/get') return { status: 200, data: TeamSummaryV1Schema.parse({
      id: 'team', name: 'Team', description: null, logo: null, archivedAt: null, recovery: null,
      policy: { v: 1, sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed',
        defaultSessionHistoryAccess: 'from_membership', admissionMode: 'invite_only', authenticationPolicy: null,
        managedDefaults: { team: { approvalProfileId: 'team-profile' }, groups: {} }, homeDefaults: null },
      managedDefaultsGroupIds: [], viewerRole: 'member', capabilities: { ...NO_TEAM_CAPABILITIES_V1, viewTeam: true },
      admission: resolveTeamAdmissionProjectionV1(), counts: null }) };
    throw new Error(`Unexpected HTTP read ${path}`);
  });
  const prepare = createPrepareSessionSpawnInput({ credentials: { token, encryption: null }, token, mode: 'plain',
    sessionId: '', ctx: null, rawSession: {}, serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test',
    externalActionMachineInstallationId: 'installed', externalActionMachineRequestPrivateKey: keys.secretKey,
  }, { serverId: 'home', serverHttpBaseUrl: 'https://home.test' }, {
    spawnConnectedServicesList: async () => { throw new Error('no connected-services intent'); },
  });
  const preparation = prepare({ ...(placement !== 'preset' ? { executionTarget: { serverId: 'home', machineId: 'machine' } } : {}),
    directory: { kind: 'path', path: '/repo' }, projectContext }, { surface: 'rpc', authority: 'account_automation', externalActionExecutionAuthorization: authorization,
    externalActionTarget: authorization.binding.target });
  if (placement === 'preset') {
    await expect(preparation).rejects.toMatchObject({ errorCode: 'client_required' });
    expect(reads).toEqual(['/v1/projects/sources/selected', '/v1/teams/get']);
    return;
  }
  const prepared = await preparation;
  expect(prepared.input.agentTarget).toMatchObject({ identity: { localId: 'codex' } });
  expect(prepared.defaults.context.personalProjectDefaults).toBeNull();
  expect(resolveManagedSessionDefaults({ ...prepared.defaults.context, agentTargetKey: '' }).approvalProfileId)
    .toMatchObject({ value: 'project-profile', source: 'project', teamOrGroupDerived: true });
  expect(reads).toEqual(['/v1/projects/sources/selected', '/v1/teams/get',
    ...(placement === 'unavailable-team' ? ['/v1/home/governance/get'] : [])]);
  if (placement === 'unavailable-team') {
    expect(prepared.defaults.unavailableDefaults).toMatchObject([
      { errorCode: 'permission_denied', effectAttempted: false }, { errorCode: 'defaults_unavailable', effectAttempted: false },
    ]);
    const invocation = ExternalActionRequesterInvocationV1Schema.parse({ caller: { kind: 'host' }, surface: 'rpc',
      authority: 'account_automation', sessionCreationDefaults: prepared.defaults });
    expect(invocation.sessionCreationDefaults?.unavailableDefaults).toEqual(prepared.defaults.unavailableDefaults);
  }
});


it.each(['pat', 'daemon'] as const)('prepares no-Project creation without requester-private reads (%s)', async kind => {
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'custodian' })).toString('base64url')}.signature`;
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root-proof', binding: {
    accountId: 'requester', principalId: 'requester', credentialId: 'pat', grant: API_TOKEN_FULL_GRANT_V1,
    accountEncryptionMode: 'plain', custodianAccountId: 'custodian', serverIdentityId: 'home',
    machineId: 'machine', installationId: 'installed', actionId: 'session.spawn_new', requestId: 'birth',
    target: { kind: 'machine', machineId: 'machine' }, requestEnvelopeDigest: 'a'.repeat(43),
  } });
  vi.spyOn(axios, 'get').mockRejectedValue(new Error('private read forbidden'));
  vi.spyOn(axios, 'post').mockRejectedValue(new Error('private write forbidden'));
  vi.spyOn(axios, 'request').mockRejectedValue(new Error('Home admin read forbidden'));
  const prepare = createPrepareSessionSpawnInput({ credentials: { token, encryption: null }, token, mode: 'plain',
    sessionId: '', ctx: null, rawSession: {}, serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test',
  }, { serverId: 'home', serverHttpBaseUrl: 'https://home.test' }, {
    spawnConnectedServicesList: async () => { throw new Error('no auth intent'); },
  });
  const prepared = await prepare({ executionTarget: { serverId: 'home', machineId: 'machine' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    directory: { kind: 'path', path: '/repo' }, primaryTeamId: 'unavailable-team' }, { surface: 'rpc', authority: 'account_automation',
    ...(kind === 'pat' ? { externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target } : {}) });
  expect(prepared.input.executionTarget).toEqual({ serverId: 'home', machineId: 'machine' });
  expect(prepared.defaults.context.homeDefaults).toBeNull();
  expect(prepared.defaults.context.primaryTeamId).toBe('unavailable-team');
  expect(prepared.defaults.context.teamDefaults).toBeNull();
  expect(axios.request).not.toHaveBeenCalled();
  expect(axios.get).not.toHaveBeenCalled();
  expect(axios.post).not.toHaveBeenCalled();
});
