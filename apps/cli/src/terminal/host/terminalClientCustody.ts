import { basename } from 'node:path';
import { processInstanceFingerprintMatches, readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { readProcessRunState } from '@/daemon/processRunState';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import type { HerdrProcessInfo } from '@/integrations/herdr/client';
import { logger } from '@/ui/logger';
import { readProcessCensus } from '@/processes/census/processCensus';
import { ancestorsOf, indexCensus } from '@/processes/tree/processTree';
import type { BorrowedTerminalProcessIdentity } from './borrowedTerminalProcess';

/** Native process custody is independent of the borrowed shell's lifetime. */
export async function readTerminalClientProcessState(identity: BorrowedTerminalProcessIdentity): Promise<'alive' | 'dead' | 'unknown'> {
    const state = await readProcessRunState(identity.pid);
    if (state === 'dead' || state === 'zombie') return 'dead';
    const fingerprint = readProcessInstanceFingerprintSync(identity.pid);
    if (!fingerprint) return 'unknown';
    return processInstanceFingerprintMatches(identity.processInstanceFingerprint, fingerprint) ? 'alive' : 'dead';
}

export async function retireTerminalClientProcess(identity: BorrowedTerminalProcessIdentity): Promise<void> {
    const state = await readTerminalClientProcessState(identity);
    if (state === 'dead') return;
    if (state !== 'alive') throw new Error('terminal_native_client_custody_unknown');
    await terminateProcessTree({ pid: identity.pid });
}

/** Compare the complete, already platform-normalized native invocation. */
export function matchesTerminalClientInvocation(
    argv: readonly string[],
    invocation: Readonly<{ command: string; args: readonly string[] }>,
): boolean {
    return argv[0] === invocation.command
        && argv.length === invocation.args.length + 1
        && invocation.args.every((argument, index) => argv[index + 1] === argument);
}

/** Invocation is the exact, already platform-normalized private attach preparation. */
export async function proveTerminalClientCustody(input: Readonly<{
    launcher: BorrowedTerminalProcessIdentity;
    processes: HerdrProcessInfo;
    invocation: Readonly<{ command: string; args: readonly string[] }>;
}>): Promise<boolean> {
    const reject = (reason: string): false => {
        logger.infoFile('[terminal] Native client custody refused', {
            reason, launcherPid: input.launcher.pid, shellPid: input.processes.shellPid,
            expectedExecutable: basename(input.invocation.command.replaceAll('\\', '/')),
            expectedArgvLength: input.invocation.args.length + 1,
        });
        return false;
    };
    if (await readTerminalClientProcessState(input.launcher) !== 'alive') return reject('launcher_not_alive');
    if (!input.processes.shellPid) return reject('missing_shell');
    const snapshot = await readProcessCensus({ freshness: 'fresh', fields: [] });
    if (snapshot.status !== 'ok') return reject('ancestry_unavailable');
    const processTree = indexCensus(snapshot.rows);
    const descendsFrom = (pid: number, ancestor: number): boolean => pid === ancestor
        || ancestorsOf(processTree, pid).some(row => row.pid === ancestor);
    const foreground = input.processes.foregroundProcesses;
    const launcher = foreground.find(process => process.pid === input.launcher.pid);
    if (!launcher || !launcher.argv.some(arg => basename(arg) === 'terminal_launch_spec_runner.cjs')) return reject('launcher_not_foreground');
    if (!descendsFrom(input.launcher.pid, input.processes.shellPid)) return reject('launcher_not_within_shell');
    if (foreground.some(process => !descendsFrom(process.pid, input.launcher.pid)
        && !descendsFrom(input.launcher.pid, process.pid))) return reject('unrelated_foreground_process');
    const native = foreground.some(process => process.pid !== input.launcher.pid
        && descendsFrom(process.pid, input.launcher.pid)
        && matchesTerminalClientInvocation(process.argv, input.invocation));
    if (!native) return reject('native_invocation_not_observed');
    return await readTerminalClientProcessState(input.launcher) === 'alive' || reject('launcher_changed');
}
