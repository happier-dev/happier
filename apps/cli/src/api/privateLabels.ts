import tweetnacl from 'tweetnacl';

import { prepareSavedSecretResourceRecipientEnvelopesV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import {
  openPrivateLabelV1,
  sealPrivateLabelV1,
  type PrivateLabelBindingV1,
  type PrivateLabelReadV1,
  type PrivateLabelReadPolicyV1,
  type PrivateLabelStoredV1,
} from '@happier-dev/protocol/crypto/privateLabelV1';
import {
  PrivateLabelRecipientCensusRequestV1Schema,
  PrivateLabelRecipientCensusResponseV1Schema,
  type PrivateLabelRecipientCensusOwnerV1,
  type PrivateLabelRecipientCensusResponseV1,
} from '@happier-dev/protocol/crypto/privateLabelRecipientCensusV1';
import {
  MachinePoolPrivateViewV1Schema,
  MachinePoolViewV1Schema,
  type MachinePoolPrivateViewV1,
  type MachinePoolViewV1,
} from '@happier-dev/protocol/machines/pools/v1';
import { fetchWithCredentialRedirectRefusal } from '@happier-dev/cli-common/homeTarget';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';

import type { AccountEncryptionCredentials } from '@/persistence';

export class CliPrivateLabelError extends Error {
  readonly code = 'private_label_unavailable' as const;

  constructor() {
    super('The Account private-label recipient material is unavailable.');
  }
}

type PrepareCliPrivateLabelInput = Readonly<{
  endpoint: string;
  token: string;
  accountId: string;
  /** The caller's already-admitted persisted Account mode. */
  accountMode: PrivateLabelRecipientCensusResponseV1['contentEncryptionMode'];
  /** The credential-specific Account transport that authorizes this census. */
  recipientCensusPath: string;
  binding: PrivateLabelBindingV1;
  value: string;
  signal?: AbortSignal;
}>;

type OpenCliPrivateLabelInput = Readonly<{
  binding: PrivateLabelBindingV1;
  /** The Home projects only this reader's envelope before the CLI opens it. */
  label: PrivateLabelReadV1 | null | undefined;
  /** The owner-established policy; protocol admits the stored arm. */
  readPolicy: PrivateLabelReadPolicyV1;
  /** The persisted author mode, represented by the stored label, decides whether this is needed. */
  accountKey?: Uint8Array;
}>;

/** Returns an independently owned key copy so the caller can retire it after opening labels. */
export function deriveCliPrivateLabelAccountKey(
  encryption: AccountEncryptionCredentials | null | undefined,
): Uint8Array | null {
  if (!encryption) return null;
  const source = encryption.type === 'legacy' ? encryption.secret : encryption.machineKey;
  if (source.byteLength !== tweetnacl.box.secretKeyLength) return null;
  return encryption.type === 'legacy'
    ? deriveAccountMachineKeyFromRecoverySecret(source)
    : new Uint8Array(source);
}

function censusUrl(endpoint: string, recipientCensusPath: string): string {
  return `${endpoint.replace(/\/+$/u, '')}${recipientCensusPath}`;
}

async function requestRecipientCensus(params: Readonly<{
  endpoint: string;
  token: string;
  owner: PrivateLabelRecipientCensusOwnerV1;
  recipientCensusPath: string;
  signal?: AbortSignal;
}>) {
  const request = PrivateLabelRecipientCensusRequestV1Schema.safeParse({ owner: params.owner });
  if (!request.success) throw new CliPrivateLabelError();

  let response: Response;
  try {
    response = await fetchWithCredentialRedirectRefusal(censusUrl(params.endpoint, params.recipientCensusPath), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request.data),
      ...(params.signal ? { signal: params.signal } : {}),
    });
  } catch {
    throw new CliPrivateLabelError();
  }
  const body = await response.json().catch(() => null);
  const census = PrivateLabelRecipientCensusResponseV1Schema.safeParse(body);
  if (!response.ok || !census.success) throw new CliPrivateLabelError();
  return census.data;
}

/**
 * Seals a CLI-owned label using the caller's admitted Account mode and a
 * credential-specific Saved Secret recipient census. The server remains the
 * recipient authority, but its census must not select the content mode.
 */
export async function prepareCliPrivateLabel(input: PrepareCliPrivateLabelInput): Promise<PrivateLabelStoredV1> {
  const census = await requestRecipientCensus({
    endpoint: input.endpoint,
    token: input.token,
    owner: { kind: 'account', accountId: input.accountId },
    recipientCensusPath: input.recipientCensusPath,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  try {
    if (census.contentEncryptionMode !== input.accountMode) throw new CliPrivateLabelError();
    if (input.accountMode === 'plain') {
      return sealPrivateLabelV1({ mode: 'plain', binding: input.binding, value: input.value });
    }

    const dataKey = tweetnacl.randomBytes(tweetnacl.secretbox.keyLength);
    try {
      const prepared = prepareSavedSecretResourceRecipientEnvelopesV1({
        recipients: census.recipients,
        resourceDataKey: dataKey,
        randomBytes: tweetnacl.randomBytes,
      });
      // A newly generated key has no prior envelopes to retain: every census
      // recipient must receive the one standard Saved Secret envelope.
      if (prepared.length !== census.recipients.length) throw new CliPrivateLabelError();
      return sealPrivateLabelV1({
        mode: 'e2ee',
        binding: input.binding,
        value: input.value,
        dataKey,
        recipients: prepared.map((recipient) => ({
          accountId: recipient.recipientAccountId,
          envelope: {
            encryptedDataKey: recipient.encryptedDataKey,
            recipientContentPublicKeyFingerprint: recipient.recipientContentPublicKeyFingerprint,
          },
        })),
        randomBytes: tweetnacl.randomBytes,
      });
    } finally {
      dataKey.fill(0);
    }
  } catch (error) {
    if (error instanceof CliPrivateLabelError) throw error;
    throw new CliPrivateLabelError();
  }
}

/** Opens only a reader-projected label; unavailable E2EE material never becomes plaintext. */
export function openCliPrivateLabel(input: OpenCliPrivateLabelInput): string | null {
  const label = input.label;
  if (!label) return null;
  try {
    if (label.content.t === 'plain') {
      return openPrivateLabelV1({ binding: input.binding, label, readPolicy: input.readPolicy });
    }
    if (!label.recipientEnvelope || !input.accountKey) return null;
    const dataKey = openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(label.recipientEnvelope.encryptedDataKey),
      recipientSecretKeyOrSeed: input.accountKey,
    });
    if (!dataKey) return null;
    try {
      return openPrivateLabelV1({ binding: input.binding, label, readPolicy: input.readPolicy, dataKey });
    } finally {
      dataKey.fill(0);
    }
  } catch {
    return null;
  }
}

/**
 * The Pool protocol deliberately separates recipient-scoped wire labels from a
 * rendered view. A missing envelope or unavailable projection makes the whole
 * display view unavailable; callers must not leak ciphertext or invent a name.
 */
export function openCliMachinePoolPrivateView(input: Readonly<{
  view: MachinePoolPrivateViewV1;
  /** Captured once for this Account-owned resource read; Team pools use their resource policy. */
  accountContentEncryptionMode: 'plain' | 'e2ee';
  accountKey?: Uint8Array;
}>): MachinePoolViewV1 | null {
  const parsed = MachinePoolPrivateViewV1Schema.safeParse(input.view);
  if (!parsed.success) return null;
  const view = parsed.data;
  const readPolicy: PrivateLabelReadPolicyV1 = view.pool.audience?.kind === 'team'
    ? { kind: 'team-resource' }
    : { kind: 'account-owned', contentEncryptionMode: input.accountContentEncryptionMode };
  const open = (field: 'name' | 'description', projection: typeof view.pool.name): string | null => {
    if (projection.kind !== 'available') return null;
    return openCliPrivateLabel({
      binding: { entity: 'machine_pool', field, id: view.pool.id },
      label: projection.label,
      readPolicy,
      ...(input.accountKey ? { accountKey: input.accountKey } : {}),
    });
  };
  const name = open('name', view.pool.name);
  const description = view.pool.description === null ? null : open('description', view.pool.description);
  if (name === null || description === null && view.pool.description !== null) return null;
  const opened = MachinePoolViewV1Schema.safeParse({
    ...view,
    pool: { ...view.pool, name, description },
  });
  return opened.success ? opened.data : null;
}

/**
 * Opens the complete Pool list before a local reference census consumes a
 * display name. Partial disclosure is unsafe: the census has no ciphertext
 * representation and must report the Pool source unavailable instead.
 */
export function openCliMachinePoolPrivateViews(input: Readonly<{
  views: readonly MachinePoolPrivateViewV1[];
  accountContentEncryptionMode: 'plain' | 'e2ee';
  accountKey?: Uint8Array;
}>): Readonly<{ pools: readonly MachinePoolViewV1[] }> | null {
  const pools: MachinePoolViewV1[] = [];
  for (const view of input.views) {
    const opened = openCliMachinePoolPrivateView({
      view,
      accountContentEncryptionMode: input.accountContentEncryptionMode,
      ...(input.accountKey ? { accountKey: input.accountKey } : {}),
    });
    if (!opened) return null;
    pools.push(opened);
  }
  return { pools };
}
