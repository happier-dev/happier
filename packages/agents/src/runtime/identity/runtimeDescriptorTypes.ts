import type {
  GeneratedCanonicalRuntimeDescriptorByProviderIdV1,
  GeneratedRuntimeDescriptorProviderIdV1,
} from '@happier-dev/protocol/agents/runtimeDescriptorContributionsV1';

export type SupportedRuntimeDescriptorProviderId = GeneratedRuntimeDescriptorProviderIdV1;

export type SharedRuntimeDescriptorRuntimeHandle = Readonly<Record<string, unknown>>;

export type GenericProviderRuntimeDescriptor = Readonly<{
  providerId: string;
  runtimeKind: string | null;
  providerSessionId: string | null;
  runtimeHandle: SharedRuntimeDescriptorRuntimeHandle | null;
  rawProvider?: Readonly<Record<string, unknown>>;
} & Record<string, unknown>>;

type SharedRuntimeKindForDescriptor<TDescriptor> =
  TDescriptor extends Readonly<{ backendMode: infer TBackendMode }>
    ? TBackendMode
    : TDescriptor extends Readonly<{ runtimeMode: infer TRuntimeMode }>
      ? TRuntimeMode
      : null;

type SharedRuntimeDescriptorForProviderId<
  TProviderId extends SupportedRuntimeDescriptorProviderId,
> = Readonly<
  GeneratedCanonicalRuntimeDescriptorByProviderIdV1[TProviderId] & {
    runtimeKind: SharedRuntimeKindForDescriptor<
      GeneratedCanonicalRuntimeDescriptorByProviderIdV1[TProviderId]
    >;
    runtimeHandle: SharedRuntimeDescriptorRuntimeHandle | null;
    home?: 'user' | 'connectedService' | null;
    connectedServiceId?: string | null;
    connectedServiceProfileId?: string | null;
    connectedServiceGroupId?: string | null;
  }
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
