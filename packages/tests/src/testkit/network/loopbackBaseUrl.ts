export function normalizeLoopbackBaseUrl(input: string): string {
  try {
    const parsed = new URL(input);
    const port = parsed.port ? `:${parsed.port}` : '';
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    const hostname = parsed.hostname;
    const isDirectLoopback =
      hostname === '127.0.0.1'
      || hostname === 'localhost'
      || hostname === '::1'
      || hostname === '[::1]'
      || hostname === '0.0.0.0';

    // Prefer an explicit IPv4 loopback URL to avoid flaky IPv6-only binds (or resolution differences)
    // in CI/Metro environments. Keep non-loopback hostnames stable.
    if (isDirectLoopback) {
      return `${parsed.protocol}//127.0.0.1${port}${path}`.replace(/\/+$/, '');
    }
    if (hostname.endsWith('.localhost')) {
      return `${parsed.protocol}//127.0.0.1${port}${path}`.replace(/\/+$/, '');
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return input.replace(/\/+$/, '');
  }
}

export function expandLoopbackBaseUrlCandidates(input: string): string[] {
  const original = input.replace(/\/+$/, '');

  try {
    const parsed = new URL(original);
    const isLoopbackHost =
      parsed.hostname === '127.0.0.1'
      || parsed.hostname === '0.0.0.0'
      || parsed.hostname === '::1'
      || parsed.hostname === '[::1]'
      || parsed.hostname === 'localhost'
      || parsed.hostname.endsWith('.localhost');

    if (!isLoopbackHost) {
      return [original];
    }

    const port = parsed.port ? `:${parsed.port}` : '';
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`.replace(/\/+$/, '');
    const v4 = `${parsed.protocol}//127.0.0.1${port}${path}`;
    const localhost = `${parsed.protocol}//localhost${port}${path}`;
    const v6 = `${parsed.protocol}//[::1]${port}${path}`;

    // Prefer IPv4 loopback first to avoid flaky IPv6-only binds or implicit redirects.
    // Keep the original URL in the candidate set for cases where the server is truly bound there.
    const candidates = [v4, localhost, original, v6];

    return [...new Set(candidates.map((candidate) => candidate.replace(/\/+$/, '')))];
  } catch {
    const normalized = normalizeLoopbackBaseUrl(original);
    return normalized === original ? [original] : [original, normalized];
  }
}
