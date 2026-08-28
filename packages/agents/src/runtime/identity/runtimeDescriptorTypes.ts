import type { GeneratedRuntimeDescriptorReaderProviderId } from '../../generated/runtimeDescriptorReaders.js';

export type SupportedRuntimeDescriptorProviderId = GeneratedRuntimeDescriptorReaderProviderId;

export type SharedRuntimeDescriptorRuntimeHandle = Readonly<Record<string, unknown>>;

export type GenericProviderRuntimeDescriptor = Readonly<{
  providerId: string;
  runtimeKind: string | null;
  providerSessionId: string | null;
  runtimeHandle: SharedRuntimeDescriptorRuntimeHandle | null;
  rawProvider?: Readonly<Record<string, unknown>>;
} & Record<string, unknown>>;

type SharedRuntimeDescriptorForProviderId<
  TProviderId extends SupportedRuntimeDescriptorProviderId,
> = Readonly<
  {
    agentId: TProviderId;
    providerSessionId?: string | null;
    runtimeKind: string | null;
    runtimeHandle: SharedRuntimeDescriptorRuntimeHandle | null;
    home?: 'user' | 'connectedService' | null;
    connectedServiceId?: string | null;
    connectedServiceProfileId?: string | null;
    connectedServiceGroupId?: string | null;
  } & Record<string, unknown>
>;

export type SharedRuntimeDescriptorByProviderId = {
  [K in SupportedRuntimeDescriptorProviderId]: SharedRuntimeDescriptorForProviderId<K>;
};

export type KnownProviderRuntimeDescriptor = SharedRuntimeDescriptorByProviderId[SupportedRuntimeDescriptorProviderId];

export type RuntimeDescriptorReaderMap = {
  [K in SupportedRuntimeDescriptorProviderId]: (
    metadataRecord: Record<string, unknown>,
  ) => SharedRuntimeDescriptorByProviderId[K] | null;
};
