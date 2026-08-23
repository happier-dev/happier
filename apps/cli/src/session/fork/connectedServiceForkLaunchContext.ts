import {
  ConnectedServiceBindingsV1Schema,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

import { generateConnectedServiceMaterializationIdentityV1 } from '@/daemon/connectedServices/materialization/identity';
import { shouldResolveConnectedServiceAuthForSpawn } from '@/daemon/connectedServices/shouldResolveConnectedServiceAuthForSpawn';

export type ConnectedServiceChildLaunchPatch = Readonly<{
  connectedServices?: ConnectedServiceBindingsV1;
  connectedServicesUpdatedAt?: number;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1;
} & Record<string, unknown>>;

export type ConnectedServiceForkLaunchContext = Readonly<{
  hasConnectedServices: boolean;
  materializationIdentity: ConnectedServiceMaterializationIdentityV1 | null;
  childLaunch: ConnectedServiceChildLaunchContext;
  inherited: Readonly<{
    spawn: ConnectedServiceChildLaunchPatch;
    metadata: ConnectedServiceChildLaunchPatch;
  }>;
}>;

export type ConnectedServiceChildLaunchContext = Readonly<{
  hasConnectedServices: boolean;
  materializationIdentity: ConnectedServiceMaterializationIdentityV1 | null;
  spawn: ConnectedServiceChildLaunchPatch;
  metadata: ConnectedServiceChildLaunchPatch;
}>;

function readNonEmptyConnectedServices(value: unknown): ConnectedServiceBindingsV1 | null {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(value);
  if (!parsed.success) return null;
  return Object.keys(parsed.data.bindingsByServiceId).length > 0 ? parsed.data : null;
}

function withoutMaterializationIdentity(patch: ConnectedServiceChildLaunchPatch): ConnectedServiceChildLaunchPatch {
  const {
    connectedServiceMaterializationIdentityV1: _ignoredParentIdentity,
    ...rest
  } = patch;
  return rest;
}

/**
 * The one child-creation projection for connected-service materialization.
 *
 * A child row and the spawn attaching its runner have to carry the same fresh
 * identity. Forks and replay-seeded source-context creation are distinct
 * ingress paths, but neither owns that identity decision.
 */
export function createConnectedServiceChildLaunchContext<TSpawn extends object, TMetadata extends object>(params: Readonly<{
  spawn: TSpawn;
  metadata: TMetadata;
  source?: string;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}>): ConnectedServiceChildLaunchContext {
  const connectedServices =
    readNonEmptyConnectedServices((params.spawn as Readonly<{ connectedServices?: unknown }>).connectedServices)
    ?? readNonEmptyConnectedServices((params.metadata as Readonly<{ connectedServices?: unknown }>).connectedServices);
  if (!connectedServices) {
    return {
      hasConnectedServices: false,
      materializationIdentity: null,
      spawn: {},
      metadata: {},
    };
  }
  if (!shouldResolveConnectedServiceAuthForSpawn({ connectedServices })) {
    return {
      hasConnectedServices: true,
      materializationIdentity: null,
      spawn: {},
      metadata: {},
    };
  }

  const materializationIdentity = {
    ...generateConnectedServiceMaterializationIdentityV1({
      now: params.now,
      randomBytes: params.randomBytes,
    }),
    ...(params.source ? { source: params.source } : {}),
  };
  return {
    hasConnectedServices: true,
    materializationIdentity,
    spawn: { connectedServiceMaterializationIdentityV1: materializationIdentity },
    metadata: { connectedServiceMaterializationIdentityV1: materializationIdentity },
  };
}

export function createConnectedServiceForkLaunchContext(params: Readonly<{
  inherited: Readonly<{
    spawn: ConnectedServiceChildLaunchPatch;
    metadata: ConnectedServiceChildLaunchPatch;
  }>;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}>): ConnectedServiceForkLaunchContext {
  const spawnWithoutParentIdentity = withoutMaterializationIdentity(params.inherited.spawn);
  const metadataWithoutParentIdentity = withoutMaterializationIdentity(params.inherited.metadata);
  const childLaunch = createConnectedServiceChildLaunchContext({
    spawn: spawnWithoutParentIdentity,
    metadata: metadataWithoutParentIdentity,
    source: 'fork',
    now: params.now,
    randomBytes: params.randomBytes,
  });

  return {
    hasConnectedServices: childLaunch.hasConnectedServices,
    materializationIdentity: childLaunch.materializationIdentity,
    childLaunch,
    inherited: {
      spawn: {
        ...spawnWithoutParentIdentity,
        ...childLaunch.spawn,
      },
      metadata: {
        ...metadataWithoutParentIdentity,
        ...childLaunch.metadata,
      },
    },
  };
}
