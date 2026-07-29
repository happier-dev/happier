import {
  VoiceCredentialBindingV1Schema,
  decryptSecretValueWithKeysV1,
  resolveSavedSecretSlotBindingIdV1,
} from '@happier-dev/protocol';

import {
  getActiveAccountSettingsSnapshot,
  type ActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { indexSavedSecretsByIdFromAccountSettings } from '@/settings/secrets/indexSavedSecretsById';

export type VoiceCredentialResolutionSource = 'account' | 'machine_override';

export type VoiceCredentialResolver = Readonly<{
  status(providerId: string, credentialSlotId: string): Readonly<{
    available: boolean;
    source: VoiceCredentialResolutionSource | null;
  }>;
  withSecret<T>(params: Readonly<{
    providerId: string;
    credentialSlotId: string;
    use: (secret: string) => Promise<T>;
  }>): Promise<T>;
}>;

function unavailable(): Error & { code: 'credential_unavailable' } {
  return Object.assign(new Error('credential_unavailable'), { code: 'credential_unavailable' as const });
}

function resolveReference(params: Readonly<{
  snapshot: ActiveAccountSettingsSnapshot | null;
  machineId: string | null;
  providerId: string;
  credentialSlotId: string;
}>): Readonly<{ secretId: string; source: VoiceCredentialResolutionSource }> | null {
  if (!params.snapshot) return null;
  const settingsRecord = params.snapshot.settings as unknown as Record<string, unknown>;
  const voice = settingsRecord.voice && typeof settingsRecord.voice === 'object' && !Array.isArray(settingsRecord.voice)
    ? settingsRecord.voice as Record<string, unknown>
    : null;
  const rawBindings = Array.isArray(voice?.credentialBindings) ? voice.credentialBindings : [];
  const binding = rawBindings
    .map((candidate) => VoiceCredentialBindingV1Schema.safeParse(candidate))
    .find((parsed) => parsed.success && parsed.data.providerId === params.providerId);
  if (!binding?.success) return null;
  const secretId = params.machineId === null
    ? binding.data.credentialBindings.account?.[params.credentialSlotId] ?? null
    : resolveSavedSecretSlotBindingIdV1(
        binding.data.credentialBindings,
        params.machineId,
        params.credentialSlotId,
      );
  if (!secretId || !indexSavedSecretsByIdFromAccountSettings(params.snapshot.settings).has(secretId)) return null;
  return {
    secretId,
    source: params.machineId !== null
      && binding.data.credentialBindings.byMachineId?.[params.machineId]?.[params.credentialSlotId] === secretId
      ? 'machine_override'
      : 'account',
  };
}

export function createVoiceCredentialResolver(params: Readonly<{
  /** Null selects the account-only client realm and deliberately ignores machine overrides. */
  machineId: string | null;
  getSnapshot?: () => ActiveAccountSettingsSnapshot | null;
}>): VoiceCredentialResolver {
  const getSnapshot = params.getSnapshot ?? getActiveAccountSettingsSnapshot;
  const reference = (providerId: string, credentialSlotId: string) => resolveReference({
    snapshot: getSnapshot(), machineId: params.machineId, providerId, credentialSlotId,
  });
  return Object.freeze({
    status(providerId, credentialSlotId) {
      const resolved = reference(providerId, credentialSlotId);
      return resolved
        ? { available: true, source: resolved.source }
        : { available: false, source: null };
    },
    async withSecret<T>(input: Readonly<{
      providerId: string;
      credentialSlotId: string;
      use: (secret: string) => Promise<T>;
    }>): Promise<T> {
      const snapshot = getSnapshot();
      const resolved = resolveReference({
        snapshot, machineId: params.machineId,
        providerId: input.providerId, credentialSlotId: input.credentialSlotId,
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
