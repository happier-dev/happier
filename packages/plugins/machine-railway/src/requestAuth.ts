import { createMachineProvisionerFetch } from '@happier-dev/plugin-sdk/machine-provisioners';
import { RAILWAY_ORIGIN } from '@happier-dev/railway-api';

export const ACCOUNT_PURPOSE = 'cloud-api';
export const ORIGINS = [RAILWAY_ORIGIN] as const;

export function nativeFetch(
  context: Parameters<typeof createMachineProvisionerFetch>[0],
  credential?: string | Readonly<Record<string, string>>,
): typeof fetch {
  return createMachineProvisionerFetch(context, {
    purpose: ACCOUNT_PURPOSE, origins: ORIGINS, headerName: 'authorization',
    credential: typeof credential === 'string' ? { authorization: 'Bearer ' + credential } : credential,
  });
}
