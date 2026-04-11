import type { DirectSessionsProviderId, DirectSessionsSource } from '@happier-dev/protocol';

import { getDirectSessionProviderOps } from '@/backends/catalog';
import type { DirectSourceValidationResult } from '@/backends/directSessions/sourceValidation';

export async function validateDirectMachineSource(params: Readonly<{
  providerId: DirectSessionsProviderId;
  source: DirectSessionsSource;
  env: NodeJS.ProcessEnv;
}>): Promise<DirectSourceValidationResult> {
  const { providerId, source, env } = params;
  const providerOps = await getDirectSessionProviderOps(providerId);
  return await providerOps.validateSource({ source, env });
}
