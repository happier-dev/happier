import { randomUUID } from 'node:crypto';

import { readCredentials, type Credentials } from '@/persistence';
import { retireSessionSubagentCustodyGeneration } from '@/session/transport/http/sessionSubagentCustodyHttp';

import type { PluginStorePaths } from '../paths';
import {
  readPluginRegistryCommitRecord,
  type PluginRegistryCommitRecord,
} from './commitRecord';
import { withPluginRegistryCommitFence } from './commitCoordinator';
import {
  cleanupUnreferencedPluginGenerations,
  readInstallationStateRevision,
} from './generationStore';

export type PluginGenerationCustodyRetirementResult =
  | Readonly<{ status: 'authentication-unavailable' }>
  | Readonly<{
      status: 'reconciled';
      removed: readonly string[];
      failures: readonly Readonly<{ generationId: string; message: string }>[];
    }>;

export type PluginGenerationCustodyRetirementRemoteDependencies = Readonly<{
  readCredentials?: () => Promise<Credentials | null>;
  retireGeneration?: (params: Readonly<{
    token: string;
    pluginId: string;
    immutableGenerationId: string;
  }>) => Promise<void>;
}>;

const retirementFenceOwner = Object.freeze({
  pid: process.pid,
  instanceId: `custody-retirement-${randomUUID()}`,
});

/**
 * Reconciles the exact durable commit's obsolete immutable generations with
 * server custody. Bytes move out of the rollback-addressable namespace before
 * the authenticated retirement request, so response loss is retryable without
 * allowing a retired generation to become current again.
 */
export async function reconcilePluginGenerationCustodyRetirement(params: Readonly<{
  paths: PluginStorePaths;
  commit: PluginRegistryCommitRecord;
  isCommitCurrent?: () => Promise<boolean>;
  withCommitFence?: <T>(operation: () => Promise<T>) => Promise<T>;
  flushDirectory?: (path: string) => Promise<void>;
}> & PluginGenerationCustodyRetirementRemoteDependencies): Promise<PluginGenerationCustodyRetirementResult> {
  const commitIdentity = JSON.stringify(params.commit);
  const isCommitCurrent = params.isCommitCurrent ?? (async () => (
    JSON.stringify(await readPluginRegistryCommitRecord(params.paths)) === commitIdentity
  ));
  let credentialsPromise: Promise<Credentials | null> | null = null;
  let authenticationUnavailable = false;
  const state = await readInstallationStateRevision({
    paths: params.paths,
    reference: params.commit.installationState,
  });
  const result = await cleanupUnreferencedPluginGenerations({
    paths: params.paths,
    commit: params.commit,
    state,
    isCommitCurrent,
    ...(params.flushDirectory ? { flushDirectory: params.flushDirectory } : {}),
    withCommitFence: params.withCommitFence ?? (async (operation) => await withPluginRegistryCommitFence({
      paths: params.paths,
      owner: retirementFenceOwner,
      operation,
    })),
    retireGeneration: async ({ pluginId, immutableGenerationId }) => {
      credentialsPromise ??= (params.readCredentials ?? readCredentials)();
      const credentials = await credentialsPromise;
      if (!credentials) {
        authenticationUnavailable = true;
        throw new Error('Authenticated generation custody retirement is unavailable');
      }
      await (params.retireGeneration ?? retireSessionSubagentCustodyGeneration)({
        token: credentials.token,
        pluginId,
        immutableGenerationId,
      });
    },
  });
  if (authenticationUnavailable) return { status: 'authentication-unavailable' };
  return {
    status: 'reconciled',
    removed: result.removed,
    failures: result.failures,
  };
}
