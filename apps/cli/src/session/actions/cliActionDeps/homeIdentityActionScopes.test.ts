import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createCliProfileActionExecuteV1 } from './createCliProfileActionDeps';
import { createCliProviderActionExecuteV1 } from './createCliProviderActionDeps';
import { createCliMcpServerActionExecuteV1 } from './createCliMcpServerActionDeps';
import { createCliRemoteHostActionExecuteV1 } from './createCliRemoteHostActionDeps';
import { createCliOccurrenceAction } from './occurrences';
import { createCliSettingsDeclarationAction } from '../settingsDeclarationAction';
import { createCliActionDeps } from '../createCliActionDeps';
import { createCurrentSessionProjectionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { V2SessionByIdResponseSchema, projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import * as machineRpc from '@/session/transport/rpc/machineRpc';

const portableHomeId = 'srv_action_home';
const foreignHomeId = 'srv_other_home';
const sessionId = 'c111111111111111111111111';
const base = 'https://action-home.example.test';
const credentials = { token: 'action-home-account', encryption: null } as const;
const context = (serverId = portableHomeId) => ({ surface: 'cli' as const, serverId });
let directory: string;
let profileId: string;
let env: ReturnType<typeof createEnvKeyScope>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'happier-action-home-'));
  env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  env.patch({ HAPPIER_HOME_DIR: directory, HAPPIER_ACTIVE_SERVER_ID: undefined, HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
  reloadConfiguration();
  const profile = await addServerProfile({ name: 'action-local-profile', serverUrl: base, webappUrl: base });
  profileId = profile.id;
  await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
    v: 1, homeServerIdentityId: portableHomeId, canonicalServerUrl: base, revision: 1, endpoints: [{ kind: 'https', url: base }],
  } });
});
afterEach(async () => {
  vi.restoreAllMocks();
  env.restore();
  reloadConfiguration();
  await rm(directory, { recursive: true, force: true });
});

function params() {
  const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: runWithServerHttpBaseUrl(base, () => resolveAccountSettingsScopeKey(credentials)) };
  return { credentials, serverId: profileId, serverHttpBaseUrl: base,
    operationContext: runWithServerHttpBaseUrl(base, () => createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
      serverHttpBaseUrl: base, isCurrent: async () => true })),
    callMachineAction: async () => ({ status: 'success', agentTargetKey: 'agent:happier.agent.codex/codex', groups: [], teamCredentialResources: [] }),
  };
}

function installSession(metadata: Record<string, unknown>) {
  const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
    agentState: null, metadata });
  const session = createCurrentSessionProjectionRecordFixture({ id: sessionId, encryptionMode: 'plain', share: null,
    metadataLayoutVersion: fields.metadataLayoutVersion, metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata,
    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
      capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
  return vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: V2SessionByIdResponseSchema.parse({ session }) };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    throw new Error(`Unexpected HTTP fixture path: ${path}`);
  });
}

function sessionDeps() {
  const captured = params();
  return createCliActionDeps({ ...captured, token: credentials.token, sessionId: '', mode: 'plain', ctx: null,
    savedSecretOperationContext: captured.operationContext });
}

describe('Account Action Home identity admission', () => {
  it('admits Profile editor handling for its portable Home and rejects another Home', async () => {
    const execute = createCliProfileActionExecuteV1(params());
    const request = { actionId: 'launch_profiles.edit' as const, input: { id: 'profile-a', expectedRevision: 1 } };
    expect(await execute(request, context())).toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'profile_editor_unavailable' } });
    expect(await execute(request, context(foreignHomeId))).toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
  });
  it('admits Provider projection for its portable Home and rejects another Home', async () => {
    const execute = createCliProviderActionExecuteV1(params());
    const request = { actionId: 'providers.models.projection' as const, input: {
      machineId: 'worker', agentTargetKey: 'agent:happier.agent.codex/codex', teamCredentialResources: [],
    } };
    expect(await execute(request, context())).toMatchObject({ ok: true, result: { status: 'success' } });
    await expect(execute(request, context(foreignHomeId))).rejects.toMatchObject({ code: 'server_scope_mismatch' });
  });
  it.each(['mcp', 'remote-host'] as const)('reads the %s catalog on its portable Home and rejects another Home', async family => {
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/mcp') return { status: 200, data: { status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, servers: [], bindings: [] } } } };
      if (path === '/v1/account/entity-rows/remote-hosts') return { status: 200, data: { status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, hosts: [] } } } };
      throw new Error(`Unexpected HTTP fixture path: ${path}`);
    });
    const captured = params();
    const invoke = family === 'mcp'
      ? (serverId: string) => createCliMcpServerActionExecuteV1(captured)({ actionId: 'mcp.servers.list', input: {}, context: context(serverId) })
      : (serverId: string) => createCliRemoteHostActionExecuteV1(captured)({ actionId: 'remote_hosts.list', input: {} }, context(serverId));
    expect(await invoke(portableHomeId)).toMatchObject({ ok: true, result: { status: family === 'mcp' ? 'ready' : 'listed' } });
    expect(await invoke(foreignHomeId)).toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
  });
  it('sends an occurrence mutation on its portable Home and rejects another Home', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 409, data: { error: 'automation_run_revision_conflict' } });
    const execute = createCliOccurrenceAction({ credentials }, { serverId: profileId, serverHttpBaseUrl: base, accountId: null });
    const request = { actionId: 'automation.run.result.redeliver' as const, input: { runId: 'run', expectedRevision: 1 } };
    expect(await execute({ ...request, context: context() })).toMatchObject({ ok: false, errorCode: 'automation_run_revision_conflict' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(await execute({ ...request, context: context(foreignHomeId) })).toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('accepts a portable Home setting target and preserves foreign-target refusal', async () => {
    const execute = createCliSettingsDeclarationAction({ serverId: profileId, serverHttpBaseUrl: base });
    const invoke = (serverId: string) => execute({ actionId: 'settings.reset', input: {
      anchor: 'homeAdministration.serverSettings.HAPPIER_CANONICAL_SERVER_URL', target: { kind: 'home', serverId },
    }, context: context(), executeOwnerAction: async () => { throw new Error('Read-only settings must not dispatch an owner mutation'); } });
    expect(await invoke(portableHomeId)).toMatchObject({ ok: false, errorCode: 'setting_read_only' });
    expect(await invoke(foreignHomeId)).toMatchObject({ ok: false, errorCode: 'setting_target_mismatch' });
  });
  it('reads a Session on its portable Home and refuses a foreign Home before transport', async () => {
    // This Session exists but has no Agent, so the domain owner reports unavailable after admission.
    const get = installSession({});
    const execute = sessionDeps().sessionCapabilitiesGet!;
    expect(await execute({ sessionId }, context())).toEqual({ ok: false, code: 'session_unavailable' });
    expect(get).toHaveBeenCalledWith(expect.stringContaining(`/v2/sessions/${sessionId}`), expect.anything());
    const before = get.mock.calls.length;
    expect(await execute({ sessionId }, context(foreignHomeId))).toEqual({ ok: false, code: 'not_found' });
    expect(get).toHaveBeenCalledTimes(before);
  });
  it('continues External Session follow on its portable Home and rejects a foreign Home', async () => {
    installSession({ machineId: 'worker', externalSessionV1: { v: 1, machineId: 'worker', agentId: 'codex', remoteSessionId: 'native-session',
      source: { kind: 'codexHome', home: '/tmp/action-home' }, linkedAtMs: 1 } });
    const rpc = vi.spyOn(machineRpc, 'callExactMachineRpc').mockResolvedValue({ ok: true, enabled: true, leaseActive: true, updatedAtMs: 42 });
    const execute = sessionDeps().hostExternalSessionAction!;
    const request = { actionId: 'sessions.external.backgroundFollow.set' as const, input: { sessionId, enabled: true } };
    expect(await execute({ ...request, context: context() })).toMatchObject({ ok: true, result: { ok: true, enabled: true } });
    expect(await execute({ ...request, context: context(foreignHomeId) })).toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
