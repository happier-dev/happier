function quoteShellArg(value: string): string {
  const text = String(value ?? '');
  return `'${text.replace(/'/gu, `'\"'\"'`)}'`;
}

export const RELAY_RUNTIME_HEALTH_OK_TOKEN = 'HAPPIER_RELAY_HEALTH_OK';

export function buildRelayRuntimeHealthProbeCommand(params: Readonly<{
  baseUrl: string;
  maxAttempts: number;
  sleepSeconds: number;
}>): string {
  const baseUrl = String(params.baseUrl ?? '').trim();
  const maxAttempts = Number.isFinite(params.maxAttempts) && params.maxAttempts > 0
    ? Math.floor(params.maxAttempts)
    : 1;
  const sleepSeconds = Number.isFinite(params.sleepSeconds) && params.sleepSeconds >= 0
    ? Math.floor(params.sleepSeconds)
    : 1;

  return [
    'set -eu',
    `BASE_URL=${quoteShellArg(baseUrl)}`,
    'i=0',
    `MAX=${maxAttempts}`,
    'while [ "$i" -lt "$MAX" ]; do',
      '  if command -v curl >/dev/null 2>&1; then',
    `    if curl -fsS --connect-timeout 2 --max-time 3 "$BASE_URL/health" >/dev/null 2>&1; then echo ${RELAY_RUNTIME_HEALTH_OK_TOKEN}; exit 0; fi`,
    '  elif command -v wget >/dev/null 2>&1; then',
    `    if wget -qO- --timeout=3 --tries=1 "$BASE_URL/health" >/dev/null 2>&1; then echo ${RELAY_RUNTIME_HEALTH_OK_TOKEN}; exit 0; fi`,
    '  else',
    '    exit 3',
    '  fi',
    '  i=$((i+1))',
    `  sleep ${sleepSeconds}`,
    'done',
    'exit 1',
  ].join('\n');
}
