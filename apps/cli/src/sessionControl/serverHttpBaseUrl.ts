import { configuration } from '@/configuration';
import { resolveLoopbackHttpUrl } from '@/api/client/loopbackUrl';

export function resolveServerHttpBaseUrl(): string {
  return resolveLoopbackHttpUrl(configuration.serverUrl).replace(/\/+$/, '');
}
