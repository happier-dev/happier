import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ProviderWireProtocol,
  QualifiedConnectedAccountPurposeV1,
} from '@happier-dev/protocol';
import {
  resolveConnectedAccountRequestAuthCapabilityPath,
} from '@happier-dev/plugin-sdk/experimental/cloud/request-auth';
import packageJson from '../../../package.json';

import {
  removePrivateBearerFile,
  writePrivateBearerFile,
} from '@/daemon/privateBearerFile';
import type {
  ManagedProviderRuntimeAdapterPreparation,
  ManagedProviderRuntimeAdapterV1,
} from '@/providers/managed/types';

import type { ManagedProviderRuntimePreparation } from './managedEndpointLaunch';

export type PreparedManagedProviderRuntimeAdapter =
  ManagedProviderRuntimePreparation<
    ManagedProviderRuntimeAdapterPreparation['prepared']
  >;

/**
 * Host-owned private runtime preparation shared by session and transient
 * catalog lifecycles. The caller must invoke it only from the managed
 * lifecycle's post-authorization preparation callback.
 */
export async function prepareManagedProviderRuntimeAdapter(input: Readonly<{
  runtimeAdapter: ManagedProviderRuntimeAdapterV1;
  materializationBaseDir: string;
  purposes: readonly QualifiedConnectedAccountPurposeV1[];
  protocols: readonly ProviderWireProtocol[];
  modelListEnabled: boolean;
}>): Promise<PreparedManagedProviderRuntimeAdapter> {
  await mkdir(input.materializationBaseDir, { recursive: true, mode: 0o700 });
  try {
    await chmod(input.materializationBaseDir, 0o700);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
  const materializedRootDir = await mkdtemp(
    join(input.materializationBaseDir, 'managed-provider-'),
  );
  const materializationId =
    `managed-provider-${randomBytes(16).toString('base64url')}`;
  let prepared: ManagedProviderRuntimeAdapterPreparation;
  try {
    prepared = await input.runtimeAdapter.prepare({
      materializedRootDir,
      materializationId,
      wrapperBuildVersion: packageJson.version,
      downstreamBearer: randomBytes(32).toString('base64url'),
      purposes: input.purposes,
      protocols: input.protocols,
      modelListEnabled: input.modelListEnabled,
      requestAuth: {
        capabilityPath:
          resolveConnectedAccountRequestAuthCapabilityPath(materializedRootDir),
      },
    }, {
      writeExclusive: writePrivateBearerFile,
      remove: removePrivateBearerFile,
    });
  } catch (error) {
    await rm(materializedRootDir, { recursive: true, force: true })
      .catch(() => undefined);
    throw error;
  }
  let cleaned = false;
  return {
    ...prepared,
    outputTee: prepared.prepared.readiness.outputTee,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      try {
        await prepared.cleanup();
      } finally {
        await rm(materializedRootDir, { recursive: true, force: true });
      }
    },
  };
}
