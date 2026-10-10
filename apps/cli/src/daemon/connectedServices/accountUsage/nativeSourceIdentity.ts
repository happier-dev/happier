import { createHash } from 'node:crypto';

type NativeProviderAccountUsageSourceProfileKind = 'providerSubject' | 'localCredential';

function hashProfileMaterial(material: string): string {
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 48);
}

export function buildNativeProviderAccountUsageSourceProfileId(params: Readonly<{
  kind: NativeProviderAccountUsageSourceProfileKind;
  providerId: string;
  material: string;
}>): string {
  const providerId = params.providerId.trim();
  const material = params.material.trim();
  const prefix = params.kind === 'providerSubject' ? 'acct' : 'native';
  const hash = hashProfileMaterial(`${providerId}:${material || 'unknown'}`);
  return `${prefix}:${hash}`;
}

/** Recognizes the existing local-credential quota-source ID format. */
export function isNativeLocalCredentialUsageSourceProfileId(profileId: string): boolean {
  return /^native:[a-f0-9]{48}$/u.test(profileId);
}
