import { normalizeProviderEndpointUrlSyntax } from '@happier-dev/protocol';

export type OpenAiCompatEndpointConsent = Readonly<{
  normalizedBaseUrl: string;
  origin: string;
  requiresInsecureConsent: boolean;
  insecureLocalOriginConsent: string | null;
  insecureLocalConsentMachineId: string | null;
}>;

/**
 * Pure settings-boundary normalizer. Network locality and DNS pinning remain
 * daemon-owned; UI only binds an explicit HTTP warning to the exact origin.
 */
export function resolveOpenAiCompatEndpointConsent(
  baseUrl: string,
  storedConsent: string | null | undefined,
  storedConsentMachineId: string | null | undefined,
  executionMachineId: string | null,
): OpenAiCompatEndpointConsent {
  const normalized = normalizeProviderEndpointUrlSyntax(baseUrl);
  const requiresInsecureConsent = normalized.protocol === 'http:';
  const consent = typeof storedConsent === 'string'
    && storedConsent === normalized.origin
    && typeof storedConsentMachineId === 'string'
    && storedConsentMachineId === executionMachineId
    ? normalized.origin
    : null;
  return Object.freeze({
    normalizedBaseUrl: normalized.normalizedUrl,
    origin: normalized.origin,
    requiresInsecureConsent,
    insecureLocalOriginConsent: requiresInsecureConsent ? consent : null,
    insecureLocalConsentMachineId: requiresInsecureConsent && consent ? executionMachineId : null,
  });
}
