import type { ScmExecResult, runScmCommand } from '../runtime.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';

/** Only the clone owner calls this on its newly reserved private directory. */
export function checkoutInitialClone(input: Readonly<{
    path: string;
    commit: string;
    runCommand: typeof runScmCommand;
    timeoutMs: number;
}>): Promise<ScmExecResult> {
    return input.runCommand({
        bin: 'git', cwd: input.path, args: ['checkout', '-B', 'main', input.commit],
        timeoutMs: input.timeoutMs, env: buildScmNonInteractiveEnv(),
    });
}
