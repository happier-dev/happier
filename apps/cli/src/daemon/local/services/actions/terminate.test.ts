import { describe, expect, it, vi } from 'vitest';

import {
    createTerminateDetectedService,
    type TerminateDescendantResolution,
    type TerminateListenerProbeResult,
    type TerminateProcessControl,
    type TerminateProcessIdentity,
    type TerminateProcessSignalOutcome,
} from './terminate';
import type { LocalServiceActionRequestV1 } from '@happier-dev/protocol';
import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';

function entry(overrides: Partial<NormalizedLocalServiceInventoryEntry> = {}): NormalizedLocalServiceInventoryEntry {
    return {
        id: 'entry-a',
        machineId: 'machine-a',
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        port: 5173,
        protocol: 'tcp',
        detectedAt: 1_000,
        lastSeenAt: 2_000,
        state: 'listening',
        source: 'detected',
        labels: [],
        confidence: 'high',
        processOwnershipConfidence: 'high',
        workspaceAssociationConfidence: 'high',
        diagnostics: [],
        provenance: {
            process: {
                pid: 4_321,
                ppid: 300,
                processStartTimeMs: 1_717_171_717_000,
                lineagePids: [4_321, 300],
                command: 'npm run dev',
                cwd: '/repo/web',
                redacted: true,
            },
            workspace: { path: '/repo', association: 'cwd_containment' },
        },
        ...overrides,
    };
}

function request(): LocalServiceActionRequestV1 {
    return {
        requestId: 'req-1',
        action: 'terminate_detected',
        target: { kind: 'inventory_entry', machineId: 'machine-a', inventoryEntryId: 'entry-a' },
        confirmationNonce: 'nonce',
        force: false,
    };
}

type ControlOverrides = Partial<TerminateProcessControl> & {
    /** Sequence of probe results returned in order; last value repeats. */
    probeResults?: readonly TerminateListenerProbeResult[];
    aliveResults?: readonly boolean[];
    signalResults?: readonly TerminateProcessSignalOutcome[];
    descendantPids?: readonly number[];
    /** Descendant resolutions returned per `resolveDescendantPids` call, in order. */
    descendantRounds?: ReadonlyArray<TerminateDescendantResolution>;
};

function held(identity: TerminateProcessIdentity): TerminateListenerProbeResult {
    return { status: 'held', identity };
}

function fakeControl(overrides: ControlOverrides = {}): TerminateProcessControl & {
    resolveDescendantPids: ReturnType<typeof vi.fn>;
    signal: ReturnType<typeof vi.fn>;
    terminateWindowsTree: ReturnType<typeof vi.fn>;
} {
    const probeResults = overrides.probeResults ?? [
        held({ pid: 4_321, startTime: 1_717_171_717_000 }),
        { status: 'free' },
    ];
    let probeIndex = 0;
    const aliveResults = overrides.aliveResults ?? [false];
    let aliveIndex = 0;
    const signalResults = overrides.signalResults ?? [{ status: 'delivered', deliveredPids: [4_321] }];
    let signalIndex = 0;

    const descendantRounds = overrides.descendantRounds;
    let descendantRound = 0;
    const resolveDescendantPids = vi.fn(async (): Promise<TerminateDescendantResolution> => {
        if (descendantRounds) {
            const value = descendantRounds[Math.min(descendantRound, descendantRounds.length - 1)];
            descendantRound += 1;
            return value ?? { status: 'resolved', pids: [] };
        }
        return { status: 'resolved', pids: overrides.descendantPids ?? [4_322, 4_323] };
    });
    const signal = vi.fn(async () => {
        const value = signalResults[Math.min(signalIndex, signalResults.length - 1)];
        signalIndex += 1;
        return value;
    });
    const terminateWindowsTree = vi.fn(async () => {});

    return {
        platform: overrides.platform ?? 'posix',
        probeListener: overrides.probeListener ?? (async () => {
            const value = probeResults[Math.min(probeIndex, probeResults.length - 1)];
            probeIndex += 1;
            return value;
        }),
        isProcessAlive: overrides.isProcessAlive ?? (async () => {
            const value = aliveResults[Math.min(aliveIndex, aliveResults.length - 1)];
            aliveIndex += 1;
            return value;
        }),
        resolveDescendantPids,
        signal,
        terminateWindowsTree,
        wait: overrides.wait ?? (async () => {}),
    };
}

describe('createTerminateDetectedService', () => {
    it('refuses an unsafe pid (never signals pid 0/1)', async () => {
        const control = fakeControl();
        const terminate = createTerminateDetectedService(control);

        const result = await terminate({
            request: request(),
            entry: entry({
                provenance: {
                    process: { pid: 1, lineagePids: [1], command: 'init', redacted: true },
                },
            }),
            now: 0,
        });

        expect(result).toEqual({ status: 'denied', reasonCode: 'unsafe_pid' });
        expect(control.signal).not.toHaveBeenCalled();
    });

    it('refuses to signal when the port was rebound by a DIFFERENT pid (TOCTOU)', async () => {
        const control = fakeControl({ probeResults: [held({ pid: 9_999 })] });
        const terminate = createTerminateDetectedService(control);

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'denied', reasonCode: 'identity_changed' });
        expect(control.signal).not.toHaveBeenCalled();
    });

    it('refuses to signal when the same pid was reused with a different process start time', async () => {
        const control = fakeControl({
            probeResults: [held({ pid: 4_321, startTime: 1_717_171_999_000 })],
        });
        const terminate = createTerminateDetectedService(control);

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'denied', reasonCode: 'identity_changed' });
        expect(control.signal).not.toHaveBeenCalled();
    });

    it('refuses to signal a full-identity row when the action-time probe cannot reverify start time', async () => {
        const control = fakeControl({
            probeResults: [held({ pid: 4_321 })],
        });
        const terminate = createTerminateDetectedService(control);

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'denied', reasonCode: 'identity_changed' });
        expect(control.signal).not.toHaveBeenCalled();
    });

    it('refuses to signal when the same pid/start time resolves to different process provenance', async () => {
        const control = fakeControl({
            probeResults: [held({
                pid: 4_321,
                startTime: 1_717_171_717_000,
                command: 'node other-server.js',
                cwd: '/repo/web',
            })],
        });
        const terminate = createTerminateDetectedService(control);

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'denied', reasonCode: 'identity_changed' });
        expect(control.signal).not.toHaveBeenCalled();
    });

    it('treats an already-gone listener as idempotent success', async () => {
        const control = fakeControl({ probeResults: [{ status: 'free' }] });
        const terminate = createTerminateDetectedService(control);

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'succeeded' });
        expect(control.signal).not.toHaveBeenCalled();
    });

    it('refuses to signal when listener identity cannot be authoritatively revalidated', async () => {
        const control = fakeControl({ probeResults: [{ status: 'indeterminate' }] });
        const terminate = createTerminateDetectedService(control);

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'failed', reasonCode: 'listener_state_unverifiable' });
        expect(control.resolveDescendantPids).not.toHaveBeenCalled();
        expect(control.signal).not.toHaveBeenCalled();
    });

    it('resolves descendants once and sends SIGTERM to the captured process tree', async () => {
        const control = fakeControl({
            probeResults: [held({ pid: 4_321, startTime: 1_717_171_717_000 }), { status: 'free' }],
            aliveResults: [false],
            descendantPids: [4_322, 4_323],
        });
        const terminate = createTerminateDetectedService(control, { graceMs: 1 });

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'succeeded' });
        expect(control.resolveDescendantPids).toHaveBeenCalledOnce();
        expect(control.resolveDescendantPids).toHaveBeenCalledWith(4_321);
        expect(control.signal).toHaveBeenCalledTimes(1);
        expect(control.signal).toHaveBeenCalledWith({
            pid: 4_321,
            signal: 'SIGTERM',
            descendantPids: [4_322, 4_323],
        });
    });

    it('escalates to SIGKILL when the process is still alive after grace', async () => {
        const control = fakeControl({
            probeResults: [held({ pid: 4_321, startTime: 1_717_171_717_000 }), { status: 'free' }],
            aliveResults: [true],
            descendantPids: [4_322],
        });
        const terminate = createTerminateDetectedService(control, { graceMs: 1 });

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'succeeded' });
        expect(control.signal).toHaveBeenNthCalledWith(1, {
            pid: 4_321,
            signal: 'SIGTERM',
            descendantPids: [4_322],
        });
        expect(control.signal).toHaveBeenNthCalledWith(2, {
            pid: 4_321,
            signal: 'SIGKILL',
            descendantPids: [4_322],
        });
    });

    it('unions descendants spawned during the grace window into the SIGKILL round', async () => {
        // Surviving SIGTERM is exactly when a dev server may fork a replacement worker; the
        // first round's pids stay in the set because they may since have been orphaned onto init.
        const control = fakeControl({
            probeResults: [held({ pid: 4_321, startTime: 1_717_171_717_000 }), { status: 'free' }],
            aliveResults: [true],
            descendantRounds: [
                { status: 'resolved', pids: [4_322] },
                { status: 'resolved', pids: [4_323] },
            ],
        });
        const terminate = createTerminateDetectedService(control, { graceMs: 1 });

        await terminate({ request: request(), entry: entry(), now: 0 });

        expect(control.resolveDescendantPids).toHaveBeenCalledTimes(2);
        expect(control.signal).toHaveBeenNthCalledWith(2, {
            pid: 4_321,
            signal: 'SIGKILL',
            descendantPids: [4_322, 4_323],
        });
    });

    it('refuses to signal anything when the process table cannot be read', async () => {
        // The regression this pins: an unreadable process table used to resolve to "no
        // descendants", so terminate signalled the listener alone. Killing the listener frees
        // the port, so verification passed and the destructive action reported success while
        // the user's children kept running.
        const control = fakeControl({
            probeResults: [held({ pid: 4_321, startTime: 1_717_171_717_000 }), { status: 'free' }],
            descendantRounds: [{ status: 'unavailable' }],
        });
        const terminate = createTerminateDetectedService(control, { graceMs: 1 });

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'failed', reasonCode: 'process_tree_unresolved' });
        expect(control.signal).not.toHaveBeenCalled();
    });

    it('refuses to escalate to SIGKILL when the re-read of the process table fails', async () => {
        // Half a tree kill is still a partial kill: SIGTERM went out, the listener survived it,
        // and we can no longer establish what else has to die. Report it instead of forcing a
        // SIGKILL at a set we know is stale.
        const control = fakeControl({
            probeResults: [held({ pid: 4_321, startTime: 1_717_171_717_000 }), { status: 'free' }],
            aliveResults: [true],
            descendantRounds: [{ status: 'resolved', pids: [4_322] }, { status: 'unavailable' }],
        });
        const terminate = createTerminateDetectedService(control, { graceMs: 1 });

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'failed', reasonCode: 'process_tree_unresolved' });
        expect(control.signal).toHaveBeenCalledOnce();
        expect(control.signal).toHaveBeenCalledWith({
            pid: 4_321,
            signal: 'SIGTERM',
            descendantPids: [4_322],
        });
    });

    it('reports port_not_released when our pid still holds the port after the kill', async () => {
        const control = fakeControl({
            probeResults: [held({ pid: 4_321, startTime: 1_717_171_717_000 })],
            aliveResults: [false],
        });
        const terminate = createTerminateDetectedService(control, { graceMs: 1, verifyPollMs: 0, verifyAttempts: 3 });

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'failed', reasonCode: 'port_not_released' });
    });

    it('reports when no addressed process received a signal', async () => {
        const control = fakeControl({
            probeResults: [held({ pid: 4_321, startTime: 1_717_171_717_000 })],
            aliveResults: [false],
            signalResults: [{ status: 'no_process_signaled' }],
        });
        const terminate = createTerminateDetectedService(control, {
            graceMs: 1,
            verifyPollMs: 0,
            verifyAttempts: 1,
        });

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'failed', reasonCode: 'terminate_no_process_signaled' });
    });

    it('maps a refused POSIX signal to terminate_permission_denied', async () => {
        const control = fakeControl({
            probeResults: [held({ pid: 4_321, startTime: 1_717_171_717_000 })],
            signalResults: [{ status: 'permission_denied' }],
        });
        const terminate = createTerminateDetectedService(control);

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'failed', reasonCode: 'terminate_permission_denied' });
    });

    it('uses taskkill /T then /F on Windows', async () => {
        const control = fakeControl({
            platform: 'windows',
            probeResults: [held({ pid: 4_321, startTime: 1_717_171_717_000 }), { status: 'free' }],
            aliveResults: [true],
        });
        const terminate = createTerminateDetectedService(control, { graceMs: 1 });

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'succeeded' });
        expect(control.terminateWindowsTree).toHaveBeenNthCalledWith(1, { pid: 4_321, force: false });
        expect(control.terminateWindowsTree).toHaveBeenNthCalledWith(2, { pid: 4_321, force: true });
        expect(control.resolveDescendantPids).not.toHaveBeenCalled();
        expect(control.signal).not.toHaveBeenCalled();
    });
});
