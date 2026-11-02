import { formatSshCommandFailure, readGuestCliFailureOutput, readGuestServiceErrorCode, type SshCommandFailureCode, type SshCommandFailurePhase, type SshCommandFailureReason } from '@happier-dev/protocol/ssh/commandFailure';
import type { RemoteFirstPartyCommandResult } from '../kinds/remoteFirstPartyPayloadInstaller.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';

export function sshCommandError(code: SshCommandFailureCode, result?: RemoteFirstPartyCommandResult,
  phase?: SshCommandFailurePhase, reason?: SshCommandFailureReason): SystemTaskExecutionError {
  const guest = code === 'ssh_command_failed' && result && result.status !== 0 && phase?.startsWith('daemon.service.')
    ? readGuestCliFailureOutput(result.stdout, result.stderr) : null;
  return new SystemTaskExecutionError(code, formatSshCommandFailure(code, result ? {
    phase, reason, exitStatus: result.status, stdoutPresent: Boolean(result.stdout.trim()), stderrPresent: Boolean(result.stderr.trim()),
    ...(readGuestServiceErrorCode(guest?.guestCliCode) ? guest : {}),
  } : phase ? { phase } : undefined));
}

/** Classify native evidence, retaining process facts but never native content. */
export function sshCommandFailure(diagnostic: string, result?: RemoteFirstPartyCommandResult,
  phase?: SshCommandFailurePhase, serviceReason?: SshCommandFailureReason): SystemTaskExecutionError {
  let code: SshCommandFailureCode = 'ssh_command_failed';
  if (/password (?:has expired|change required)|required to change your password/iu.test(diagnostic)) {
    code = 'ssh_password_expired';
  } else if (/REMOTE HOST IDENTIFICATION HAS CHANGED/iu.test(diagnostic)) {
    code = 'ssh_host_key_changed';
  } else if (/Host key verification failed/iu.test(diagnostic)) {
    code = 'ssh_host_key_unverified';
  }
  return sshCommandError(code, result, phase, code === 'ssh_command_failed' ? serviceReason : undefined);
}
