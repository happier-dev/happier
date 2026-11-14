import { describe, expect, it, vi } from 'vitest';
import type { LocalServiceActionRequestV1 } from '@happier-dev/protocol';

import { createProcessTreeTerminator } from '@/processes/terminate/terminateProcessTree';
import { readLinuxCensus } from '@/processes/census/linux';
import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';
import { localServiceProcfsFixture } from '../inventory/platform/censusFixture.testkit';
import { createTerminateDetectedService, type TerminateListenerProbeResult } from './terminate';

const PID = 4321;
const CHILD = 4322;
const free = { status: 'free' } as const;

function entry(startTime?: number): NormalizedLocalServiceInventoryEntry {
    return {
        id: 'entry-a', machineId: 'machine-a',
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        port: 5173, protocol: 'tcp', detectedAt: 1000, lastSeenAt: 2000,
        state: 'listening', source: 'detected', labels: [], confidence: 'high',
        processOwnershipConfidence: 'high', workspaceAssociationConfidence: 'high', diagnostics: [],
        provenance: { process: {
            pid: PID, lineagePids: [PID], command: 'npm run dev', cwd: '/repo/web', redacted: true,
            ...(startTime === undefined ? {} : { processStartTimeMs: startTime }),
        } },
    };
}
const request: LocalServiceActionRequestV1 = {
    requestId: 'req', action: 'terminate_detected', force: false,
    target: { kind: 'inventory_entry', machineId: 'machine-a', inventoryEntryId: 'entry-a' },
};

async function harness(input: Readonly<{ resistantChild?: boolean; survive?: boolean; signalError?: string; readFailure?: boolean; finalVerificationFailure?: boolean; absentRoot?: boolean }> = {}) {
    const live = new Set(input.absentRoot ? [] : [PID, CHILD]);
    let emptyReads = 0;
    const fixture = () => localServiceProcfsFixture([...live].map(pid => ({ pid, ppid: pid === CHILD && live.has(PID) ? PID : 1 })));
    const boundary = {
        readdir: async (path: string) => {
            if (input.readFailure) throw new Error('procfs unavailable');
            return fixture().readdir(path);
        },
        readFile: async (path: string) => {
            if (input.readFailure) throw new Error('procfs unavailable');
            // Targeted census proves self identity without enumerating the whole process table.
            if (input.finalVerificationFailure && live.size === 0 && path === `/proc/${process.pid}/stat` && ++emptyReads > 1) {
                throw new Error('final procfs verification unavailable');
            }
            return fixture().readFile(path);
        },
        readlink: async (path: string) => fixture().readlink(path),
    };
    const initial = await readLinuxCensus({ boundary: localServiceProcfsFixture([{ pid: PID }]), selfPid: process.pid, capturedAtMs: 0, logicalCpus: 4 });
    if (initial.status !== 'ok') throw new Error('fixture census unavailable');
    const start = initial.rows.find(row => row.pid === PID)?.start.startTimeMs;
    if (start === undefined) throw new Error('fixture identity unavailable');
    const held: TerminateListenerProbeResult = { status: 'held', identity: { pid: PID, startTime: start } };
    let index = 0;
    const probeListener = vi.fn(async (): Promise<TerminateListenerProbeResult> => index++ === 0 ? held : free);
    const kill = vi.fn((pid: number, signal: NodeJS.Signals) => {
        if (input.signalError) throw Object.assign(new Error(input.signalError), { code: input.signalError });
        if (!input.survive && (signal === 'SIGKILL' || !input.resistantChild || pid !== CHILD)) live.delete(pid);
    });
    const control = {
        probeListener,
        terminateTree: createProcessTreeTerminator({ platform: 'linux', kill, censusDependencies: { platform: 'linux', linuxBoundary: boundary } }),
    };
    const run = (target = entry(start)) => createTerminateDetectedService(control, { graceMs: 1 })({ request, entry: target, now: 3000 });
    return { run, probeListener, kill, live, start, held };
}

describe('createTerminateDetectedService', () => {
    it('interrupts the tree and forces its resistant child before confirming port release', async () => {
        const h = await harness({ resistantChild: true });
        await expect(h.run()).resolves.toEqual({ status: 'succeeded' });
        expect(h.live.size).toBe(0);
        expect(h.kill.mock.calls).toContainEqual([CHILD, 'SIGINT']);
        expect(h.kill.mock.calls).toContainEqual([CHILD, 'SIGKILL']);
        expect(h.kill.mock.calls).toContainEqual([PID, 'SIGINT']);
    });
    it('requires a listener observation generated after the action request', async () => {
        const h = await harness();
        await h.run();
        expect(h.probeListener).toHaveBeenNthCalledWith(1, { host: '127.0.0.1', port: 5173, notBefore: 3000 });
    });
    it.each([0, 1, -1])('refuses unsafe listener pid %s', async pid => {
        const h = await harness();
        const target = entry(h.start);
        await expect(h.run({ ...target, provenance: { process: { ...target.provenance!.process!, pid } } }))
            .resolves.toEqual({ status: 'denied', reasonCode: 'unsafe_pid' });
        expect(h.kill).not.toHaveBeenCalled();
    });
    it('refuses a missing process identity', async () => {
        const h = await harness();
        await expect(h.run({ ...entry(), provenance: {} })).resolves.toEqual({ status: 'denied', reasonCode: 'process_identity_unavailable' });
        expect(h.kill).not.toHaveBeenCalled();
    });
    it.each([{ pid: 9999 }, { pid: PID, startTime: 9999 }, { pid: PID }])('refuses changed or unverifiable listener identity %j', async identity => {
        const h = await harness();
        h.probeListener.mockResolvedValue({ status: 'held', identity });
        await expect(h.run()).resolves.toEqual({ status: 'denied', reasonCode: 'identity_changed' });
        expect(h.kill).not.toHaveBeenCalled();
    });
    it('refuses changed command provenance despite equal pid/start', async () => {
        const h = await harness();
        h.probeListener.mockResolvedValue({ status: 'held', identity: { pid: PID, startTime: h.start, command: 'other-server' } });
        await expect(h.run()).resolves.toEqual({ status: 'denied', reasonCode: 'identity_changed' });
        expect(h.kill).not.toHaveBeenCalled();
    });
    it('does not signal an already released listener', async () => {
        const h = await harness();
        h.probeListener.mockResolvedValue(free);
        await expect(h.run()).resolves.toEqual({ status: 'succeeded' });
        expect(h.kill).not.toHaveBeenCalled();
    });
    it('refuses an indeterminate listener observation', async () => {
        const h = await harness();
        h.probeListener.mockResolvedValue({ status: 'indeterminate' });
        await expect(h.run()).resolves.toEqual({ status: 'failed', reasonCode: 'listener_state_unverifiable' });
        expect(h.kill).not.toHaveBeenCalled();
    });
    it('refuses changed generation found by the shared terminator after the listener probe', async () => {
        const h = await harness();
        h.probeListener.mockResolvedValue({ status: 'held', identity: { pid: PID, startTime: h.start + 1000 } });
        await expect(h.run(entry())).resolves.toEqual({ status: 'denied', reasonCode: 'identity_changed' });
        expect(h.kill).not.toHaveBeenCalled();
    });
    it('does not report success for a freed port while a tree member survives', async () => {
        const h = await harness({ survive: true });
        await expect(h.run()).resolves.toEqual({ status: 'failed', reasonCode: 'terminate_signal_failed' });
        expect(h.live.size).toBe(2);
    });
    it('maps a shared census failure without signalling the listener alone', async () => {
        const h = await harness({ readFailure: true });
        await expect(h.run()).resolves.toEqual({ status: 'failed', reasonCode: 'process_tree_unresolved' });
        expect(h.kill).not.toHaveBeenCalled();
    });
    it('refuses success when the final fresh tree verification fails after the members ended', async () => {
        const h = await harness({ finalVerificationFailure: true });
        await expect(h.run()).resolves.toEqual({ status: 'failed', reasonCode: 'process_tree_unresolved' });
        expect(h.live.size).toBe(0);
    });
    it('maps a genuine OS permission refusal', async () => {
        const h = await harness({ signalError: 'EPERM' });
        await expect(h.run()).resolves.toEqual({ status: 'failed', reasonCode: 'terminate_permission_denied' });
    });
    it('reports the port still held after the shared terminator observed the tree end', async () => {
        const h = await harness();
        // A later release must not hide the fresh post-termination observation.
        h.probeListener.mockResolvedValue(free).mockResolvedValueOnce(h.held).mockResolvedValueOnce(h.held);
        await expect(h.run()).resolves.toEqual({ status: 'failed', reasonCode: 'port_not_released' });
        expect(h.live.size).toBe(0);
    });
    it('reports unverifiable port release after shared termination', async () => {
        const h = await harness();
        h.probeListener.mockResolvedValue({ status: 'indeterminate' }).mockResolvedValueOnce(h.held);
        await expect(h.run()).resolves.toEqual({ status: 'failed', reasonCode: 'port_release_unverified' });
    });
    it('accepts release when a different pid has rebound the port', async () => {
        const h = await harness();
        h.probeListener.mockResolvedValue({ status: 'held', identity: { pid: 9999 } }).mockResolvedValueOnce(h.held);
        await expect(h.run()).resolves.toEqual({ status: 'succeeded' });
    });
    it('accepts release when the pid was reused by a new listener generation', async () => {
        const h = await harness();
        h.probeListener.mockResolvedValue({ status: 'held', identity: { pid: PID, startTime: h.start + 1000 } }).mockResolvedValueOnce(h.held);
        await expect(h.run()).resolves.toEqual({ status: 'succeeded' });
    });
    it('names a stale listener observation when the process was gone before shared termination', async () => {
        const h = await harness({ absentRoot: true });
        h.probeListener.mockResolvedValue(h.held);
        await expect(h.run()).resolves.toEqual({ status: 'failed', reasonCode: 'terminate_no_process_signaled' });
        expect(h.kill).not.toHaveBeenCalled();
    });
});
