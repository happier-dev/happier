import type {
  AccountSettings,
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import { getConnectedServicesMaterializer } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import type {
  ConnectedServiceResolvedSelection,
  ConnectedServicesMaterialization,
  ConnectedServicesMaterializationDiagnostic,
} from '@/daemon/connectedServices/materialization/materializer';
import {
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY,
  serializeConnectedServiceMaterializedEnvKeys,
  serializeConnectedServiceChildSelections,
} from '../connectedServiceChildEnvironment';
import { resolveConnectedServiceMaterializedRootDir } from './resolveConnectedServiceMaterializedRootDir';
import { resolveConnectedServiceTargetMaterializedRoot } from './resolveConnectedServiceTargetMaterializedRoot';

export class ConnectedServiceMaterializationBlockedError extends Error {
  readonly code = 'connected_service_materialization_blocked';
  readonly diagnostics: readonly ConnectedServicesMaterializationDiagnostic[];

  constructor(diagnostics: readonly ConnectedServicesMaterializationDiagnostic[]) {
    super('Connected service materialization blocked');
    this.name = 'ConnectedServiceMaterializationBlockedError';
    this.diagnostics = diagnostics;
  }
}

export async function materializeConnectedServicesForSpawn(params: Readonly<{
  agentId: CatalogAgentId;
  materializationKey: string;
  activeServerDir: string;
  baseDir: string;
  sessionDirectory?: string | null;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
  selectionsByServiceId?: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>;
  accountSettings?: AccountSettings | Readonly<Record<string, unknown>> | null;
  processEnv?: NodeJS.ProcessEnv;
}>): Promise<ConnectedServicesMaterialization | null> {
  const rootDir = resolveConnectedServiceMaterializedRootDir({
    baseDir: params.baseDir,
    agentId: params.agentId,
    materializationKey: params.materializationKey,
  });
  const materializer = await getConnectedServicesMaterializer(params.agentId);
  if (!materializer) return null;

  const materialized = await materializer({
    materializationKey: params.materializationKey,
    activeServerDir: params.activeServerDir,
    baseDir: params.baseDir,
    rootDir,
    sessionDirectory: params.sessionDirectory ?? null,
    recordsByServiceId: params.recordsByServiceId,
    selectionsByServiceId: params.selectionsByServiceId,
    accountSettings: params.accountSettings ?? null,
    processEnv: params.processEnv ?? process.env,
  });
  if (!materialized) return null;
  const blockingDiagnostics = (materialized.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.severity === 'blocking');
  if (blockingDiagnostics.length > 0) {
    throw new ConnectedServiceMaterializationBlockedError(blockingDiagnostics);
  }

  const serializedSelections = serializeConnectedServiceChildSelections(params.selectionsByServiceId);
  const serializedMaterializedEnvKeys = serializeConnectedServiceMaterializedEnvKeys(materialized.env);
  const targetMaterializedRoot = materialized.targetMaterializedRoot
    ?? resolveConnectedServiceTargetMaterializedRoot({
      agentId: params.agentId,
      targetMaterializedEnv: materialized.env,
    })
    ?? (materialized.cleanupOnFailure ? rootDir : null);
  if (!serializedSelections && !serializedMaterializedEnvKeys && !targetMaterializedRoot) return materialized;

  return {
    ...materialized,
    env: {
      ...materialized.env,
      ...(targetMaterializedRoot
        ? { [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: targetMaterializedRoot }
        : null),
      ...(serializedSelections
        ? { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: serializedSelections }
        : null),
      ...(serializedMaterializedEnvKeys
        ? { [HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]: serializedMaterializedEnvKeys }
        : null),
    },
  };
}
