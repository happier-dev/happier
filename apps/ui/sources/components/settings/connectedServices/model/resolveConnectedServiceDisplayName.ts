import type { ConnectedServiceId } from '@happier-dev/protocol';

import { t } from '@/text';

export function resolveConnectedServiceDisplayName(serviceId: ConnectedServiceId): string {
  switch (serviceId) {
    case 'claude-subscription':
      return t('connectedServices.serviceNames.claudeSubscription');
    case 'openai-codex':
      return t('connectedServices.serviceNames.openaiCodex');
    case 'openai':
      return t('connectedServices.serviceNames.openai');
    case 'anthropic':
      return t('connectedServices.serviceNames.anthropic');
    case 'gemini':
      return t('connectedServices.serviceNames.gemini');
    default:
      return t('connectedServices.fallbackName');
  }
}
