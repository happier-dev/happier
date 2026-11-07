export function parseTimeoutSeconds(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(numeric)) {
    return Math.max(1, Math.floor(numeric));
  }
  return fallback;
}

export function buildSshKeyscanInvocation(params: Readonly<{
  host: string;
  port?: number;
  timeoutSec?: number;
  keyType?: string;
}>): Readonly<{ command: string; args: string[] }> {
  const host = String(params.host ?? '').trim();
  if (!host) {
    throw new Error('host is required');
  }
  if (host.startsWith('-')) {
    throw new Error('host must not start with "-"');
  }
  if (/\s/u.test(host)) {
    throw new Error('host must not contain whitespace');
  }
  const args = [
    '-T',
    String(parseTimeoutSeconds(params.timeoutSec, 5)),
    ...(params.port ? ['-p', String(Math.floor(params.port))] : []),
    '-t',
    String(params.keyType ?? 'ed25519'),
    host,
  ];
  return { command: 'ssh-keyscan', args };
}

