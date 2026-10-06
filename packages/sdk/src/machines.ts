import { openEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { resolvePublishedMachineDataEncryptionKeyV1 } from '@happier-dev/protocol/machines/machineStoredContent';
import { ExternalActionMachineBootstrapListV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { ExternalActionMachineBootstrapV1, ExternalActionTargetV1 } from '@happier-dev/protocol/actions';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';

import { HappierTransportError } from './errors.js';

export type HappierMachine = Readonly<{
  id: string;
  kind: 'persistent' | 'ephemeral_session_runner';
  active: boolean;
  revokedAt: number | null;
  replacedByMachineId: string | null;
}>;

export type MachineListOptions = Readonly<{
  signal?: AbortSignal;
}>;

/** Account E2EE material, and the Machine content key a Runner target needs. */
export type ProtectedActionMaterial = Readonly<{ type: 'dataKey'; machineKey: Uint8Array }>;

export function parseMachineBootstrapRows(
  value: unknown,
): readonly ExternalActionMachineBootstrapV1[] {
  const parsed = ExternalActionMachineBootstrapListV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new HappierTransportError('The Happier machine API returned an invalid response.');
  }
  return parsed.data;
}

export function parseMachineListResponse(value: unknown): readonly HappierMachine[] {
  return Object.freeze(parseMachineBootstrapRows(value).map((row) => Object.freeze({
    id: row.id,
    kind: row.kind,
    active: row.active,
    revokedAt: row.revokedAt,
    replacedByMachineId: row.replacedByMachineId,
  })));
}

export type MachineProtectedActionMaterialResolution =
  /** Not a restricted Runner: the released Account-material sealing applies. */
  | Readonly<{ kind: 'account' }>
  | Readonly<{ kind: 'runner'; material: ProtectedActionMaterial }>
  | Readonly<{ kind: 'unavailable' }>;

function openPublishedRunnerEnvelope(
  published: string,
  accountContentSecret: Uint8Array,
): Uint8Array | null {
  try {
    const envelope = decodeBase64(published);
    if (encodeBase64(envelope) !== published) return null;
    return openEncryptedDataKeyEnvelopeV1({
      envelope,
      recipientSecretKeyOrSeed: accountContentSecret,
    });
  } catch {
    return null;
  }
}

/**
 * Decides what a protected Action targeting this exact Machine or Session seals
 * against.
 *
 * A restricted Runner holds no Account material by contract, so a request
 * sealed with the Account key is unreadable there. Its own Machine content key
 * is published as an Account-sealed envelope authenticated by the creator's
 * strict binding; this resolves that key through the one canonical Machine
 * content-key owner, with the Home, creator Account and exact Machine supplied
 * from the row the target named and then re-proved against that binding rather
 * than trusted. Any mismatch — substituted binding, verifier fact, envelope or
 * Machine — resolves `unavailable`, and the caller fails closed instead of
 * falling back to the Account key or to plaintext.
 *
 * A Session target selects the Runner through its activation-signed claim, and
 * the same owner accepts the key only when that claim — verified under the
 * activation identity that authenticates the key binding — names this exact
 * Session, Machine and activation. The key binding alone signs no Session, so
 * an authentic key for Runner B is not proof that B holds Session A: a request
 * sealed to B's key would be disclosed to B's key holder even though an honest
 * B refuses the foreign Session before opening it. The Home therefore relays
 * the correspondence but cannot author it. One activation owns one Session and
 * one Machine, so a genuine projection names at most one Runner per Session;
 * more than one is a Home-authored ambiguity and fails closed. A Session no
 * Runner claims keeps the released Account sealing, which the Home cannot open.
 */
export function resolveMachineProtectedActionMaterial(params: Readonly<{
  rows: readonly ExternalActionMachineBootstrapV1[];
  target: ExternalActionTargetV1;
  homeServerIdentityId: string;
  accountId: string;
  accountMaterial: ProtectedActionMaterial;
}>): MachineProtectedActionMaterialResolution {
  const target = params.target;
  let row: ExternalActionMachineBootstrapV1 | undefined;
  if (target.kind === 'machine') {
    row = params.rows.find((candidate) => candidate.id === target.machineId);
  } else {
    const claimed = params.rows.filter((candidate) => (
      candidate.kind === 'ephemeral_session_runner'
      && candidate.runnerClaim?.payload.binding.sessionId === target.sessionId
    ));
    if (claimed.length > 1) return { kind: 'unavailable' };
    row = claimed[0];
  }
  if (!row || row.kind !== 'ephemeral_session_runner') return { kind: 'account' };
  const openedDataEncryptionKey = typeof row.dataEncryptionKey === 'string'
    ? openPublishedRunnerEnvelope(row.dataEncryptionKey, params.accountMaterial.machineKey)
    : null;
  const resolution = resolvePublishedMachineDataEncryptionKeyV1({
    machine: {
      id: row.id,
      kind: row.kind,
      installationId: row.installationId,
      dataEncryptionKey: row.dataEncryptionKey,
      runnerContentKeyBinding: row.runnerContentKeyBinding,
      runnerClaim: row.runnerClaim,
    },
    openedDataEncryptionKey,
    expectedAccountMode: 'e2ee',
    expectedRunnerBinding: {
      homeServerIdentityId: params.homeServerIdentityId,
      creatorAccountId: params.accountId,
      machineId: row.id,
      accountScopedMaterial: params.accountMaterial,
      ...(target.kind === 'session' ? { sessionId: target.sessionId } : {}),
    },
  });
  return resolution.status === 'e2ee'
    ? { kind: 'runner', material: { type: 'dataKey', machineKey: resolution.dataKey } }
    : { kind: 'unavailable' };
}
