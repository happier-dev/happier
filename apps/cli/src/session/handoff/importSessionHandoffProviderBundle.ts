import type { ImportedSessionHandoffBundle, SessionHandoffProviderBundle } from './types';

import { resolveBackendExecutionSurfaces } from '@/backends/catalog';

export async function importSessionHandoffProviderBundle(params: Readonly<{
  bundle: SessionHandoffProviderBundle;
  targetPath: string;
  sessionStorageMode?: 'direct' | 'persisted';
}>): Promise<ImportedSessionHandoffBundle> {
  const providerOps = (await resolveBackendExecutionSurfaces(params.bundle.providerId)).sessionHandoff;
  if (!providerOps) {
    throw new Error(`Unsupported handoff provider: ${params.bundle.providerId}`);
  }
  return await providerOps.importBundle({
    bundle: params.bundle,
    targetPath: params.targetPath,
    sessionStorageMode: params.sessionStorageMode,
  });
}
