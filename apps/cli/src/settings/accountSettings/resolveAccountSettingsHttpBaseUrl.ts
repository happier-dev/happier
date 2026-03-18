import { resolveLoopbackHttpUrl } from '@/api/client/loopbackUrl';
import { configuration } from '@/configuration';

export function resolveAccountSettingsHttpBaseUrl(): string {
  return resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
}
