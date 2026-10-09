import axios, { AxiosHeaders } from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createWorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';
import { buildWorkBoardArtifactHeaderV1 } from '@happier-dev/protocol/boards/workBoardArtifactV1';
import { buildLaunchProfileArtifactHeaderV1, LaunchProfileArtifactV1Schema } from '@happier-dev/protocol/launchProfiles/launchProfileArtifactV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { AutomationDefinitionListItemSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { MachinePoolViewV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import { PROFILE_ROWS_ROUTE_V1, ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { configuration } from '@/configuration';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createCliActionDeps } from './createCliActionDeps';

const temporaryRoots: string[] = [];
const originalConfiguration = {
  happyHomeDir: configuration.happyHomeDir,
  settingsFile: configuration.settingsFile,
  serversDir: configuration.serversDir,
  activeServerDir: configuration.activeServerDir,
  privateKeyFile: configuration.privateKeyFile,
};
afterEach(async () => {
  vi.restoreAllMocks();
  resetInMemoryAccountSettingsContextForTests();
  Object.assign(configuration, originalConfiguration);
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each(['legacy', 'destination', 'unavailable'] as const)('reviews current canonical machine references from the captured CLI Account before native Delete (%s Profile source)', async (profileSource) => {
  const requests: { method: string; origin: string; path: string }[] = [];
  const diagnostics = () => JSON.stringify({ profileSource, requests });
  const root = await mkdtemp(join(tmpdir(), 'happier-managed-reference-review-'));
  temporaryRoots.push(root);
  Object.assign(configuration, { happyHomeDir: root, settingsFile: join(root, 'settings.json'),
    serversDir: join(root, 'servers'), activeServerDir: join(root, 'servers', configuration.activeServerId),
    privateKeyFile: join(root, 'servers', configuration.activeServerId, 'access.key') });
  resetInMemoryAccountSettingsContextForTests();
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;
  const machine = ManagedMachineV1Schema.parse({
    id: 'managed-a', homeId: 'home-a', custodianAccountId: 'account-a', enrolledMachineId: 'target-machine',
    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'VM', choices: {} },
    controller: { machineId: 'controller-a', installationId: 'installation-a' },
    allocation: 'bound', resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'native-a' } },
    creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 2,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
  });
  const board = { ...createWorkBoardV1({ id: 'board-a', name: 'Affected Board' }),
    source: { picked: [{ kind: 'machine' as const, qualifiedId: { serverId: 'home-a', id: 'target-machine' } }] } };
  const unrelatedBoard = { ...createWorkBoardV1({ id: 'unrelated-board', name: 'Unrelated Board' }),
    source: { picked: [{ kind: 'machine' as const, qualifiedId: { serverId: 'home-b', id: 'target-machine' } }] } };
  const profile = LaunchProfileArtifactV1Schema.parse({ kind: 'launch-profile.v1', secretBindings: {}, profile: {
    v: 2, id: 'profile-a', name: 'Affected Profile', createdAt: 1, updatedAt: 1,
    placement: { fixed: { serverId: 'home-a', machineId: 'target-machine' } },
  } });
  const unrelatedProfile = LaunchProfileArtifactV1Schema.parse({ kind: 'launch-profile.v1', secretBindings: {}, profile: {
    v: 2, id: 'unrelated-profile', name: 'Unrelated Profile', createdAt: 1, updatedAt: 1,
    placement: { fixed: { serverId: 'home-a', machineId: 'other-machine' } },
  } });
  const artifacts = [
    { id: 'board-a', header: buildWorkBoardArtifactHeaderV1(board), body: board },
    { id: 'unrelated-board', header: buildWorkBoardArtifactHeaderV1(unrelatedBoard), body: unrelatedBoard },
    { id: 'profile-artifact-a', header: buildLaunchProfileArtifactHeaderV1(profile), body: profile },
    { id: 'unrelated-profile-artifact', header: buildLaunchProfileArtifactHeaderV1(unrelatedProfile), body: unrelatedProfile },
  ].map((artifact) => ({ id: artifact.id, ownerAccountId: 'account-a', access: 'owner', encryptionMode: 'plain',
    header: encodePlainArtifactStoredContent(artifact.header), body: encodePlainArtifactStoredContent({ body: JSON.stringify(artifact.body) }),
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }));
  const assignment = (id: string, machineId: string) => AutomationDefinitionListItemSchema.parse({ id,
    name: id === 'workflow-assignment-a' ? 'Affected Workflow' : 'Unrelated Workflow', description: null,
    enabled: true, workflowDefinitionId: 'builtin:workflow-definition-a', targetType: null, existingSessionId: null,
    templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
    assignments: [{ machineId, enabled: true, priority: 0, updatedAt: 1 }], triggers: [],
  });
  const pool = (id: string, machineId: string) => MachinePoolViewV1Schema.parse({ pool: { id,
    name: machineId === 'target-machine' ? 'Affected Pool' : 'Unrelated Pool', description: null,
    revision: 1, createdAt: 1, updatedAt: 1, members: [{ machineId, priorityTier: 0, enabled: true, state: 'unknown' }] },
    availability: { state: 'unknown' } });
  const pools = [pool('11111111-1111-4111-8111-111111111111', 'target-machine'),
    pool('22222222-2222-4222-8222-222222222222', 'other-machine')];
  const profileRecord = ProfileRecordV1Schema.parse({ v: 1, id: 'profile-a',
    definition: { kind: 'artifact', artifactId: 'profile-artifact-a' }, enabled: true, promptStack: [], secretBindings: {} });
  const transfer = profileSource === 'destination' ? { status: 'present', revision: 1,
    content: { t: 'plain', v: { v: 1, phase: 'active', sourceSettingsVersion: 1, migratedLogicalRevision: 1,
      inventory: [{ kind: 'account_row', id: profileRecord.id, revision: 1 }] } } } : { status: 'absent' };
  const response = (data: unknown) => ({ data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } });
  // HTTP is the boundary: credential scope, content opening and canonical reference readers remain real.
  const network = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname;
    requests.push({ method: 'GET', origin: parsedUrl.origin, path });
    if (path === '/v2/account/settings') return response({ version: 1, content: { t: 'plain', v: {
      profiles: profileSource === 'destination' ? [{ artifactId: 'unrelated-profile-artifact' }]
        : [{ artifactId: 'profile-artifact-a' }, { artifactId: 'unrelated-profile-artifact' }],
    } } });
    if (path === '/v1/account/encryption/currentness') return response({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    if (path === '/v1/account/encryption') return response({ mode: 'plain', updatedAt: 1 });
    if (path === PROFILE_ROWS_ROUTE_V1) {
      if (profileSource === 'unavailable') throw new Error('Profile catalog unreachable');
      return response({ status: 'listed', rows: profileSource === 'destination'
        ? [{ id: profileRecord.id, revision: 1, content: { t: 'plain', v: profileRecord } }] : [],
        nextCursor: null, complete: true, referenceGuardRevision: 'absent', transferControl: transfer, diagnostics: [] });
    }
    if (path === `${PROFILE_ROWS_ROUTE_V1}/reference-guard`) return response({ status: 'ready', revision: 'absent' });
    if (path === PROFILE_TRANSFER_ROUTE_V1) return response(transfer);
    if (path === '/v1/artifacts') return response(artifacts);
    if (path.startsWith('/v1/artifacts/')) return response(artifacts.find(artifact => artifact.id === path.split('/').at(-1)));
    if (path === '/v3/automations') return response({ automations: [assignment('workflow-assignment-a', 'target-machine'),
      assignment('unrelated-workflow-assignment', 'other-machine')], nextCursor: null });
    throw new Error(`Unexpected read: ${path}`);
  });
  const outward = vi.spyOn(axios, 'post').mockImplementation(async (url) => {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname;
    requests.push({ method: 'POST', origin: parsedUrl.origin, path });
    if (path === managedMachineActionEndpointPathV1('machines.managed.get')) return response(machine);
    if (path.endsWith('/pools/list')) return response({ pools });
    throw new Error(`Unexpected outward effect during review: ${path}`);
  });
  const deps = createCliActionDeps({ token, credentials: { token, encryption: null },
    sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'home-a', serverHttpBaseUrl: 'https://home-a.example' });
  const input = { homeId: 'home-a', managedId: 'managed-a', expectedRevision: 2,
    intent: 'delete', when: 'now', reviewedDependencies: true };
  const preview = await deps.buildApprovalPreview?.({ actionId: 'machines.managed.delete', input,
    context: { surface: 'cli', authority: 'present_user', serverId: 'home-a', runtimeAccountId: 'account-a' },
    defaultPreview: { actionId: 'machines.managed.delete', actionArgs: input } });
  expect(preview).toMatchObject({ machineReferences: { homeId: 'home-a', machineId: 'target-machine',
    coverage: profileSource === 'unavailable' ? 'partial' : 'complete',
    references: expect.arrayContaining([expect.objectContaining({ kind: 'board', id: 'board-a' }),
      ...(profileSource === 'unavailable' ? [] : [expect.objectContaining({ kind: 'profile', id: 'profile-a' })]),
      expect.objectContaining({ kind: 'machine_pool', id: '11111111-1111-4111-8111-111111111111' }),
      expect.objectContaining({ kind: 'workflow_assignment', id: 'workflow-assignment-a' })]) } });
  if (profileSource === 'unavailable') expect(preview).toMatchObject({ machineReferences: { unavailable: ['profiles'] } });
  expect(JSON.stringify(preview)).not.toContain('unrelated-');
  for (const [url, options] of network.mock.calls) {
    expect(new URL(url).origin, diagnostics()).toBe('https://home-a.example');
    expect(options?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
  }
  for (const [url, , options] of outward.mock.calls) {
    expect(new URL(url).origin, diagnostics()).toBe('https://home-a.example');
    expect(options?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
  }
});
