import { sshCommandFailure as sharedSshCommandFailure, type RemoteFirstPartyCommandResult, type SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';
import type { SshCommandFailurePhase } from '@happier-dev/protocol/ssh/commandFailure';
import { readLaunchctlFailureReason } from '@/daemon/service/launchctlFailure';

export { sshCommandError } from '@happier-dev/cli-common/systemTasks';

/** The daemon contributes its native service reason; shared SSH owns classification. */
export function sshCommandFailure(diagnostic: string | Error, result?: RemoteFirstPartyCommandResult,
  phase?: SshCommandFailurePhase): SystemTaskExecutionError {
  const reason = result && result.status !== 0 && phase?.startsWith('daemon.service.')
    ? readLaunchctlFailureReason(typeof diagnostic === 'string' ? diagnostic : diagnostic.message)
    : undefined;
  return sharedSshCommandFailure(diagnostic, result, phase, reason);
}
