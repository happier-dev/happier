export function normalizeLoopbackBaseUrl(input: string): string {
  try {
    const parsed = new URL(input);
    const port = parsed.port ? `:${parsed.port}` : '';
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1' || parsed.hostname === '[::1]') {
      return `${parsed.protocol}//${parsed.host}${path}`.replace(/\/+$/, '');
    }
    if (parsed.hostname === '0.0.0.0' || parsed.hostname.endsWith('.localhost')) {
      return `${parsed.protocol}//localhost${port}${path}`.replace(/\/+$/, '');
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
    const candidates = [
      original,
      `${parsed.protocol}//localhost${port}${path}`,
      `${parsed.protocol}//127.0.0.1${port}${path}`,
      `${parsed.protocol}//[::1]${port}${path}`,
    ];

    return [...new Set(candidates.map((candidate) => candidate.replace(/\/+$/, '')))];
  } catch {
    const normalized = normalizeLoopbackBaseUrl(original);
    return normalized === original ? [original] : [original, normalized];
  }
}
