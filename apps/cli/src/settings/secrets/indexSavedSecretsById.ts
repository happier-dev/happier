import { SecretStringV1Schema, type SecretStringV1 } from '@happier-dev/protocol';

export function indexSavedSecretsByIdFromAccountSettings(
  settingsLike: unknown,
): Map<string, SecretStringV1> {
  const out = new Map<string, SecretStringV1>();
  const rec = settingsLike && typeof settingsLike === 'object' && !Array.isArray(settingsLike)
    ? (settingsLike as Record<string, unknown>)
    : null;
  const raw = rec?.secrets;
  if (!Array.isArray(raw)) return out;

  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== 'string' || id.trim().length === 0) continue;
    const parsed = SecretStringV1Schema.safeParse(record.encryptedValue);
    if (!parsed.success) continue;
    out.set(id, parsed.data);
  }

  return out;
}
