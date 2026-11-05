import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';

import type { TerminalHostProcessObservation } from '@/integrations/terminal/host/_types';
import { logger } from '@/ui/logger';

import type { BorrowedTerminalProcessIdentity } from './borrowedTerminalProcess';
import { matchesTerminalClientInvocation, readTerminalClientProcessState } from './terminalClientCustody';

// Herdr has no native process lifetime push for independently created panes.
// Preserve the predecessor host-liveness cadence while exit listeners need it.
const NATIVE_EXIT_POLL_MS = 30_000;

/** Positive pane observations establish custody; only OS custody proves exit. */
export function createNativeProcessExitObserver(input: Readonly<{
    invocation: Readonly<{ command: string; args: readonly string[] }>;
    captureProcessObservations(): Promise<readonly TerminalHostProcessObservation[] | null>;
    onExit(): void;
}>): Readonly<{ start(): void; stop(): void }> {
    let identity: BorrowedTerminalProcessIdentity | undefined;
    let stopActive: (() => void) | undefined;

    return {
        start() {
            if (stopActive) return;
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const stop = () => {
                controller.abort();
                if (timer) clearTimeout(timer);
                if (stopActive === stop) stopActive = undefined;
            };
            stopActive = stop;

            const observe = async () => {
                try {
                    if (!identity) {
                        const observations = await input.captureProcessObservations();
                        if (controller.signal.aborted) return;
                        const candidates = observations?.filter(candidate => matchesTerminalClientInvocation(candidate.argv, input.invocation));
                        const process = candidates?.length === 1 ? candidates[0] : undefined;
                        if (process) {
                            const processInstanceFingerprint = readProcessInstanceFingerprintSync(process.pid);
                            if (processInstanceFingerprint) identity = { pid: process.pid, processInstanceFingerprint };
                        }
                    }
                    if (identity) {
                        const state = await readTerminalClientProcessState(identity);
                        if (controller.signal.aborted) return;
                        if (state === 'dead') {
                            stop();
                            input.onExit();
                        }
                    }
                } catch (error) {
                    if (!controller.signal.aborted) {
                        logger.infoFile('[WARN] [terminal-host] Native exit probe failed (terminal_native_exit_probe_failed)', {
                            errorName: error instanceof Error ? error.name : 'unknown',
                        });
                    }
                } finally {
                    if (!controller.signal.aborted) {
                        timer = setTimeout(() => { void observe(); }, NATIVE_EXIT_POLL_MS);
                        timer.unref?.();
                    }
                }
            };
            void observe();
        },
        stop() { stopActive?.(); },
    };
}
