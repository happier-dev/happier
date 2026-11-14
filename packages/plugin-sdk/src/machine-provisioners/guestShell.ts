/** @moduleRealm any */
import { redactBugReportSensitiveText } from '../diagnostics.js';
import { MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1, type MachineProvisionerNativeCauseV1 } from '../machineProvisioners.js';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** A completed guest prerequisite can fail without making its native response malformed. */
export function assertMachineProvisionerGuestCommandSucceeded(
  result: Readonly<{ exitCode: number; truncated?: boolean; stderr?: string | Uint8Array }>,
  failure: (details: Readonly<{ exitCode: number; truncated?: boolean;
    nativeCause: Extract<MachineProvisionerNativeCauseV1, { localCause: 'native_command_failed' }> }>) => Error,
): void {
  if (result.exitCode === 0 && !result.truncated) return;
  const stderr = typeof result.stderr === 'string' ? result.stderr : new TextDecoder().decode(result.stderr);
  // Project the complete retained text before bounding, so a credential cannot straddle the tail boundary.
  const projected = redactBugReportSensitiveText(stderr).trim();
  throw failure({ exitCode: result.exitCode,
    ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
    nativeCause: { localCause: 'native_command_failed', command: 'run', exitCode: result.exitCode,
      ...(projected ? { stderr: projected.slice(-MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1) } : {}),
      ...(result.truncated || projected.length > MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1 ? { stderrTruncated: true } : {}),
    },
  });
}

/** Preserve binary stdout/stderr and exit status over a native text-only exec API.
 * Omit inputBase64 when the vendor already carries stdin separately. */
export function buildMachineProvisionerShellCommand(argv: readonly string[], inputBase64?: string): string {
  return 'umask 077; d=$(mktemp -d) || exit 1; trap \'rm -rf "$d"\' EXIT; '
      + (inputBase64 === undefined ? '' : 'printf %s ' + quote(inputBase64) + ' | base64 -d | ') + argv.map(quote).join(' ') + ' >"$d/out" 2>"$d/err"; s=$?; '
      + 'printf \'{"exitCode":%s,"stdoutBase64":"%s","stderrBase64":"%s"}\\n\' "$s" "$(base64 <"$d/out" | tr -d \'\\n\')" "$(base64 <"$d/err" | tr -d \'\\n\')"';
}

/** Render the host-provided daemon recipe for native vendors that retain a startup file.
 * Native staging, modes, publication and startup registration remain with the leaf. */
export function buildMachineProvisionerDaemonStartScript(environment: Readonly<Record<string, string>>, detachedDaemonStartArgv: readonly string[]): string {
  return '#!/bin/sh\n' + Object.entries(environment).map(([key, value]) => 'export ' + key + '=' + quote(value)).join('\n')
        + '\nexec ' + detachedDaemonStartArgv.map(quote).join(' ') + '\n';
}
