import { describe, expect, it } from 'vitest';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { isApprovalRequiredByActionsSettings } from './actionApprovalPolicy.js';
import type { HappierStorageSummaryV1 } from '../storage/storageV1.js';
import { resolveMachineRpcRoutePolicy } from '../machines/peer/mediation/rpc/routePolicyV1.js';

const summary: HappierStorageSummaryV1 = {
  revision: 1, sizedAt: 1000, volumes: [], categories: [], suggestionsTop: [],
  pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 },
  wholeDisk: { enabled: false, scans: [] },
};

describe('machine storage Action front door', () => {
  it('admits Manage scan and protection Actions with strict inputs and only ordinary agent-asks removal', () => {
    const settings = ActionsSettingsV1Schema.parse({ v: 1 });
    const start = getActionSpec(ActionIdSchema.parse('machines.storage.scan.start')).inputSchema;
    expect(start.safeParse({ machineId: 'machine', target: { volumeId: 'volume' }, drawableNodes: 24 }).success).toBe(false);
    const inputs = {
      'machines.storage.scan.start': { target: { volumeId: 'volume' } },
      'machines.storage.scan.get': { view: { tab: 'old', depth: 2, olderThanDays: 1000, pageSize: 1000 } },
      'machines.storage.scan.cancel': { scanId: 'scan' },
      'machines.storage.scan.skip': { scanId: 'scan', path: '/unreadable' },
      'machines.storage.protected.add': { path: '/personal' },
      'machines.storage.protected.remove': { path: '/personal' },
    };
    for (const [id, input] of Object.entries(inputs)) {
      const actionId = ActionIdSchema.parse(id);
      const spec = getActionSpec(actionId);
      expect(spec.inputSchema.parse({ machineId: 'machine', ...input })).toEqual({ machineId: 'machine', ...input });
      expect(spec.inputSchema.safeParse({ machineId: 'machine', ...input, actorAccountId: 'forged' }).success).toBe(false);
      expect(isApprovalRequiredByActionsSettings(actionId, settings, { surface: 'agent' })).toBe(id.endsWith('protected.remove'));
      expect(resolveMachineRpcRoutePolicy(spec.bindings!.rpcMethod!)).toMatchObject({ sharedMachineAccess: 'manage', actionSpecId: id });
    }
    const get = getActionSpec(ActionIdSchema.parse('machines.storage.scan.get')).inputSchema;
    expect(get.safeParse({ machineId: 'machine', view: { tab: 'folders', depth: 1, pageSize: 500 } }).success).toBe(true);
    expect(get.safeParse({ machineId: 'machine', view: { tab: 'folders', depth: 1, drawableNodes: 12, pageSize: 500 } }).success).toBe(false);
    expect(get.safeParse({ machineId: 'machine', view: { tab: 'folders', depth: 1, drawableNodes: 0, pageSize: 500 } }).success).toBe(false);
    expect(get.safeParse({ machineId: 'machine', view: { tab: 'old', depth: 1, olderThanDays: 1, olderThanMonths: 3 } }).success).toBe(false);
    expect(get.safeParse({ machineId: 'machine', view: { tab: 'find', depth: 1, query: { name: 'cache', actor: 'forged' } } }).success).toBe(false);
    const removeId = ActionIdSchema.parse('machines.storage.protected.remove');
    expect(isApprovalRequiredByActionsSettings(removeId, ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { 'machines.storage.protected.remove': ['agent'] } }), { surface: 'agent' })).toBe(false);
  });
  it('keeps cleanup approval in the Action policy and permits an agent waiver for every reviewed verdict', async () => {
    const actionId = ActionIdSchema.parse('machines.storage.trash.move');
    const items = ['safe', 'caution', 'keep', 'forbidden'].map((claimedVerdict, i) => ({
      ref: { itemId: `item-${i}`, path: `/cache/${i}`, identity: { dev: '1', ino: `${i}`, kind: 'directory' },
        collectedAt: 1, collectedBy: { accountId: 'owner', kind: 'agent' } }, expect: `expect-${i}`, claimedVerdict,
    }));
    const result = { batchId: 'batch', mode: 'trash', outcomes: items.map(({ ref, claimedVerdict }) => ({
      itemId: ref.itemId, status: claimedVerdict === 'forbidden' ? 'refused' : 'moved',
      ...(claimedVerdict === 'forbidden' ? { reason: { code: 'system' } } : {}),
    })), inTrashBytes: 12288, freedBytes: 0 };
    // Daemon transport is the process boundary: its current filesystem classification
    // supplies refusal facts, while real Action admission must not add verdict rules.
    const executor = createActionExecutor({ machineStorageAction: async () => result,
      isActionApprovalRequired: (id, ctx, input) => isApprovalRequiredByActionsSettings(id, ctx.actionsSettings, ctx, undefined, undefined, input),
    } as ActionExecutorDeps);
    const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'machines.storage.trash.move': ['agent'] } });
    expect(isApprovalRequiredByActionsSettings(actionId, ActionsSettingsV1Schema.parse({ v: 1 }), { surface: 'agent' })).toBe(true);
    expect(await executor.execute(actionId, { machineId: 'machine', items }, { surface: 'agent', actionsSettings: settings }))
      .toEqual({ ok: true, result });
    const deleteId = ActionIdSchema.parse('machines.storage.deleteNow');
    expect(isApprovalRequiredByActionsSettings(deleteId, ActionsSettingsV1Schema.parse({ v: 1 }), { surface: 'agent' })).toBe(true);
  });

  it('narrows approved item sets and refreshes only expectations while preserving target and presentation', () => {
    const actionId = ActionIdSchema.parse('machines.storage.trash.move');
    const ref = { itemId: 'item', path: '/cache', identity: { dev: '1', ino: '2', kind: 'directory' },
      collectedAt: 1, collectedBy: { accountId: 'owner', kind: 'agent' } };
    const original = { machineId: 'machine', items: [{ ref, expect: 'old', claimedVerdict: 'keep', reason: { code: 'in_use' } },
      { ref: { ...ref, itemId: 'second', path: '/other' }, expect: 'other', claimedVerdict: 'safe' }], emptyAfter: true, goalBytes: 4096 };
    const chosen = { ...original, items: [{ ...original.items[0], expect: 'new' }], emptyAfter: false };
    const narrow = getActionSpec(actionId).approvalNarrowing;
    expect(narrow?.narrow(original, chosen)).toEqual(chosen);
    for (const mutated of [{ ...chosen, machineId: 'other' }, { ...chosen, goalBytes: 8192 },
      { ...chosen, items: [{ ...chosen.items[0], claimedVerdict: 'safe' }] },
      { ...chosen, items: [{ ...chosen.items[0], ref: { ...ref, path: '/replacement' } }] },
      { ...chosen, items: [] }]) expect(narrow?.narrow(original, mutated)).toBeNull();
    expect(narrow?.narrow({ ...original, emptyAfter: false }, { ...chosen, emptyAfter: true })).toBeNull();
  });

  it('narrows exact Trash entry identities without expanding an all-entry request', () => {
    const spec = getActionSpec(ActionIdSchema.parse('machines.storage.trash.empty'));
    const original = { machineId: 'machine', entryIds: ['one', 'two'], volume: 'volume' };
    const chosen = { ...original, entryIds: ['two'] };
    expect(spec.approvalNarrowing?.narrow(original, chosen)).toEqual(chosen);
    expect(spec.approvalNarrowing?.narrow(original, { ...chosen, entryIds: ['other'] })).toBeNull();
    expect(spec.approvalNarrowing?.narrow(original, { ...chosen, entryIds: ['two', 'two'] })).toBeNull();
    expect(spec.approvalNarrowing?.narrow(original, { machineId: 'machine', volume: 'volume' })).toBeNull();
  });
  it('admits strict machine storage operations with ordinary Allowed approval defaults', async () => {
    const settings = ActionsSettingsV1Schema.parse({ v: 1 });
    for (const id of ['machines.storage.summary.get', 'machines.storage.category.list', 'machines.storage.size.refresh']) {
      expect(ActionIdSchema.safeParse(id).success).toBe(true);
      const actionId = ActionIdSchema.parse(id);
      expect(isApprovalRequiredByActionsSettings(actionId, settings, { surface: 'agent' })).toBe(false);
      expect(getActionSpec(actionId).inputSchema.safeParse({ machineId: 'machine', ...(id.endsWith('category.list') ? { categoryId: 'logs' } : {}), unexpected: true }).success).toBe(false);
    }
    const calls: unknown[] = [];
    // The machine RPC transport is the system boundary; Action parsing and routing remain real.
    const executor = createActionExecutor({ machineStorageAction: async (request: unknown) => { calls.push(request); return summary; } } as unknown as ActionExecutorDeps);
    const actionId = ActionIdSchema.parse('machines.storage.summary.get');
    expect(await executor.execute(actionId, { machineId: 'machine' }, { surface: 'cli', serverId: 'home' }))
      .toEqual({ ok: true, result: summary });
    expect(await executor.execute(actionId, { machineId: 'machine', serverId: 'other' }, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(calls).toHaveLength(1);
  });

  it('executes category reads and remeasurement through the same typed front door and validates answers', async () => {
    const executor = createActionExecutor({ machineStorageAction: async ({ actionId }) => actionId === 'machines.storage.category.list'
      ? { revision: 1, sizedAt: 1000, categoryId: 'logs', items: [] } : summary } as ActionExecutorDeps);
    expect(await executor.execute('machines.storage.category.list', { machineId: 'machine', categoryId: 'logs' }, { surface: 'agent' }))
      .toEqual({ ok: true, result: { revision: 1, sizedAt: 1000, categoryId: 'logs', items: [] } });
    expect(await executor.execute('machines.storage.size.refresh', { machineId: 'machine' }, { surface: 'cli' }))
      .toEqual({ ok: true, result: summary });
    const broken = createActionExecutor({ machineStorageAction: async () => ({ revision: 1 }) } as unknown as ActionExecutorDeps);
    expect(await broken.execute('machines.storage.summary.get', { machineId: 'machine' }, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    const failed = createActionExecutor({ machineStorageAction: async () => ({ ok: false, errorCode: 'native_disk_unavailable', error: 'native_disk_unavailable' }) } as unknown as ActionExecutorDeps);
    expect(await failed.execute('machines.storage.size.refresh', { machineId: 'machine' }, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'native_disk_unavailable' });
  });
});
