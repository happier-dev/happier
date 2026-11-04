import { BrowserOpenViewCommandV1Schema } from '@happier-dev/protocol/browser/control/v1';
import type { BrowserDaemonControlAdapter } from '@/daemon/browser/control/types';
import type { BrowserSidecarResourceTarget } from '@/daemon/browser/sidecar/controlAdapter';
import type { ManagedServiceResourceTarget } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import type { LocalServiceLauncherStartTarget } from '@/daemon/local/services/launch/start';
import type { LocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
import type { TerminateDetectedService } from '@/daemon/local/services/actions/terminate';
import type { TerminalPtySessionManager } from '@/terminal/pty/sessions';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { equalProcessStart, processOwnerKey, type HappierProcessRoot } from '../ownership/types';
import type { HappierProcessRootSource } from '../roots/listHappierProcessRoots';
import type { ProcessActionExecution, ProcessActionExecutorInput } from './processActionExecutor';

export type ProcessActionOwnerAdaptersInput = Readonly<{
    readServiceTargets?: () => readonly ManagedServiceResourceTarget[];
    readBrowsers?: () => readonly BrowserSidecarResourceTarget[];
    startService?: LocalServiceLauncherStartTarget;
    getBrowserAdapter?: () => Pick<BrowserDaemonControlAdapter, 'dispatchCommand'> | null;
    terminal?: Pick<TerminalPtySessionManager, 'close'>;
    refreshInventory?: LocalServicesDaemonRuntime['refreshInventoryNow'];
    terminateDetectedService?: TerminateDetectedService;
}>;

function sameRoot(expected: HappierProcessRoot, actual: HappierProcessRootSource): boolean {
    return expected.pid === actual.pid && processOwnerKey(expected.owner) === processOwnerKey(actual.owner)
        && (!actual.start || equalProcessStart(expected.start, actual.start))
        && (actual.processStartTimeMs === undefined || actual.processStartTimeMs === expected.start.startTimeMs);
}

async function isCurrent(execution: ProcessActionExecution): Promise<boolean> {
    return !execution.signal?.aborted && (!execution.verifyCurrent || await execution.verifyCurrent()) && !execution.signal?.aborted;
}

/** Consumes retained native owners after Process Action approval; never enters another Action ingress. */
export function createProcessActionOwnerAdapters(input: ProcessActionOwnerAdaptersInput): Required<Pick<ProcessActionExecutorInput,
    'stopOwner' | 'closeTerminal' | 'terminateDetected' | 'startOwner'>> & Readonly<{
        captureServiceRoot(target: ManagedServiceResourceTarget): HappierProcessRootSource;
        captureBrowserRoot(target: BrowserSidecarResourceTarget): HappierProcessRoot;
    }> {
    const captureServiceRoot = (target: ManagedServiceResourceTarget): HappierProcessRootSource => {
        const start = target.wayBack?.find(item => item.actionId === 'localServices.launcher.start');
        return !start ? target.root : { ...target.root, async startAgain(execution) {
            if (!await isCurrent(execution)) return { status: 'refused', reasonCode: 'access_denied' };
            if (!input.startService) return { status: 'refused', reasonCode: 'original_start_unavailable' };
            if (!execution.rpcContext) return { status: 'refused', reasonCode: 'machine_admission_required' };
            const originalIngress = execution.rpcContext;
            const verifyAdmission = originalIngress.verifyMachineAdmissionCurrent;
            const ingress = { ...originalIngress,
                signal: execution.signal ? AbortSignal.any([originalIngress.signal, execution.signal]) : originalIngress.signal,
                ...(verifyAdmission ? { verifyMachineAdmissionCurrent: async () =>
                    await isCurrent(execution) && await verifyAdmission() } : {}),
            };
            const originalContext = execution.actionContext ?? buildActionExecutorContextForRpc({ ...ingress,
                serverId: start.input.workspace?.serverId });
            const context = { ...originalContext, signal: originalContext.signal
                ? AbortSignal.any([originalContext.signal, ingress.signal]) : ingress.signal };
            const result = await input.startService(start.input, ingress, context);
            return result.status === 'succeeded' ? { status: 'started' }
                : { status: 'refused', reasonCode: result.reasonCode ?? 'managed_service_start_failed',
                    serviceStart: { request: start.input, response: result } };
        } };
    };
    const captureBrowserRoot = (target: BrowserSidecarResourceTarget): HappierProcessRoot => {
        // Explicit Process Actions consume the browser owner's purge intent;
        // Guard retains the original target.root.stop and its Session workspace.
        const root = target.stopAndPurge ? { ...target.root, stop: target.stopAndPurge } : target.root;
        const start = target.wayBack?.find(item => item.actionId === 'browser.view.open');
        const command = BrowserOpenViewCommandV1Schema.safeParse(start?.input);
        return !command.success ? root : { ...root, async startAgain(execution) {
            if (!await isCurrent(execution)) return { status: 'refused', reasonCode: 'access_denied' };
            const adapter = input.getBrowserAdapter?.();
            if (!adapter) return { status: 'refused', reasonCode: 'original_start_unavailable' };
            const result = await adapter.dispatchCommand(command.data, { signal: execution.signal });
            return result.status === 'dispatched' ? { status: 'started' }
                : { status: 'refused', reasonCode: result.error.code };
        } };
    };
    return {
        captureServiceRoot,
        captureBrowserRoot,
        async stopOwner(root, execution) {
            if (!await isCurrent(execution)) return { status: 'denied', reasonCode: 'access_denied' };
            if (!root.stop) return { status: 'denied', reasonCode: 'stop_owner_unavailable' };
            return await root.stop();
        },
        async closeTerminal(owner, execution) {
            if (!await isCurrent(execution)) return { status: 'denied', reasonCode: 'access_denied' };
            if (!input.terminal) return { status: 'denied', reasonCode: 'terminal_owner_unavailable' };
            const result = input.terminal.close({ terminalId: owner.terminalId });
            return result.ok ? result : { status: 'denied', reasonCode: result.errorCode };
        },
        async terminateDetected(row, execution) {
            if (!input.refreshInventory || !input.terminateDetectedService) return null;
            if (!await isCurrent(execution)) return { status: 'denied', reasonCode: 'access_denied' };
            const snapshot = await input.refreshInventory();
            const entry = snapshot.entries.find(entry => entry.state !== 'gone' && entry.provenance?.process?.pid === row.pid);
            if (!entry) return null;
            if (entry.provenance?.process?.processStartTimeMs !== row.start.startTimeMs) {
                return { status: 'denied', reasonCode: 'identity_changed' };
            }
            if (!await isCurrent(execution)) return { status: 'denied', reasonCode: 'access_denied' };
            return await input.terminateDetectedService({ entry, now: Date.now(),
                request: { requestId: `process-kill:${row.pid}:${row.start.startTimeMs}`, action: 'terminate_detected', force: false,
                    target: { kind: 'inventory_entry', machineId: entry.machineId, inventoryEntryId: entry.id } },
                execution: { tree: execution.tree, signal: execution.signal,
                    authorizeSignal: async () => await isCurrent(execution)
                        && (!execution.authorizeSignal || await execution.authorizeSignal()),
                    authorizeSnapshot: async snapshot => await isCurrent(execution)
                        && (!execution.authorizeSnapshot || await execution.authorizeSnapshot(snapshot)) },
            });
        },
        async startOwner(root, execution) {
            if (!await isCurrent(execution)) return { status: 'refused', reasonCode: 'access_denied' };
            if (root.startAgain) return await root.startAgain(execution);
            if (root.owner.kind === 'service') {
                const target = input.readServiceTargets?.().find(target => sameRoot(root, target.root));
                const captured = target && captureServiceRoot(target);
                return captured?.startAgain ? await captured.startAgain(execution)
                    : { status: 'refused', reasonCode: 'original_start_unavailable' };
            }
            if (root.owner.kind === 'browser_sidecar') {
                const target = input.readBrowsers?.().find(target => sameRoot(root, target.root));
                const captured = target && captureBrowserRoot(target);
                return captured?.startAgain ? await captured.startAgain(execution)
                    : { status: 'refused', reasonCode: 'original_start_unavailable' };
            }
            return { status: 'refused', reasonCode: 'not_restartable' };
        },
    };
}
