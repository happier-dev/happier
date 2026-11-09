import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { readUsageWidgetPageScope } from './usageWidgetPageContext';
import { useUsageWidgetPageContext } from './useUsageWidgetPageContext';
import { useUsageWidgetPageFilters } from './useUsageWidgetPageFilters';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { clearProjectedAgentUiBehaviorDescriptors, publishProjectedAgentUiBehaviorDescriptors } from '@/agents/registry/agentUiBehaviorProjection';

afterEach(standardCleanup);

it('keeps declared source choices distinct with qualified Agent identity while source details are closed', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    publishProjectedAgentUiBehaviorDescriptors({ machineId: 'research-machine', descriptorsByAgentId: {
        'third.party/research': { kind: 'plugin.ui.v1', pluginId: 'third.party', agentId: 'third.party/research', behavior: {
            accountingSourcePresentation: [{ sourceId: 'research-observed-v1', title: 'Research observations' }],
        } },
    } });
    const sourceIds = ['claude-assistant-usage', 'claude-sdk-result', 'research-observed-v1'];
    const scope = readUsageWidgetPageScope(normalizeUsageQuery({ sources: sourceIds }));
    const hook = await renderHook(() => {
        const page = useUsageWidgetPageContext({ authority: null,
            initialFilters: { period: '7days', metric: 'tokens', costMode: 'auto', focus: null, scope } });
        return useUsageWidgetPageFilters(page, [], false, getActiveServerSnapshot().serverId);
    });
    try {
        const choices = hook.getCurrent().find(filter => filter.field === 'sources')!.options;
        expect(choices.filter(choice => sourceIds.includes(choice.id)).map(choice => choice.id).sort()).toEqual([...sourceIds].sort());
        expect(choices.find(choice => choice.id === 'research-observed-v1')).toMatchObject({
            label: 'Research observations', agentId: 'third.party/research',
        });
        expect(choices.find(choice => choice.id === 'claude-assistant-usage')!.label)
            .not.toBe(choices.find(choice => choice.id === 'claude-sdk-result')!.label);
        expect(fetch).not.toHaveBeenCalled();
    } finally {
        await hook.unmount();
        clearProjectedAgentUiBehaviorDescriptors();
        fetch.mockRestore();
    }
});

it('retains the drill choices when a batch changes only facts outside its scope options', async () => {
    const query = normalizeUsageQuery({ agents: ['codex'] });
    const base = resolveUsagePageAggregation({ queries: [query] }).results[0]!;
    let slices = [base];
    let scope = readUsageWidgetPageScope(query);
    const hook = await renderHook(() => {
        const page = useUsageWidgetPageContext({ authority: null,
            initialFilters: { period: '7days', metric: 'tokens', costMode: 'auto', focus: null, scope } });
        return useUsageWidgetPageFilters(page, slices, false, getActiveServerSnapshot().serverId);
    });
    try {
        const retained = hook.getCurrent();
        for (let index = 0; index < 20; index++) {
            slices = [{ ...base, pending: index % 2 === 0 }];
            await hook.rerender();
            expect(hook.getCurrent(), 'Equal choices do not republish the drill context').toBe(retained);
        }
        expect(await retained.find(filter => filter.field === 'agents')!.select('codex'), 'Retention does not bypass missing authority').toBe(false);
        scope = { ...scope, agents: [] };
        await hook.rerender();
        expect(hook.getCurrent().find(filter => filter.field === 'agents')!.selected).toEqual([]);
        expect(hook.getCurrent()).not.toBe(retained);
    } finally { await hook.unmount(); }
});

it('keeps filter consumers quiet through Machine runtime changes while names, locks and missing choices stay live', async () => {
    const original = storage.getState();
    const machines = Array.from({ length: 150 }, (_, index) => createMachineFixture({ id: `machine-${index}` }));
    const scope = readUsageWidgetPageScope(normalizeUsageQuery({ machines: ['machine-0', 'machine-1', 'missing'] }));
    const counter = createRenderCommitCounter();
    storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: {}, machineListStatusByServerId: {} });
    const hook = await renderHook(() => {
        const page = useUsageWidgetPageContext({ authority: null,
            initialFilters: { period: '7days', metric: 'tokens', costMode: 'auto', focus: null, scope } });
        const filters = useUsageWidgetPageFilters(page, [], false, getActiveServerSnapshot().serverId);
        useRenderCommitCounter(counter);
        return filters.find(filter => filter.field === 'machines')!;
    });
    try {
        const expected = () => resolveMachineDisplayNames([
            ...Object.values(storage.getState().machines), { id: 'missing', absence: 'unlisted' as const },
        ]);
        const labels = () => new Map(hook.getCurrent().options.map(option => [option.id, option.label]));
        expect(labels().get('machine-0')).toBe(expected().get('machine-0'));
        expect(labels().get('machine-0')).not.toBe(labels().get('machine-1'));
        counter.reset();
        for (let index = 0; index < 20; index++) {
            await act(async () => {
                const current = storage.getState().machines;
                storage.setState({ machines: { ...current, 'machine-0': { ...current['machine-0']!, daemonStateVersion: index + 2 } } });
            });
        }
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        await act(async () => {
            const current = storage.getState().machines;
            storage.setState({ machines: { ...current, 'machine-0': { ...current['machine-0']!,
                metadata: { ...current['machine-0']!.metadata!, displayName: 'Build box' } } } });
        });
        expect(labels().get('machine-0')).toBe('Build box');
        expect(counter.read().commits).toBeGreaterThan(0);
        await act(async () => {
            const current = storage.getState().machines;
            storage.setState({ machines: { ...current, 'machine-0': { ...current['machine-0']!, availability: { kind: 'locked', reason: 'decryption_failed' } } } });
        });
        expect(labels().get('machine-0')).toBe(expected().get('machine-0'));
        expect(labels().get('machine-0')).not.toBe('Build box');
        expect(labels().get('missing')).toBe(expected().get('missing'));
    } finally {
        await hook.unmount();
        storage.setState({ machines: original.machines, machineListByServerId: original.machineListByServerId,
            machineListStatusByServerId: original.machineListStatusByServerId });
    }
});

it('D21 names accounting-only Project choices from the opened Project owner and preserves Machine distinctions', async () => {
    const previous = storage.getState();
    const serverId = getActiveServerSnapshot().serverId;
    const scope = { serverId, accountId: 'd21-account' };
    const keys = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)];
    const machines = ['3ca2700f-c0a8-440f-be06-cb4f3f51cb01', 'eadc2422-b42b-478d-97b1-af9b530d5f08']
        .map(id => {
            const machine = createMachineFixture({ id });
            return { ...machine, metadata: machine.metadata && { ...machine.metadata, host: 'Shared host', displayName: 'Shared host' } };
        });
    const { WorkspaceRefV1Schema } = await import('@/sync/domains/workspaces/workspaceRefModel');
    const refs = machines.map((machine, index) => WorkspaceRefV1Schema.parse({ id: `d21-checkout-${index}`,
        projectKey: keys[index], serverId, machineId: machine.id, rootPath: '/work/happier', createdAtMs: 0 }));
    const { createProjectAccountRowCipherV1 } = await import('@happier-dev/protocol/projects/projectAccountRowCipherV1');
    const { createProjectAccountRowsSync } = await import('@/sync/engine/projects/projectAccountRowsSync');
    const { t } = await import('@/text');
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null });
    const rows = [...refs.map(ref => {
        const key = { kind: 'workspace-ref' as const, serverId, id: ref.id };
        return { key, revision: 1, content: cipher.seal({ key, value: ref }) };
    }), ...keys.slice(2).map((projectKey, index) => {
        const key = { kind: 'project-organization' as const, serverId, projectKey };
        return { key, revision: 1, content: cipher.seal({ key, value: { label: index === 0 ? 'Native project' : projectKey } }) };
    })];
    const owner = createProjectAccountRowsSync({ scope, cipher, isCurrent: () => true,
        transport: { read: async () => { throw new Error('Project names use the census'); },
            list: async () => ({ status: 'listed', coverage: 'complete', rows }),
            mutate: async () => { throw new Error('Reading Project names cannot mutate'); } },
        apply: (...args) => storage.getState().applyProjectAccountRowsForScope(scope, ...args) });
    const query = normalizeUsageQuery({ projects: [keys[3]!] });
    const base = resolveUsagePageAggregation({ queries: [query] }).results[0]!;
    // The real filter inventory requests accounting only, without Work/Session evidence.
    const slices = [{ ...base, accounting: { v: 1 as const,
        totals: { eventCount: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
        breakdowns: { project: [refs[0]!.id, keys[0]!, keys[1]!, keys[2]!, keys[3]!].map(key => ({ key,
            ...(key === keys[3] ? { label: 'Stale accounting name' } : {}), eventCount: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } })) } } }];
    storage.setState({ profileScope: scope, machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: {}, machineListStatusByServerId: {} });
    storage.getState().activateProjectAccountRowsScope(scope);
    const hook = await renderHook(() => {
        const page = useUsageWidgetPageContext({ authority: null, initialFilters: { period: '7days', metric: 'tokens',
            costMode: 'auto', focus: null, scope: readUsageWidgetPageScope(query) } });
        return useUsageWidgetPageFilters(page, slices, false, serverId).find(filter => filter.field === 'projects')!;
    });
    try {
        await act(async () => { await owner.refresh(); });
        const options = hook.getCurrent().options.slice(1);
        expect(options.map(option => option.id)).toEqual(keys);
        const names = resolveMachineDisplayNames(machines);
        for (const [index, machine] of machines.entries()) {
            expect(options[index]!.label).toContain('happier');
            expect(options[index]!.subtitle).toBe(names.get(machine.id));
        }
        expect(options[0]!.subtitle).not.toBe(options[1]!.subtitle);
        expect(options[2]!.label).toBe('Native project');
        expect(options[3]!.label).toBe(t('usage.board.work.unknownProject'));
        for (const option of options) expect(`${option.label} ${option.subtitle ?? ''}`).not.toMatch(/[a-f\d]{64}/i);
        expect(hook.getCurrent().selected).toEqual([keys[3]]);
        await act(async () => storage.getState().setProjectAccountRowsStatusForScope(scope, 'locked'));
        for (const option of hook.getCurrent().options.slice(1).filter(option => option.id !== keys[3])) {
            expect(option.label).toBe(t('usage.board.work.unknownProject'));
        }
        await act(async () => storage.getState().setProjectAccountRowsStatusForScope(scope, 'ready'));
        expect(hook.getCurrent().options.find(option => option.id === keys[2])!.label).toBe('Native project');
    } finally { await hook.unmount(); storage.setState(previous, true); }
});
