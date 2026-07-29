import type {
  DaemonProviderConnectionMutationRequestV1,
  DaemonProviderConnectionMutationResponseV1,
  DaemonProviderConnectionsDescribeRequestV1,
  DaemonProviderConnectionsDescribeResponseV1,
} from '@happier-dev/protocol/rpc';
import {
  DaemonProviderConnectionMutationResponseV1Schema,
  DaemonProviderConnectionsDescribeResponseV1Schema,
} from '@happier-dev/protocol/rpc';

import type { createProviderConnectionService } from './service';

type ProviderConnectionService = ReturnType<typeof createProviderConnectionService>;
type FlatConnectionMutationResult = Awaited<ReturnType<ProviderConnectionService['setEnabled']>>;
type FlatConnectionMutationAction =
  | 'enableDetected'
  | 'update'
  | 'setEndpointOverride'
  | 'duplicate'
  | 'setEnabled'
  | 'bindSecret';

function projectFlatConnectionMutationResult(
  action: FlatConnectionMutationAction,
  result: FlatConnectionMutationResult,
): DaemonProviderConnectionMutationResponseV1 {
  if (result.status === 'error') {
    return DaemonProviderConnectionMutationResponseV1Schema.parse(result);
  }
  const { status: _serviceStatus, ...connection } = result;
  return DaemonProviderConnectionMutationResponseV1Schema.parse({
    status: 'success',
    action,
    connection,
  });
}

export function createProviderConnectionRpcAdapter(service: ProviderConnectionService): Readonly<{
  describeConnections(input: DaemonProviderConnectionsDescribeRequestV1): Promise<DaemonProviderConnectionsDescribeResponseV1>;
  mutateConnection(input: DaemonProviderConnectionMutationRequestV1): Promise<DaemonProviderConnectionMutationResponseV1>;
}> {
  return Object.freeze({
    describeConnections: async (input) => DaemonProviderConnectionsDescribeResponseV1Schema.parse(
      await service.describe(input),
    ),
    mutateConnection: async (input) => {
      switch (input.action) {
        case 'createContribution':
        case 'createCustom': {
          const result = await service.create(input);
          return DaemonProviderConnectionMutationResponseV1Schema.parse(result.status === 'error'
            ? result
            : { status: 'success', action: input.action, connection: result.connection, created: result.created });
        }
        case 'enableDetected': {
          const result = await service.enableDetected(input);
          return projectFlatConnectionMutationResult(input.action, result);
        }
        case 'startLocal': {
          const result = await service.startLocal(input);
          return DaemonProviderConnectionMutationResponseV1Schema.parse(result.status === 'error'
            ? result
            : { status: 'success', action: input.action, contributionKey: result.contributionKey, phase: result.phase });
        }
        case 'update':
        case 'setEndpointOverride':
        case 'duplicate':
        case 'setEnabled':
        case 'bindSecret': {
          const result = await service[input.action](input as never);
          return projectFlatConnectionMutationResult(input.action, result);
        }
        case 'delete': {
          const result = await service.delete(input);
          return DaemonProviderConnectionMutationResponseV1Schema.parse(result.status === 'error'
            ? result
            : { status: 'success', action: 'delete', deletedConnectionId: result.connectionId });
        }
      }
    },
  });
}
