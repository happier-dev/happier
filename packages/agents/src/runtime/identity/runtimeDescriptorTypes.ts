import type { CodexBackendMode } from '../../providerSettings/definitions/codex.js';
import type { OpenCodeBackendMode } from '../../providerSettings/definitions/opencode.js';

export type SupportedRuntimeDescriptorProviderId = 'codex' | 'opencode' | 'pi';

export type SharedRuntimeDescriptorRuntimeHandle = Readonly<Record<string, unknown>>;

export type SharedRuntimeDescriptorByProviderId = {
  codex: Readonly<{
    providerId: 'codex';
    runtimeKind: CodexBackendMode | null;
    backendMode: CodexBackendMode | null;
    vendorSessionId: string | null;
    runtimeHandle: SharedRuntimeDescriptorRuntimeHandle | null;
    home: 'user' | 'connectedService' | null;
    connectedServiceId: string | null;
    connectedServiceProfileId: string | null;
    homePath: string | null;
  }>;
  opencode: Readonly<{
    providerId: 'opencode';
    runtimeKind: OpenCodeBackendMode | null;
    backendMode: OpenCodeBackendMode | null;
    vendorSessionId: string | null;
    runtimeHandle: SharedRuntimeDescriptorRuntimeHandle | null;
    serverBaseUrl: string | null;
    serverBaseUrlExplicit: boolean;
  }>;
  pi: Readonly<{
    providerId: 'pi';
    runtimeKind: null;
    vendorSessionId: string | null;
    runtimeHandle: SharedRuntimeDescriptorRuntimeHandle | null;
  }>;
};

export type KnownProviderRuntimeDescriptor = SharedRuntimeDescriptorByProviderId[SupportedRuntimeDescriptorProviderId];

export type GenericProviderRuntimeDescriptor = Readonly<{
  providerId: string;
  runtimeKind: string | null;
  vendorSessionId: string | null;
  runtimeHandle: Readonly<Record<string, unknown>> | null;
  rawProvider: Readonly<Record<string, unknown>>;
}>;
