import type { ConnectedServiceId } from '@happier-dev/protocol';

export type ConnectedServiceOauthMode = 'device' | 'paste' | 'embedded';
export type ConnectedServiceOauthAddMethod = 'device' | 'paste' | 'browser';

function normalizeMethod(method: unknown): string {
  return typeof method === 'string' ? method.trim().toLowerCase() : '';
}

export function resolveConnectedServiceOauthMode(params: Readonly<{
  platformOS: string;
  serviceId: ConnectedServiceId;
  method?: string;
  oauthAddActionModes?: ReadonlyArray<ConnectedServiceOauthAddMethod>;
}>): ConnectedServiceOauthMode {
  const platformOS = String(params.platformOS ?? '').trim().toLowerCase();
  const method = normalizeMethod(params.method);

  const explicit: ConnectedServiceOauthMode | null =
    method === 'browser'
      ? 'embedded'
      : method === 'paste'
        ? 'paste'
        : method === 'device'
          ? 'device'
          : null;

  const fallbackMode = (() => {
    const preferred = params.oauthAddActionModes?.[0] ?? null;
    if (preferred === 'device') return 'device';
    if (preferred === 'paste') return 'paste';
    if (preferred === 'browser') return 'embedded';
    return 'paste';
  })();

  const allowDevice = (params.oauthAddActionModes ?? []).includes('device');
  const resolved = (() => {
    if (explicit === 'device' && !allowDevice) return 'paste';
    return explicit ?? fallbackMode;
  })();

  // Web cannot render embedded OAuthView, so treat it as paste.
  if (platformOS === 'web' && resolved === 'embedded') return 'paste';
  return resolved;
}
