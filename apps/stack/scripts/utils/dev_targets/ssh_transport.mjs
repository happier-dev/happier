// Doctor and lifecycle control share the existing two-attempt recovery policy.
// A refused multiplex session or connect timeout happens before dispatch. Other
// exit-255 results may follow execution and must never replay the command.
export function classifyDevTargetSshDiagnostic(line) {
  const diagnostic = String(line ?? '').trim();
  if (/^ssh: connect to host .+ port \d+: Connection timed out$/i.test(diagnostic)) return 'ssh-connect-timeout';
  if (/^ssh: connect to host .+ port \d+: (Connection refused|No route to host|Network is unreachable)$/i.test(diagnostic)) return 'ssh-connect-unreachable';
  if (/permission denied \(|host key verification failed|too many authentication failures/i.test(diagnostic)) return 'ssh-authentication-failed';
  if (/mux_client_request_session: session request failed: Session open refused by peer/i.test(diagnostic)) return 'ssh-multiplex-session-refused';
  return null;
}

export function resolveDevTargetSshDiagnostic(result) {
  if (result?.code === 0) return null;
  if (result?.code === 255) {
    if (result.diagnosticReason) return result.diagnosticReason;
    for (const line of [result.stderr, result.err].filter(Boolean).flatMap(value => String(value).split(/\r?\n/))) {
      const reason = classifyDevTargetSshDiagnostic(line);
      if (reason) return reason;
    }
    return 'ssh-connection-failed';
  }
  return result?.error?.code ? 'ssh-process-failed' : 'remote-doctor-failed';
}

export async function runDevTargetSshProcess(input, runProcess) {
  const result = await runProcess(input);
  if (!['ssh', 'scp'].includes(input.command)
    || !['ssh-connect-timeout', 'ssh-multiplex-session-refused'].includes(resolveDevTargetSshDiagnostic(result))) return result;
  return await runProcess({ ...input, args: ['-o', 'ControlMaster=no', '-o', 'ControlPath=none', ...input.args] });
}
