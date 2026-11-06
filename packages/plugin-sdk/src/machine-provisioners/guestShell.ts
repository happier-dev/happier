/** @moduleRealm any */
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

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
