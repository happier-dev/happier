import type { ConnectedServiceId } from '@happier-dev/protocol';

export type ConnectedServiceOauthMode = 'device' | 'paste' | 'embedded';

function normalizeMethod(method: unknown): string {
  return typeof method === 'string' ? method.trim().toLowerCase() : '';
}

export function resolveConnectedServiceOauthMode(params: Readonly<{
  platformOS: string;
  serviceId: ConnectedServiceId;
  method?: string;
}>): ConnectedServiceOauthMode {
  const platformOS = String(params.platformOS ?? '').trim().toLowerCase();
  const method = normalizeMethod(params.method);

  if (platformOS === 'web') {
    if (params.serviceId === 'openai-codex') {
      return method === 'paste' ? 'paste' : 'device';
    }
    return 'paste';
  }

  if (params.serviceId === 'openai-codex') {
    if (method === 'browser') return 'embedded';
    if (method === 'paste') return 'paste';
    return 'device';
  }

  if (params.serviceId === 'claude-subscription') {
    if (method === 'browser') return 'embedded';
    return 'paste';
  }

  if (method === 'browser') return 'embedded';
  if (method === 'paste') return 'paste';

  // Default to paste mode on native for reliability (many providers block embedded webviews).
  return 'paste';
}
