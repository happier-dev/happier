import {
  ConnectedServiceBindingsV1Schema,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

import { generateConnectedServiceMaterializationIdentityV1 } from '@/daemon/connectedServices/materialization/identity';

type ConnectedServiceForkPatch = Readonly<{
  connectedServices?: ConnectedServiceBindingsV1;
  connectedServicesUpdatedAt?: number;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1;
} & Record<string, unknown>>;

export type ConnectedServiceForkLaunchContext = Readonly<{
  hasConnectedServices: boolean;
  materializationIdentity: ConnectedServiceMaterializationIdentityV1 | null;
  inherited: Readonly<{
    spawn: ConnectedServiceForkPatch;
    metadata: ConnectedServiceForkPatch;
  }>;
}>;

function readNonEmptyConnectedServices(value: unknown): ConnectedServiceBindingsV1 | null {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(value);
  if (!parsed.success) return null;
  return Object.keys(parsed.data.bindingsByServiceId).length > 0 ? parsed.data : null;
}

function withoutMaterializationIdentity(patch: ConnectedServiceForkPatch): ConnectedServiceForkPatch {
  const {
    connectedServiceMaterializationIdentityV1: _ignoredParentIdentity,
    ...rest
  } = patch;
  return rest;
}

export function createConnectedServiceForkLaunchContext(params: Readonly<{
  inherited: Readonly<{
    spawn: ConnectedServiceForkPatch;
    metadata: ConnectedServiceForkPatch;
  }>;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}>): ConnectedServiceForkLaunchContext {
  const spawnWithoutParentIdentity = withoutMaterializationIdentity(params.inherited.spawn);
  const metadataWithoutParentIdentity = withoutMaterializationIdentity(params.inherited.metadata);
  const connectedServices =
    readNonEmptyConnectedServices(spawnWithoutParentIdentity.connectedServices)
    ?? readNonEmptyConnectedServices(metadataWithoutParentIdentity.connectedServices);

  if (!connectedServices) {
    return {
      hasConnectedServices: false,
      materializationIdentity: null,
      inherited: {
        spawn: spawnWithoutParentIdentity,
        metadata: metadataWithoutParentIdentity,
      },
    };
  }

  const materializationIdentity = {
    ...generateConnectedServiceMaterializationIdentityV1({
      now: params.now,
      randomBytes: params.randomBytes,
    }),
    source: 'fork',
  };

  return {
    hasConnectedServices: true,
    materializationIdentity,
    inherited: {
      spawn: {
        ...spawnWithoutParentIdentity,
        connectedServiceMaterializationIdentityV1: materializationIdentity,
      },
      metadata: {
        ...metadataWithoutParentIdentity,
        connectedServiceMaterializationIdentityV1: materializationIdentity,
      },
    },
  };
}
