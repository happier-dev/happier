import type { CodexBackendMode } from '../providerSettings/definitions/codex.js';
import type { OpenCodeBackendMode } from '../providerSettings/definitions/opencode.js';

export type SupportedRuntimeDescriptorProviderId = 'codex' | 'opencode' | 'pi';

export type SharedRuntimeDescriptorByProviderId = {
  codex: Readonly<{
    providerId: 'codex';
    backendMode: CodexBackendMode | null;
    vendorSessionId: string | null;
    home: 'user' | 'connectedService' | null;
    connectedServiceId: string | null;
    connectedServiceProfileId: string | null;
    homePath: string | null;
  }>;
  opencode: Readonly<{
    providerId: 'opencode';
    backendMode: OpenCodeBackendMode | null;
    vendorSessionId: string | null;
    serverBaseUrl: string | null;
    serverBaseUrlExplicit: boolean;
  }>;
  pi: Readonly<{
    providerId: 'pi';
    vendorSessionId: string | null;
  }>;
};
