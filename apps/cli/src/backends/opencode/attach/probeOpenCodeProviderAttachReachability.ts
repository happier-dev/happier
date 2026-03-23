import type { ProviderAttachReachability } from '@/backends/types';

import { resolveOpenCodeProviderAttachTarget } from './evaluateOpenCodeProviderAttachEligibility';

function buildHealthUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/global/health`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export async function probeOpenCodeProviderAttachReachability(params: Readonly<{
  metadata: Record<string, unknown>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}>): Promise<ProviderAttachReachability> {
  const target = resolveOpenCodeProviderAttachTarget(params.metadata);
  if (!target.eligible) {
    return {
      reachable: false,
      reason: target.reason,
    };
  }

  const url = buildHealthUrl(target.baseUrl);
  if (!url) {
    return {
      reachable: false,
      reason: 'Session includes an invalid OpenCode server URL.',
    };
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), params.timeoutMs ?? 1_500);
    timer.unref?.();
    const response = await (params.fetchFn ?? fetch)(url, {
      method: 'GET',
      signal: ctrl.signal,
    }).catch(() => null);
    clearTimeout(timer);

    return response?.ok
      ? { reachable: true }
      : { reachable: false, reason: 'Remote OpenCode server is unreachable.' };
  } catch {
    return {
      reachable: false,
      reason: 'Remote OpenCode server is unreachable.',
    };
  }
}
