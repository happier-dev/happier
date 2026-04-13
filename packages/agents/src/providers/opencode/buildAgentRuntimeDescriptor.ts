import type { OpenCodeBackendMode } from '../../providerSettings/definitions/opencode.js';
import { normalizeOpenCodeServerBaseUrlExplicit } from '../../providerSettings/definitions/opencode.js';
import { buildOpenCodeRuntimeDescriptorProviderExtra } from './runtimeDescriptorExtra.js';
import { normalizeTrimmedString } from '../../sessionControls/runtimeDescriptorShared.js';

export type BuildOpenCodeAgentRuntimeDescriptorParams = Readonly<{
  backendMode: OpenCodeBackendMode;
  vendorSessionId?: string | null;
  serverBaseUrl?: string | null;
  serverBaseUrlExplicit?: boolean;
}>;

export type OpenCodeAgentRuntimeDescriptorV1 = Readonly<{
  v: 1;
  providerId: 'opencode';
  provider: {
    backendMode: OpenCodeBackendMode;
    vendorSessionId?: string;
    serverBaseUrl?: string;
    serverBaseUrlExplicit?: true;
    providerExtra: {
      owner: 'opencode';
      schemaId: 'opencode.agentRuntimeDescriptorExtra';
      v: 1;
      runtimeHandle?: {
        backendMode?: OpenCodeBackendMode;
        vendorSessionId?: string;
        serverBaseUrl?: string;
        serverBaseUrlExplicit?: true;
      };
    };
  };
}>;

export function buildOpenCodeAgentRuntimeDescriptor(
  params: BuildOpenCodeAgentRuntimeDescriptorParams,
): OpenCodeAgentRuntimeDescriptorV1 {
  const vendorSessionId = normalizeTrimmedString(params.vendorSessionId);
  const rawServerBaseUrl = normalizeTrimmedString(params.serverBaseUrl);
  const serverBaseUrlExplicit = normalizeOpenCodeServerBaseUrlExplicit(params.serverBaseUrlExplicit);
  const serverBaseUrl = serverBaseUrlExplicit ? rawServerBaseUrl : null;

  return {
    v: 1,
    providerId: 'opencode',
    provider: {
      backendMode: params.backendMode,
      ...(vendorSessionId ? { vendorSessionId } : {}),
      ...(serverBaseUrl ? { serverBaseUrl } : {}),
      ...(serverBaseUrl && serverBaseUrlExplicit ? { serverBaseUrlExplicit: true } : {}),
      providerExtra: {
        owner: 'opencode',
        schemaId: 'opencode.agentRuntimeDescriptorExtra',
        ...buildOpenCodeRuntimeDescriptorProviderExtra({
          backendMode: params.backendMode,
          vendorSessionId,
          serverBaseUrl,
          serverBaseUrlExplicit,
        }),
      },
    },
  };
}
