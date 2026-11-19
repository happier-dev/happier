import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { useBulkSessionComposer } from './useBulkSessionComposer';

afterEach(standardCleanup);
it('keeps the host quiet while nonempty message text changes and sends the latest text', async () => {
    const address = { serverId: 'home', sessionId: 'active' };
    const targets = [{ address, agentId: 'agent', machineId: 'machine' }];
    let renders = 0;
    const messages: unknown[] = [];
    const hook = await renderHook(() => {
        renders++;
        return useBulkSessionComposer({ targets, initialText: 'hello', executeConfirmed: async (_id, input) => {
            messages.push(input);
            return { ok: true, result: { kind: 'fanout', results: [{ target: address,
                result: { ok: true, result: { status: 'accepted', localId: 'input' } },
            }] } };
        } });
    });
    const before = renders;
    await act(async () => {
        for (let i = 0; i < 50; i++) hook.getCurrent().setText(`hello ${i}`);
    });
    expect(renders - before).toBe(0);
    await act(async () => { await hook.getCurrent().send(); });
    expect(messages).toEqual([expect.objectContaining({ message: 'hello 49' })]);
});

it('sends the latest per-item intent and leaves other overrides outside the Action payload', async () => {
    const address = { serverId: 'home', sessionId: 'active' };
    const targets = [{ address, agentId: 'agent', machineId: 'machine', capabilitySelection: {
        skills: { v: 1 as const, forceIncludeSkillIds: ['existing'], forceExcludeSkillIds: [], excludeNativeSkillNames: [] },
    } }];
    const payloads: unknown[] = [];
    const hook = await renderHook(() => useBulkSessionComposer({ targets, executeConfirmed: async (id, input) => {
        payloads.push({ id, input });
        return { ok: true, result: { kind: 'fanout', results: [
            { target: address, result: { ok: true, result: { ok: true } } },
        ] } };
    } }));
    await act(async () => {
        hook.getCurrent().setCapabilityItem({ kind: 'mcp_server', id: 'line', state: 'on' });
        hook.getCurrent().setCapabilityItem({ kind: 'mcp_server', id: 'line', state: 'off' });
        hook.getCurrent().setSelection({ permissionMode: 'yolo' });
    });
    await act(async () => { await hook.getCurrent().send(); });
    expect(payloads[0]).toEqual({ id: 'session.capabilities.set', input: {
        sessionId: { selector: 'sessions', addresses: [address] }, kind: 'mcp_server', id: 'line', state: 'off',
    } });
    expect(payloads).toHaveLength(2);
});

it('includes owner-skipped targets in consequences and the submitted results', async () => {
    const address = { serverId: 'home', sessionId: 'active' };
    const skipped = { serverId: 'home', sessionId: 'archived' };
    const hook = await renderHook(() => useBulkSessionComposer({
        targets: [{ address, agentId: 'agent', machineId: 'machine' }],
        skippedTargets: [{ address: skipped, reason: 'archived' }], initialText: 'hello',
        executeConfirmed: async () => ({ ok: true, result: { kind: 'fanout', results: [{ target: address,
            result: { ok: true, result: { status: 'accepted', localId: 'input' } },
        }] } }),
    }));
    expect(hook.getCurrent().consequences.skipped).toBe(1);
    await act(async () => { await hook.getCurrent().send(); });
    expect(hook.getCurrent().rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: skipped, state: 'skipped', code: 'archived' }),
    ]));
});

it('settles the unchanged peer while an empty-draft Agent switch is still running', async () => {
    const switching = { serverId: 'home', sessionId: 'muse' };
    const unchanged = { serverId: 'home', sessionId: 'codex' };
    const codex = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
    const targets = [
        { address: switching, agentId: 'happier.agent.muse/muse', machineId: 'machine' },
        { address: unchanged, agentId: 'happier.agent.codex/codex', machineId: 'machine' },
    ];
    const transition = Promise.withResolvers<void>();
    const hook = await renderHook(() => useBulkSessionComposer({
        targets,
        executeConfirmed: async (_id, input) => {
            expect(input).toMatchObject({ sessionId: { selector: 'sessions', addresses: [switching] } });
            await transition.promise;
            return { ok: true, result: { type: 'accepted' } };
        },
    }));
    await act(async () => hook.getCurrent().setSelection({ agentTarget: codex }));
    let submission: Promise<void> | undefined;
    await act(async () => { submission = hook.getCurrent().send(); });
    try {
        expect(hook.getCurrent().rows).toMatchObject([
            { target: switching, state: 'applying' },
            { target: unchanged, state: 'skipped', code: 'no_change' },
        ]);
    } finally {
        await act(async () => { transition.resolve(); await submission; });
    }
    expect(hook.getCurrent().rows.map(row => row.state)).toEqual(['switched', 'skipped']);
});

it('keeps changes pending until Send and retries failures using the captured message and selection', async () => {
    const a = { serverId: 'home', sessionId: 'a' };
    const b = { serverId: 'home', sessionId: 'b' };
    const targets = [a, b].map(address => ({ address, agentId: 'agent', machineId: 'machine' }));
    const calls: unknown[] = [];
    const hook = await renderHook(() => useBulkSessionComposer({ targets, initialText: 'original',
        executeConfirmed: async (actionId, input) => {
            calls.push({ actionId, input });
            if (actionId === 'session.permission_mode.set') return { ok: true, result: {} };
            return { ok: true, result: { kind: 'fanout', results: calls.length === 2 ? [
                { target: a, result: { ok: true, result: { status: 'accepted', localId: 'a-input' } } },
                { target: b, result: { ok: false, errorCode: 'target_unavailable', error: 'offline' } },
            ] : [{ target: b, result: { ok: true, result: { status: 'accepted', localId: 'b-input' } } }] } };
        } }));
    await act(async () => hook.getCurrent().setSelection({ permissionMode: 'yolo' }));
    expect(calls).toEqual([]);
    await act(async () => { await hook.getCurrent().send(); });
    await act(async () => { hook.getCurrent().setText('edited'); hook.getCurrent().setSelection({ permissionMode: 'read-only' }); });
    await act(async () => { await hook.getCurrent().retryFailed(); });
    expect(calls.slice(2)).toEqual([
        { actionId: 'session.permission_mode.set', input: { permissionMode: 'yolo', sessionId: { selector: 'sessions', addresses: [b] } } },
        { actionId: 'session.message.send', input: { message: 'original', permissionModeOverride: 'yolo', sessionId: { selector: 'sessions', addresses: [b] } } },
    ]);
    expect(hook.getCurrent().rows.map(row => row.state)).toEqual(['sent', 'sent']);
});

it('keeps other failed targets retryable after a per-row retry', async () => {
    const addresses = ['a', 'b'].map(sessionId => ({ serverId: 'home', sessionId }));
    const targets = addresses.map(address => ({ address, agentId: 'agent', machineId: 'machine' }));
    let calls = 0;
    const hook = await renderHook(() => useBulkSessionComposer({ targets, initialText: 'send',
        executeConfirmed: async (_id, input) => {
            calls++;
            const selected = (input as { sessionId: { addresses: typeof addresses } }).sessionId.addresses;
            return { ok: true, result: { kind: 'fanout', results: selected.map(target => ({ target,
                result: calls === 1 ? { ok: false, error: 'offline', errorCode: 'target_unavailable' }
                    : { ok: true, result: { status: 'accepted', localId: `input-${target.sessionId}` } },
            })) } };
        } }));
    await act(async () => { await hook.getCurrent().send(); });
    await act(async () => { await hook.getCurrent().retryFailed(addresses[0]); });
    await act(async () => { await hook.getCurrent().retryFailed(addresses[1]); });
    expect(calls).toBe(3);
    expect(hook.getCurrent().failedTargets).toEqual([]);
});

it('retries only current failures, in bulk or by address, and puts failures first', async () => {
    const targets = ['sent', 'first-failure', 'waking', 'second-failure'].map(sessionId => ({
        address: { serverId: 'home', sessionId }, agentId: 'agent', machineId: 'machine',
    }));
    const calls: string[][] = [];
    const hook = await renderHook(() => useBulkSessionComposer({
        targets, initialText: 'send',
        executeConfirmed: async (_id, input) => {
            const { addresses } = (input as { sessionId: { addresses: (typeof targets)[number]['address'][] } }).sessionId;
            calls.push(addresses.map(address => address.sessionId));
            return { ok: true, result: { kind: 'fanout', results: addresses.map(target => ({
                target,
                result: calls.length > 1 || target.sessionId === 'sent'
                    ? { ok: true, result: { status: 'accepted', localId: target.sessionId } }
                    : { ok: false, error: 'Unavailable', errorCode: target.sessionId === 'waking'
                        ? 'managed_wake_unconfirmed' : 'target_unavailable' },
            })) } };
        },
    }));
    await act(async () => { await hook.getCurrent().send(); });
    expect(hook.getCurrent().rows.map(row => row.state)).toEqual(['failed', 'failed', 'waking', 'sent']);
    await act(async () => { await hook.getCurrent().retryFailed(targets[1]!.address); });
    await act(async () => { await hook.getCurrent().retryFailed(); });
    expect(calls.slice(1)).toEqual([['first-failure'], ['second-failure']]);
});

it('replans retry against current Agent facts after a successful switch and failed message', async () => {
    const address = { serverId: 'home', sessionId: 'a' };
    let targets = [{ address, agentId: 'old/agent', machineId: 'machine' }];
    const calls: string[] = [];
    const hook = await renderHook(() => useBulkSessionComposer({ targets, initialText: 'hello',
        executeConfirmed: async actionId => {
            calls.push(actionId);
            return { ok: true, result: { kind: 'fanout', results: [{ target: address,
                result: actionId === 'session.agent.transition' ? { ok: true, result: { type: 'accepted' } }
                    : calls.length === 2 ? { ok: false, error: 'offline', errorCode: 'target_unavailable' }
                        : { ok: true, result: { status: 'accepted', localId: 'input' } },
            }] } };
        } }));
    await act(async () => hook.getCurrent().setSelection({ agentTarget: {
        kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
    } }));
    await act(async () => { await hook.getCurrent().send(); });
    targets = [{ address, agentId: 'happier.agent.codex/codex', machineId: 'machine' }];
    await hook.rerender();
    await act(async () => { await hook.getCurrent().retryFailed(); });
    expect(calls).toEqual(['session.agent.transition', 'session.message.send', 'session.message.send']);
});
