import { AIBackendProfileSchema, type AIBackendProfile } from '@happier-dev/protocol';

export type AccountSettingsProfilesSnapshot = Readonly<{
  customProfiles: AIBackendProfile[];
  secretBindingsByProfileId: Record<string, Record<string, string>>;
}>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function readProfilesFromAccountSettings(settings: Readonly<Record<string, unknown>>): AccountSettingsProfilesSnapshot {
  const customProfiles: AIBackendProfile[] = [];
  const rawProfiles = (settings as any)?.profiles;
  if (Array.isArray(rawProfiles)) {
    for (const item of rawProfiles) {
      const parsed = AIBackendProfileSchema.safeParse(item);
      if (parsed.success) {
        customProfiles.push(parsed.data);
      }
    }
  }

  const secretBindingsByProfileId: Record<string, Record<string, string>> = {};
  const rawBindings = (settings as any)?.secretBindingsByProfileId;
  if (isPlainRecord(rawBindings)) {
    for (const [profileId, maybeBindings] of Object.entries(rawBindings)) {
      if (!isPlainRecord(maybeBindings)) continue;
      const out: Record<string, string> = {};
      for (const [envVarName, rawSecretId] of Object.entries(maybeBindings)) {
        if (typeof rawSecretId !== 'string') continue;
        const normalized = rawSecretId.trim();
        if (!normalized) continue;
        out[envVarName] = normalized;
      }
      if (Object.keys(out).length > 0) {
        secretBindingsByProfileId[profileId] = out;
      }
    }
  }

  return { customProfiles, secretBindingsByProfileId };
}

