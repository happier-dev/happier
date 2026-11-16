import type { ScmExecResult, runScmCommand } from '../runtime.js';
import type { ScmRepositoryCloneInput } from '@happier-dev/plugin-sdk/scm';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';

/** Only the clone owner calls this on its newly reserved private directory. */
export function checkoutInitialClone(input: Readonly<{
    path: string;
    commit?: string;
    branch: NonNullable<ScmRepositoryCloneInput['initialCheckout']>['branch'];
    runCommand: typeof runScmCommand;
    timeoutMs: number;
}>): Promise<ScmExecResult> {
    return input.runCommand({
        bin: 'git', cwd: input.path, args: input.branch === null
            ? ['checkout', '--detach', input.commit!]
            : input.commit
                ? ['checkout', '-B', input.branch, input.commit]
                : ['checkout', '-B', input.branch, '--track', `refs/remotes/origin/${input.branch}`],
        timeoutMs: input.timeoutMs, env: buildScmNonInteractiveEnv(),
    });
}
