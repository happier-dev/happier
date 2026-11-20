/** @moduleRealm any */
import { projectPluginFailureText } from '../diagnostics.js';
import { MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1, type ManagedGuestCliBuildInputV1, type MachineProvisionerNativeCauseV1 } from '../machineProvisioners.js';

export const quoteMachineProvisionerShellArgument = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
const quote = quoteMachineProvisionerShellArgument;

type NativeCommandFailure = Extract<MachineProvisionerNativeCauseV1, { localCause: 'native_command_failed' }>;

/** Pass stderr only for operations whose output is safe to excerpt. */
export function projectMachineProvisionerGuestCommandFailure(
  input: Readonly<{ command: NativeCommandFailure['command']; exitCode: number | null; stderr?: string | Uint8Array; stderrTruncated?: boolean }>,
): NativeCommandFailure {
  const stderr = (typeof input.stderr === 'string' ? input.stderr : new TextDecoder().decode(input.stderr)).trim();
  // Project the complete retained text before bounding the excerpt.
  const projected = stderr ? projectPluginFailureText(new Error(stderr)) : '';
  return {
    localCause: 'native_command_failed', command: input.command, exitCode: input.exitCode,
    ...(projected ? { stderr: projected.slice(-MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1) } : {}),
    ...(input.stderrTruncated || projected.length > MACHINE_PROVISIONER_NATIVE_STDERR_MAX_LENGTH_V1 ? { stderrTruncated: true } : {}),
  };
}

/** Run the supplier from the staged context and confirm its binary before setup. */
export function buildMachineProvisionerPreparationInstallScript(input: Readonly<{
  cli: Pick<ManagedGuestCliBuildInputV1, 'installScript' | 'binaryPath'>;
  stageDirectory?: string;
  readableRoot?: string;
  setupScript?: string;
}>): string {
  return [
    'set -e',
    ...(input.stageDirectory === undefined ? [] : ['cd -- ' + quote(input.stageDirectory)]),
    'sh -ec ' + quote(input.cli.installScript),
    'test -x ' + quote(input.cli.binaryPath),
    ...(input.readableRoot === undefined ? [] : ['chmod -R a+rX ' + quote(input.readableRoot)]),
    ...(input.setupScript === undefined ? [] : ['sh -ec ' + quote(input.setupScript)]),
  ].join('\n') + '\n';
}

/** A completed guest prerequisite can fail without making its native response malformed. */
export function assertMachineProvisionerGuestCommandSucceeded(
  result: Readonly<{ exitCode: number; truncated?: boolean; stderr?: string | Uint8Array }>,
  failure: (details: Readonly<{ exitCode: number; truncated?: boolean;
    nativeCause: Extract<MachineProvisionerNativeCauseV1, { localCause: 'native_command_failed' }> }>) => Error,
): void {
  if (result.exitCode === 0 && !result.truncated) return;
  throw failure({ exitCode: result.exitCode,
    ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
    nativeCause: projectMachineProvisionerGuestCommandFailure({ command: 'run', exitCode: result.exitCode,
      stderr: result.stderr, stderrTruncated: result.truncated }),
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
