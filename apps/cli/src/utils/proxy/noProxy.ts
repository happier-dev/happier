export type NoProxyRule =
  | { kind: 'all' }
  | { kind: 'exact'; hostname: string; port: number | null }
  | { kind: 'suffix_dot'; suffix: string; port: number | null }
  | { kind: 'suffix_wildcard'; suffix: string; port: number | null };

function parseOptionalPort(raw: string): { hostname: string; port: number | null } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Hostname:port (best-effort; does not attempt to fully parse IPv6)
  const m = trimmed.match(/^(.*?):(\d+)$/);
  if (!m) {
    return { hostname: trimmed, port: null };
  }

  const hostname = (m[1] ?? '').trim();
  const portNum = Number(m[2]);
  if (!hostname) return null;
  if (!Number.isFinite(portNum) || portNum <= 0) return { hostname: trimmed, port: null };
  return { hostname, port: portNum };
}

export function parseNoProxy(raw: string | undefined | null): readonly NoProxyRule[] {
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const parts = trimmed.split(',').map((p) => p.trim()).filter(Boolean);
  const rules: NoProxyRule[] = [];

  for (const part of parts) {
    const parsed = parseOptionalPort(part);
    if (!parsed) continue;
    const hostname = parsed.hostname.trim().toLowerCase();
    const port = parsed.port;
    if (!hostname) continue;

    if (hostname === '*') {
      rules.push({ kind: 'all' });
      continue;
    }

    if (hostname.startsWith('*.') && hostname.length > 2) {
      // Store as ".example.com" suffix for easy endsWith matching.
      rules.push({ kind: 'suffix_wildcard', suffix: hostname.slice(1), port });
      continue;
    }

    if (hostname.startsWith('.')) {
      rules.push({ kind: 'suffix_dot', suffix: hostname, port });
      continue;
    }

    rules.push({ kind: 'exact', hostname, port });
  }

  return rules;
}

export function isNoProxyMatch(params: Readonly<{ hostname: string; port: number | null; rules: readonly NoProxyRule[] }>): boolean {
  const host = params.hostname.trim().toLowerCase();
  if (!host) return false;

  for (const rule of params.rules) {
    if (rule.kind === 'all') return true;
    if (rule.port != null && params.port != null && rule.port !== params.port) continue;

    if (rule.kind === 'exact') {
      if (host === rule.hostname) return true;
      continue;
    }

    if (rule.kind === 'suffix_dot') {
      const root = rule.suffix.slice(1);
      if (host === root) return true;
      if (host.endsWith(rule.suffix)) return true;
      continue;
    }

    if (rule.kind === 'suffix_wildcard') {
      const root = rule.suffix.slice(1);
      if (host === root) return false;
      if (host.endsWith(rule.suffix)) return true;
      continue;
    }
  }

  return false;
}

