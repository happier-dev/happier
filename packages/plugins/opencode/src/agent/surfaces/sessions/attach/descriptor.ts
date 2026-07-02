import { readOpenCodeSessionRuntimeHandleFromMetadata } from '../../../identity/runtimeDescriptor.js';

export type OpenCodeAttachTarget =
  | Readonly<{
      ok: true;
      providerSessionId: string;
      directory: string;
      baseUrl: string;
    }>
  | Readonly<{
      ok: false;
      reason: string;
    }>;

export function resolveOpenCodeAttachTarget(params: Readonly<{
  metadata: Readonly<Record<string, unknown>>;
  fallbackServerBaseUrl?: string | null;
}>): OpenCodeAttachTarget {
  const runtimeHandle = readOpenCodeSessionRuntimeHandleFromMetadata(params.metadata);
  const providerSessionId = runtimeHandle.providerSessionId;
  const directory = typeof params.metadata.path === 'string' && params.metadata.path.trim().length > 0
    ? params.metadata.path.trim()
    : null;
  const baseUrl = runtimeHandle.serverBaseUrl ?? params.fallbackServerBaseUrl ?? null;

  if (!providerSessionId) {
    return { ok: false, reason: 'Session does not include an OpenCode provider session id.' };
  }
  if (!directory) {
    return { ok: false, reason: 'Session metadata is missing a working directory path.' };
  }
  if (runtimeHandle.backendMode !== 'server') {
    return { ok: false, reason: 'OpenCode attach is only available for server-backed sessions.' };
  }
  if (!baseUrl) {
    return { ok: false, reason: 'Session does not include an OpenCode server URL.' };
  }

  return {
    ok: true,
    providerSessionId,
    directory,
    baseUrl,
  };
}

export function createOpenCodeAttachArgs(target: Readonly<{
  baseUrl: string;
  directory: string;
  providerSessionId: string;
}>): string[] {
  return [
    'attach',
    target.baseUrl,
    '--dir',
    target.directory,
    '--session',
    target.providerSessionId,
  ];
}

export function buildOpenCodeAttachHealthUrl(baseUrl: string): string | null {
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
