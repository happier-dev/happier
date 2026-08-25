import {
  type VoiceCredentialBindingIdentityV1,
  type VoiceCredentialSourceSelection,
  decryptSecretValueWithKeysV1,
  resolveAccountSettingsVoiceCredentialSource,
} from '@happier-dev/protocol';

import {
  getActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshotLifetimeToken,
  type ActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { indexSavedSecretsByIdFromAccountSettings } from '@/settings/secrets/indexSavedSecretsById';

export type VoiceCredentialResolutionSource = 'account' | 'machine_override';

type VoiceCredentialReference = Readonly<{
  secretId: string;
  source: VoiceCredentialResolutionSource;
  secretUpdatedAt: number;
  /** Retained only for unscoped snapshots, which cannot prove Account identity. */
  snapshot: ActiveAccountSettingsSnapshot;
}>;

export type VoiceCredentialResolver = Readonly<{
  /** Current Account-settings source selection before any secret materialization. */
  resolveSelectedSource(identity: VoiceCredentialBindingIdentityV1): VoiceCredentialSourceSelection | null;
  status(identity: VoiceCredentialBindingIdentityV1): Readonly<{
    available: boolean;
    source: VoiceCredentialResolutionSource | null;
  }>;
  withSecret<T>(params: Readonly<{
    identity: VoiceCredentialBindingIdentityV1;
    recipientContractDigest?: string;
    use: (secret: string) => Promise<T>;
  }>): Promise<T>;
}>;

function unavailable(): Error & { code: 'credential_unavailable' } {
  return Object.assign(new Error('credential_unavailable'), { code: 'credential_unavailable' as const });
}

/**
 * Resolve the SavedSecret this Voice target may use right now.
 *
 * The selected credential source is owned by Account Settings: a target whose
 * source is `none` or `connectedAccount` deliberately keeps its dormant
 * SavedSecret bindings, so only the canonical resolution may decide that the
 * saved-secret arm is the effective one. Any invalid or ambiguous stored shape
 * fails closed rather than falling back to a raw binding read.
 */
function resolveReference(params: Readonly<{
  snapshot: ActiveAccountSettingsSnapshot | null;
  machineId: string | null;
  identity: VoiceCredentialBindingIdentityV1;
  recipientContractDigest?: string;
}>): VoiceCredentialReference | null {
  if (!params.snapshot) return null;
  let resolved: ReturnType<typeof resolveAccountSettingsVoiceCredentialSource>;
  try {
    resolved = resolveAccountSettingsVoiceCredentialSource(
      params.snapshot.settings as unknown as Readonly<Record<string, unknown>>,
      {
        contribution: params.identity.contribution,
        credentialSlotId: params.identity.credentialSlotId,
        purpose: params.identity.purpose,
        machineId: params.machineId,
      },
    );
  } catch {
    return null;
  }
  if (resolved.selection.kind !== 'savedSecret' || !resolved.savedSecret) return null;
  if (
    params.recipientContractDigest
    && resolved.approvedRecipientContractDigest !== params.recipientContractDigest
  ) {
    return null;
  }
  const secretId = resolved.savedSecret.secretId;
  if (!indexSavedSecretsByIdFromAccountSettings(params.snapshot.settings).has(secretId)) return null;
  let savedSecret: (typeof params.snapshot.settings.secrets)[number] | null = null;
  // Match the `Map#set` last-record semantics used for the decryption lookup
  // below so an invalid duplicate record cannot split the revision fence from
  // the credential bytes this legacy reader still selects.
  for (const candidate of params.snapshot.settings.secrets) {
    if (candidate.id === secretId) savedSecret = candidate;
  }
  if (!savedSecret) return null;
  return Object.freeze({
    secretId,
    source: resolved.savedSecret.source,
    secretUpdatedAt: savedSecret.updatedAt,
    snapshot: params.snapshot,
  });
}

/**
 * A Settings version is the whole-document CAS revision, so unrelated Account
 * settings writes advance it.  This resolver instead fences the exact
 * selected SavedSecret record and source.  Unscoped snapshots cannot prove
 * they belong to the same Account and therefore retain the stricter identity
 * check; Account-lifetime changes are fenced separately by the publisher.
 */
function sameCredentialReference(
  before: VoiceCredentialReference,
  after: VoiceCredentialReference,
): boolean {
  const beforeScopeKey = before.snapshot.scopeKey;
  const afterScopeKey = after.snapshot.scopeKey;
  if (beforeScopeKey === undefined || afterScopeKey === undefined) {
    return before.snapshot === after.snapshot;
  }
  return beforeScopeKey === afterScopeKey
    && before.secretId === after.secretId
    && before.source === after.source
    && before.secretUpdatedAt === after.secretUpdatedAt;
}

function readSelectedSource(params: Readonly<{
  snapshot: ActiveAccountSettingsSnapshot | null;
  machineId: string | null;
  identity: VoiceCredentialBindingIdentityV1;
}>): VoiceCredentialSourceSelection | null {
  if (!params.snapshot) return null;
  try {
    return resolveAccountSettingsVoiceCredentialSource(
      params.snapshot.settings as unknown as Readonly<Record<string, unknown>>,
      {
        contribution: params.identity.contribution,
        credentialSlotId: params.identity.credentialSlotId,
        purpose: params.identity.purpose,
        machineId: params.machineId,
      },
    ).selection;
  } catch {
    return null;
  }
}

export function createVoiceCredentialResolver(params: Readonly<{
  /** Null selects the account-only client realm and deliberately ignores machine overrides. */
  machineId: string | null;
  getSnapshot?: () => ActiveAccountSettingsSnapshot | null;
  getLifetimeToken?: () => number;
}>): VoiceCredentialResolver {
  const getSnapshot = params.getSnapshot ?? getActiveAccountSettingsSnapshot;
  const getLifetimeToken = params.getLifetimeToken ?? getActiveAccountSettingsSnapshotLifetimeToken;
  return Object.freeze({
    resolveSelectedSource(identity) {
      return identity
        ? readSelectedSource({
            snapshot: getSnapshot(),
            machineId: params.machineId,
            identity,
          })
        : null;
    },
    status(identity) {
      const resolved = identity
        ? resolveReference({ snapshot: getSnapshot(), machineId: params.machineId, identity })
        : null;
      return resolved
        ? { available: true, source: resolved.source }
        : { available: false, source: null };
    },
    async withSecret<T>(input: Readonly<{
      identity: VoiceCredentialBindingIdentityV1;
      recipientContractDigest?: string;
      use: (secret: string) => Promise<T>;
    }>): Promise<T> {
      if (!input.identity) throw unavailable();
      const snapshot = getSnapshot();
      const lifetimeToken = getLifetimeToken();
      const resolved = resolveReference({
        snapshot,
        machineId: params.machineId,
        identity: input.identity,
        ...(input.recipientContractDigest
          ? { recipientContractDigest: input.recipientContractDigest }
          : {}),
      });
      if (!snapshot || !resolved) throw unavailable();
      const savedSecret = indexSavedSecretsByIdFromAccountSettings(snapshot.settings).get(resolved.secretId);
      if (!savedSecret) throw unavailable();
      const secret = decryptSecretValueWithKeysV1(savedSecret, snapshot.settingsSecretsReadKeys);
      if (!secret) throw unavailable();
      const result = await input.use(secret);
      const current = resolveReference({
        snapshot: getSnapshot(),
        machineId: params.machineId,
        identity: input.identity,
        ...(input.recipientContractDigest
          ? { recipientContractDigest: input.recipientContractDigest }
          : {}),
      });
      // A client artifact minted from a superseded selected credential must
      // not escape after an Account switch, source change, removal, rotation,
      // or recipient-approval change. Account Settings' whole-document CAS
      // version is deliberately not an authority fence here.
      if (
        getLifetimeToken() !== lifetimeToken
        || !current
        || !sameCredentialReference(resolved, current)
      ) {
        throw unavailable();
      }
      return result;
    },
  });
}
