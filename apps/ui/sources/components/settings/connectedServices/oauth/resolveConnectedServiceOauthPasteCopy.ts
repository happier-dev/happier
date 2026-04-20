import { t } from '@/text';

import type { ConnectedServiceId } from '@happier-dev/protocol';
import { getConnectedServiceRegistryEntry, type ConnectedServiceOauthPasteCopyKeyPrefix } from '@/sync/domains/connectedServices/connectedServiceRegistry';

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

function resolveCopyFromPrefix(prefix: ConnectedServiceOauthPasteCopyKeyPrefix): ConnectedServiceOauthPasteCopyOverride {
  return {
    connectWebDescription: t(`${prefix}.connectWebDescription`),
    pasteRedirectUrlPromptBody: t(`${prefix}.pasteRedirectUrlPromptBody`),
    pasteRedirectUrlPlaceholder: t(`${prefix}.pasteRedirectUrlPlaceholder`),
    missingStateError: t(`${prefix}.errors.missingState`),
  };
}

export function resolveConnectedServiceOauthPasteCopy(serviceId: ConnectedServiceId): ConnectedServiceOauthPasteCopy {
  const base = resolveDefaultCopy();
  const entry = getConnectedServiceRegistryEntry(serviceId);
  const override = entry.oauthPasteCopyKeyPrefix ? resolveCopyFromPrefix(entry.oauthPasteCopyKeyPrefix) : null;
  if (!override) return base;
  return {
    ...base,
    ...override,
  };
}
