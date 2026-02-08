export function escapeSystemdValue(value: string): string {
  const s = String(value ?? '');

  // Allow simple values without quoting (matches typical systemd unit examples).
  // Quote only when needed to preserve spaces/special characters.
  if (/^[A-Za-z0-9_./:@+-]+$/.test(s)) return s;

  // systemd Environment= values should be quoted when they contain spaces or special chars.
  const escaped = s
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '%%')
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\n', '\\n')
    .replaceAll('"', '\\"');

  return `"${escaped}"`;
}

function assertSingleLineSystemdField(fieldName: string, value: string): string {
  const s = String(value ?? '');
  if (s.includes('\n') || s.includes('\r')) {
    throw new Error(`${fieldName} must not contain newlines`);
  }
  return s;
}

export function buildSystemdUserUnit(params: Readonly<{
  description: string;
  execStart: string;
  workingDirectory?: string;
  env?: Record<string, string>;
}>): string {
  const description = assertSingleLineSystemdField('description', params.description);
  const execStart = assertSingleLineSystemdField('execStart', params.execStart);
  const workingDirectory =
    typeof params.workingDirectory === 'string' && params.workingDirectory.length > 0
      ? assertSingleLineSystemdField('workingDirectory', params.workingDirectory)
      : undefined;
  const env = params.env ?? {};
  const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const envLines = Object.entries(env).map(
    ([k, v]) => {
      if (!envKeyPattern.test(k)) {
        throw new Error(`Invalid systemd environment variable name: ${k}`);
      }
      return `Environment=${k}=${escapeSystemdValue(v)}`;
    },
  );

  return [
    '[Unit]',
    `Description=${description}`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${execStart}`,
    ...(workingDirectory ? [`WorkingDirectory=${workingDirectory}`] : []),
    ...envLines,
    'Restart=on-failure',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}
