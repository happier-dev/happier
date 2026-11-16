import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import nacl from 'tweetnacl';
import { ActionsSettingsV1Schema, createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeMachineOwnerEnvelopeFingerprintV1 } from '@happier-dev/protocol/machines/machineOwnerEnvelopeFingerprintV1';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountServerActionDeps } from './accountServerActionDeps';
import { createCliActionInventoryDeps } from '@/session/actions/cliActionDeps/createCliActionInventoryDeps';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { listBuiltInHappierTools } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { dispatchBuiltInHappierTool } from '@/agent/tools/happierTools/dispatchBuiltInHappierTool';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createChangeTitleToolHandler } from '@/agent/tools/happierTools/createChangeTitleToolHandler';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { addServerProfile, getServerProfile, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { readStoredCredentials, readStoredCredentialsForServerId, updateSettings, writeCredentialsTokenOnlyForServerId } from '@/persistence';
import { resolveActionCliCredentialTarget } from '@/cli/actions/actionServerTarget';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { handleActionsCommand } from '@/cli/commands/actions';
import { seedTestServerProfile } from '@/testkit/serverProfiles';

let app: FastifyInstance | undefined;
let restore: (() => void) | undefined;
afterEach(async () => { restore?.(); restore = undefined; await app?.close(); app = undefined; });

describe('Machine access headless Action transport', () => {
  it('dispatches CLI machines.list for the owner beside key-pending Machines with withheld metadata', async () => {
    await withTempDir('machine-inventory-dispatch-', async home => {
      const scope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
      const previousExitCode = process.exitCode;
      let restoreStdout: (() => void) | undefined;
      try {
        scope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: undefined, HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
        reloadConfiguration();
        const serverId = 'inventory-dispatch-home';
        const homeId = 'srv_inventory_dispatch';
        const origin = 'https://inventory-dispatch.example.test';
        await seedTestServerProfile({ id: serverId, homeId, serverUrl: origin });
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob', session: 'fixture-inventory-owner' })).toString('base64url')}.signature`;
        const secret = new Uint8Array(32).fill(9);
        const credentials = { token, encryption: { type: 'legacy' as const, secret } };
        const codec = createMachineContentCodec({ encryptionMode: 'e2ee', encryptionVariant: 'legacy', encryptionKey: secret });
        const access = { custodian: { accountId: 'bob', displayName: 'Bob' }, role: 'manage', resourceMode: 'e2ee', accessState: 'ready' };
        const own = MachinePublishedRowV1Schema.parse({ id: 'own-machine', managedMachineRef: null,
          metadata: codec.encodeStored(MachinePublishedMetadataV1Schema.parse({ host: 'own-computer', platform: 'linux',
            happyCliVersion: 'test', homeDir: '/home/bob', happyHomeDir: '/home/bob/.happier' })),
          metadataVersion: 1, daemonState: null, daemonStateVersion: 0, storageMode: 'e2ee', access,
          active: true, activeAt: Date.now(), revokedAt: null, replacedByMachineId: null });
        const pending = MachinePublishedRowV1Schema.parse({ ...own, id: 'shared-key-pending', metadata: null,
          access: { ...access, custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', accessState: 'key_pending' } });
        app = fastify();
        let inventoryReads = 0;
        app.get('/v1/machines', async request => {
          expect(request.headers.authorization).toBe(`Bearer ${token}`);
          inventoryReads++;
          return [pending, own];
        });
        await app.ready();
        restore = installAxiosFastifyAdapter({ app, origin });
        let output = '';
        // HTTP, stored credentials and stdout are the boundaries; CLI binding,
        // credentialed dispatch, inventory parsing and content opening stay real.
        const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...rest: unknown[]) => {
          output += String(chunk);
          // Both write overloads end with an optional completion callback.
          rest.find((value): value is () => void => typeof value === 'function')?.();
          return true;
        });
        restoreStdout = () => stdout.mockRestore();
        await handleActionsCommand(['invoke', 'machines.list', '--server-id', serverId,
          '--input-json', JSON.stringify({ serverId: homeId }), '--request-id', 'net-inventory-dispatch', '--json'], {
          readCredentialsFn: async () => credentials,
          readCredentialsForServerIdFn: async requested => requested === serverId ? credentials : null,
        });
        expect(JSON.parse(output), output).toMatchObject({ ok: true, data: { items: [
          { serverId: homeId, machineId: pending.id, access: { accessState: 'key_pending' } },
          { serverId: homeId, machineId: own.id, label: 'own-computer', access: { role: 'manage', accessState: 'ready' } },
        ] } });
        expect(inventoryReads).toBe(1);
      } finally {
        restoreStdout?.(); process.exitCode = previousExitCode;
        scope.restore(); reloadConfiguration();
      }
    });
  });
  it.each(['alice', 'bob'])('executes the presence setup dependency for owner/Manage requester %s', async accountId => {
    app = fastify();
    const transitions = { v: 1, revision: 2, offline: null, online: { revision: 2, occurredAt: 1000 } };
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    app.get('/v1/machines/machine/presence', async request => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      expect(request.query).toEqual({});
      return { kind: 'present', machineId: 'machine', transitions };
    });
    await app.ready();
    restore = installAxiosFastifyAdapter({ app, origin: 'http://access.test' });
    const executor = createActionExecutor({
      ...createAccountServerActionDeps({ token, serverId: 'home', serverHttpBaseUrl: 'http://access.test' }),
    } as unknown as ActionExecutorDeps);
    expect(await executor.execute('machines.presence.read', { serverId: 'home', machineId: 'machine' }, {
      surface: 'cli', authority: 'present_user', serverId: 'home', runtimeAccountId: accountId,
    })).toEqual({ ok: true, result: { kind: 'present', machineId: 'machine', transitions } });
  });

  it.each(['https', 'local-dial-alias'] as const)('admits a portable Home target after preparing a restored profile without a saved descriptor (%s)', async basis => {
    await withTempDir('requester-machine-access-home-', async home => {
      const scope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
      try {
        scope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: undefined, HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
        reloadConfiguration();
        const serverUrl = basis === 'https' ? 'https://access.test' : 'http://happier-agent-qa-l12-c.localhost:3019';
        const dialUrl = basis === 'https' ? serverUrl : 'http://127.0.0.1:49933';
        const profile = await addServerProfile({ name: 'restored-profile', serverUrl, webappUrl: serverUrl,
          ...(dialUrl !== serverUrl ? { localServerUrl: dialUrl } : {}), use: true });
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'requester', session: 'fixture-restored-account' })).toString('base64url')}.signature`;
        await writeCredentialsTokenOnlyForServerId(profile.id, { token });
        reloadConfiguration();
        expect(await resolveServerProfileHomeIdentityId(profile.id)).toBeNull();
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
          expect(String(input)).toBe(`${dialUrl}/v1/features/authenticated`);
          expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
          return Response.json({ features: {},
          capabilities: { serverIdentity: { serverIdentityId: 'srv_requester_home' } },
          homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_requester_home', canonicalServerUrl: serverUrl,
            revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] } });
        }));
        const prepared = await resolveActionCliCredentialTarget({ requestedServerId: null, deps: {
          readCredentialsFn: readStoredCredentials, readCredentialsForServerIdFn: readStoredCredentialsForServerId,
          getServerProfileFn: getServerProfile,
        } });
        expect(prepared.serverIdentityId).toBe('srv_requester_home');
        expect(await resolveServerProfileHomeIdentityId(profile.id)).toBe('srv_requester_home');
        app = fastify();
        let reads = 0;
        app.get('/v1/machines/machine/access', async request => {
          expect(request.headers.authorization).toBe(`Bearer ${token}`);
          reads++;
          return { machineId: 'machine', custodian: { accountId: 'alice', displayName: 'Alice' },
            access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'plain', accessState: 'ready' },
            canManage: false, grants: [], ownDirectGrant: true, ownAccessSources: [] };
        });
        await app.ready();
        restore = installAxiosFastifyAdapter({ app, origin: dialUrl });
        const executor = createCliActionExecutorFromCredentials({ credentials: prepared.credentials!,
          serverId: profile.id, serverIdentityId: prepared.serverIdentityId, serverApiUrl: dialUrl,
          pluginActionExecutionOwner: 'current_process',
          actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) },
        });
        for (const serverId of [profile.id, 'srv_requester_home']) {
          const result = await executor.execute('machines.access.grants.list', { serverId: 'srv_requester_home', machineId: 'machine' },
            { surface: 'cli', authority: 'present_user', serverId });
          expect(result, JSON.stringify(result))
            .toMatchObject({ ok: true, result: { machineId: 'machine', canManage: false, access: { role: 'use', accessState: 'ready' } } });
        }
        expect(reads).toBe(2);
        expect(await executor.execute('machines.access.grants.list', { serverId: 'srv_other_home', machineId: 'machine' },
          { surface: 'cli', authority: 'present_user', serverId: profile.id }))
          .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
        await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
          [profile.id]: { ...settings.servers![profile.id], homeConnectionDescriptor: undefined, homeConnectionDescriptorAuthority: undefined },
        } }));
        expect(await executor.execute('machines.access.grants.list', { serverId: 'srv_requester_home', machineId: 'machine' },
          { surface: 'cli', authority: 'present_user', serverId: profile.id }))
          .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
        expect(reads).toBe(2);
      } finally { vi.unstubAllGlobals(); scope.restore(); reloadConfiguration(); }
    });
  });
  it('returns qualified accessible inventory through the incumbent captured-endpoint owner', async () => {
    app = fastify();
    app.get('/v1/machines', async request => {
      expect(request.headers.authorization).toBe('Bearer test-token');
      return [
        { id: 'local', metadata: JSON.stringify({ host: 'coordinator' }), active: true, revokedAt: null, replacedByMachineId: null },
        { id: 'remote', metadata: JSON.stringify({ host: 'remote-builder' }), active: true, revokedAt: null, replacedByMachineId: null },
        { id: 'shared', metadata: null, active: false, revokedAt: null, replacedByMachineId: null,
          access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'e2ee', accessState: 'key_pending' } },
      ];
    });
    await app.ready();
    restore = installAxiosFastifyAdapter({ app, origin: 'http://access.test' });
    const deps = createCliActionInventoryDeps({ token: 'test-token', sessionId: '', mode: 'plain', ctx: null });
    // These read Actions consume only inventory dependencies; all inventory and
    // option projection logic stays real beneath the HTTP boundary.
    const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
    const context = { surface: 'cli', authority: 'present_user', serverId: 'home' } as const;
    expect(await runWithServerHttpBaseUrl('http://access.test', () => executor.execute('machines.list', { serverId: 'home' }, context)))
      .toMatchObject({ ok: true, result: { items: [
        { serverId: 'home', machineId: 'local', label: 'coordinator', active: true },
        { serverId: 'home', machineId: 'remote', label: 'remote-builder', active: true },
        { serverId: 'home', machineId: 'shared', active: false, access: { accessState: 'key_pending' } },
      ] } });
    expect(await runWithServerHttpBaseUrl('http://access.test', () => executor.execute('action.options.resolve', {
      actionId: 'session.spawn_new', fieldPath: 'executionTarget.machineId',
      executionTarget: { serverId: 'home' },
    }, context))).toMatchObject({ ok: true, result: { options: [
      { value: 'local', label: 'coordinator' }, { value: 'remote', label: 'remote-builder' },
      { value: 'shared', label: 'shared' },
    ] } });
    expect(await runWithServerHttpBaseUrl('http://access.test', () => deps.machinesList({ serverId: 'home', refresh: true })))
      .toMatchObject({ items: expect.arrayContaining([
        expect.objectContaining({ serverId: 'home', machineId: 'shared', active: false, access: expect.objectContaining({ accessState: 'key_pending' }) }),
      ]) });
  });
  it('executes grant/set/remove and self leave through the declared qualified route', async () => {
    app = fastify();
    const principal = { kind: 'account', accountId: 'bob' } as const;
    const grant = { machineId: 'machine', principal, level: 'view' } as const;
    let saved = false;
    app.get('/v1/machines/machine/access', async request => {
      expect(request.query).toEqual({});
      return { machineId: 'machine', custodian: { accountId: 'alice', displayName: 'Alice' },
        access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
        canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [] };
    });
    app.put('/v1/machines/machine/access', async request => {
      expect(request.headers.authorization).toBe('Bearer test-token');
      expect(request.body).toEqual({ principal, level: 'view' });
      saved = true;
      return { kind: 'saved', grant, readiness: 'ready', canPrepareKeys: false };
    });
    app.delete('/v1/machines/machine/access', async request => {
      if (Object.keys(request.body as object).length === 0) return { kind: 'left', effectiveAccess: 'none' };
      expect(request.body).toEqual({ principal });
      saved = false;
      return { kind: 'removed', effectiveAccess: 'use' };
    });
    await app.ready();
    restore = installAxiosFastifyAdapter({ app, origin: 'http://access.test' });
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"machines.access.grants.list": Object.keys(ActionSurfaceSchema.shape), "machines.access.grant.set": Object.keys(ActionSurfaceSchema.shape), "machines.access.grant.remove": Object.keys(ActionSurfaceSchema.shape), "machines.access.leave": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }),
      ...createAccountServerActionDeps({ token: 'test-token', serverId: 'home', serverHttpBaseUrl: 'http://access.test' }),

    } as unknown as ActionExecutorDeps);
    const context = { surface: 'cli', authority: 'present_user', serverId: 'home' } as const;
    const target = { serverId: 'home', machineId: 'machine' };
    expect(await executor.execute('machines.access.grants.list', target, context))
      .toMatchObject({ ok: true, result: { machineId: 'machine', canManage: true, access: { accessState: 'ready' } } });
    for (const surface of ['agent', 'mcp'] as const) {
      const tools = listBuiltInHappierTools({ surface, actionsSettings: null, isActionEnabled: () => true });
      const direct = tools.find(tool => tool.actionId === 'machines.access.grant.set');
      const toolName = direct?.name ?? 'action_execute';
      expect(tools.some(tool => tool.name === toolName)).toBe(true);
      const bridge = createActionToolExecutorBridge({ executor, surface, actionsSettings: null });
      expect(await dispatchBuiltInHappierTool({ toolName, surface, sessionId: '', actionsSettings: null,
        args: direct ? { ...target, principal, level: 'view' } : { actionId: 'machines.access.grant.set', input: { ...target, principal, level: 'view' } },
        deps: { executeActionByToolName: bridge.executeActionByToolName,
          changeTitle: createChangeTitleToolHandler({ executor, surface }) },
      })).toEqual({ ok: true, result: { kind: 'saved', grant, readiness: 'ready', canPrepareKeys: false } });
      expect(saved).toBe(true);
    }
    expect(await executor.execute('machines.access.grant.set', { ...target, principal, level: 'view' }, context))
      .toEqual({ ok: true, result: { kind: 'saved', grant, readiness: 'ready', canPrepareKeys: false } });
    expect(saved).toBe(true);
    expect(await executor.execute('machines.access.grant.remove', { ...target, principal }, context))
      .toEqual({ ok: true, result: { kind: 'removed', effectiveAccess: 'use' } });
    expect(saved).toBe(false);
    expect(await executor.execute('machines.access.leave', target, context))
      .toEqual({ ok: true, result: { kind: 'left', effectiveAccess: 'none' } });
    expect(await executor.execute('machines.access.grant.set', { ...target, serverId: 'foreign', principal, level: 'view' }, context))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(saved).toBe(false);
  });
  it('prepares through the real private census continuation and preserves a committed grant if readiness refresh is unusable', async () => {
    app = fastify();
    const principal = { kind: 'account', accountId: 'bob' } as const;
    const grant = { machineId: 'machine', principal, level: 'view' } as const;
    const manager = nacl.box.keyPair();
    const dataKey = nacl.randomBytes(32);
    const envelope = sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: manager.publicKey, randomBytes: nacl.randomBytes });
    const callerDataEncryptionKey = encodeBase64(envelope);
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'manager' })).toString('base64url')}.signature`;
    const content = { metadata: createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey: dataKey, encryptionVariant: 'dataKey' }).encodeStored({
      host: 'host', platform: 'linux', happyCliVersion: '0.3', homeDir: '/home/alice', happyHomeDir: '/home/alice/.happier',
    }), metadataVersion: 1, daemonState: null, daemonStateVersion: 0 };
    let permissionWrites = 0;
    let censusReads = 0;
    app.put('/v1/machines/machine/access', async request => {
      expect(request.body).toEqual({ principal, level: 'view' });
      permissionWrites++;
      return { kind: 'saved', grant, readiness: 'key_pending', canPrepareKeys: true };
    });
    app.get('/v1/machines/machine/data-key-envelopes', async request => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      expect(request.query).toEqual({ state: 'action_required' });
      censusReads++;
      // Another holder may have repaired the pending member since the grant response.
      return { machineId: 'machine', custodianAccountId: 'alice', encryptionMode: 'e2ee',
        machineOwnerEnvelopeFingerprint: computeMachineOwnerEnvelopeFingerprintV1(envelope), callerDataEncryptionKey, nextCursor: null,
        content, recipients: [] };
    });
    app.get('/v1/machines/machine', async () => ({ machine: { id: 'machine', ...content, dataEncryptionKey: callerDataEncryptionKey,
      access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'e2ee', accessState: 'ready' } } }));
    app.get('/v1/machines/machine/access', async () => ({ malformed: true }));
    await app.ready();
    restore = installAxiosFastifyAdapter({ app, origin: 'http://access.test' });
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"machines.access.prepareKeys": Object.keys(ActionSurfaceSchema.shape), "machines.access.grant.set": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...createAccountServerActionDeps({ token,
      credentials: { token, encryption: { type: 'dataKey', publicKey: manager.publicKey, machineKey: manager.secretKey } },
      serverId: 'home', serverHttpBaseUrl: 'http://access.test' }),
    } as unknown as ActionExecutorDeps);
    const target = { serverId: 'home', machineId: 'machine' };
    const context = { surface: 'cli', authority: 'present_user', serverId: 'home' } as const;
    expect(await executor.execute('machines.access.prepareKeys', target, context))
      .toEqual({ ok: true, result: { kind: 'prepared' } });
    expect(permissionWrites).toBe(0);
    expect(await executor.execute('machines.access.grant.set', { ...target, principal, level: 'view' }, context))
      .toEqual({ ok: true, result: { kind: 'saved', grant, readiness: 'key_pending', canPrepareKeys: true } });
    expect(permissionWrites).toBe(1);
    expect(censusReads).toBe(4);
  });
});
