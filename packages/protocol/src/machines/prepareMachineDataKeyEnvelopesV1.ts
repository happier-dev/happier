import type { MachineAccessRecipientCensusResponseV1, MachineAccessRefusalCodeV1, MachineKeyPreparationResultV1, MachineRecipientKeyEnvelopeCommitInputV1, MachineRecipientKeyEnvelopeCommitResponseV1, MachineRecipientKeyEnvelopeInputV1 } from './machineAccessV1.js';
import { isMachinePublishedContentSafeV1 } from './machinePublishedContentV1.js';
import { computeContentPublicKeyFingerprint } from './identity/contentPublicKeyFingerprint.js';
import { decodeBase64 } from '../crypto/base64.js';
import { ENCRYPTED_DATA_KEY_V1_BYTES } from '../crypto/encryptedDataKeyEnvelopeFormatV1.js';
import { prepareResourceDataKeyEnvelopeItemV1 } from '../sessions/encryption/prepareSessionDataKeyEnvelopeItemV1.js';
import { runSessionDataKeyPreparationPass } from '../sessions/encryption/sessionDataKeyPreparationPass.js';

export class MachineDataKeyPreparationErrorV1 extends Error {
  constructor(readonly code: MachineAccessRefusalCodeV1) { super(code); this.name = 'MachineDataKeyPreparationErrorV1'; }
}

export type MachineDataKeyEnvelopeTransportV1 = Readonly<{
  fetchPage: (cursor: string | null) => Promise<MachineAccessRecipientCensusResponseV1>;
  patchPage: (request: MachineRecipientKeyEnvelopeCommitInputV1) => Promise<MachineRecipientKeyEnvelopeCommitResponseV1>;
}>;

type Recipient = MachineAccessRecipientCensusResponseV1['recipients'][number];

/** One trusted-holder flow; the Home alone owns audience, permission and conditional tuple writes. */
export async function prepareMachineDataKeyEnvelopesV1(params: Readonly<{
  machineId: string;
  transport: MachineDataKeyEnvelopeTransportV1;
  resolveTransferableDataKey: (page: MachineAccessRecipientCensusResponseV1) => Promise<Uint8Array | null>;
  decodeStoredContent: (key: Uint8Array, content: string) => Promise<unknown>;
  isScopeCurrent: () => boolean;
  randomBytes: (length: number) => Uint8Array;
  mapRecipients: <T>(items: readonly Recipient[], prepare: (item: Recipient) => T) => Promise<T[]>;
}>): Promise<MachineKeyPreparationResultV1> {
  try {
    if (!params.isScopeCurrent()) return { kind: 'unavailable', code: 'machine_key_changed' };
    const basis = await params.transport.fetchPage(null);
    if (!params.isScopeCurrent()) return { kind: 'unavailable', code: 'machine_key_changed' };
    if (basis.machineId !== params.machineId) return { kind: 'unavailable', code: 'machine_unavailable' };
    if (basis.encryptionMode === 'plain') return { kind: 'prepared' };
    if (!basis.machineOwnerEnvelopeFingerprint || !basis.callerDataEncryptionKey) return { kind: 'pending_holder' };
    const key = await params.resolveTransferableDataKey(basis);
    if (!params.isScopeCurrent()) return { kind: 'unavailable', code: 'machine_key_changed' };
    if (!key || key.byteLength !== ENCRYPTED_DATA_KEY_V1_BYTES) return { kind: 'pending_holder' };

    // Open both whole blobs, without tolerant hydration or caches. Unknown/private bytes are a
    // disclosure failure even when a display reader would silently strip them.
    let metadata: unknown;
    let daemonState: unknown = null;
    try {
      metadata = await params.decodeStoredContent(key, basis.content.metadata);
      if (basis.content.daemonState !== null) daemonState = await params.decodeStoredContent(key, basis.content.daemonState);
    } catch { return { kind: 'pending_holder' }; }
    if (!params.isScopeCurrent()) return { kind: 'unavailable', code: 'machine_key_changed' };
    if (!isMachinePublishedContentSafeV1({ metadata, daemonState })) return { kind: 'pending_holder' };

    let initial = true;
    let incompatible = false;
    let invalidBinding = false;
    const result = await runSessionDataKeyPreparationPass<Recipient, MachineRecipientKeyEnvelopeInputV1>({
      fetchPage: async cursor => {
        const page = initial ? basis : await params.transport.fetchPage(cursor);
        initial = false;
        if (page.machineId !== basis.machineId || page.encryptionMode !== basis.encryptionMode
          || page.machineOwnerEnvelopeFingerprint !== basis.machineOwnerEnvelopeFingerprint
          || page.callerDataEncryptionKey !== basis.callerDataEncryptionKey
          || page.content.metadataVersion !== basis.content.metadataVersion
          || page.content.daemonStateVersion !== basis.content.daemonStateVersion) {
          throw new MachineDataKeyPreparationErrorV1('machine_key_changed');
        }
        return { items: page.recipients, nextCursor: page.nextCursor };
      },
      itemKey: item => item.recipientAccountId,
      prepareEntries: async items => {
        const failedItemKeys: string[] = [];
        const prepared = await params.mapRecipients(items, item => {
          const sealed = prepareResourceDataKeyEnvelopeItemV1({
            item: { ...item, envelopeState: item.encryptedDataKey === null ? 'missing' : 'invalid' },
            resourceDataKey: key, randomBytes: params.randomBytes,
          });
          if (sealed.kind !== 'prepared') {
            failedItemKeys.push(item.recipientAccountId);
            if (sealed.kind === 'invalid_binding') invalidBinding = true;
            if (sealed.kind === 'setup_required' && sealed.reason === 'plain_account') incompatible = true;
            return null;
          }
          const fingerprint = computeContentPublicKeyFingerprint(decodeBase64(item.contentKey.status === 'available' ? item.contentKey.contentPublicKey : ''));
          if (fingerprint !== item.contentPublicKeyFingerprint) {
            throw new MachineDataKeyPreparationErrorV1('recipient_binding_changed');
          }
          return { ...sealed.entry, recipientContentPublicKeyFingerprint: fingerprint };
        });
        return { entries: prepared.filter(entry => entry !== null), failedItemKeys };
      },
      commitEntries: async entries => {
        const response = await params.transport.patchPage({
          machineId: basis.machineId,
          expectedMachineOwnerEnvelopeFingerprint: basis.machineOwnerEnvelopeFingerprint!,
          expectedCallerDataEncryptionKey: basis.callerDataEncryptionKey!,
          expectedMetadataVersion: basis.content.metadataVersion,
          expectedDaemonStateVersion: basis.content.daemonStateVersion,
          recipientKeyEnvelopes: [...entries],
        });
        return response.appliedRecipientAccountIds.length;
      },
      isScopeCurrent: params.isScopeCurrent,
    });
    if (result.status === 'scope_changed') return { kind: 'unavailable', code: 'machine_key_changed' };
    if (incompatible) return { kind: 'recipient_incompatible' };
    if (invalidBinding) return { kind: 'unavailable', code: 'invalid_recipient_envelope' };
    return result.status === 'complete' ? { kind: 'prepared' } : { kind: 'pending_holder' };
  } catch (error) {
    if (!params.isScopeCurrent()) return { kind: 'unavailable', code: 'machine_key_changed' };
    return { kind: 'unavailable', code: error instanceof MachineDataKeyPreparationErrorV1 ? error.code : 'machine_unavailable' };
  }
}
