function escapeSystemdEnvValue(value: string): string {
  const s = String(value ?? '');
  if (/^[A-Za-z0-9_./:@%+-]+$/.test(s)) return s;
  const escaped = s
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '%%')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\n', '\\n')
    .replaceAll('"', '\\"');
  return `"${escaped}"`;
}

function escapeSystemdExecArg(value: string): string {
  const s = String(value ?? '');
  if (/^[A-Za-z0-9_./:@%+=-]+$/.test(s)) return s;
  const escaped = s
    .replaceAll('\\', '\\\\')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\n', '\\n')
    .replaceAll('"', '\\"');
  return `"${escaped}"`;
}

function systemdEnvLines(env: Record<string, string> | undefined): string[] {
  const entries = Object.entries(env ?? {}).filter(([k]) => String(k ?? '').trim());
  const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const lines: string[] = [];
  for (const [kRaw, vRaw] of entries) {
    const k = String(kRaw ?? '').trim();
    if (!k) continue;
    if (!envKeyPattern.test(k)) {
      throw new Error(`Invalid systemd environment variable name: ${k}`);
    }
    lines.push(`Environment=${k}=${escapeSystemdEnvValue(String(vRaw ?? ''))}`);
  }
  return lines;
}

export function renderSystemdServiceUnit(params: Readonly<{
  description: string;
  execStart: string | readonly string[];
  workingDirectory?: string;
  env?: Record<string, string>;
  restart?: string;
  runAsUser?: string;
  stdoutPath?: string;
  stderrPath?: string;
  wantedBy?: string;
}>): string {
  const desc = String(params.description ?? '').trim() || 'Happier Service';
  const restartPolicy = String(params.restart ?? '').trim() || 'always';
  const workDir = String(params.workingDirectory ?? '').trim();
  const out = String(params.stdoutPath ?? '').trim();
  const err = String(params.stderrPath ?? '').trim();
  const runAsUser = String(params.runAsUser ?? '').trim();

  const execStart = Array.isArray(params.execStart)
    ? params.execStart.map((a) => escapeSystemdExecArg(String(a ?? ''))).join(' ')
    : String(params.execStart ?? '').trim();
  if (!execStart) {
    throw new Error('execStart is required');
  }

  const envLines = systemdEnvLines(params.env);
  const workDirLine = workDir ? `WorkingDirectory=${workDir}\n` : '';
  const userLine = runAsUser ? `User=${runAsUser}\n` : '';
  const outLine = out ? `StandardOutput=append:${out}\n` : '';
  const errLine = err ? `StandardError=append:${err}\n` : '';
  const wantedBy = String(params.wantedBy ?? '').trim() || 'default.target';

  const envBlock = envLines.length ? `\n${envLines.join('\n')}\n` : '\n';

  return `[Unit]
Description=${desc}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${workDirLine}${userLine}${envBlock}ExecStart=${execStart}
Restart=${restartPolicy}
RestartSec=2
${outLine}${errLine}[Install]
WantedBy=${wantedBy}
`;
}
