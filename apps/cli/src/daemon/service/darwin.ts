import { dirname } from 'node:path';

import { buildServicePath } from './path';

function xmlEscape(s: string): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

const MACOS_DEFAULT_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

export function buildLaunchdPath(params: Readonly<{ execPath?: string; basePath?: string }> = {}): string {
  return buildServicePath({ ...params, defaultPath: MACOS_DEFAULT_PATH });
}

export function buildLaunchAgentPlistXml(params: Readonly<{
  label: string;
  programArgs: string[];
  env?: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
  workingDirectory?: string | null;
}>): string {
  const envEntries = Object.entries(params.env ?? {}).filter(([k, v]) => String(k).trim() && v != null);
  const programArgsXml = params.programArgs.map((a) => `      <string>${xmlEscape(a)}</string>`).join('\n');
  const envXml = envEntries
    .map(([k, v]) => `      <key>${xmlEscape(k)}</key>\n      <string>${xmlEscape(v)}</string>`)
    .join('\n');
  const workingDirXml = params.workingDirectory
    ? `\n    <key>WorkingDirectory</key>\n    <string>${xmlEscape(params.workingDirectory)}</string>\n`
    : '\n';

  // Restart on non-zero exit (crash), but do not spin on clean exit.
  const keepAliveXml =
    `\n    <key>KeepAlive</key>\n` +
    `    <dict>\n` +
    `      <key>SuccessfulExit</key>\n` +
    `      <false/>\n` +
    `    </dict>\n`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(params.label)}</string>

    <key>ProgramArguments</key>
    <array>
${programArgsXml}
    </array>

    <key>RunAtLoad</key>
    <true/>
${keepAliveXml}
${workingDirXml}    <key>StandardOutPath</key>
    <string>${xmlEscape(params.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(params.stderrPath)}</string>

    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
  </dict>
</plist>
`;
}
