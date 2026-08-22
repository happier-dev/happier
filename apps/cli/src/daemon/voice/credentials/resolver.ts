import {
  type VoiceCredentialBindingIdentityV1,
  decryptSecretValueWithKeysV1,
  resolveAccountSettingsVoiceCredentialSource,
} from '@happier-dev/protocol';

import {
  getActiveAccountSettingsSnapshot,
  type ActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { indexSavedSecretsByIdFromAccountSettings } from '@/settings/secrets/indexSavedSecretsById';

export type VoiceCredentialResolutionSource = 'account' | 'machine_override';

export type VoiceCredentialResolver = Readonly<{
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
}>): Readonly<{ secretId: string; source: VoiceCredentialResolutionSource }> | null {
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
  return { secretId, source: resolved.savedSecret.source };
}

export function createVoiceCredentialResolver(params: Readonly<{
  /** Null selects the account-only client realm and deliberately ignores machine overrides. */
  machineId: string | null;
  getSnapshot?: () => ActiveAccountSettingsSnapshot | null;
}>): VoiceCredentialResolver {
  const getSnapshot = params.getSnapshot ?? getActiveAccountSettingsSnapshot;
  return Object.freeze({
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
      // A client artifact minted from a superseded account snapshot must not
      // escape after an account switch, credential removal, or rotation.
      if (getSnapshot() !== snapshot) throw unavailable();
      return result;
    },
  });
}
