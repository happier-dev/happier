import { afterEach, describe, expect, it } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import nacl from 'tweetnacl';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
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

let app: FastifyInstance | undefined;
let restore: (() => void) | undefined;
afterEach(async () => { restore?.(); restore = undefined; await app?.close(); app = undefined; });

describe('Machine access headless Action transport', () => {
  it('returns qualified accessible inventory through the incumbent captured-endpoint owner', async () => {
    app = fastify();
    app.get('/v1/machines', async () => [{ id: 'shared', active: false, revokedAt: null, replacedByMachineId: null,
      access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'e2ee', accessState: 'key_pending' } }]);
    await app.ready();
    restore = installAxiosFastifyAdapter({ app, origin: 'http://access.test' });
    const deps = createCliActionInventoryDeps({ token: 'test-token', sessionId: '', mode: 'plain', ctx: null });
    expect(await runWithServerHttpBaseUrl('http://access.test', () => deps.machinesList({ serverId: 'home' })))
      .toMatchObject({ items: [{ serverId: 'home', machineId: 'shared', active: false, access: { accessState: 'key_pending' } }] });
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
      ...createAccountServerActionDeps({ token: 'test-token', serverId: 'home', serverHttpBaseUrl: 'http://access.test' }),
      isActionApprovalRequired: () => false,
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
    const executor = createActionExecutor({ ...createAccountServerActionDeps({ token,
      credentials: { token, encryption: { type: 'dataKey', publicKey: manager.publicKey, machineKey: manager.secretKey } },
      serverId: 'home', serverHttpBaseUrl: 'http://access.test' }), isActionApprovalRequired: () => false,
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
