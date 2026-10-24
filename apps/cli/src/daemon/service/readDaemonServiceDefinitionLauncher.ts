import { parsePowerShellQuotedString } from '@happier-dev/cli-common/service';

import type { DaemonServicePlatform } from './plan';

/**
 * The program a service definition launches: every argument before the `daemon` subcommand, so the
 * shim form `[shim, daemon, start-sync]` and the node form `[node, entry.mjs, daemon, start-sync]`
 * each name the CLI they run. Parsed from the three templates this CLI renders
 * (`@happier-dev/cli-common/service`); `null` when the definition is not one of them.
 */
export function readDaemonServiceDefinitionLauncher(params: Readonly<{
  platform: DaemonServicePlatform;
  contents: string;
}>): readonly string[] | null {
  const args = readProgramArguments(params.platform, params.contents);
  if (!args) {
    return null;
  }
  const daemonIndex = args.indexOf('daemon');
  const launcher = daemonIndex >= 0 ? args.slice(0, daemonIndex) : args;
  return launcher.length > 0 ? launcher : null;
}

function readProgramArguments(platform: DaemonServicePlatform, contents: string): readonly string[] | null {
  if (platform === 'linux') {
    const execStart = /^ExecStart=(.*)$/mu.exec(contents)?.[1];
    return execStart ? [...execStart.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/gu)].map((match) => (
      match[1] !== undefined ? unescapeSystemdQuoted(match[1]) : String(match[2]).replaceAll('%%', '%')
    )) : null;
  }
  if (platform === 'darwin') {
    const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(contents)?.[1];
    return array ? [...array.matchAll(/<string>([\s\S]*?)<\/string>/gu)].map((match) => unescapeXml(String(match[1]))) : null;
  }
  const command = /^& (.*)$/mu.exec(contents)?.[1];
  return command ? [...command.matchAll(/"((?:[^"`]|`.)*)"/gu)].flatMap((match) => {
    const value = parsePowerShellQuotedString(match[0]);
    return value === null ? [] : [value];
  }) : null;
}

function unescapeSystemdQuoted(value: string): string {
  return value
    .replace(/\\(.)/gu, (_match, escaped: string) => (escaped === 'n' ? '\n' : escaped))
    .replaceAll('%%', '%');
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

/**
 * This definition would switch which CLI the installed service runs: from a CLI the user installed
 * (npm, Homebrew, a checkout) to the managed CLI, or back (plan R12 "Keep my own", R13 b). Rewriting
 * it silently would change the CLI the user's service runs, so the install dry-run reports it for
 * consent (plan R10 K3; setup's R12 answer is that consent) and `service start`/`restart` leave that
 * definition as it is — the switch happens only through the strict install, whose failure is
 * reported. A launcher that merely drifts within one kind — a node path moved by fnm, one managed
 * version to the managed shim — is ordinary drift. `null` when no such switch is written or either
 * definition cannot be read.
 */
export function describeDaemonServiceRuntimeReplacement(params: Readonly<{
  platform: DaemonServicePlatform;
  installedContents: string | null;
  expectedContents: string;
  isManagedCliLauncher: (launcher: readonly string[]) => boolean;
}>): Readonly<{ current: string; replacement: string }> | null {
  if (params.installedContents === null) {
    return null;
  }
  const current = readDaemonServiceDefinitionLauncher({ platform: params.platform, contents: params.installedContents });
  const replacement = readDaemonServiceDefinitionLauncher({ platform: params.platform, contents: params.expectedContents });
  if (
    !current
    || !replacement
    || current.join('\0') === replacement.join('\0')
    || params.isManagedCliLauncher(current) === params.isManagedCliLauncher(replacement)
  ) {
    return null;
  }
  return { current: current.join(' '), replacement: replacement.join(' ') };
}
