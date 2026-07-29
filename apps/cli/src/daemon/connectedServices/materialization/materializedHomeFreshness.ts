import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { ConnectedServiceChildSelection } from '../connectedServiceChildEnvironment';

export type ConnectedServiceMaterializedHomeFreshnessInput = Readonly<{
  serviceId: ConnectedServiceId;
  materializedRootDir: string;
  record: ConnectedServiceCredentialRecordV1;
  now: number;
  refreshWindowMs: number;
}>;

export type ConnectedServiceMaterializedHomeRootParams = Readonly<{
  agentId: CatalogAgentId;
  activeServerDir: string;
  serviceId: ConnectedServiceId;
  profileId: string;
  selection?: ConnectedServiceChildSelection | null;
}>;

export type ConnectedServiceMaterializedHomeRootResolver = (
  params: ConnectedServiceMaterializedHomeRootParams,
) => string | null;

export type ConnectedServiceMaterializedHomeFreshness = Readonly<{
  isMaterializedHomeStale(
    input: ConnectedServiceMaterializedHomeFreshnessInput,
  ): boolean | Promise<boolean>;
}>;
