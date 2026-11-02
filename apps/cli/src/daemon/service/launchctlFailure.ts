import type { SshCommandFailureReason } from '@happier-dev/protocol/ssh/commandFailure';

/** Closed native evidence shared by service recovery and SSH presentation. */
export function readLaunchctlFailureReason(output: string): SshCommandFailureReason | undefined {
  if (/^Bootstrap failed: 5: Input\/output error\r?$/mu.test(output)) return 'launchctl_io_error';
  if (/^Bootstrap failed: 125: Domain does not support specified action\r?$/mu.test(output)) return 'launchctl_domain_unsupported';
  if (/^Could not find service "[^"\r\n]+" in domain for (?:user (?:gui|user)|uid): [0-9]+\r?$/mu.test(output)) return 'launchctl_service_missing';
  return undefined;
}
