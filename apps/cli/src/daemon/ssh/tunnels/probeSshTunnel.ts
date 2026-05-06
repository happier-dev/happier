import type { SshTunnelHealth } from './types';

export type ProbeSshTunnelDeps = Readonly<{
  fetch?: typeof fetch;
  nowMs?: () => number;
}>;

function checkedAt(deps: ProbeSshTunnelDeps): string {
  return new Date((deps.nowMs ?? Date.now)()).toISOString();
}

function appendSlash(url: string): string {
  const parsed = new URL(url);
  if (!parsed.pathname || parsed.pathname === '/') {
    parsed.pathname = '/';
  }
  return parsed.toString();
}

function classifyProbeError(error: unknown): SshTunnelHealth['state'] {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase();
  const code = typeof (error as { code?: unknown } | null)?.code === 'string'
    ? String((error as { code: string }).code).toLowerCase()
    : '';
  if (code.includes('econnrefused') || code.includes('econnreset') || message.includes('econnrefused')) {
    return 'local_port_unreachable';
  }
  if (code.includes('etimedout') || message.includes('timeout')) {
    return 'remote_runtime_unavailable';
  }
  return 'unknown';
}

export async function probeSshTunnelUrl(
  httpBaseUrl: string,
  deps: ProbeSshTunnelDeps = {},
): Promise<SshTunnelHealth> {
  const doFetch = deps.fetch ?? fetch;
  try {
    const response = await doFetch(appendSlash(httpBaseUrl), {
      method: 'GET',
      signal: AbortSignal.timeout(3_000),
    });
    if (response.ok) {
      return {
        state: 'healthy',
        checkedAt: checkedAt(deps),
      };
    }
    return {
      state: response.status === 401 || response.status === 403 ? 'auth_required' : 'remote_runtime_unavailable',
      checkedAt: checkedAt(deps),
      httpStatus: response.status,
    };
  } catch (error) {
    return {
      state: classifyProbeError(error),
      checkedAt: checkedAt(deps),
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
