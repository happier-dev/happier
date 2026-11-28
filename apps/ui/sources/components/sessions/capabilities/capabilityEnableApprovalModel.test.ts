import { expect, it } from 'vitest';
import { createCapabilityEnableApprovalController, resolveCapabilityAlwaysWrite } from './capabilityEnableApprovalModel';

it('keeps the deciding workspace/project scope, falls back locally for Everywhere/null, and refuses an unknown deciding rule', () => {
    const exception = { id: 'exception', target: { t: 'workspace' as const, machineId: 'machine', workspaceRoot: '/repo' },
        enabled: false, agentId: 'gemini', createdAt: 1, updatedAt: 1 };
    const base = { projectKey: 'project', machineId: 'machine', rules: [exception] };
    expect(resolveCapabilityAlwaysWrite({ ...base, decidedBy: { ruleId: exception.id, target: 'workspace', agentQualified: true } }))
        .toEqual({ place: exception.target, agentId: 'gemini', state: 'on' });
    expect(resolveCapabilityAlwaysWrite({ ...base, decidedBy: null })).toEqual({ place: { t: 'project', projectKey: 'project' }, state: 'on' });
    expect(resolveCapabilityAlwaysWrite({ ...base, projectKey: null, decidedBy: null })).toEqual({ place: { t: 'machine', machineId: 'machine' }, state: 'on' });
    expect(resolveCapabilityAlwaysWrite({ ...base, decidedBy: { ruleId: 'missing', target: 'project', agentQualified: false } })).toBeNull();
    const everywhere = { ...exception, target: { t: 'allMachines' as const } };
    expect(resolveCapabilityAlwaysWrite({ ...base, rules: [everywhere], decidedBy: { ruleId: everywhere.id, target: 'allMachines', agentQualified: true } }))
        .toEqual({ place: { t: 'project', projectKey: 'project' }, agentId: 'gemini', state: 'on' });
});

it('Not now rejects through the existing decision owner and makes no rules write', async () => {
    const decisions: string[] = [];
    let writes = 0;
    const controller = createCapabilityEnableApprovalController({ alwaysWrite: null, decide: async decision => { decisions.push(decision); return true; },
        changeRules: async () => { writes++; return { ok: false, message: 'must_not_write' }; },
        undoRules: async () => { throw new Error('No rules were written'); } });
    await controller.choose('reject');
    expect(controller.getSnapshot().status).toBe('rejected');
    expect(decisions).toEqual(['reject']); expect(writes).toBe(0);
});
