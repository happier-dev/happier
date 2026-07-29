/** Normalizes the two accepted persisted SHA-256 encodings without weakening validation. */
export function normalizeVoiceModelPackSha256DigestV1(value: string): string {
  return value.replace(/^sha256:/i, '').toLowerCase();
}

export function voiceModelPackSha256DigestsEqualV1(left: string, right: string): boolean {
  return normalizeVoiceModelPackSha256DigestV1(left) === normalizeVoiceModelPackSha256DigestV1(right);
}
