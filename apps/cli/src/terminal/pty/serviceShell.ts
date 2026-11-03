import type { HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';
import type { ServiceShellObservation } from '@/daemon/local/services/launch/serviceCommand';
import type { TerminalPtyMachineCustody, TerminalPtySessionManager } from '@/terminal/pty/sessions';
import type { DaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';

type Registration = Awaited<ReturnType<TerminalPtySessionManager['ensure']>>;

/** Consumes the current service owner's launch within withServiceShell. The
 * service owner alone releases native keys and the redaction attachment.
 * Docker-client exit settles this terminal session, including intentional
 * detach (owner ruling 2026-10-29T16:20Z); it does not attest container exit.
 */
export async function consumeServiceShellTerminal(input: Readonly<{
    terminalSessions: TerminalPtySessionManager;
    admissionDrain?: DaemonAdmissionDrain;
    custody: Omit<TerminalPtyMachineCustody, 'rootPath'>;
    terminalKey: string;
    cols?: number;
    rows?: number;
    launch: HostAuthorizedPluginExecLaunch;
    signal?: AbortSignal;
    onRegistered(terminal: Registration): void;
    onOutcomeUncertain(): void;
}>): Promise<ServiceShellObservation<Registration>> {
    const refuse = (errorCode: 'terminal_forbidden' | 'terminal_unavailable' | 'terminal_busy', error: string = errorCode) => {
        const terminal = { ok: false as const, errorCode, error };
        input.onRegistered(terminal);
        return { kind: 'not_started' as const, terminal };
    };
    // The admitted native owner supplies cwd. No terminal-selected fallback.
    if (!input.launch.cwd) return refuse('terminal_unavailable');
    try {
        await input.terminalSessions.prepare?.();
        await input.launch.recheckInputs?.();
        if (input.signal?.aborted) return refuse('terminal_forbidden');
    } catch (error) {
        // This path precedes process birth and therefore cannot retain a
        // dispatched native effect merely because preparation failed.
        return refuse('terminal_unavailable', error instanceof Error && 'code' in error
            && typeof error.code === 'string' ? error.code : 'terminal_unavailable');
    }
    const terminal = await input.terminalSessions.ensure({
        ...(input.admissionDrain ? { admissionDrain: input.admissionDrain } : {}),
        terminalKey: input.terminalKey,
        cwd: input.launch.cwd,
        custody: { ...input.custody, rootPath: input.launch.cwd },
        requesterAccountId: input.custody.requesterAccountId,
        cols: input.cols,
        rows: input.rows,
        launchProcess: { file: input.launch.command, args: input.launch.args, env: input.launch.env,
            ...(input.launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) },
        authorizedProjectLaunch: input.launch,
    });
    if (!terminal.ok) {
        input.onRegistered(terminal);
        return { kind: 'not_started', terminal };
    }
    // Reconnect consumes the retained terminalId. A new native admission must
    // never borrow a terminal created by a different admitted generation.
    if (terminal.reused) return refuse('terminal_busy');
    input.onRegistered(terminal);
    const stop = () => {
        void input.terminalSessions.requestStop({ terminalId: terminal.terminalId })
            .then(observation => {
                if (observation.kind === 'unconfirmed' || observation.kind === 'unavailable') input.onOutcomeUncertain();
            }).catch(input.onOutcomeUncertain);
    };
    input.signal?.addEventListener('abort', stop, { once: true });
    if (input.signal?.aborted) stop();
    try {
        // Cancellation requests stop; it never cancels retained exit custody.
        const clientExit = await input.terminalSessions.waitForExit({ terminalId: terminal.terminalId,
            onOutcomeUncertain: input.onOutcomeUncertain });
        return { kind: 'client_exit', terminal, clientExit };
    } finally {
        input.signal?.removeEventListener('abort', stop);
    }
}
