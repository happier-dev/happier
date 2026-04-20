import type {
  SessionHandoffProviderBundleTransferPublication as ProtocolSessionHandoffProviderBundleTransferPublication,
} from '@happier-dev/protocol';

export type SessionHandoffProviderBundleTransferPublication =
  ProtocolSessionHandoffProviderBundleTransferPublication;

const SESSION_HANDOFF_PROVIDER_BUNDLE_TRANSFER_ID_SUFFIX = ':provider-bundle-file';

export function buildSessionHandoffProviderBundleTransferId(handoffId: string): string {
  return `session-handoff:${handoffId}${SESSION_HANDOFF_PROVIDER_BUNDLE_TRANSFER_ID_SUFFIX}`;
}

export function parseSessionHandoffProviderBundleTransferId(
  transferId: string,
): Readonly<{ handoffId: string }> | null {
  if (!transferId.startsWith('session-handoff:') || !transferId.endsWith(SESSION_HANDOFF_PROVIDER_BUNDLE_TRANSFER_ID_SUFFIX)) {
    return null;
  }

  const handoffId = transferId.slice(
    'session-handoff:'.length,
    transferId.length - SESSION_HANDOFF_PROVIDER_BUNDLE_TRANSFER_ID_SUFFIX.length,
  ).trim();
  return handoffId.length > 0 ? { handoffId } : null;
}
