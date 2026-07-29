import type { LocalServiceListenerFact } from '../inventory/scanner';
import { taskkillWindowsProcessTree } from '@/subprocess/supervision/taskkillWindowsProcessTree';
import {
    LOCAL_SERVICE_PROCESS_LINEAGE_MAX_DEPTH,
    recoverProcessLineageFacts,
    type LocalServiceProcessFact,
} from '../inventory/provenance';
import type {
    TerminateListenerProbeInput,
    TerminateProcessControl,
    TerminateProcessIdentity,
    TerminateProcessSignalInput,
    TerminateWindowsTreeInput,
} from './terminate';

/**
 * Real OS process-control adapter backing {@link TerminateDetectedService} (LSV-5).
 *
 * This is the system boundary the terminate orchestration injects: process signals,
 * liveness probes, the platform listener scan (for TOCTOU re-resolution), and the Windows
 * `taskkill` tree kill. Keeping it isolated lets the orchestration logic stay deterministically
 * unit-tested while the daemon supplies these real implementations.
 */

export type OsProcessControlScanResult = Readonly<{
    listeners: readonly LocalServiceListenerFact[];
    processes?: ReadonlyMap<number, LocalServiceProcessFact>;
}>;

export type CreateOsProcessControlInput = Readonly<{
    /** The same platform scan the inventory uses, so TOCTOU re-resolution sees live truth. */
    scan: () => Promise<OsProcessControlScanResult>;
    platform?: NodeJS.Platform;
    wait?: (ms: number) => Promise<void>;
}>;

function resolvePlatform(platform: NodeJS.Platform): 'posix' | 'windows' {
    return platform === 'win32' ? 'windows' : 'posix';
}

function hostsCompatible(scanned: string, requested: string): boolean {
    if (scanned === requested) return true;
    // A wildcard listener (`0.0.0.0`/`::`/`*`) answers loopback requests for the same port.
    return scanned === '0.0.0.0' || scanned === '::' || scanned === '*';
}

async function defaultWait(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}

export function createOsProcessControl(input: CreateOsProcessControlInput): TerminateProcessControl {
    const platform = resolvePlatform(input.platform ?? process.platform);
    const wait = input.wait ?? defaultWait;

    async function probeListener(probe: TerminateListenerProbeInput): Promise<TerminateProcessIdentity | null> {
        const result = await input.scan();
        const matches = result.listeners.filter(
            (listener) => listener.port === probe.port && typeof listener.pid === 'number',
        );
        const exact = matches.find((listener) => listener.address === probe.host);
        const chosen = exact ?? matches.find((listener) => hostsCompatible(listener.address, probe.host));
        if (!chosen || typeof chosen.pid !== 'number') return null;
        const recovered = result.processes?.has(chosen.pid)
            ? recoverProcessLineageFacts({
                listenerPid: chosen.pid,
                maxDepth: LOCAL_SERVICE_PROCESS_LINEAGE_MAX_DEPTH,
                processes: result.processes,
            })
            : undefined;
        const processStartTimeMs = recovered?.processStartTimeMs;
        return {
            pid: chosen.pid,
            ...(typeof processStartTimeMs === 'number' ? { startTime: processStartTimeMs } : {}),
            ...(recovered?.command ? { command: recovered.command } : {}),
            ...(recovered?.cwd ? { cwd: recovered.cwd } : {}),
        };
    }

    async function isProcessAlive(pid: number): Promise<boolean> {
        try {
            // Signal 0 performs no kill but throws ESRCH when the pid is gone.
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'EPERM';
        }
    }

    async function signal(signalInput: TerminateProcessSignalInput): Promise<void> {
        // Negative pid signals the process group; the run-wrapper child shares the leader's group.
        const target = signalInput.group ? -Math.abs(signalInput.pid) : signalInput.pid;
        try {
            process.kill(target, signalInput.signal);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            // The process exiting between our liveness check and the signal is success, not failure.
            if (code === 'ESRCH') return;
            throw error;
        }
    }

    async function terminateWindowsTree(treeInput: TerminateWindowsTreeInput): Promise<void> {
        await taskkillWindowsProcessTree(treeInput);
    }

    return {
        platform,
        probeListener,
        isProcessAlive,
        signal,
        terminateWindowsTree,
        wait,
    };
}
