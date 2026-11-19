import { describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '@/daemon/types';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';

import { createSessionRunnerRespawnManager } from './sessionRunnerRespawn';
import { createSparedHeldAgentCustody } from './sparedHeldAgents';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';
import {
    attachSessionHolderChild, createSessionHolderSocketPath, requireSessionHolderExecutablePath, spawnSessionHolderChild,
    type SessionHeldAgentV1,
} from '@/subprocess/supervision/sessionHolder';

/**
 * A crashed runner's held primary Agent through the real respawn owner: handed
 * to the respawned runner on success, ended on every give-up. The owner
 * remainder is recorded here (its real process behavior is proven in
 * endOwnerRemainder.test.ts); the holder probe is the OS socket boundary.
 */

const held = Object.freeze({ role: 'primary' as const, socketPath: '/run/user/1/happier-holders-1/a.sock', holderPid: 4101, agentPid: 4102 });

function scenario(overrides: Partial<Parameters<typeof createSessionRunnerRespawnManager>[0]> = {}, nativeAgent?: SessionHeldAgentV1) {
    const ended: string[] = [];
    const endedTurns: (string | null)[] = [];
    const spawned: SpawnSessionOptions[] = [];
    const custody = createSparedHeldAgentCustody({
        ownerRemainder: { end: async owner => { ended.push(owner.kind === 'session' ? owner.sessionId : 'other'); return { status: 'complete', outcomes: [] }; } },
        endTurn: async tracked => { endedTurns.push(tracked.activeTurnId ?? null); },
        ...(nativeAgent ? {} : { probe: async (candidate: SessionHeldAgentV1) => candidate.holderPid === held.holderPid }),
    });
    const manager = createSessionRunnerRespawnManager({
        enabled: true, maxRestarts: 3, baseDelayMs: 0, maxDelayMs: 0, jitterMs: 0, random: () => 0,
        isSessionAlreadyRunning: () => false,
        spawnSession: async options => { spawned.push(options); return { type: 'success' }; },
        onRespawnSuccess: ({ sessionId }) => custody.handOver(sessionId),
        onRespawnTerminal: async ({ sessionId }) => { await custody.end(sessionId); },
        logDebug: () => {}, logWarn: () => {},
        ...overrides,
    });
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(4100), pid: 4100, happySessionId: 'cs1', startedBy: 'daemon', processStartTimeMs: Date.now() - 1_000, activeTurnId: 'turn-7',
        spawnOptions: { directory: '/tmp/work' } as SpawnSessionOptions, heldAgentsV1: [nativeAgent ?? held] } as TrackedSession;
    // What onChildExited does for an unexpected runner exit before asking the respawn owner.
    const crash = async () => {
        const spare = await custody.spare(tracked);
        if (spare) tracked.sparedHeldAgentV1 = { ...spare.held, ...(spare.turnId ? { turnId: spare.turnId } : {}) };
        spare?.handOff();
        return manager.handleUnexpectedExit(tracked, { reason: 'process-exited', code: 1, signal: null });
    };
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 5)); await manager.awaitTerminalSettlement('cs1'); };
    return { ended, endedTurns, spawned, manager, crash, settle, custody };
}

describe('spared held Agent custody through the respawn owner', () => {
    it('hands the spared Agent to the respawned runner and does not end it', async () => {
        const run = scenario();
        expect(await run.crash()).toBe('scheduled');
        await run.settle();
        // The running turn travels with the Agent: the respawned runner completes it.
        expect(run.spawned.map(options => options.adoptSessionHolder)).toEqual([
            { socketPath: held.socketPath, holderPid: held.holderPid, agentPid: held.agentPid, turnId: 'turn-7' }]);
        expect(run.ended).toEqual([]);
        expect(run.endedTurns).toEqual([]);
        // Handed over: a later give-up of another cycle has nothing spared to end.
        await run.custody.end('cs1');
        expect(run.ended).toEqual([]);
    });

    it.each([
        ['no restart', { maxRestarts: 0 }],
        ['already running', { isSessionAlreadyRunning: () => true }],
        ['startup failure', { readStartupFailure: async () => ({ scope: 'primary_session', status: 'failed', source: 'dependency_failure',
            code: 'dependency_missing', occurredAt: Date.now() }) as never }],
    ] as const)('ends the spared Agent when the respawn gives up (%s)', async (_branch, overrides) => {
        const run = scenario(overrides as never);
        await run.crash();
        await run.settle();
        expect(run.ended).toEqual(['cs1']);
        expect(run.endedTurns).toEqual(['turn-7']);
        expect(run.spawned).toEqual([]);
    });

    it('ends the spared Agent when Stop arrives while the respawn is pending', async () => {
        const run = scenario({ baseDelayMs: 200, maxDelayMs: 200 });
        expect(await run.crash()).toBe('scheduled');
        run.manager.markStopRequested('cs1', { source: 'test', requestedAtMs: Date.now() } as never);
        await run.settle();
        expect(run.ended).toEqual(['cs1']);
        expect(run.spawned).toEqual([]);
    });

    it('ends the spared Agent when the exit observation leaves before handing it to the respawn owner', async () => {
        const run = scenario();
        const tracked = { trackingKey: legacyPidSessionTrackingKey(4100), pid: 4100, happySessionId: 'cs1', startedBy: 'daemon', heldAgentsV1: [held] } as TrackedSession;
        const spare = await run.custody.spare(tracked);
        await spare!.abandon();
        expect(run.ended).toEqual(['cs1']);
        // Handed off: the observation's settle is a no-op; the respawn owner decides.
        const handed = await run.custody.spare(tracked);
        handed!.handOff();
        await handed!.abandon();
        expect(run.ended).toEqual(['cs1']);
    });

    it('probes and ends a Session target\'s held Agent in its target, never as a process of this Machine', async () => {
        const local: string[] = [];
        const reached: string[] = [];
        const ended: string[] = [];
        const custody = createSparedHeldAgentCustody({
            ownerRemainder: { end: async () => ({ status: 'complete', outcomes: [] }) },
            endTurn: async () => undefined,
            probe: async candidate => { local.push(candidate.socketPath); return true; },
            target: {
                probe: async (tracked, candidate) => { reached.push(`${tracked.spawnOptions?.managedTargetPlacement?.managedId}:${candidate.agentPid}`); return true; },
                end: async (tracked, candidate) => { ended.push(`${tracked.spawnOptions?.managedTargetPlacement?.managedId}:${candidate.agentPid}`); },
            },
        });
        const placed = { trackingKey: legacyPidSessionTrackingKey(4200), pid: 4200, happySessionId: 'cs2', startedBy: 'daemon',
            spawnOptions: { directory: '/tmp/work', managedTargetPlacement: { managedId: 'row-1', workspaceRoot: '/workspace' } } as SpawnSessionOptions,
            heldAgentsV1: [{ ...held, socketPath: '/home/guest/.happier/run/primary.sock' }] } as TrackedSession;
        const spare = await custody.spare(placed);
        expect(spare?.held.socketPath).toBe('/home/guest/.happier/run/primary.sock');
        expect({ local, reached }).toEqual({ local: [], reached: ['row-1:4102'] });
        spare!.handOff();
        await custody.end('cs2');
        expect(ended).toEqual(['row-1:4102']);
    });

    it('ends the target-held Agent of a reattached placed runner that leaves without a spare (its relay ended with the previous daemon)', async () => {
        const ended: string[] = [];
        const custody = createSparedHeldAgentCustody({
            ownerRemainder: { end: async () => ({ status: 'complete', outcomes: [] }) },
            endTurn: async () => undefined,
            target: { probe: async () => true, end: async (tracked, candidate) => { ended.push(`${tracked.happySessionId}:${candidate.agentPid}`); } },
        });
        const placement = { managedId: 'row-1', workspaceRoot: '/workspace' };
        const session = (id: string, extra: Partial<TrackedSession>) => ({ trackingKey: legacyPidSessionTrackingKey(4300), pid: 4300, happySessionId: id, startedBy: 'daemon',
            heldAgentsV1: [held], ...extra }) as TrackedSession;
        await custody.endStranded(session('reattached', { reattachedFromDiskMarker: true,
            spawnOptions: { directory: '/tmp/work', managedTargetPlacement: placement } as SpawnSessionOptions }));
        // This daemon's own placement stopped its Agents through the relay; a local Session has no target.
        await custody.endStranded(session('placed-here', { spawnOptions: { directory: '/tmp/work', managedTargetPlacement: placement } as SpawnSessionOptions }));
        await custody.endStranded(session('local', { reattachedFromDiskMarker: true, spawnOptions: { directory: '/tmp/work' } as SpawnSessionOptions }));
        expect(ended).toEqual(['reattached:4102']);
    });

    it('serves a reattached placed runner\'s relay again after a daemon restart; its exit releases the relay and ends no Agent it stopped itself', async () => {
        const ended: string[] = [];
        const served: string[] = [];
        const released: string[] = [];
        const custody = createSparedHeldAgentCustody({
            ownerRemainder: { end: async () => ({ status: 'complete', outcomes: [] }) },
            endTurn: async () => undefined,
            target: { probe: async () => true, end: async (tracked, candidate) => { ended.push(`${tracked.happySessionId}:${candidate.agentPid}`); },
                serveRelay: async (tracked, candidate) => { served.push(`${tracked.happySessionId}:${candidate.relaySocketPath}`);
                    return () => { released.push(tracked.happySessionId!); }; } },
        });
        const placement = { managedId: 'row-1', workspaceRoot: '/workspace' };
        const relayed = { ...held, relaySocketPath: '/run/user/1/happier-holders-1/relay.sock' };
        const session = (id: string, pid: number, extra: Partial<TrackedSession>) => ({ trackingKey: legacyPidSessionTrackingKey(pid), pid, happySessionId: id, startedBy: 'daemon',
            heldAgentsV1: [relayed], ...extra }) as TrackedSession;
        const reattached = session('reattached', 4300, { reattachedFromDiskMarker: true,
            spawnOptions: { directory: '/tmp/work', managedTargetPlacement: placement } as SpawnSessionOptions });
        const crashed = session('crashed', 4400, { reattachedFromDiskMarker: true,
            spawnOptions: { directory: '/tmp/work', managedTargetPlacement: placement } as SpawnSessionOptions });
        await custody.restoreRelays([reattached, crashed,
            // A local Session and a runner this daemon placed (its relay is live) have nothing to restore.
            session('local', 4500, { reattachedFromDiskMarker: true, spawnOptions: { directory: '/tmp/work' } as SpawnSessionOptions }),
            session('placed-here', 4600, { spawnOptions: { directory: '/tmp/work', managedTargetPlacement: placement } as SpawnSessionOptions })]);
        expect(served).toEqual([`reattached:${relayed.relaySocketPath}`, `crashed:${relayed.relaySocketPath}`]);

        // The runner reached its Agent again and stopped it through its holder: its final exit only releases the relay.
        await custody.endStranded(reattached);
        expect({ ended, released }).toEqual({ ended: [], released: ['reattached'] });
        // A crash of a restored runner: the respawn places the Session anew, so the restored relay is released.
        await custody.spare(crashed);
        expect(released).toEqual(['reattached', 'crashed']);
    });

    it('spares nothing when the holder is not the recorded adoptable one', async () => {
        const run = scenario({ maxRestarts: 0 });
        const custody = createSparedHeldAgentCustody({ ownerRemainder: { end: async () => ({ status: 'complete', outcomes: [] }) },
            endTurn: async () => undefined, probe: async () => false });
        expect(await custody.spare({ trackingKey: legacyPidSessionTrackingKey(1), pid: 1, happySessionId: 'cs1', startedBy: 'daemon', heldAgentsV1: [held] } as TrackedSession)).toBeNull();
        expect(run.ended).toEqual([]);
    });

    it.skipIf(process.platform === 'win32').each(['not adoptable', 'respawn cancelled'] as const)('releases the exact local Agent after host loss (%s)', async (disposition) => {
        const socketPath = createSessionHolderSocketPath();
        const child = spawnSessionHolderChild({
            executablePath: requireSessionHolderExecutablePath(), socketPath, command: process.execPath,
            args: ['-e', 'process.stdin.resume()'], role: 'primary',
        });
        await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        const held = { role: 'primary' as const, socketPath, holderPid: child.holderPid!, agentPid: child.pid! };
        const custody = createSparedHeldAgentCustody({
            ownerRemainder: { end: async () => ({ status: 'complete', outcomes: [] }) },
            endTurn: async () => undefined,
        });
        const tracked: TrackedSession = {
            trackingKey: legacyPidSessionTrackingKey(43219), pid: 43219, happySessionId: 'request-wake-session',
            startedBy: 'daemon', heldAgentsV1: [held],
        };
        try {
            if (disposition === 'respawn cancelled') {
                expect(await child.request({ op: 'meta', value: { role: 'primary' } })).toMatchObject({ ok: true });
            }
            child.detach();
            if (disposition === 'respawn cancelled') {
                const run = scenario({ baseDelayMs: 30_000, maxDelayMs: 30_000 }, held);
                expect(await run.crash()).toBe('scheduled');
                // The runner is gone and the process census has no owner roots for this holder.
                run.manager.markStopRequested('cs1', { source: 'test', requestedAtMs: Date.now() } as never);
                await run.manager.awaitTerminalSettlement('cs1');
                expect(run.spawned).toEqual([]);
            } else {
                expect(await custody.spare(tracked)).toBeNull();
                await custody.endStranded({ ...tracked, heldAgentsV1: [{ ...held, holderPid: process.pid }] });
                expect(() => process.kill(held.agentPid, 0)).not.toThrow();
                await custody.endStranded(tracked);
            }
            expect(() => process.kill(held.agentPid, 0)).toThrow();
            await vi.waitFor(() => expect(() => process.kill(held.holderPid, 0)).toThrow());
        } finally {
            child.detach();
            const remaining = await (async () => {
                try { process.kill(held.agentPid, 0); } catch { return null; }
                return await attachSessionHolderChild(socketPath, 'primary').catch(() => null);
            })();
            if (remaining) {
                const exited = new Promise<void>(resolve => remaining.once('exit', () => resolve()));
                remaining.resumeDelivery();
                remaining.kill('SIGKILL');
                await exited;
                remaining.detach();
            }
        }
    }, 30_000);
});
