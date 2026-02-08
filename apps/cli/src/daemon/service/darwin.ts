import { dirname } from 'node:path';

function xmlEscape(s: string): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function splitPath(p: string): string[] {
  return String(p ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function buildLaunchdPath(params: Readonly<{ execPath?: string; basePath?: string }> = {}): string {
  const execPath = params.execPath ?? process.execPath;
  const basePath = params.basePath ?? process.env.PATH ?? '';
  const nodeDir = execPath ? dirname(execPath) : '';
  const defaults = splitPath('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  const fromNode = nodeDir ? [nodeDir] : [];
  const fromEnv = splitPath(basePath);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of [...fromNode, ...fromEnv, ...defaults]) {
    if (seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out.join(':') || '/usr/bin:/bin:/usr/sbin:/sbin';
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
