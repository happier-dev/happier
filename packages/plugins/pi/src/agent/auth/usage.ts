import { unsupportedAccountUsage, type UnsupportedAccountUsage } from '@happier-dev/plugin-sdk/account-usage';

export type PiAccountUsageAvailability = Readonly<{
  providerId: 'pi';
}> & UnsupportedAccountUsage<'no_verified_usage_source'>;

export function resolvePiAccountUsageAvailability(): PiAccountUsageAvailability {
  return {
    providerId: 'pi',
    ...unsupportedAccountUsage('no_verified_usage_source'),
  };
}
