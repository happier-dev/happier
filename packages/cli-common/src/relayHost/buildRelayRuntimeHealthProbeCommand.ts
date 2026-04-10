function quoteShellArg(value: string): string {
  const text = String(value ?? '');
  return `'${text.replace(/'/gu, `'\"'\"'`)}'`;
}

export const RELAY_RUNTIME_HEALTH_OK_TOKEN = 'HAPPIER_RELAY_HEALTH_OK';

export function buildRelayRuntimeHealthProbeCommand(params: Readonly<{
  baseUrl: string;
  path?: string;
  maxAttempts: number;
  sleepSeconds: number;
}>): string {
  const baseUrl = String(params.baseUrl ?? '').trim().replace(/\/+$/u, '');
  const rawPath = String(params.path ?? '').trim();
  const path = rawPath.length === 0
    ? '/health'
    : rawPath.startsWith('/')
      ? rawPath
      : `/${rawPath}`;
  const healthUrl = `${baseUrl}${path}`;
  const maxAttempts = Number.isFinite(params.maxAttempts) && params.maxAttempts > 0
    ? Math.floor(params.maxAttempts)
    : 1;
  const sleepSeconds = Number.isFinite(params.sleepSeconds) && params.sleepSeconds >= 0
    ? Math.floor(params.sleepSeconds)
    : 1;

  return [
    'set -eu',
    `HEALTH_URL=${quoteShellArg(healthUrl)}`,
    'i=0',
    `MAX=${maxAttempts}`,
    'while [ "$i" -lt "$MAX" ]; do',
      '  if command -v curl >/dev/null 2>&1; then',
    `    if curl -fsS --connect-timeout 2 --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then echo ${RELAY_RUNTIME_HEALTH_OK_TOKEN}; exit 0; fi`,
    '  elif command -v wget >/dev/null 2>&1; then',
    `    if wget -qO- --timeout=3 --tries=1 "$HEALTH_URL" >/dev/null 2>&1; then echo ${RELAY_RUNTIME_HEALTH_OK_TOKEN}; exit 0; fi`,
    '  else',
    '    exit 3',
    '  fi',
    '  i=$((i+1))',
    `  sleep ${sleepSeconds}`,
    'done',
    'exit 1',
  ].join('\n');
}
