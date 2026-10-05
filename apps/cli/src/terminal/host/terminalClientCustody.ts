import psList from 'ps-list';
import { basename } from 'node:path';
import { processInstanceFingerprintMatches, readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { readProcessRunState } from '@/daemon/processRunState';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import type { HerdrProcessInfo } from '@/integrations/herdr/client';
import { logger } from '@/ui/logger';
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
    await killProcessTree({ pid: identity.pid });
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
    const parents = new Map((await psList()).map(process => [process.pid, process.ppid]));
    const descendsFrom = (pid: number, ancestor: number): boolean => {
        const seen = new Set<number>();
        while (pid > 1 && !seen.has(pid)) {
            if (pid === ancestor) return true;
            seen.add(pid);
            pid = parents.get(pid) ?? 0;
        }
        return false;
    };
    const foreground = input.processes.foregroundProcesses;
    const launcher = foreground.find(process => process.pid === input.launcher.pid);
    if (!launcher || !launcher.argv.some(arg => basename(arg) === 'terminal_launch_spec_runner.cjs')) return reject('launcher_not_foreground');
    if (!descendsFrom(input.launcher.pid, input.processes.shellPid)) return reject('launcher_not_within_shell');
    if (foreground.some(process => !descendsFrom(process.pid, input.launcher.pid)
        && !descendsFrom(input.launcher.pid, process.pid))) return reject('unrelated_foreground_process');
    const native = foreground.some(process => process.pid !== input.launcher.pid
        && descendsFrom(process.pid, input.launcher.pid)
        && process.argv[0] === input.invocation.command
        && process.argv.length === input.invocation.args.length + 1
        && input.invocation.args.every((arg, index) => process.argv[index + 1] === arg));
    if (!native) return reject('native_invocation_not_observed');
    return await readTerminalClientProcessState(input.launcher) === 'alive' || reject('launcher_changed');
}
