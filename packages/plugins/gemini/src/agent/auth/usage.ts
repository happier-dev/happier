import { unsupportedAccountUsage, type UnsupportedAccountUsage } from '@happier-dev/plugin-sdk/account-usage';

export type GeminiAccountUsageAvailability = Readonly<{
  providerId: 'gemini';
}> & UnsupportedAccountUsage<'no_verified_usage_source'>;

export function resolveGeminiAccountUsageAvailability(): GeminiAccountUsageAvailability {
  return {
    providerId: 'gemini',
    ...unsupportedAccountUsage('no_verified_usage_source'),
  };
}
