import { afterEach, describe, expect, it } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol';
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
      return { kind: 'saved', grant, readiness: 'ready' };
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
      })).toEqual({ ok: true, result: { kind: 'saved', grant, readiness: 'ready' } });
      expect(saved).toBe(true);
    }
    expect(await executor.execute('machines.access.grant.set', { ...target, principal, level: 'view' }, context))
      .toEqual({ ok: true, result: { kind: 'saved', grant, readiness: 'ready' } });
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
    let permissionWrites = 0;
    let censusReads = 0;
    app.put('/v1/machines/machine/access', async request => {
      expect(request.body).toEqual({ principal, level: 'view' });
      permissionWrites++;
      return { kind: 'saved', grant, readiness: 'key_pending' };
    });
    app.get('/v1/machines/machine/data-key-envelopes', async request => {
      expect(request.headers.authorization).toBe('Bearer test-token');
      expect(request.query).toEqual({ state: 'action_required' });
      censusReads++;
      return { machineId: 'machine', custodianAccountId: 'alice', encryptionMode: 'plain',
        machineOwnerEnvelopeFingerprint: null, callerDataEncryptionKey: null, nextCursor: null,
        content: { metadata: '{}', metadataVersion: 1, daemonState: null, daemonStateVersion: 0 }, recipients: [] };
    });
    app.get('/v1/machines/machine/access', async () => ({ malformed: true }));
    await app.ready();
    restore = installAxiosFastifyAdapter({ app, origin: 'http://access.test' });
    const executor = createActionExecutor({ ...createAccountServerActionDeps({ token: 'test-token',
      serverId: 'home', serverHttpBaseUrl: 'http://access.test' }), isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);
    const target = { serverId: 'home', machineId: 'machine' };
    const context = { surface: 'cli', authority: 'present_user', serverId: 'home' } as const;
    expect(await executor.execute('machines.access.prepareKeys', target, context))
      .toEqual({ ok: true, result: { kind: 'prepared' } });
    expect(permissionWrites).toBe(0);
    expect(await executor.execute('machines.access.grant.set', { ...target, principal, level: 'view' }, context))
      .toEqual({ ok: true, result: { kind: 'saved', grant, readiness: 'key_pending' } });
    expect(permissionWrites).toBe(1);
    expect(censusReads).toBe(2);
  });
});
