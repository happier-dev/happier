import type {
  ConnectedAccountServiceKey,
  ConnectedServiceCredentialRevisionV1,
  ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import type { ConnectedServiceChildSelection } from '../connectedServiceChildEnvironment';

export type ConnectedServiceRuntimeBoundProfile = Readonly<{
  serviceId: ConnectedAccountServiceKey;
  profileId: string;
}>;

export type ConnectedServiceRuntimeBindingIdentity = ConnectedServiceRuntimeBoundProfile & Readonly<{
  groupId: string | null;
  groupGeneration: number | null;
  credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
}>;

export type ConnectedServicesRuntimeBindingsV1Like = Readonly<{
  v?: unknown;
  bindingsByServiceId?: Record<string, unknown>;
}>;

export type ConnectedServiceRuntimeTargetInput = Readonly<{
  pid: number;
  agentId?: CatalogAgentId | string | null;
  sessionId?: string | null;
  connectedServicesBindingsRaw?: unknown;
  connectedServiceSelectionsEnv?: Pick<NodeJS.ProcessEnv, string> | null;
  connectedServiceSelectionsEnvRaw?: string | null;
  materializationKey?: string | null;
  connectedServiceMaterializationIdentityV1?: unknown;
  sessionDirectory?: string | null;
}>;

export type ConnectedServiceRuntimeTargetUpdate = ConnectedServiceRuntimeTargetInput;

export type ConnectedServiceRuntimeTarget = Readonly<{
  pid: number;
  agentId: string | null;
  sessionId: string | null;
  connectedServicesBindingsRaw: ConnectedServicesRuntimeBindingsV1Like;
  connectedServiceSelectionsEnv: Readonly<Record<string, string>>;
  connectedServiceSelections: ReadonlyArray<ConnectedServiceChildSelection>;
  materializationKey: string | null;
  connectedServiceMaterializationIdentityV1: ConnectedServiceMaterializationIdentityV1 | null;
  sessionDirectory: string | null;
  boundProfiles: ReadonlyArray<ConnectedServiceRuntimeBoundProfile>;
  activeBindings: ReadonlyArray<ConnectedServiceRuntimeBindingIdentity>;
  runtimeIdentityKey: string;
  revision: number;
}>;

export type ConnectedServiceRuntimeRegisteredTarget = ConnectedServiceRuntimeTarget & Readonly<{
  bindings: ReadonlyArray<ConnectedServiceRuntimeBindingIdentity>;
}>;

export type ConnectedServiceRuntimeRefreshTarget = Readonly<Omit<ConnectedServiceRuntimeTarget, 'agentId' | 'bindings' | 'materializationKey'> & {
  agentId: CatalogAgentId;
  materializationKey: string;
  bindings: ReadonlyArray<ConnectedServiceRuntimeBoundProfile>;
  childSelectionsByServiceId: ReadonlyMap<ConnectedAccountServiceKey, ConnectedServiceChildSelection> | null;
}>;

export type ConnectedServiceRuntimeQuotaTarget = Readonly<Omit<ConnectedServiceRuntimeTarget, 'bindings'> & {
  bindings: ConnectedServicesRuntimeBindingsV1Like;
  connectedServiceSelectionsEnv: Readonly<Record<string, string>>;
}>;
