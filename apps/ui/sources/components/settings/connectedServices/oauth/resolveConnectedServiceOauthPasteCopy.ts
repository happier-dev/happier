import { t } from '@/text';

import type { ConnectedServiceId } from '@happier-dev/protocol';

export type ConnectedServiceOauthPasteCopy = Readonly<{
  connectWebDescription: string;
  pasteRedirectUrlPromptBody: string;
  pasteRedirectUrlPlaceholder: string;
  missingStateError: string;
}>;

function resolveDefaultCopy(): ConnectedServiceOauthPasteCopy {
  return {
    connectWebDescription: t('connectedServices.oauthPaste.connectWebDescription'),
    pasteRedirectUrlPromptBody: t('connectedServices.oauthPaste.pasteRedirectUrlPromptBody'),
    pasteRedirectUrlPlaceholder: t('connectedServices.oauthPaste.pasteRedirectUrlPlaceholder'),
    missingStateError: t('connectedServices.oauthPaste.errors.missingState'),
  };
}

type ConnectedServiceOauthPasteCopyOverride = Readonly<Partial<ConnectedServiceOauthPasteCopy>>;

const SERVICE_OVERRIDES: Readonly<Partial<Record<ConnectedServiceId, ConnectedServiceOauthPasteCopyOverride>>> = Object.freeze({
  'claude-subscription': Object.freeze({
    connectWebDescription: t('connectedServices.oauthPaste.providerOverrides.claudeSubscription.connectWebDescription'),
    pasteRedirectUrlPromptBody: t('connectedServices.oauthPaste.providerOverrides.claudeSubscription.pasteRedirectUrlPromptBody'),
    pasteRedirectUrlPlaceholder: t('connectedServices.oauthPaste.providerOverrides.claudeSubscription.pasteRedirectUrlPlaceholder'),
    missingStateError: t('connectedServices.oauthPaste.providerOverrides.claudeSubscription.errors.missingState'),
  }),
});

export function resolveConnectedServiceOauthPasteCopy(serviceId: ConnectedServiceId): ConnectedServiceOauthPasteCopy {
  const base = resolveDefaultCopy();
  const override = SERVICE_OVERRIDES[serviceId];
  if (!override) return base;
  return {
    ...base,
    ...override,
  };
}
