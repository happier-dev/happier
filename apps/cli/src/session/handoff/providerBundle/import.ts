import type { ImportedSessionHandoffBundle, SessionHandoffProviderBundle } from '../types';

import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { normalizeCodexBackendMode } from '@happier-dev/agents';
import { applySessionStateUpdatesToMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import {
  ExternalSessionsSourceSchema,
  readCanonicalRuntimeDescriptorV1ForProvider,
  readRuntimeDescriptorV1FromMetadata,
} from '@happier-dev/protocol';

export async function importSessionHandoffProviderBundle(params: Readonly<{
  bundle: SessionHandoffProviderBundle;
  targetPath: string;
  sessionStorageMode?: 'direct' | 'persisted';
}>): Promise<ImportedSessionHandoffBundle> {
  const providerOps = (await getSessionHostBridge().resolveExecutionSurfaces(params.bundle.providerId)).handoff;
  if (!providerOps) {
    throw new Error(`Unsupported handoff provider: ${params.bundle.providerId}`);
  }
  const imported = await providerOps.importBundle({
    bundle: params.bundle,
    targetDirectory: params.targetPath,
  });
  if (!imported.ok) {
    throw new Error(imported.message ?? `Session handoff import failed: ${imported.code}`);
  }
  const source = ExternalSessionsSourceSchema.parse(imported.value.source);
  const metadataPatch = applySessionStateUpdatesToMetadata({}, imported.value.launch.sessionStateUpdates ?? []);
  const runtimeDescriptorV1 = readRuntimeDescriptorV1FromMetadata(metadataPatch) ?? undefined;
  const codexRuntimeDescriptor = readCanonicalRuntimeDescriptorV1ForProvider(runtimeDescriptorV1, 'codex');
  const codexBackendMode = normalizeCodexBackendMode(codexRuntimeDescriptor?.backendMode);

  return {
    remoteSessionId: imported.value.providerSessionId,
    directSource: source,
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
    resume: {
      directory: imported.value.launch.directory ?? params.targetPath,
      agent: params.bundle.providerId,
      resume: imported.value.providerSessionId,
      ...(imported.value.launch.environmentVariables
        ? { environmentVariables: { ...imported.value.launch.environmentVariables } }
        : {}),
      transcriptStorage: params.sessionStorageMode === 'persisted' ? 'persisted' : 'direct',
      approvedNewDirectoryCreation: true,
      ...(codexBackendMode ? { codexBackendMode } : {}),
    },
  };
}
