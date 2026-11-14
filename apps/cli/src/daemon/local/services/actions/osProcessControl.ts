import { createProcessTreeTerminator, terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import type { createProcessOwnershipRuntime } from '@/daemon/processes/ownership/processOwnershipRuntime';
import { equalProcessStart, resolveRawProcessControlRefusal } from '@/daemon/processes/ownership/types';
import type { NormalizedLocalServiceInventorySnapshot } from '../inventory/scanner';
import type { TerminateListenerProbeInput, TerminateListenerProbeResult, TerminateProcessControl } from './terminate';

/** Listener probes share the inventory refresh; all process control uses the shared terminator. */
export type CreateOsProcessControlInput = Readonly<{
    refreshInventory: () => Promise<NormalizedLocalServiceInventorySnapshot>;
    platform?: NodeJS.Platform;
    wait?: (ms: number) => Promise<void>;
    /** Genuine OS signal boundary, passed directly to the shared process owner. */
    kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
    /** The installed daemon's one ownership owner; consumes the terminator's census. */
    processOwnershipRuntime?: Pick<ReturnType<typeof createProcessOwnershipRuntime>, 'resolveSnapshot'>;
}>;

function hostsCompatible(scanned: string, requested: string): boolean {
    if (scanned === requested) return true;
    // A wildcard listener (`0.0.0.0`/`::`/`*`) answers loopback requests for the same port.
    return scanned === '0.0.0.0' || scanned === '::' || scanned === '*';
}

export function createOsProcessControl(input: CreateOsProcessControlInput): TerminateProcessControl {
    const terminateTree = input.platform || input.kill || input.wait
        ? createProcessTreeTerminator({
            platform: input.platform,
            kill: input.kill,
            wait: input.wait,
            ...(input.platform ? { censusDependencies: { platform: input.platform } } : {}),
        })
        : terminateProcessTree;

    async function probeListener(probe: TerminateListenerProbeInput): Promise<TerminateListenerProbeResult> {
        let snapshot = await input.refreshInventory();
        if (typeof probe.notBefore === 'number' && snapshot.generatedAt < probe.notBefore) {
            // The single-flight refresh handed us a pass that started before this request. One
            // re-read is enough: the previous pass has settled, so the next one is ours.
            snapshot = await input.refreshInventory();
            if (snapshot.generatedAt < probe.notBefore) {
                return { status: 'indeterminate' };
            }
        }
        if (snapshot.refreshState === 'error') {
            // A failed listener scan retains the previous entries verbatim, still marked
            // `listening`. Reading that as truth would revalidate identity against stale facts.
            return { status: 'indeterminate' };
        }
        const matches = snapshot.entries.filter(
            (entry) => entry.state === 'listening' && entry.port === probe.port,
        );
        const exact = matches.find((entry) => entry.address.host === probe.host);
        const chosen = exact ?? matches.find((entry) => hostsCompatible(entry.address.host, probe.host));
        if (!chosen) return { status: 'free' };
        const listenerProcess = chosen.provenance?.process;
        if (!listenerProcess) {
            // Something holds the port but the scan could not attribute it to a pid.
            return { status: 'indeterminate' };
        }
        return {
            status: 'held',
            identity: {
                pid: listenerProcess.pid,
                ...(typeof listenerProcess.processStartTimeMs === 'number'
                    ? { startTime: listenerProcess.processStartTimeMs }
                    : {}),
                ...(listenerProcess.command ? { command: listenerProcess.command } : {}),
                ...(listenerProcess.cwd ? { cwd: listenerProcess.cwd } : {}),
            },
        };
    }

    const ownership = input.processOwnershipRuntime;
    const terminateWithOwnership: TerminateProcessControl['terminateTree'] = ownership ? async request => {
        let refusal: string | null = null;
        const result = await terminateTree({ ...request, authorizeSnapshot: async (snapshot, targets) => {
            if (request.authorizeSnapshot && !await request.authorizeSnapshot(snapshot, targets)) return false;
            const observed = await ownership.resolveSnapshot(snapshot, undefined, { requesterAttribution: 'retained' });
            if (observed.status !== 'ok') { refusal = 'ownership_unavailable'; return false; }
            if (!targets) { refusal = 'ownership_unavailable'; return false; }
            const captured = new Map(targets.map(target => [target.pid, target.start]));
            for (const row of observed.rows) if (captured.has(row.pid) && equalProcessStart(captured.get(row.pid)!, row.start)) {
                refusal = resolveRawProcessControlRefusal(row.owner) ?? (row.level === 'unknown' ? 'ownership_unavailable' : null);
                if (refusal) return false;
            }
            return true;
        } });
        return refusal ? { ...result, outcomes: result.outcomes.map(row => row.outcome === 'refused' ? { ...row, reason: refusal! } : row) } : result;
    } : terminateTree;
    return { probeListener, terminateTree: terminateWithOwnership };
}
