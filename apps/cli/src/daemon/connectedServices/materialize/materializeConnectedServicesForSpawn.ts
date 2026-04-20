import { join } from 'node:path';

import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import { getConnectedServicesMaterializer } from '@/backends/catalog';
import type { CatalogAgentId } from '@/backends/types';
import type { ConnectedServicesMaterialization } from '@/daemon/connectedServices/materialization/materializer';
import { normalizeMaterializationKeyForPath } from './normalizeMaterializationKeyForPath';

export async function materializeConnectedServicesForSpawn(params: Readonly<{
  agentId: CatalogAgentId;
  materializationKey: string;
  activeServerDir: string;
  baseDir: string;
  recordsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceCredentialRecordV1>;
}>): Promise<ConnectedServicesMaterialization | null> {
  const materializationSegment = normalizeMaterializationKeyForPath(params.materializationKey);
  const rootDir = join(params.baseDir, materializationSegment, params.agentId);
  const materializer = await getConnectedServicesMaterializer(params.agentId);
  if (!materializer) return null;

  return await materializer({
    materializationKey: params.materializationKey,
    activeServerDir: params.activeServerDir,
    baseDir: params.baseDir,
    rootDir,
    recordsByServiceId: params.recordsByServiceId,
  });
}
