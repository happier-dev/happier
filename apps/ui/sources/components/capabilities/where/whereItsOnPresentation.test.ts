import { describe, expect, it } from 'vitest';
import type { ReachRuleV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import type { ReachPlaceV1 } from '@happier-dev/protocol/reach/reachPlaceV1';
import { resolveReachV1, type ReachContextV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import { projectReachForMachinesV1 } from '@happier-dev/protocol/reach/projectReachV1';
import { t } from '@/text';
import {
    describeReach,
    describeOfflineMachines,
    describeReachRule,
    formatWhereItsOnConsequence,
    formatWhereItsOnSentence,
    sayWhereItsOn,
    shortWhereItsOn,
    type WhereItsOnNames,
} from './whereItsOnPresentation';

const agentTitle = (id: string) => ({ claude: 'Claude', codex: 'Codex', gemini: 'Gemini', opencode: 'OpenCode' } as Record<string, string>)[id] ?? id;
const names: WhereItsOnNames = {
    agentName: agentTitle,
    agentNames: (ids) => ids.map(agentTitle),
    machineName: (id) => ({ mbp: 'MacBook Pro', nl2: 'nl2', win: 'Windows desktop', a: 'A' } as Record<string, string>)[id] ?? id,
    projectName: (key) => key,
    folderLabel: (machineId, root) => `${root.replace('/home/me', '~')} on ${machineId}`,
};

let seq = 0;
function rule(target: ReachPlaceV1, enabled: boolean, agentId?: string): ReachRuleV1 {
    seq += 1;
    return { id: `r${seq}`, target, enabled, createdAt: seq, updatedAt: seq, ...(agentId ? { agentId } : {}) };
}
const everywhere = (on: boolean) => rule({ t: 'allMachines' }, on);
const project = (key: string, on: boolean, agentId?: string) => rule({ t: 'project', projectKey: key }, on, agentId);
const machine = (id: string, on: boolean, agentId?: string) => rule({ t: 'machine', machineId: id }, on, agentId);
const agent = (id: string, on: boolean) => rule({ t: 'allMachines' }, on, id);
const text = (rules: ReachRuleV1[]) => formatWhereItsOnSentence(sayWhereItsOn(rules, names));
const ctx = (over: Partial<ReachContextV1>): ReachContextV1 => ({ machineId: 'a', machinePlatform: 'posix', directory: null, projectKey: null, agentId: null, ...over });

describe('shortWhereItsOn', () => {
    it('produces the six summary forms', () => {
        expect(shortWhereItsOn([everywhere(true)], names)).toBe('Everywhere');
        expect(shortWhereItsOn([everywhere(true), agent('gemini', false)], names)).toBe('Everywhere · except Gemini');
        expect(shortWhereItsOn([everywhere(true), project('client-site', false)], names)).toBe('Everywhere · except in client-site');
        expect(shortWhereItsOn([everywhere(true), agent('gemini', false), project('client-site', false)], names)).toBe('Everywhere · 2 exceptions');
        expect(shortWhereItsOn([everywhere(false), project('client-site', true)], names)).toBe('Only in client-site');
        expect(shortWhereItsOn([everywhere(false)], names)).toBe('Off');
        expect(shortWhereItsOn([], names)).toBe('Off');
    });
});

describe('sayWhereItsOn', () => {
    it('shows an admitted built-in default and preserves explicit Off without seeding rules', () => {
        const rules: ReachRuleV1[] = [];
        expect(formatWhereItsOnSentence(sayWhereItsOn(rules, names, true))).toBe('On everywhere');
        expect(rules).toEqual([]);
        expect(formatWhereItsOnSentence(sayWhereItsOn([everywhere(false)], names, true))).toBe('Off');
    });
    it('states base On with an agent and a project exception', () => {
        expect(text([everywhere(true), agent('gemini', false), project('client-site', false)]))
            .toBe('On everywhere · except Gemini · except in client-site');
    });

    it('states base Off with one place for one agent', () => {
        expect(text([everywhere(false), machine('nl2', true, 'codex')])).toBe('Only for Codex on nl2');
    });

    it('keeps an agent exception holding everywhere and the place override for it (D33)', () => {
        const rules = [everywhere(false), project('happier', true), agent('gemini', false), project('client-site', true, 'gemini')];
        const sentence = sayWhereItsOn(rules, names);
        expect(formatWhereItsOnSentence(sentence)).toBe('Only in happier · except Gemini · on for Gemini in client-site');
        expect(sentence.clauses.map((clause) => clause.state)).toEqual(['off', 'on']);
    });

    it('folds more than three clauses into a count', () => {
        const rules = [everywhere(true), agent('gemini', false), agent('opencode', false), machine('nl2', false), project('client-site', false)];
        expect(formatWhereItsOnSentence(sayWhereItsOn(rules, names), { maxClauses: 3 })).toBe('On everywhere · except Gemini · except OpenCode · except on nl2 · 1 more');
    });

    it('keeps the restoring clause under a narrower Off (R4-03)', () => {
        const rules = [everywhere(true), machine('a', false), project('p', true)];
        expect(text(rules)).toBe('On everywhere · except on A · on in p');
        expect(shortWhereItsOn(rules, names)).toBe('Everywhere · 2 exceptions');
        expect(resolveReachV1(rules, ctx({ machineId: 'a', projectKey: 'p' })).enabled).toBe(true);
    });

    it('keeps a 0.2 workspace On under a machine Off (R4-03)', () => {
        const rules = [everywhere(true), machine('a', false), rule({ t: 'workspace', machineId: 'a', workspaceRoot: '/home/me/client' }, true)];
        expect(text(rules)).toBe('On everywhere · except on A · on in ~/client on a');
        expect(shortWhereItsOn(rules, names)).toBe('Everywhere · 2 exceptions');
        expect(resolveReachV1(rules, ctx({ directory: '/home/me/client/src' })).enabled).toBe(true);
        expect(resolveReachV1(rules, ctx({ directory: '/home/me/other' })).enabled).toBe(false);
    });
});

describe('describeReachRule', () => {
    it('says an agent exception never gets the item and a place+agent rule overrides it there', () => {
        expect(describeReachRule(agent('gemini', false), names, 'skill')).toEqual({ title: 'Gemini', effect: 'Never gets this skill, wherever it’s on' });
        expect(describeReachRule(project('happier', true, 'gemini'), names, 'skill')).toEqual({ title: 'happier · Gemini', effect: 'Gemini gets it in happier' });
        expect(describeReachRule(machine('nl2', false), names, 'mcp_server').title).toBe('nl2');
    });
});

describe('describeReach', () => {
    it.each(['skill', 'mcp_server'] as const)('does not call unknown empty %s inventory unavailable while preserving confirmed reach', kind => {
        const machines = [{ machineId: 'mbp', online: true }];
        const incomplete = [{ machineId: 'mbp', agents: [], agentInventoryComplete: false }];
        expect(formatWhereItsOnConsequence(describeReach(incomplete, machines, names, () => 'full', kind), names)).toBe('—');
        const known = [{ ...incomplete[0]!, agents: [{ agentId: 'codex', enabled: true, decidedBy: null }] }];
        expect(formatWhereItsOnConsequence(describeReach(known, machines, names, () => 'full', kind), names)).toContain('Codex');
        const complete = [{ ...incomplete[0]!, agentInventoryComplete: true }];
        expect(formatWhereItsOnConsequence(describeReach(complete, machines, names, () => 'full', kind), names)).toBe(t('capabilities.where.availableNowhere'));
    });
    it('describes project-only availability on the actual project machines and keeps Agent exceptions', () => {
        const rules = [everywhere(false), project('client-site', true), agent('gemini', false)];
        const facts = [{ machineId: 'mbp', platform: 'posix' as const, agentIds: ['claude', 'gemini'] },
            { machineId: 'nl2', platform: 'posix' as const, agentIds: ['codex', 'gemini'] }];
        const contexts = [
            ...projectReachForMachinesV1(rules, { machines: facts }),
            ...projectReachForMachinesV1(rules, { machines: facts, projectKey: 'client-site' })
                .map(row => ({ ...row, projectKey: 'client-site' })),
        ];
        const consequence = describeReach(contexts, [{ machineId: 'mbp', online: true }, { machineId: 'nl2', online: true }], names, () => 'full');
        expect(consequence.availableAgentIds).toEqual(['claude', 'codex']);
        expect(consequence.onlineMachineNames).toEqual(['MacBook Pro', 'nl2']);
        expect(formatWhereItsOnConsequence(consequence, names)).toBe('Available to Claude and Codex on MacBook Pro and nl2, only in client-site');
    });
    it('names a few machines and folds the rest into a count, so a long Account still reads as one sentence', () => {
        const many = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map(machineId => ({ machineId,
            agents: [{ agentId: 'claude', enabled: true, decidedBy: null }] }));
        const consequence = describeReach(many, many.map(row => ({ machineId: row.machineId, online: true })), names, () => 'full');
        expect(formatWhereItsOnConsequence(consequence, names))
            .toBe(`Available to Claude on m1, m2, m3, and ${t('capabilities.detail.moreMachines', { count: 3 })}`);
        const four = describeReach(many.slice(0, 4), many.slice(0, 4).map(row => ({ machineId: row.machineId, online: true })), names, () => 'full');
        expect(formatWhereItsOnConsequence(four, names)).toBe('Available to Claude on m1, m2, m3, and m4');
    });
    it('composes every instance title of a shared runtime once, so a sentence never nests lists', () => {
        const acpTitles: Record<string, readonly string[]> = { 'custom-acp': ['QA Alpha', 'QA Beta'], claude: ['Claude'], opencode: ['OpenCode'] };
        const instanced: WhereItsOnNames = {
            ...names,
            agentName: (id) => (acpTitles[id] ?? [id]).join(' and '),
            agentNames: (ids) => [...new Set(ids.flatMap((id) => acpTitles[id] ?? [id]))],
        };
        const rows = [{ machineId: 'mbp', agents: ['claude', 'custom-acp', 'opencode'].map(agentId => ({ agentId, enabled: true, decidedBy: null })) }];
        const consequence = describeReach(rows, [{ machineId: 'mbp', online: true }], instanced, () => 'full');
        expect(formatWhereItsOnConsequence(consequence, instanced)).toBe('Available to Claude, QA Alpha, QA Beta, and OpenCode on MacBook Pro');
    });
    const projection = [
        { machineId: 'mbp', agents: [{ agentId: 'claude', enabled: true, decidedBy: null }, { agentId: 'gemini', enabled: true, decidedBy: null }] },
        { machineId: 'nl2', agents: [{ agentId: 'codex', enabled: true, decidedBy: null }, { agentId: 'claude', enabled: false, decidedBy: null }] },
        { machineId: 'win', agents: [{ agentId: 'opencode', enabled: true, decidedBy: null }] },
    ];
    const machines = [{ machineId: 'mbp', online: true }, { machineId: 'nl2', online: true }, { machineId: 'win', online: false }];
    const takes = (agentId: string) => (agentId === 'gemini' ? 'none' as const : 'full' as const);

    it('names offline machines in notes and leaves agents that cannot take the item out', () => {
        const consequence = describeReach(projection, machines, names, takes, 'skill');
        expect(consequence.availableAgentIds).toEqual(['claude', 'codex']);
        expect(consequence.onlineMachineNames).toEqual(['MacBook Pro', 'nl2']);
        expect(consequence.notes).toEqual(['Windows desktop is offline. It gets this when it’s back.', 'Gemini can’t load skills.']);
        expect(formatWhereItsOnConsequence(consequence, names)).toBe('Available to Claude and Codex on MacBook Pro and nl2');
    });

    it('states several offline machines once, by count, instead of one sentence per machine', () => {
        const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
            machineId: id,
            agents: [{ agentId: 'claude', enabled: true, decidedBy: null }],
        }));
        const offline = many.map(({ machineId }) => ({ machineId, online: false }));
        const consequence = describeReach(many, offline, names, () => 'full', 'skill');
        expect(consequence.notes).toEqual(['6 offline machines get it when they’re back.']);
    });
});

describe('describeOfflineMachines', () => {
    it('names one machine and counts several', () => {
        expect(describeOfflineMachines([])).toBeNull();
        expect(describeOfflineMachines(['Windows desktop'])).toBe('Windows desktop is offline. It gets this when it’s back.');
        expect(describeOfflineMachines(['mbp', 'nl2'])).toBe('2 offline machines get it when they’re back.');
    });
});
