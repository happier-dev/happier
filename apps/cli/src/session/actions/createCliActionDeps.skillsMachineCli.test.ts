import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactJsonCreateHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactMutationHttpV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createPromptBundleInLibrary, type PromptLibraryArtifactStore } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1, SKILL_MACHINE_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { artifactListResponse } from '@/testkit/http/artifactHome';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { tryHandleSkillsCliCommand } from '@/cli/actions/skillsNameArgAdapter';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

const io = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); process.exitCode = 0; });

async function fixture(approvalRequired = false, invalidReply = false) {
  const base = 'https://skills-cli.example.test', serverId = 'skills-home', identity = 'srv_skills';
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'skills-account', tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
  const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
  const actionsSettingsV1 = { v: 1 as const, approvalWaivedSurfaces: approvalRequired ? {} : {
    'skills.machine.install': ['cli' as const], 'skills.machine.uninstall': ['cli' as const],
  } };
  runWithServerHttpBaseUrl(base, () => setActiveAccountSettingsSnapshot({ source: 'network',
    settings: accountSettingsParse({ actionsSettingsV1 }), rawSettings: { actionsSettingsV1 }, settingsVersion: 7,
    loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) }));
  const artifacts: Array<Readonly<{ id: string; header: string; body: string; dataEncryptionKey: string;
    headerVersion: number; bodyVersion: number; seq: number; createdAt: number; updatedAt: number;
    ownerAccountId: string; access: 'owner'; encryptionMode: 'plain' }>> = [];
  const store: PromptLibraryArtifactStore = {
    read: async () => null, update: async () => { throw new Error('Unexpected seed update'); },
    create: async input => {
      const id = '00000000-0000-4000-8000-000000000001';
      artifacts.push({ id, header: encodePlainArtifactStoredContent(input.header), body: encodePlainArtifactStoredContent({ body: input.body }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1,
        createdAt: 1, updatedAt: 1, ownerAccountId: 'skills-account', access: 'owner', encryptionMode: 'plain' });
      return id;
    },
  };
  await createPromptBundleInLibrary({ store, request: { title: 'review', bundleSchemaId: 'skills.skill_md_v1',
    entries: [{ path: 'SKILL.md', contentKind: 'utf8', contentBase64: Buffer.from('---\nname: review\ndescription: Review changes\n---\nRead the patch.').toString('base64') }] } });
  const reads: string[] = [], requests: Array<Readonly<{ method: string; params: unknown }>> = [];
  // Home HTTP and Socket.IO are the substituted boundaries. The ordinary CLI
  // factory, credential lifetime, library codecs, admission, and exact RPC stay real.
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const target = new URL(String(url)); expect(target.origin).toBe(base); reads.push(target.pathname);
    const path = target.pathname;
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
      key, revision: 1, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) },
    })) } };
    if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(String(url), artifacts) };
    if (/^\/v1\/artifacts\/[^/]+$/.test(path)) {
      const artifact = artifacts.find(artifact => path === `/v1/artifacts/${artifact.id}`);
      return artifact ? { status: 200, data: artifact } : { status: 404, data: { error: 'Artifact not found' } };
    }
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: { actionsSettingsV1 } }, version: 7 } };
    if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
    if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
    if (path === '/v1/machines/selected-machine') return { status: 200, data: { machine: {
      id: 'selected-machine', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, active: true,
      revokedAt: null, replacedByMachineId: null,
    } } };
    throw new Error(`Unexpected Skills CLI Home read: ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
    expect(String(url)).toBe(`${base}/v1/artifacts`);
    const input = ArtifactJsonCreateHttpInputV1Schema.parse(body);
    artifacts.push({ id: input.id, header: input.header, body: input.body, dataEncryptionKey: input.dataEncryptionKey,
      headerVersion: 1, bodyVersion: 1, seq: artifacts.length + 1, createdAt: 1, updatedAt: 1,
      ownerAccountId: 'skills-account', access: 'owner', encryptionMode: 'plain' });
    return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
  });
  vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
  bindApiSessionSocketMock(io, createApiSessionSocketStub({ emitWithAck: (event, raw) => {
    if (event !== SOCKET_RPC_EVENTS.CALL || !raw || typeof raw !== 'object'
      || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)) throw new Error('Unexpected Skills CLI socket request');
    requests.push({ method: raw.method, params: raw.params });
    const id = raw.method.slice('selected-machine:'.length);
    if (id !== 'skills.machine.install' && id !== 'skills.machine.uninstall') throw new Error('Unexpected Skills machine method');
    const input = SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1[id].parse(raw.params);
    expect(input.machineId).toBe('selected-machine');
    const result = invalidReply ? { invalid: true } : SKILL_MACHINE_ACTION_OUTPUT_SCHEMAS_V1[id].parse(id === 'skills.machine.install'
      ? { receipts: [{ root: '/skills', path: '/skills/review', digest: 'sha256:review' }] } : { removed: ['/skills/review'] });
    return { ok: true, result };
  } }));
  const run = (leaf: 'machine-install' | 'machine-uninstall') => tryHandleSkillsCliCommand({
    argv: ['skills', leaf, 'review', '--machine', 'selected-machine', '--server-id', serverId,
      ...(leaf === 'machine-install' ? ['--agent', 'claude', '--agent', 'codex'] : ['--force']), '--json'],
    actionExecutionDeps: {
      readCredentialsForServerIdFn: async () => credentials,
      getServerProfileFn: async () => ({ id: serverId, name: 'Skills Home', serverUrl: base, webappUrl: base,
        createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: {
          v: 1, homeServerIdentityId: identity, canonicalServerUrl: base, revision: 1, endpoints: [{ kind: 'https', url: base }],
        } }),
      createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
        actionsSettingsProvider: createActionSettingsProvider({ scopeKey: runWithServerHttpBaseUrl(base, () => resolveAccountSettingsScopeKey(credentials)) }),
      }),
    },
  });
  return { run, reads, requests, artifactId: artifacts[0]!.id };
}

it('mounts ordinary Skills machine CLI commands through the exact RPC after real library name resolution', async () => {
  const owner = await fixture(), output = captureConsoleJsonOutput<unknown>();
  try {
    expect(await owner.run('machine-install')).toBe(true);
    expect(output.json()).toMatchObject({ ok: true, data: { receipts: [{ path: '/skills/review' }] } });
    expect(await owner.run('machine-uninstall')).toBe(true);
    expect(output.json()).toMatchObject({ ok: true, data: { removed: ['/skills/review'] } });
    expect(owner.requests).toEqual([
      { method: 'selected-machine:skills.machine.install', params: { skillId: owner.artifactId, machineId: 'selected-machine', agents: ['claude', 'codex'] } },
      { method: 'selected-machine:skills.machine.uninstall', params: { skillId: owner.artifactId, machineId: 'selected-machine', force: true } },
    ]);
    expect(owner.reads).toContain(`/v1/artifacts/${owner.artifactId}`);
  } finally { output.restore(); }
});

it('keeps default machine Action approval admission ahead of its RPC effect', async () => {
  const owner = await fixture(true), output = captureConsoleJsonOutput<unknown>();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await owner.run('machine-install')).toBe(true);
    const result = output.json();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, data: { kind: 'approval_request_created', artifactId: expect.any(String) } });
    expect(owner.requests).toEqual([]);
  } finally { output.restore(); }
});

it('rejects a malformed machine acknowledgement through the strict Action result owner', async () => {
  const owner = await fixture(false, true), output = captureConsoleJsonOutput<unknown>();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await owner.run('machine-install')).toBe(true);
    expect(output.json()).toMatchObject({ ok: false, error: { code: 'invalid_action_output' } });
    expect(owner.requests).toHaveLength(1);
  } finally { output.restore(); }
});
