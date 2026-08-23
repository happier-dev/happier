import {
  ConnectedServiceBindingsV1Schema,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

import { createConnectedServiceMaterializationIdentity } from '@/daemon/connectedServices/materialize/createConnectedServiceMaterializationIdentity';
import { shouldResolveConnectedServiceAuthForSpawn } from '@/daemon/connectedServices/shouldResolveConnectedServiceAuthForSpawn';

export type ConnectedServiceChildLaunchPatch = Readonly<{
  connectedServices?: ConnectedServiceBindingsV1;
  connectedServicesUpdatedAt?: number;
  connectedServiceMaterializationIdentityV1?: ConnectedServiceMaterializationIdentityV1;
}>;

export type ConnectedServiceForkInheritedOverrides = Readonly<{
  spawn: ConnectedServiceChildLaunchPatch;
  metadata: ConnectedServiceChildLaunchPatch;
}>;

export type ConnectedServiceChildLaunchContext = Readonly<{
  hasConnectedServices: boolean;
  materializationIdentity: ConnectedServiceMaterializationIdentityV1 | null;
  spawn: ConnectedServiceChildLaunchPatch;
  metadata: ConnectedServiceChildLaunchPatch;
}>;

export type ConnectedServiceForkLaunchContext = ConnectedServiceChildLaunchContext;

function readNonEmptyConnectedServices(value: unknown): ConnectedServiceBindingsV1 | null {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(value);
  if (!parsed.success) return null;
  return Object.keys(parsed.data.bindingsByServiceId).length > 0 ? parsed.data : null;
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
  nowMs?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}>): ConnectedServiceChildLaunchContext {
  const inheritedConnectedServices =
    readNonEmptyConnectedServices((params.spawn as Readonly<{ connectedServices?: unknown }>).connectedServices)
    ?? readNonEmptyConnectedServices((params.metadata as Readonly<{ connectedServices?: unknown }>).connectedServices);
  if (!inheritedConnectedServices) {
    return {
      hasConnectedServices: false,
      materializationIdentity: null,
      spawn: {},
      metadata: {},
    };
  }
  if (!shouldResolveConnectedServiceAuthForSpawn({ connectedServices: inheritedConnectedServices })) {
    return {
      hasConnectedServices: true,
      materializationIdentity: null,
      spawn: {},
      metadata: {},
    };
  }

  const materializationIdentity = createConnectedServiceMaterializationIdentity({
    ...(params.nowMs ? { nowMs: params.nowMs } : {}),
    ...(params.randomBytes ? { randomBytes: params.randomBytes } : {}),
  });

  return {
    hasConnectedServices: true,
    materializationIdentity,
    spawn: {
      connectedServiceMaterializationIdentityV1: materializationIdentity,
    },
    metadata: {
      connectedServiceMaterializationIdentityV1: materializationIdentity,
    },
  };
}

export function createConnectedServiceForkLaunchContext(params: Readonly<{
  inherited: ConnectedServiceForkInheritedOverrides;
  nowMs?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}>): ConnectedServiceForkLaunchContext {
  return createConnectedServiceChildLaunchContext({
    spawn: params.inherited.spawn,
    metadata: params.inherited.metadata,
    ...(params.nowMs ? { nowMs: params.nowMs } : {}),
    ...(params.randomBytes ? { randomBytes: params.randomBytes } : {}),
  });
}
