import { describe, expect, it, vi } from 'vitest';

import {
    createTerminateDetectedService,
    type TerminateProcessControl,
    type TerminateProcessIdentity,
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
    probeResults?: ReadonlyArray<TerminateProcessIdentity | null>;
    aliveResults?: readonly boolean[];
};

function fakeControl(overrides: ControlOverrides = {}): TerminateProcessControl & {
    signal: ReturnType<typeof vi.fn>;
    terminateWindowsTree: ReturnType<typeof vi.fn>;
} {
    const probeResults = overrides.probeResults ?? [{ pid: 4_321, startTime: 1_717_171_717_000 }, null];
    let probeIndex = 0;
    const aliveResults = overrides.aliveResults ?? [false];
    let aliveIndex = 0;

    const signal = vi.fn(async () => {});
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
        const control = fakeControl({ probeResults: [{ pid: 9_999 }] });
        const terminate = createTerminateDetectedService(control);

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'denied', reasonCode: 'identity_changed' });
        expect(control.signal).not.toHaveBeenCalled();
    });

    it('refuses to signal when the same pid was reused with a different process start time', async () => {
        const control = fakeControl({
            probeResults: [{ pid: 4_321, startTime: 1_717_171_999_000 }],
        });
        const terminate = createTerminateDetectedService(control);

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'denied', reasonCode: 'identity_changed' });
        expect(control.signal).not.toHaveBeenCalled();
    });

    it('refuses to signal a full-identity row when the action-time probe cannot reverify start time', async () => {
        const control = fakeControl({
            probeResults: [{ pid: 4_321 }],
        });
        const terminate = createTerminateDetectedService(control);

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'denied', reasonCode: 'identity_changed' });
        expect(control.signal).not.toHaveBeenCalled();
    });

    it('refuses to signal when the same pid/start time resolves to different process provenance', async () => {
        const control = fakeControl({
            probeResults: [{
                pid: 4_321,
                startTime: 1_717_171_717_000,
                command: 'node other-server.js',
                cwd: '/repo/web',
            }],
        });
        const terminate = createTerminateDetectedService(control);

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'denied', reasonCode: 'identity_changed' });
        expect(control.signal).not.toHaveBeenCalled();
    });

    it('treats an already-gone listener as idempotent success', async () => {
        const control = fakeControl({ probeResults: [null] });
        const terminate = createTerminateDetectedService(control);

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'succeeded' });
        expect(control.signal).not.toHaveBeenCalled();
    });

    it('sends a group SIGTERM for a run-wrapped child and succeeds without SIGKILL when it exits in grace', async () => {
        const control = fakeControl({
            probeResults: [{ pid: 4_321, startTime: 1_717_171_717_000 }, null],
            aliveResults: [false],
        });
        const terminate = createTerminateDetectedService(control, { graceMs: 1 });

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'succeeded' });
        expect(control.signal).toHaveBeenCalledTimes(1);
        expect(control.signal).toHaveBeenCalledWith({ pid: 4_321, signal: 'SIGTERM', group: true });
    });

    it('escalates to SIGKILL when the process is still alive after grace', async () => {
        const control = fakeControl({
            probeResults: [{ pid: 4_321, startTime: 1_717_171_717_000 }, null],
            aliveResults: [true],
        });
        const terminate = createTerminateDetectedService(control, { graceMs: 1 });

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'succeeded' });
        expect(control.signal).toHaveBeenNthCalledWith(1, { pid: 4_321, signal: 'SIGTERM', group: true });
        expect(control.signal).toHaveBeenNthCalledWith(2, { pid: 4_321, signal: 'SIGKILL', group: true });
    });

    it('signals the bare pid (not the group) for a non-wrapped single-pid process', async () => {
        const control = fakeControl({ probeResults: [{ pid: 4_321, startTime: 1_717_171_717_000 }, null], aliveResults: [false] });
        const terminate = createTerminateDetectedService(control, { graceMs: 1 });

        await terminate({
            request: request(),
            entry: entry({
                provenance: { process: { pid: 4_321, processStartTimeMs: 1_717_171_717_000, lineagePids: [4_321], command: 'server', redacted: true } },
            }),
            now: 0,
        });

        expect(control.signal).toHaveBeenCalledWith({ pid: 4_321, signal: 'SIGTERM', group: false });
    });

    it('reports port_not_released when our pid still holds the port after the kill', async () => {
        const control = fakeControl({
            probeResults: [{ pid: 4_321, startTime: 1_717_171_717_000 }],
            aliveResults: [false],
        });
        const terminate = createTerminateDetectedService(control, { graceMs: 1, verifyPollMs: 0, verifyAttempts: 3 });

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'failed', reasonCode: 'port_not_released' });
    });

    it('uses taskkill /T then /F on Windows', async () => {
        const control = fakeControl({
            platform: 'windows',
            probeResults: [{ pid: 4_321, startTime: 1_717_171_717_000 }, null],
            aliveResults: [true],
        });
        const terminate = createTerminateDetectedService(control, { graceMs: 1 });

        const result = await terminate({ request: request(), entry: entry(), now: 0 });

        expect(result).toEqual({ status: 'succeeded' });
        expect(control.terminateWindowsTree).toHaveBeenNthCalledWith(1, { pid: 4_321, force: false });
        expect(control.terminateWindowsTree).toHaveBeenNthCalledWith(2, { pid: 4_321, force: true });
        expect(control.signal).not.toHaveBeenCalled();
    });
});
