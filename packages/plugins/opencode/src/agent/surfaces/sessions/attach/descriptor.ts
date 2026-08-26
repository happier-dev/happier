import { readOpenCodeSessionRuntimeHandleFromMetadata } from '../../../identity/runtimeDescriptor.js';
import type {
  AgentProviderCliAttachTargetResolutionV1,
  AgentProviderCliAttachTargetV1,
  AttachSessionMetadata as AttachSessionMetadataV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

export type OpenCodeAttachTarget = AgentProviderCliAttachTargetResolutionV1;

export function resolveOpenCodeAttachTarget(params: Readonly<{
  metadata: AttachSessionMetadataV1;
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
    value: {
      providerSessionId,
      directory,
      baseUrl,
    },
  };
}

export function createOpenCodeAttachArgs(target: AgentProviderCliAttachTargetV1): string[] {
  return [
    'attach',
    target.baseUrl,
    '--dir',
    target.directory,
    '--session',
    target.providerSessionId,
  ];
}

export function buildOpenCodeAttachHealthUrl(target: AgentProviderCliAttachTargetV1): string | null {
  try {
    const url = new URL(target.baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/global/health`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}
