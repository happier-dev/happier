import type { CodexBackendMode } from '../../providerSettings/definitions/codex.js';

export type SupportedRuntimeDescriptorProviderId = 'codex' | 'opencode' | 'pi';

export type SharedRuntimeDescriptorRuntimeHandle = Readonly<Record<string, unknown>>;

export type SharedRuntimeDescriptorByProviderId = {
  codex: Readonly<{
    providerId: 'codex';
    runtimeKind: CodexBackendMode | null;
    backendMode: CodexBackendMode | null;
    providerSessionId: string | null;
    runtimeHandle: SharedRuntimeDescriptorRuntimeHandle | null;
    home: 'user' | 'connectedService' | null;
    connectedServiceId: string | null;
    connectedServiceProfileId: string | null;
    connectedServiceGroupId: string | null;
    homePath: string | null;
  }>;
  opencode: Readonly<{
    providerId: 'opencode';
    runtimeKind: 'server' | 'acp' | null;
    backendMode: 'server' | 'acp' | null;
    providerSessionId: string | null;
    runtimeHandle: SharedRuntimeDescriptorRuntimeHandle | null;
    serverBaseUrl: string | null;
    serverBaseUrlExplicit: boolean;
  }>;
  pi: Readonly<{
    providerId: 'pi';
    runtimeKind: null;
    providerSessionId: string | null;
    runtimeHandle: SharedRuntimeDescriptorRuntimeHandle | null;
  }>;
};

export type KnownProviderRuntimeDescriptor = SharedRuntimeDescriptorByProviderId[SupportedRuntimeDescriptorProviderId];

export type GenericProviderRuntimeDescriptor = Readonly<{
  providerId: string;
  runtimeKind: string | null;
  providerSessionId: string | null;
  runtimeHandle: Readonly<Record<string, unknown>> | null;
  rawProvider: Readonly<Record<string, unknown>>;
}>;

export type RuntimeDescriptorReaderMap = {
  [K in SupportedRuntimeDescriptorProviderId]: (
    metadataRecord: Record<string, unknown>,
  ) => SharedRuntimeDescriptorByProviderId[K] | null;
};
