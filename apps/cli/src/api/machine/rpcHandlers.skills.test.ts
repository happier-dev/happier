import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createActionExecutor, type ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveMachineRpcRoutePolicy, resolveMachineRpcExternalActionEffectV1 } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1, SkillFoundListResultV1Schema, SkillMachineInstallResultV1Schema, SkillMachineUninstallResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRecordV1Schema, buildPromptLibraryPhysicalKeyV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../server/sources/app/api/testkit/sqliteFastify';
import { accountRoutes } from '../../../../server/sources/app/api/routes/account/accountRoutes';
import { artifactsRoutes } from '../../../../server/sources/app/api/routes/artifacts/artifactsRoutes';
import type { Fastify } from '../../../../server/sources/app/api/types';
import { auth } from '../../../../server/sources/app/auth/auth';
import { db } from '../../../../server/sources/storage/db';
import { inTx } from '../../../../server/sources/storage/inTx';
import { resolveMachineAdmission, setMachineAccessGrantInTx } from '../../../../server/sources/app/machines/machineAccess';
import { eventRouter } from '../../../../server/sources/app/events/connectionEventRouter';
import { getAccountStoredContentV3SocketRoom } from '../../../../server/sources/app/api/socketRooms';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { createMachineSkillActions } from '@/prompts/skills/machineInstall/machineSkillActions';
import { createMachineSkillActionExecutor } from '@/prompts/skills/machineInstall/machineSkillActionExecutor';
import { makeShareEligibleForTest } from '../../../../server/sources/testkit/shareEligibility.testkit';
import { ApiMachineClient } from '../apiMachine';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { registerMachineSkillsRpcHandlers } from './rpcHandlers.skills';
import { registerMachinePromptAssetTransferRpcHandlers } from './rpcHandlers.promptAssetTransfers';

let database: LightSqliteHarness;
const nativeHome = vi.hoisted(() => ({ path: null as string | null }));
// Native home lookup is the OS boundary; keep the real host, catalog, Account and install owners.
vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, homedir: () => nativeHome.path ?? os.homedir() };
});
beforeAll(async () => { database = await createLightSqliteHarness({ tempDirPrefix: 'happier-p3f-install-seam-', initAuth: true, initEncrypt: true }); }, 120_000);
afterAll(async () => { await database?.close(); });

it('scans, reads, adopts and installs through registered Actions and transfers with authenticated HTTP, SQLite and Socket.IO', async () => {
  const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 7 } });
  const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
  for (const key of PromptLibraryCatalogKeyV1Schema.options) await db.userKVStore.create({ data: {
    accountId: account.id, key: buildPromptLibraryPhysicalKeyV1(key), version: 0,
    value: new TextEncoder().encode(JSON.stringify({ t: 'plain', v: emptyPromptLibraryRecordV1(key) })),
  } });
  const credentials = { token: await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' }), encryption: null };
  const server = createAuthenticatedTestApp({ authentication: 'real' }) as Fastify;
  accountRoutes(server);
  artifactsRoutes(server);
  const sockets = new Server(server.server, { path: '/v1/updates' });
  sockets.use((socket, next) => {
    void (async () => {
      const token: unknown = socket.handshake.auth.token;
      const verified = typeof token === 'string' ? await auth.verifyTokenForRoute(token) : null;
      if (!verified || verified.userId !== account.id) return next(new Error('Unauthorized'));
      await socket.join(getAccountStoredContentV3SocketRoom(verified.userId)); next();
    })().catch(next);
  });
  eventRouter.setIo(sockets);
  const serverUrl = await server.listen({ port: 0, host: '127.0.0.1' });
  const observer = connect(serverUrl, { path: '/v1/updates', transports: ['websocket'], auth: { token: credentials.token }, reconnection: false });
  const wakes: unknown[] = [];
  observer.on('update', event => { wakes.push(event); });
  await new Promise<void>((resolve, reject) => { observer.once('connect', resolve); observer.once('connect_error', reject); });
  const releaseHome = publishServerHttpRuntimeOrigin(serverUrl, 'https');
  const home = join(database.baseDir, 'native-home');
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL']);
  env.patch({ HAPPIER_HOME_DIR: join(home, '.happier'), HAPPIER_ACTIVE_SERVER_ID: undefined, HAPPIER_SERVER_URL: undefined });
  nativeHome.path = home;
  reloadConfiguration();
  const profile = await addServerProfile({ name: 'skill-seam', serverUrl, webappUrl: serverUrl });
  await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
    v: 1, homeServerIdentityId: 'srv_seam', canonicalServerUrl: serverUrl, revision: 1, endpoints: [{ kind: 'https', url: serverUrl }],
  } });
  env.patch({ HAPPIER_ACTIVE_SERVER_ID: profile.id, HAPPIER_SERVER_URL: serverUrl });
  reloadConfiguration();
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
    loadedAtMs: Date.now(), settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
  const machineClient = new ApiMachineClient(await auth.createToken(custodian.id, undefined, { kind: 'account', authority: 'present_user' }), { id: 'machine', encryptionMode: 'plain',
    metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
  const snapshot = getActiveAccountSettingsSnapshot();
  if (!snapshot) throw new Error('Requester snapshot missing');
  const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, snapshot,
    serverHttpBaseUrl: serverUrl, isCurrent: async () => true,
    machineAdmission: { actorAccountId: account.id, custodianAccountId: custodian.id, role: 'manage' } });
  const agents = [{ agentId: 'codex', nativeRoots: { user: [['.agents', 'skills']],
    plugin: [['.codex', 'plugins', 'cache', '*', '{plugin}', '*', 'skills']] } }];
  const store = createCliApprovalsArtifactStore({ credentials, serverId: 'srv_seam', getAccountEncryptionMode: async () => 'plain' });
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), skillMachineActionExecute: machineClient.createMachineSkillActionExecutor({ credentials, operationContext }) });
  let confirmation: ActionExecutorContext['presentUserConfirmation'];
  const manager = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
  // Human confirmation is a UI/transport boundary fact, not a public RPC input or a fake policy decision.
  registerMachineSkillsRpcHandlers({ rpcHandlerManager: manager, actionExecutor: {
    execute: (id, input, context) => executor.execute(id, input, { ...context, ...(confirmation ? { presentUserConfirmation: confirmation } : {}) }),
  } });
  const transfers = registerMachinePromptAssetTransferRpcHandlers({ rpcHandlerManager: manager,
    foundSkills: { home, agents } });
  const accountExecutor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials,
    serverId: 'srv_seam', serverIdentityId: 'srv_seam', serverHttpBaseUrl: serverUrl,
    sessionId: 'account-client', mode: 'plain', ctx: null,
    machineActionDirectTargetTransport: { machineId: 'machine', invoke: (method, input, options) => manager.invokeLocal(method, input, options) },
  }));
  const context = { localActionContext: { surface: 'ui' as const, authority: 'present_user' as const } };
  const readReceiptRow = async () => {
    const row = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key: buildPromptLibraryPhysicalKeyV1('external-links') } } });
    const envelope: unknown = JSON.parse(new TextDecoder().decode(row.value!));
    if (!envelope || typeof envelope !== 'object' || !('t' in envelope) || envelope.t !== 'plain' || !('v' in envelope)) throw new Error('Wrong Account envelope');
    const record = PromptLibraryRecordV1Schema.parse(envelope.v);
    if (record.key !== 'external-links') throw new Error('Wrong receipt owner');
    return { revision: row.version, links: record.value.links, raw: envelope.v };
  };
  try {
    await db.machine.create({ data: { id: 'machine', accountId: custodian.id, installationId: 'install', active: true,
      metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: home, happyHomeDir: join(home, '.happier') }),
      daemonState: encodePlainMachineStoredContent({ status: 'running' }), dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
    await makeShareEligibleForTest(custodian.id, account.id);
    expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: 'machine', principal: { kind: 'account', accountId: account.id }, level: 'admin' }))).toMatchObject({ kind: 'saved' });
    for (const level of ['view', 'admin'] as const) {
      const guest = await db.account.create({ data: { encryptionMode: 'plain' } });
      await makeShareEligibleForTest(custodian.id, guest.id);
      expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: 'machine', principal: { kind: 'account', accountId: guest.id }, level }))).toMatchObject({ kind: 'saved' });
      for (const actionId of ['skills.machine.install', 'skills.machine.uninstall']) {
        expect(await resolveMachineAdmission({ actorAccountId: guest.id, machineId: 'machine', actionId })).toMatchObject(level === 'admin'
          ? { kind: 'admitted', role: 'manage', custodianAccountId: custodian.id } : { kind: 'denied', code: 'access_denied' });
        expect(await resolveMachineAdmission({ actorAccountId: account.id, machineId: 'machine', actionId })).toMatchObject({ kind: 'admitted', custodianAccountId: custodian.id });
      }
    }
    for (const actionId of ['skills.machine.install', 'skills.machine.uninstall'] as const) {
      const method = getActionSpec(actionId).bindings?.rpcMethod;
      if (!method) throw new Error('Machine skill Action has no registered method');
      expect(resolveMachineRpcRoutePolicy(method)).toMatchObject({ routeClass: 'server_required',
        serverRequiredReason: 'destructive_or_recovery_mutation', rpcClassification: 'action_spec_bound',
        actionSpecId: actionId, sharedMachineAccess: 'manage', commandReceiptRequired: false });
      expect(resolveMachineRpcExternalActionEffectV1(method)).toBe(actionId);
    }
    const reply = await manager.invokeLocal('skills.machine.install', { skillId: 'happier:happier', machineId: 'machine', agents: ['codex'] }, context);
    expect(reply).toHaveProperty('receipts');
    const installed = SkillMachineInstallResultV1Schema.parse(reply);
    expect(installed.receipts).toHaveLength(1);
    const path = installed.receipts[0]!.path;
    expect(readFileSync(join(path, 'SKILL.md'), 'utf8')).toContain('happier');
    expect(statSync(path).isDirectory()).toBe(true);
    const receiptRow = await readReceiptRow();
    expect(await db.userKVStore.count({ where: { accountId: custodian.id } })).toBe(0);
    expect(receiptRow.links).toMatchObject([{ artifactId: 'happier:happier', machineId: 'machine', lastExternalDigest: installed.receipts[0]!.digest }]);
    expect(receiptRow.raw).not.toHaveProperty('value.links.0.syncMode');
    const pluginPath = join(home, '.codex', 'plugins', 'cache', 'market', 'fixture', '1', 'skills', 'happier');
    mkdirSync(join(pluginPath, 'scripts'), { recursive: true });
    writeFileSync(join(pluginPath, 'SKILL.md'), '---\nname: happier\ndescription: A plugin copy\n---\nPlugin instructions');
    const scriptPath = join(pluginPath, 'scripts', 'run.sh');
    writeFileSync(scriptPath, '#!/bin/sh\nprintf plugin\n');
    chmodSync(scriptPath, 0o755);
    const found = SkillFoundListResultV1Schema.parse(await manager.invokeLocal('skills.found.list', { machineId: 'machine' }, context));
    expect(found.items).toMatchObject([{ name: 'happier', path, scope: 'user', agents: expect.arrayContaining(['codex']),
      inLibrary: null, masksLibrary: true, happierInstalled: true, pluginOwned: null },
      { name: 'happier', path: pluginPath, scope: 'plugin', agents: ['codex'], inLibrary: null,
        masksLibrary: false, happierInstalled: false, pluginOwned: { pluginName: 'fixture' } }]);
    const beforeRead = await db.artifact.count({ where: { accountId: account.id } });
    const read = await accountExecutor.execute('skills.found.read', { machineId: 'machine', path: pluginPath }, { surface: 'ui', authority: 'present_user' });
    if (!read.ok) throw new Error(read.errorCode);
    expect(read.ok).toBe(true);
    const content = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.found.read'].parse(read.result);
    expect(content.files).toContainEqual(expect.objectContaining({ path: 'scripts/run.sh', unixMode: statSync(scriptPath).mode & 0o7777 }));
    expect(await db.artifact.count({ where: { accountId: account.id } })).toBe(beforeRead);
    await vi.waitFor(() => expect(wakes).toContainEqual(expect.objectContaining({ body: { t: 'account-change' } })));
    const beforeAdoptWakeCount = wakes.length;
    const adopted = await accountExecutor.execute('skills.found.adopt', { machineId: 'machine', items: [{ name: 'happier', path: pluginPath }] }, { surface: 'ui', authority: 'present_user' });
    if (!adopted.ok) throw new Error(adopted.errorCode);
    expect(adopted.ok).toBe(true);
    const acknowledgement = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.found.adopt'].parse(adopted.result);
    expect(acknowledgement.skillIds).toHaveLength(1);
    expect(acknowledgement.incomplete).toBeUndefined();
    const skillId = acknowledgement.skillIds[0]!;
    const rulesRow = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key: buildPromptLibraryPhysicalKeyV1('skill-rules') } } });
    const rulesEnvelope: unknown = JSON.parse(new TextDecoder().decode(rulesRow.value!));
    if (!rulesEnvelope || typeof rulesEnvelope !== 'object' || !('t' in rulesEnvelope) || rulesEnvelope.t !== 'plain' || !('v' in rulesEnvelope)) throw new Error('Wrong rules envelope');
    const rules = PromptLibraryRecordV1Schema.parse(rulesEnvelope.v);
    expect(rules).toMatchObject({ key: 'skill-rules', value: { rules: expect.arrayContaining([
      expect.objectContaining({ skillId, target: { t: 'allMachines' }, enabled: true }),
    ]) } });
    const copied = await store.promptLibraryStore.read(skillId);
    expect(copied?.header).toMatchObject({ kind: 'prompt_bundle.v2', skillLock: { provenance: { kind: 'machine', machineId: 'machine', path: pluginPath, agentIds: ['codex'] } } });
    const afterAdopt = SkillFoundListResultV1Schema.parse(await manager.invokeLocal('skills.found.list', { machineId: 'machine' }, context));
    expect(afterAdopt.items.find(item => item.path === pluginPath)).toMatchObject({ inLibrary: skillId, masksLibrary: false, happierInstalled: false });
    expect(await db.artifact.count({ where: { accountId: account.id } })).toBe(beforeRead + 1);
    expect(readFileSync(join(pluginPath, 'SKILL.md'), 'utf8')).toContain('Plugin instructions');
    expect(readFileSync(scriptPath, 'utf8')).toBe('#!/bin/sh\nprintf plugin\n');
    await vi.waitFor(() => expect(wakes.slice(beforeAdoptWakeCount)).toContainEqual(expect.objectContaining({ body: { t: 'account-change' } })));
    const revision = (await readReceiptRow()).revision;
    expect(await manager.invokeLocal('skills.machine.install', { skillId: 'happier:happier', machineId: 'foreign' }, context)).toMatchObject({ errorCode: 'machine_target_mismatch' });
    expect((await readReceiptRow()).revision).toBe(revision);
    expect(await manager.invokeLocal('skills.machine.uninstall', { skillId: 'happier:happier', machineId: 'machine' }, context)).toMatchObject({ errorCode: 'approvals_not_supported' });
    expect(existsSync(path)).toBe(true);
    confirmation = { actionId: 'skills.machine.uninstall' };
    const removed = SkillMachineUninstallResultV1Schema.parse(await manager.invokeLocal('skills.machine.uninstall', { skillId: 'happier:happier', machineId: 'machine' }, context));
    expect(removed.removed).toEqual([path]);
    expect(existsSync(path)).toBe(false);
    expect((await readReceiptRow()).links).toEqual([]);

    const conflictPath = join(home, '.conflicting', 'skills', basename(path));
    mkdirSync(conflictPath, { recursive: true });
    writeFileSync(join(conflictPath, 'SKILL.md'), 'native owner content');
    const partialService = createMachineSkillActions({ store: store.promptLibraryStore, readPluginSkills: store.readPluginSkills,
      target: { machineId: 'machine', serverIdentityId: 'srv_seam' }, libraryServerIdentityId: 'srv_seam',
      homeDirectory: home, happierHomeDirectory: join(home, '.happier'),
      agents: [{ agentId: 'codex', nativeRoots: { user: [['.agents', 'skills']] } },
        { agentId: 'claude', nativeRoots: { user: [['.conflicting', 'skills']] } }],
      readInstalledAgents: async () => ['codex', 'claude'] });
    const partialExecutor = createActionExecutor({
      ...createUnavailableActionTransportDeps(),
      skillMachineActionExecute: createMachineSkillActionExecutor({ machineId: 'machine', service: partialService }),
    });
    const partialManager = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain' });
    registerMachineSkillsRpcHandlers({ rpcHandlerManager: partialManager, actionExecutor: partialExecutor });
    const partialFailure = ActionExecuteFailureSchema.parse(await partialManager.invokeLocal('skills.machine.install',
      { skillId: 'happier:happier', machineId: 'machine', agents: ['codex', 'claude'] }, context));
    expect(partialFailure.errorCode).toBe('native_conflict');
    const acknowledged = SkillMachineInstallResultV1Schema.parse(partialFailure.details);
    expect(acknowledged.receipts).toHaveLength(1);
    expect(acknowledged.receipts[0]?.path).toBe(path);
    expect(readFileSync(join(path, 'SKILL.md'), 'utf8')).toContain('happier');
    expect(readFileSync(join(conflictPath, 'SKILL.md'), 'utf8')).toBe('native owner content');
    expect((await readReceiptRow()).links).toMatchObject([{ lastExternalDigest: acknowledged.receipts[0]!.digest }]);
  } finally { await machineClient.shutdown(); await transfers.dispose(); resetActiveAccountSettingsSnapshotForTests(); releaseHome(); observer.disconnect(); eventRouter.clearIo(); await sockets.close(); await server.close(); nativeHome.path = null; env.restore(); reloadConfiguration(); }
});
