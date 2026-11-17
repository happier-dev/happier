import { expect, it } from 'vitest';
import { createActionExecutor, getActionSpec } from '@happier-dev/protocol';
import { ProfileRecordV1Schema, buildProfilePhysicalKey, sealProfileRecordContentV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createLightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../server/sources/app/api/testkit/sqliteFastify';
import { accountRoutes } from '../../../../server/sources/app/api/routes/account/accountRoutes';
import { artifactsRoutes } from '../../../../server/sources/app/api/routes/artifacts/artifactsRoutes';
import type { Fastify } from '../../../../server/sources/app/api/types';
import { auth } from '../../../../server/sources/app/auth/auth';
import { db } from '../../../../server/sources/storage/db';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createCliProfileStore } from './profileStore';
import { AIBackendProfileSchema } from '@happier-dev/protocol/profiles/backendProfileSchema';
import { createCliProfileActionExecuteV1 } from '@/session/actions/cliActionDeps/createCliProfileActionDeps';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';

it('refuses an unknown launch Profile through real admission and MCP without reading remembered builtin visibility', async () => {
  const database = await createLightSqliteHarness({ tempDirPrefix: 'happier-profile-admission-', initAuth: true, initEncrypt: true });
  const server = createAuthenticatedTestApp({ authentication: 'real' }) as Fastify;
  try {
    const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 7 } });
    const credentials = { token: await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' }), encryption: null };
    const reads: string[] = [];
    server.addHook('onRequest', async (request, reply) => {
      reads.push(`${request.method} ${request.url}`);
      // Unrelated remembered builtin evidence is an unavailable HTTP boundary.
      if (request.url.includes('authoring-memory')) return reply.code(503).send();
    });
    accountRoutes(server);
    artifactsRoutes(server);
    const origin = await server.listen({ port: 0, host: '127.0.0.1' });
    await runWithServerHttpBaseUrl(origin, async () => {
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      const diagnostics: { phase: string; elapsedMs?: number }[] = [];
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
        profileActionExecute: createCliProfileActionExecuteV1({ credentials, serverId: 'profile-home', serverHttpBaseUrl: origin,
          callMachineAction: async () => { throw new Error('Unknown Profile must not reach the Machine'); } }),
      });
      const bridge = createActionToolExecutorBridge({ surface: 'agent',
        resolveCallerPermissionMode: () => 'default',
        resolveActiveTurnPermissionWitness: () => ({ turnId: 'profile-turn',
          causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } }),
        executor: { execute: (actionId, input, context) => executor.execute(actionId, input, { ...context,
          serverId: 'profile-home', runtimeAccountId: account.id,
          actionCaller: { kind: 'session', sessionId: 'profile-parent', starterDepth: 0, turnDepth: 0 },
          recordActionStartDiagnostic: diagnostic => diagnostics.push(diagnostic),
        }) },
      });
      const tools = new Map<string, (args: unknown, extra?: unknown) => Promise<unknown>>();
      registerHappierMcpBuiltInTools({ registerTool: (name, _metadata, handler) => { tools.set(name, handler); } }, {
        sessionId: 'profile-parent', surface: 'agent', deps: { ...bridge,
          resolveActionOptions: input => bridge.resolveActionOptions(input, 'profile-parent'),
          changeTitle: async () => { throw new Error('Unexpected title mutation'); } },
      });
      const execute = tools.get('action_execute');
      if (!execute) throw new Error('Missing real MCP Action registration');
      const response = CallToolResultSchema.parse(await execute({ actionId: 'session.spawn_new', input: {
        creationKey: 'unknown-profile-child', profileId: 'qa-r37g-no-such-profile',
        executionTarget: { serverId: 'profile-home', machineId: 'profile-machine' },
        directory: { kind: 'path', path: '/workspace' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      } }));
      const text = response.content.find(block => block.type === 'text');
      if (text?.type !== 'text') throw new Error('Missing MCP result text');
      expect({ isError: response.isError, result: JSON.parse(text.text) }).toEqual({ isError: true,
        result: { errorCode: 'target_unavailable', error: 'target_unavailable',
          details: { code: 'target_unavailable', reason: 'profile_unavailable' } } });
      expect(ActionExecuteFailureSchema.safeParse({ ok: false, ...JSON.parse(text.text) }).success).toBe(true);
      expect(reads.some(path => path.includes('/entity-rows/profiles'))).toBe(true);
      expect(reads.filter(path => path.includes('authoring-memory'))).toEqual([]);
      expect(diagnostics.filter(item => item.phase === 'agent_start_context' && item.elapsedMs !== undefined)).toEqual([]);
      expect(await db.session.count({ where: { accountId: account.id } })).toBe(0);
      const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'profile-home' };
      expect(await executor.execute('launch_profiles.read', { id: 'qa-r37g-no-such-profile' }, context))
        .toMatchObject({ ok: true, result: { status: 'invalid', reason: 'profile-not-found', id: 'qa-r37g-no-such-profile' } });
      expect(reads.filter(path => path.includes('authoring-memory'))).toEqual([]);
      // Real builtins still require remembered visibility; its failure must not
      // be misreported as evidence that the builtin does not exist.
      await expect(executor.execute('launch_profiles.read', { id: 'azure-openai' }, context))
        .resolves.toMatchObject({ ok: false, errorCode: 'action_failed' });
      expect(reads.some(path => path.includes('authoring-memory'))).toBe(true);
    });
  } finally {
    resetActiveAccountSettingsSnapshotForTests();
    await server.close(); await database.close();
  }
}, 120_000);

it('saves a retained 0.2-shaped Profile and deletes it through the real Action binding, HTTP catalog and SQLite tombstone', async () => {
  const database = await createLightSqliteHarness({ tempDirPrefix: 'happier-profile-actions-', initAuth: true, initEncrypt: true });
  const server = createAuthenticatedTestApp({ authentication: 'real' }) as Fastify;
  try {
    const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 7 } });
    const credentials = { token: await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' }), encryption: null };
    // The unversioned definition is the predecessor AIBackendProfile writer's shape
    // (../0.2 packages/protocol/src/profiles/backendProfileSchema.ts); its row is current custody.
    const record = ProfileRecordV1Schema.parse({ v: 1, id: 'legacy-review', enabled: true, secretBindings: { MASKED: null },
      definition: { kind: 'legacy', profile: AIBackendProfileSchema.parse({ id: 'legacy-review', name: 'Frontend review',
        environmentVariables: [], compatibility: { claude: true }, createdAt: 1, updatedAt: 1 }) }, skillSeeds: ['kept-seed'],
      promptStack: [
        { id: 'consumed', enabled: true, skillMigrationV1: true, placement: 'skill_instructions', ref: { kind: 'bundle', artifactId: 'missing-consumed' } },
        { id: 'disabled', enabled: false, placement: 'skill_instructions', ref: { kind: 'bundle', artifactId: 'missing-disabled' } },
      ] });
    const key = buildProfilePhysicalKey(record.id);
    await db.userKVStore.create({ data: { accountId: account.id, key, version: 1,
      value: new TextEncoder().encode(JSON.stringify(sealProfileRecordContentV1({ mode: 'plain', material: null, record }))) } });
    const memoryRequests: string[] = [];
    const settingsRequests: string[] = [];
    server.addHook('onRequest', async request => {
      if (request.url.includes('/authoring-memory/lastUsedProfile')) memoryRequests.push(request.method);
      if (request.url.includes('/account/settings')) settingsRequests.push(request.method);
    });
    accountRoutes(server);
    artifactsRoutes(server);
    const origin = await server.listen({ port: 0, host: '127.0.0.1' });
    await runWithServerHttpBaseUrl(origin, async () => {
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
        profileActionExecute: createCliProfileActionExecuteV1({ credentials, serverId: 'profile-home', serverHttpBaseUrl: origin,
          callMachineAction: async () => { throw new Error('Unexpected Machine boundary'); } }),
      });
      const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'profile-home' };
      const read = await executor.execute('launch_profiles.read', { id: record.id }, context);
      expect(read.ok, JSON.stringify(read)).toBe(true);
      const opened = getActionSpec('launch_profiles.read').outputSchema.parse(read.ok ? read.result : undefined);
      if (opened.status !== 'present' || !('revision' in opened)) throw new Error('Expected the captured legacy row');
      const saved = await executor.execute('launch_profiles.save', { id: record.id, expectedRevision: opened.revision,
        profile: { ...opened.profile, name: 'Frontend review saved', updatedAt: 2 } }, context);
      expect(saved).toMatchObject({ ok: true, result: { status: 'updated', id: record.id, revision: 2 } });
      expect(getActionSpec('launch_profiles.save').outputSchema.safeParse(saved.ok ? saved.result : undefined).success).toBe(true);
      const store = createCliProfileStore({ credentials });
      expect(await store.readProfileCatalog({ migrateSkills: true })).toMatchObject({ status: 'ready', records: [{ revision: 2,
        record: { skillSeeds: record.skillSeeds, promptStack: record.promptStack, secretBindings: record.secretBindings,
          definition: { kind: 'legacy', profile: { name: 'Frontend review saved' } } } }] });
      const { createAuthoringMemoryClient } = await import('@/settings/authoringMemory/createAuthoringMemoryClient');
      const memory = await createAuthoringMemoryClient({ credentials });
      expect(await memory.mutate('lastUsedProfile', 'absent', memory.seal('lastUsedProfile', 42)))
        .toMatchObject({ status: 'updated' });
      memoryRequests.length = 0;
      settingsRequests.length = 0;
      expect(await executor.execute('launch_profiles.select', { id: null }, context))
        .toMatchObject({ ok: false, errorCode: 'action_failed' });
      expect(memoryRequests).toEqual(['GET']);
      expect(settingsRequests).toEqual([]);
      const invalidRow = await memory.read('lastUsedProfile');
      if (invalidRow.status !== 'present') throw new Error('Expected the invalid current row to remain unchanged');
      expect(memory.open('lastUsedProfile', invalidRow.content)).toBe(42);
      await memory.mutate('lastUsedProfile', invalidRow.revision, memory.seal('lastUsedProfile', null));
      memoryRequests.length = 0;
      settingsRequests.length = 0;
      // R-NO-INTERMEDIATE: selection uses current memory directly, without a Settings import.
      expect(await executor.execute('launch_profiles.select', { id: null }, context))
        .toMatchObject({ ok: true, result: { status: 'selected', id: null } });
      expect(memoryRequests).toEqual(['GET', 'POST']);
      expect(settingsRequests).toEqual([]);
      memoryRequests.length = 0;
      settingsRequests.length = 0;
      const removed = await executor.execute('launch_profiles.delete', { id: record.id, expectedRevision: 2 }, {
        ...context, presentUserConfirmation: { actionId: 'launch_profiles.delete' },
      });
      expect(memoryRequests).toEqual(['GET']);
      // Catalog preference reads are distinct; deleting a Profile never retires Settings memory.
      expect(settingsRequests).not.toContain('POST');
      expect(removed).toMatchObject({ ok: true, result: { status: 'updated', id: record.id, revision: 3 } });
      expect(getActionSpec('launch_profiles.delete').outputSchema.safeParse(removed.ok ? removed.result : undefined).success).toBe(true);
      for (let pass = 0; pass < 2; pass++) expect(await store.readProfileCatalog({ migrateSkills: true })).toMatchObject({
        status: 'ready', records: [], tombstones: [{ id: record.id, revision: 3 }],
      });
      const row = await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key } } });
      expect(row).toMatchObject({ version: 3, value: null });
      expect(await executor.execute('launch_profiles.save', { id: record.id, expectedRevision: 2,
        profile: opened.profile }, context)).toMatchObject({ ok: true, result: { status: 'conflict' } });
      expect((await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key } } })).value).toBeNull();
    });
  } finally {
    resetActiveAccountSettingsSnapshotForTests();
    await server.close(); await database.close();
  }
}, 120_000);

it('loads disabled unavailable Profile custody through real authenticated HTTP and SQLite without a seed or write', async () => {
  const database = await createLightSqliteHarness({ tempDirPrefix: 'happier-b1fix-c-profile-', initAuth: true, initEncrypt: true });
  const server = createAuthenticatedTestApp({ authentication: 'real' }) as Fastify;
  try {
    const account = await db.account.create({ data: { encryptionMode: 'plain', settingsVersion: 7 } });
    const credentials = { token: await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' }), encryption: null };
    const record = ProfileRecordV1Schema.parse({ v: 1, id: 'retained-profile', enabled: true, secretBindings: {},
      definition: { kind: 'inline', profile: { v: 2, id: 'retained-profile', name: 'Retained', createdAt: 1, updatedAt: 1 } },
      promptStack: [{ id: 'disabled', enabled: false, placement: 'skill_instructions', ref: { kind: 'bundle', artifactId: 'missing' } }] });
    const key = buildProfilePhysicalKey(record.id);
    const encode = (value: typeof record) => new TextEncoder().encode(JSON.stringify(sealProfileRecordContentV1({ mode: 'plain', material: null, record: value })));
    await db.userKVStore.create({ data: { accountId: account.id, key, version: 1, value: encode(record) } });
    let artifactReads = 0; let mutations = 0;
    server.addHook('onRequest', async request => {
      if (request.url.startsWith('/v1/artifacts/')) artifactReads++;
      if (request.method === 'POST' && request.url.startsWith('/v1/account/entity-rows/profiles')) mutations++;
    });
    accountRoutes(server);
    artifactsRoutes(server);
    const origin = await server.listen({ port: 0, host: '127.0.0.1' });
    await runWithServerHttpBaseUrl(origin, async () => {
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      const store = createCliProfileStore({ credentials });
      expect(await store.readProfileCatalog({ migrateSkills: true })).toMatchObject({ status: 'ready',
        records: [{ revision: 1, record: { skillSeeds: [], promptStack: record.promptStack } }] });
      expect(artifactReads).toBe(0); expect(mutations).toBe(0);
      expect((await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key } } })).version).toBe(1);
      // Retained data becomes decision-material only when the entry is enabled.
      const enabled = ProfileRecordV1Schema.parse({ ...record, promptStack: record.promptStack.map(entry => ({ ...entry, enabled: true })) });
      await db.userKVStore.update({ where: { accountId_key: { accountId: account.id, key } }, data: { value: encode(enabled), version: 2 } });
      expect(await store.readProfileCatalog({ migrateSkills: true })).toEqual({ status: 'unavailable', reason: 'invalid-stored-content' });
      expect(artifactReads).toBe(1); expect(mutations).toBe(0);
    });
  } finally {
    resetActiveAccountSettingsSnapshotForTests();
    await server.close(); await database.close();
  }
}, 120_000);
