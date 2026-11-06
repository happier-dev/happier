import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { prepareCliManagedMachineWake } from './managedMachineWake';

// Socket.IO is the external push boundary; shared preparation and readiness stay real.
const wire = vi.hoisted(() => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const emit = (event: string, ...args: unknown[]) => { for (const listener of [...(listeners.get(event) ?? [])]) listener(...args); };
    const socket = { connected: false, io: { timeout() {}, on() {}, off() {} },
        on(event: string, listener: (...args: unknown[]) => void) { const group = listeners.get(event) ?? new Set(); group.add(listener); listeners.set(event, group); },
        off(event: string, listener: (...args: unknown[]) => void) { listeners.get(event)?.delete(listener); },
        connect() { socket.connected = true; emit('connect'); },
        disconnect() { socket.connected = false; emit('disconnect', 'client disconnect'); }, removeAllListeners() { listeners.clear(); }, offAny() {},
    };
    return { socket, emit, io: vi.fn(() => socket) };
});
vi.mock('socket.io-client', () => ({ io: wire.io }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it.each(['ready', 'cancelled'] as const)('settles admitted CLI wake on exact guest %s without polling', async outcome => {
    vi.useFakeTimers();
    let managed = ManagedMachineV1Schema.parse({ id: 'retained', homeId: 'srv_home', custodianAccountId: 'owner',
        enrolledMachineId: 'guest', allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 4,
        launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        resource: { contributionRef: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
        controller: { machineId: 'controller', installationId: 'installation' },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        observation: { availability: 'present', power: 'stopped', storage: 'retained', observedAt: 1 },
    });
    const reads: string[] = [];
    let online = false;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        reads.push(String(url));
        return { status: 200, data: { machine: { id: 'guest', active: online, kind: 'persistent', revokedAt: null, replacedByMachineId: null,
            managedMachineRef: { homeId: managed.homeId, managedId: managed.id } } } };
    });
    const effects: string[] = [];
    // The host supplies network execution. The reviewed-child matcher and its
    // original-operand binding remain the production protocol implementation.
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url) => {
        if (String(url).endsWith('/get')) return { status: 200, data: managed };
        effects.push('wake'); managed = { ...managed, observation: { ...managed.observation!, power: 'running' } };
        return { status: 200, data: { kind: 'accepted', managedId: managed.id, intentRevision: 5 } };
    });
    const abort = new AbortController();
    const context = { surface: 'cli' as const, signal: abort.signal };
    const plan = await prepareCliManagedMachineWake({ actionId: 'daemon.filesystem.readFile', input: { rootPath: '/work', path: 'a' }, context,
        machineRuntimeDemand: { target: { kind: 'machine', machineId: 'guest' } } }, {
        provisionerAccount: { token: 'owner-token', credentials: { token: 'owner-token', encryption: null }, serverUrl: 'https://home.test' },
        readSessionMachineId: async () => null,
        managedMachineAction: async request => (await axios.post('https://home.test/get', request.input)).data,
    });
    expect(plan && !('ok' in plan) && plan.executeAdmittedAction).toBeTypeOf('function');
    if (!plan || 'ok' in plan || !plan.executeAdmittedAction) throw new Error('runtime_closure_missing');
    const hostReviewedChild = createHostReviewedChildPortV1({ actionId: 'daemon.filesystem.readFile', input: {}, context,
        plan, reviewAdmitted: true,
        execute: async input => ({ ok: true, result: (await axios.post('https://home.test/power', input)).data }),
    });
    const pending = plan.executeAdmittedAction({ actionId: 'daemon.filesystem.readFile', input: {}, context: { ...context, hostReviewedChild },
        execute: async (_context, target) => { effects.push('run'); return { ok: true, result: target }; } });
    await vi.advanceTimersByTimeAsync(0);
    expect(effects).toEqual(['wake']);
    const initialReads = reads.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reads).toHaveLength(initialReads);
    wire.emit('update', { id: 'unrelated', seq: 1, createdAt: 1, body: { t: 'update-machine', machineId: 'other' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toHaveLength(initialReads);
    if (outcome === 'ready') {
        online = true;
        wire.emit('update', { id: 'ready', seq: 2, createdAt: 2, body: { t: 'update-machine', machineId: 'guest' } });
        await expect(pending).resolves.toEqual({ ok: true, result: { machineId: 'guest' } });
        expect(effects).toEqual(['wake', 'run']);
    } else {
        const rejected = expect(pending).rejects.toThrow('cancelled_by_caller');
        abort.abort(new Error('cancelled_by_caller'));
        await rejected;
        expect(effects).toEqual(['wake']);
    }
    expect(post.mock.calls.filter(([url]) => String(url).endsWith('/power'))).toHaveLength(1);
    expect(wire.socket.connected).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
});
