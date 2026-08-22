import { configuration } from '@/configuration';

import { resolveLoopbackHttpUrl } from './loopbackUrl';

export function normalizeServerHttpBaseUrl(serverUrl: string): string {
  return resolveLoopbackHttpUrl(serverUrl).replace(/\/+$/, '');
}

export function resolveServerHttpBaseUrl(): string {
  return normalizeServerHttpBaseUrl(configuration.apiServerUrl);
}
