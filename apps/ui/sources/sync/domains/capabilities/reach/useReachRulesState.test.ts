import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { McpRulesSetInputV1Schema } from '@happier-dev/protocol/actions/specs/capabilityRules';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { useReachRulesState, type ExecuteReachRules, type ReachRulesSource } from './useReachRulesState';

afterEach(standardCleanup);
const initial = { id: 'everywhere', target: { t: 'allMachines' as const }, enabled: true, createdAt: 1, updatedAt: 1 };
const source: ReachRulesSource = { key: 'account/server', kind: 'mcp_server', itemId: 'server', rules: [initial], revision: 1, status: 'ready', valueAvailable: true };

describe('reach rule optimistic state', () => {
    it('distinguishes unread rules from a read empty value, and keeps read data through refresh', async () => {
        const execute = vi.fn<ExecuteReachRules>();
        const hook = await renderHook((props: ReachRulesSource) => useReachRulesState(props, execute), {
            initialProps: { ...source, status: 'loading', rules: [], valueAvailable: false },
        });
        expect(hook.getCurrent()).toMatchObject({ status: 'loading', valueAvailable: false });
        await hook.rerender({ ...source, status: 'loading' });
        expect(hook.getCurrent()).toMatchObject({ status: 'loading', valueAvailable: true, rules: [initial] });
        expect(await hook.getCurrent().change({ kind: 'replace', rules: [] })).toEqual({ ok: false, message: 'catalog_unavailable' });
        expect(execute).not.toHaveBeenCalled();
        await hook.rerender({ ...source, rules: [] });
        expect(hook.getCurrent()).toMatchObject({ status: 'ready', valueAvailable: true, rules: [] });
        await hook.rerender({ ...source, status: 'loading', rules: [] });
        expect(hook.getCurrent()).toMatchObject({ status: 'loading', valueAvailable: true, rules: [] });
    });
    it('refuses Undo when no acknowledged write has a previous rule set', async () => {
        const execute = vi.fn<ExecuteReachRules>();
        const hook = await renderHook(() => useReachRulesState(source, execute));
        expect(await hook.getCurrent().undoLast()).toEqual({ ok: false, message: 'nothing_to_undo' });
        expect(execute).not.toHaveBeenCalled();
    });
    it('writes skill rules through the skill Action and Undo restores its previous value', async () => {
        const off = { ...initial, enabled: false, updatedAt: 2 };
        const execute = vi.fn<ExecuteReachRules>().mockResolvedValueOnce({ ok: true,
            result: { ok: true, revision: 2, items: [{ skillId: 'lint', rules: [off], previous: [initial] }] } })
            .mockResolvedValueOnce({ ok: true, result: { ok: true, revision: 3,
                items: [{ skillId: 'lint', rules: [initial], previous: [off] }] } });
        const hook = await renderHook(() => useReachRulesState({ ...source, kind: 'skill', itemId: 'lint' }, execute));
        await act(async () => {
            expect(await hook.getCurrent().change({ kind: 'write', write: { place: initial.target, state: 'off' } })).toEqual({ ok: true });
        });
        expect(hook.getCurrent().rules).toEqual([off]);
        await act(async () => { expect(await hook.getCurrent().undoLast()).toEqual({ ok: true }); });
        expect(execute.mock.calls.at(-1)).toEqual(['skills.rules.set', { items: [{ skillId: 'lint' }],
            change: { kind: 'replace', rules: [{ target: initial.target, enabled: true }] } }]);
        expect(hook.getCurrent().rules).toEqual([initial]);
    });
    it('shows a replace immediately and rolls back with a typed refusal', async () => {
        const pending = createDeferred<ActionExecuteResult>();
        const execute = vi.fn<ExecuteReachRules>().mockReturnValueOnce(pending.promise);
        const hook = await renderHook(() => useReachRulesState(source, execute));
        let write!: ReturnType<ReturnType<typeof useReachRulesState>['change']>;
        act(() => { write = hook.getCurrent().change({ kind: 'replace', rules: [{ target: initial.target, enabled: false }] }); });
        expect(hook.getCurrent().rules[0]?.enabled).toBe(false);
        await act(async () => { pending.resolve({ ok: true, result: { ok: false, code: 'conflict' } }); await write; });
        expect(await write).toEqual({ ok: false, message: 'conflict' });
        expect(hook.getCurrent().rules).toEqual([initial]);
    });
    it('serializes rapid edits and preserves both changes through acknowledgements and a stale read', async () => {
        const pending = createDeferred<ActionExecuteResult>();
        const off = { ...initial, enabled: false, updatedAt: 2 };
        const machine = { id: 'machine', target: { t: 'machine' as const, machineId: 'm1' }, enabled: true, createdAt: 3, updatedAt: 3 };
        const execute = vi.fn<ExecuteReachRules>().mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ok: true,
            result: { ok: true, revision: 3, items: [{ serverId: 'server', rules: [off, machine], previous: [off] }] } });
        const hook = await renderHook((props: ReachRulesSource) => useReachRulesState(props, execute), { initialProps: source });
        let one!: Promise<unknown>; let two!: Promise<unknown>;
        act(() => {
            one = hook.getCurrent().change({ kind: 'write', write: { place: initial.target, state: 'off' } });
            two = hook.getCurrent().change({ kind: 'write', write: { place: machine.target, state: 'on' } });
        });
        await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
        expect(hook.getCurrent().rules.find(rule => rule.target.t === 'allMachines')?.enabled).toBe(false);
        expect(hook.getCurrent().rules.find(rule => rule.target.t === 'machine')?.enabled).toBe(true);
        await act(async () => { pending.resolve({ ok: true, result: { ok: true, revision: 2,
            items: [{ serverId: 'server', rules: [off], previous: [initial] }] } }); await one; await two; });
        await hook.rerender({ ...source, rules: [{ ...initial }] });
        expect(hook.getCurrent().rules).toEqual([off, machine]);
        execute.mockResolvedValueOnce({ ok: true, result: { ok: true, revision: 4,
            items: [{ serverId: 'server', rules: [off], previous: [off, machine] }] } });
        await act(async () => { await hook.getCurrent().undoLast(); });
        expect(execute.mock.calls.at(-1)).toEqual(['mcp.rules.set', { items: [{ serverId: 'server' }],
            change: { kind: 'replace', rules: [{ target: initial.target, enabled: false }] } }]);
        expect(McpRulesSetInputV1Schema.safeParse(execute.mock.calls.at(-1)?.[1]).success).toBe(true);
        expect(hook.getCurrent().rules).toEqual([off]);
    });
    it('rolls back a failed Undo and refuses writes to an unavailable row', async () => {
        const off = { ...initial, enabled: false, updatedAt: 2 };
        const execute = vi.fn<ExecuteReachRules>().mockResolvedValueOnce({ ok: true, result: { ok: true, revision: 2,
            items: [{ serverId: 'server', rules: [off], previous: [initial] }] } })
            .mockResolvedValueOnce({ ok: true, result: { ok: false, code: 'conflict' } });
        const hook = await renderHook((props: ReachRulesSource) => useReachRulesState(props, execute), { initialProps: source });
        await act(async () => { await hook.getCurrent().change({ kind: 'write', write: { place: initial.target, state: 'off' } }); });
        await act(async () => { expect(await hook.getCurrent().undoLast()).toEqual({ ok: false, message: 'conflict' }); });
        expect(hook.getCurrent().rules).toEqual([off]);
        await hook.rerender({ ...source, status: 'unavailable' });
        expect(hook.getCurrent().rules).toEqual([off]);
        expect(await hook.getCurrent().change({ kind: 'replace', rules: [] })).toEqual({ ok: false, message: 'catalog_unavailable' });
        expect(execute).toHaveBeenCalledTimes(2);
        await hook.rerender({ ...source, status: 'unavailable', rules: [], valueAvailable: false });
        expect(hook.getCurrent().rules).toEqual([]);
        await hook.rerender({ ...source, status: 'loading', rules: [], valueAvailable: false });
        expect(hook.getCurrent().rules).toEqual([]);
    });
    it('does not let a queued old Account edit mutate a new Account projection', async () => {
        const pending = createDeferred<ActionExecuteResult>();
        const execute = vi.fn<ExecuteReachRules>().mockReturnValueOnce(pending.promise);
        const hook = await renderHook((props: ReachRulesSource) => useReachRulesState(props, execute), { initialProps: source });
        let one!: Promise<unknown>; let two!: Promise<unknown>;
        act(() => {
            one = hook.getCurrent().change({ kind: 'write', write: { place: initial.target, state: 'off' } });
            two = hook.getCurrent().change({ kind: 'replace', rules: [] });
        });
        await hook.rerender({ ...source, key: 'other-account/server', rules: [] });
        await act(async () => { pending.resolve({ ok: false, error: 'scope-retired', errorCode: 'scope-retired' }); await one; await two; });
        expect(hook.getCurrent().rules).toEqual([]);
        expect(execute).toHaveBeenCalledTimes(1);
    });
    it('keeps distinct optimistic row identities when a multi-place replace is rebased after an acknowledgement', async () => {
        const first = createDeferred<ActionExecuteResult>();
        const second = createDeferred<ActionExecuteResult>();
        const execute = vi.fn<ExecuteReachRules>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const hook = await renderHook(() => useReachRulesState({ ...source, rules: [] }, execute));
        const machine = { target: { t: 'machine' as const, machineId: 'm1' }, enabled: true };
        const project = { target: { t: 'project' as const, projectKey: 'project' }, enabled: true };
        let one!: Promise<unknown>; let two!: Promise<unknown>;
        act(() => {
            one = hook.getCurrent().change({ kind: 'write', write: { place: initial.target, state: 'on' } });
            two = hook.getCurrent().change({ kind: 'replace', rules: [machine, project] });
        });
        const optimisticIds = hook.getCurrent().rules.map(rule => rule.id);
        await act(async () => { first.resolve({ ok: true, result: { ok: true, revision: 2,
            items: [{ serverId: 'server', rules: [initial], previous: [] }] } }); await one; });
        expect(new Set(hook.getCurrent().rules.map(rule => rule.id)).size).toBe(2);
        expect(hook.getCurrent().rules.map(rule => rule.id)).toEqual(optimisticIds);
        await act(async () => { second.resolve({ ok: true, result: { ok: true, revision: 3, items: [{ serverId: 'server',
            previous: [initial], rules: [{ ...machine, id: 'machine-rule', createdAt: 3, updatedAt: 3 },
                { ...project, id: 'project-rule', createdAt: 3, updatedAt: 3 }] }] } }); await two; });
    });
});
