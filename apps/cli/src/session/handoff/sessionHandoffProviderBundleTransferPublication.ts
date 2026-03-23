import {
  TransferEndpointCandidateSchema,
  type TransferEndpointCandidate,
} from '@happier-dev/protocol';

export type SessionHandoffProviderBundleTransferPublication = Readonly<{
  transferId: string;
  sizeBytes: number;
  manifestHash: string;
  endpointCandidates?: readonly TransferEndpointCandidate[];
}>;

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

export function parseSessionHandoffProviderBundleTransferPublication(
  value: unknown,
): SessionHandoffProviderBundleTransferPublication | null {
  if (value === undefined) {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid session handoff transfer payload');
  }

  const transferId = (value as { transferId?: unknown }).transferId;
  const sizeBytes = (value as { sizeBytes?: unknown }).sizeBytes;
  const manifestHash = (value as { manifestHash?: unknown }).manifestHash;
  const endpointCandidatesValue = (value as { endpointCandidates?: unknown }).endpointCandidates;
  if (
    typeof transferId !== 'string'
    || transferId.length === 0
    || typeof sizeBytes !== 'number'
    || !Number.isInteger(sizeBytes)
    || sizeBytes < 0
    || typeof manifestHash !== 'string'
    || manifestHash.length === 0
  ) {
    throw new Error('Invalid session handoff transfer payload');
  }

  const endpointCandidates =
    endpointCandidatesValue === undefined
      ? undefined
      : Array.isArray(endpointCandidatesValue)
        ? endpointCandidatesValue.map((endpointCandidate) => {
          const parsed = TransferEndpointCandidateSchema.safeParse(endpointCandidate);
          if (!parsed.success) {
            throw new Error('Invalid session handoff transfer payload');
          }
          return parsed.data;
        })
        : (() => {
          throw new Error('Invalid session handoff transfer payload');
        })();

  return {
    transferId,
    sizeBytes,
    manifestHash,
    ...(endpointCandidates ? { endpointCandidates } : {}),
  };
}
