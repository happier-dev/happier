import { dirname } from 'node:path';

function splitPath(p: string): string[] {
  return String(p ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function buildLaunchdPath(params: Readonly<{ execPath?: string; basePath?: string }> = {}): string {
  // launchd starts with a minimal environment; ensure common tool paths exist,
  // and include the current Node binary directory so shell shims that exec `node`
  // still work (e.g. nvm-managed installs).
  const execPath = String(params.execPath ?? '').trim();
  const basePath = String(params.basePath ?? '').trim();
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

function xmlEscape(s: string): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function buildLaunchdPlistXml(params: Readonly<{
  label: string;
  programArgs: readonly string[];
  env?: Record<string, string>;
  stdoutPath: string;
  stderrPath: string;
  workingDirectory?: string;
  keepAliveOnFailure?: boolean;
  startIntervalSec?: number;
}>): string {
  const label = String(params.label ?? '').trim();
  if (!label) throw new Error('label is required');

  const programArgs = Array.isArray(params.programArgs)
    ? params.programArgs.map((a) => String(a ?? '')).filter(Boolean)
    : [];
  if (programArgs.length === 0) throw new Error('programArgs is required');

  const envEntries = Object.entries(params.env ?? {}).filter(([k]) => String(k).trim());
  const programArgsXml = programArgs.map((a) => `      <string>${xmlEscape(a)}</string>`).join('\n');
  const envXml = envEntries
    .map(([k, v]) => `      <key>${xmlEscape(k)}</key>\n      <string>${xmlEscape(String(v ?? ''))}</string>`)
    .join('\n');

  const stdoutPath = String(params.stdoutPath ?? '').trim();
  const stderrPath = String(params.stderrPath ?? '').trim();
  const workingDirectory = String(params.workingDirectory ?? '').trim();

  const workingDirXml = workingDirectory
    ? `\n    <key>WorkingDirectory</key>\n    <string>${xmlEscape(workingDirectory)}</string>\n`
    : '\n';

  const keepAlive = params.keepAliveOnFailure === false
    ? ''
    : (
        `\n    <key>KeepAlive</key>\n` +
        `    <dict>\n` +
        `      <key>SuccessfulExit</key>\n` +
        `      <false/>\n` +
        `    </dict>\n`
      );

  const intervalRaw = Number(params.startIntervalSec);
  const interval = Number.isFinite(intervalRaw) && intervalRaw > 0 ? Math.floor(intervalRaw) : 0;
  const startInterval = interval
    ? `\n    <key>StartInterval</key>\n    <integer>${interval}</integer>\n`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>

    <key>ProgramArguments</key>
    <array>
${programArgsXml}
    </array>

    <key>RunAtLoad</key>
    <true/>
${keepAlive}
${startInterval}
${workingDirXml}    <key>StandardOutPath</key>
    <string>${xmlEscape(stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(stderrPath)}</string>

    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
  </dict>
</plist>
`;
}
