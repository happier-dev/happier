import { SecretStringV1Schema, type SecretStringV1 } from '@happier-dev/protocol';

export function indexSavedSecretsByIdFromAccountSettings(
  settings: Readonly<Record<string, unknown>>,
): Map<string, SecretStringV1> {
  const out = new Map<string, SecretStringV1>();
  const raw = (settings as any)?.secrets;
  if (!Array.isArray(raw)) return out;

  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = (item as any).id;
    if (typeof id !== 'string' || id.trim().length === 0) continue;
    const parsed = SecretStringV1Schema.safeParse((item as any).encryptedValue);
    if (!parsed.success) continue;
    out.set(id, parsed.data);
  }

  return out;
}

