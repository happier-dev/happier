import axios from 'axios';
import nacl from 'tweetnacl';
import { encodeBase64 } from '@/api/encryption';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeV1Schema,
  ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { afterEach, expect, it, vi, onTestFinished } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactJsonCreateHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactMutationHttpV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createPromptBundleInLibrary, type PromptLibraryArtifactStore } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1, SKILL_MACHINE_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { artifactListResponse } from '@/testkit/http/artifactHome';
import { installAxiosRequestMethodAdapter } from '@/testkit/http/axiosAdapter';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createEmptyActionAutomationPort, createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { tryHandleSkillsCliCommand } from '@/cli/actions/skillsNameArgAdapter';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { seedTestServerProfile } from '@/testkit/serverProfiles';

const io = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); process.exitCode = 0; });

async function fixture(approvalRequired = false, invalidReply = false) {
  installAxiosRequestMethodAdapter();
  const rawMachineCalls: unknown[] = [];
  bindApiSessionSocketMock(io, createApiSessionSocketStub({
    emit: (event, args) => { if (event === SOCKET_RPC_EVENTS.CALL) rawMachineCalls.push(args); },
    emitWithAck: (event, payload) => { if (event === SOCKET_RPC_EVENTS.CALL) rawMachineCalls.push(payload); },
  }));
  const base = 'https://skills-cli.example.test', serverId = 'skills-home', identity = 'srv_skills';
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'skills-account', tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
  const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
  const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(18));
  const homeDir = await createTempDir('skills-machine-cli-');
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
  env.patch({ HAPPIER_HOME_DIR: homeDir });
  reloadConfiguration();
  onTestFinished(async () => { env.restore(); reloadConfiguration(); await removeTempDir(homeDir); });
  const profile = await seedTestServerProfile({ id: serverId, homeId: identity, serverUrl: base });
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
  const reads: string[] = [], requests: Array<Readonly<{ actionId: string; input: unknown }>> = [];
  // Home HTTP is the substituted boundary. The CLI, library codecs, root
  // admission, requester sealing and response validation stay real.
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
      kind: 'persistent', installationId: 'skills-installation', installationPublicKey: encodeBase64(installation.publicKey),
      revokedAt: null, replacedByMachineId: null,
      access: { custodian: { accountId: 'skills-account', displayName: 'Skills owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
    } } };
    throw new Error(`Unexpected Skills CLI Home read: ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
    const path = new URL(String(url)).pathname;
    if (path.startsWith('/v1/actions/')) {
      const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(carrier.envelope);
      const actionId = path.split('/')[3]!;
      expect(envelope.target).toEqual({ kind: 'machine', machineId: 'selected-machine' });
      if (path.endsWith('/execution-authorization')) return { status: 200, data: { v: 1, token: 'skills-admission', binding: {
        accountId: 'skills-account', custodianAccountId: 'skills-account', authentication: { kind: 'account', tokenEpoch: 1 },
        accountEncryptionMode: 'plain', serverIdentityId: identity, machineId: 'selected-machine', installationId: 'skills-installation',
        actionId, requestId: envelope.requestId, target: envelope.target, idempotencyKey: envelope.idempotencyKey,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        ...(envelope.machineRuntimeDemand === undefined ? {} : { machineRuntimeDemand: envelope.machineRuntimeDemand }),
      } } };
      expect(carrier.executionAuthorization?.token).toBe('skills-admission');
      if (actionId !== 'skills.machine.install' && actionId !== 'skills.machine.uninstall') throw new Error('Unexpected Skills Action');
      const id = actionId;
      const input = SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1[id].parse(envelope.input);
      if (approvalRequired) return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({
        v: 1, actionId, requestId: envelope.requestId, execution: { ok: true,
          result: { kind: 'approval_request_created', artifactId: '00000000-0000-4000-8000-000000000002' } },
      }) };
      requests.push({ actionId: id, input });
      // The receiving Action owner settles filesystem-adapter acknowledgements
      // before Home relays its public result. Keep that strict owner real.
      const receiver = createActionExecutor({ ...createUnavailableActionTransportDeps(),
        actionAutomations: createEmptyActionAutomationPort('skills-account'),
        skillMachineActionExecute: async () => invalidReply ? { invalid: true }
          : SKILL_MACHINE_ACTION_OUTPUT_SCHEMAS_V1[id].parse(id === 'skills.machine.install'
            ? { receipts: [{ root: '/skills', path: '/skills/review', digest: 'sha256:review' }] } : { removed: ['/skills/review'] }),
      });
      const execution = await receiver.execute(id, input, { surface: 'cli', authority: 'present_user',
        bypassApprovals: true, actionRequestId: envelope.requestId });
      return { status: 200, data: { v: 1, actionId, requestId: envelope.requestId, execution } };
    }
    expect(String(url)).toBe(`${base}/v1/artifacts`);
    const input = ArtifactJsonCreateHttpInputV1Schema.parse(body);
    artifacts.push({ id: input.id, header: input.header, body: input.body, dataEncryptionKey: input.dataEncryptionKey,
      headerVersion: 1, bodyVersion: 1, seq: artifacts.length + 1, createdAt: 1, updatedAt: 1,
      ownerAccountId: 'skills-account', access: 'owner', encryptionMode: 'plain' });
    return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
  });
  vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
  const run = (leaf: 'machine-install' | 'machine-uninstall') => tryHandleSkillsCliCommand({
    argv: ['skills', leaf, 'review', '--machine', 'selected-machine', '--server-id', serverId,
      ...(leaf === 'machine-install' ? ['--agent', 'claude', '--agent', 'codex'] : ['--force']), '--json'],
    actionExecutionDeps: {
      readCredentialsForServerIdFn: async () => credentials,
      getServerProfileFn: async () => profile,
      createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
        actionsSettingsProvider: createActionSettingsProvider({ scopeKey: runWithServerHttpBaseUrl(base, () => resolveAccountSettingsScopeKey(credentials)) }),
      }),
    },
  });
  return { run, reads, requests, rawMachineCalls, artifactId: artifacts[0]!.id };
}

it('mounts ordinary Skills machine CLI commands through admitted Home delivery after real library name resolution', async () => {
  const owner = await fixture(), output = captureConsoleJsonOutput<unknown>();
  try {
    expect(await owner.run('machine-install')).toBe(true);
    expect(output.json()).toMatchObject({ ok: true, data: { receipts: [{ path: '/skills/review' }] } });
    expect(await owner.run('machine-uninstall')).toBe(true);
    expect(output.json()).toMatchObject({ ok: true, data: { removed: ['/skills/review'] } });
    expect(owner.requests).toEqual([
      { actionId: 'skills.machine.install', input: { skillId: owner.artifactId, machineId: 'selected-machine', agents: ['claude', 'codex'] } },
      { actionId: 'skills.machine.uninstall', input: { skillId: owner.artifactId, machineId: 'selected-machine', force: true } },
    ]);
    expect(owner.reads).toContain(`/v1/artifacts/${owner.artifactId}`);
    expect(owner.rawMachineCalls).toEqual([]);
  } finally { output.restore(); }
});

it('surfaces the Home machine Action approval without a machine effect', async () => {
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
