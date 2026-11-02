import type { TailscaleCommandResult } from './commandRunner.js';

export type TailscaleCommandFailure = Readonly<{
  code: 'tailscale_operator_authorization_refused';
  retryable: false;
  remediation: string;
}>;

const OPERATOR_REMEDIATION = "Run this Tailscale step with sudo. If this account is not the operator, an administrator can run 'sudo tailscale set --operator=<user>'. On Linux, an operator with an empty display name can work around the Tailscale bug by setting it to the account's login name: 'sudo usermod --comment <user> <user>'.";

/** Native failure classification lives here; callers project only these closed facts. */
export class TailscaleCommandError extends Error {
  readonly result: TailscaleCommandResult;
  readonly failure: TailscaleCommandFailure | null;

  constructor(message: string, result: TailscaleCommandResult) {
    // Linux Tailscale 1.104.2, tailscale/tailscale#21204. Do not infer the specific
    // operator refusal from generic 401s, nor carry native paths/output into copy.
    const refused = result.exitCode !== 0 && result.stderr.replace(/\s+/g, ' ').toLowerCase()
      .includes("must be root, or be an operator and able to run 'sudo tailscale' to serve a path or unix socket");
    super(refused ? `Tailscale refused operator authorization. ${OPERATOR_REMEDIATION}` : message);
    this.name = 'TailscaleCommandError';
    this.result = result;
    this.failure = refused ? {
      code: 'tailscale_operator_authorization_refused', retryable: false, remediation: OPERATOR_REMEDIATION,
    } : null;
  }
}
