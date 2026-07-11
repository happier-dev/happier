import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

export function resolveAccountSettingsHttpBaseUrl(): string {
  return resolveServerHttpBaseUrl();
}
