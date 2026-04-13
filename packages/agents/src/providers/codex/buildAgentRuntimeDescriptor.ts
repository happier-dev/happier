import type { CodexBackendMode } from '../../providerSettings/definitions/codex.js';
import { buildCodexRuntimeDescriptorProviderExtra } from './runtimeDescriptorExtra.js';
import { normalizeCodexHome, normalizeTrimmedString } from '../../sessionControls/runtimeDescriptorShared.js';

export type BuildCodexAgentRuntimeDescriptorParams = Readonly<{
  backendMode: CodexBackendMode;
  vendorSessionId?: string | null;
  home?: 'user' | 'connectedService' | null;
  connectedServiceId?: string | null;
  connectedServiceProfileId?: string | null;
  homePath?: string | null;
}>;

export type CodexAgentRuntimeDescriptorV1 = Readonly<{
  v: 1;
  providerId: 'codex';
  provider: {
    backendMode: CodexBackendMode;
    vendorSessionId?: string;
    home?: 'user' | 'connectedService';
    connectedServiceId?: string;
    connectedServiceProfileId?: string;
    homePath?: string;
    providerExtra: {
      owner: 'codex';
      schemaId: 'codex.agentRuntimeDescriptorExtra';
      v: 1;
      runtimeAffinity?: {
        backendMode?: CodexBackendMode;
        vendorSessionId?: string;
        home?: 'user' | 'connectedService';
        connectedServiceId?: string;
        connectedServiceProfileId?: string;
        homePath?: string;
      };
    };
  };
}>;

export function buildCodexAgentRuntimeDescriptor(
  params: BuildCodexAgentRuntimeDescriptorParams,
): CodexAgentRuntimeDescriptorV1 {
  const vendorSessionId = normalizeTrimmedString(params.vendorSessionId);
  const home = normalizeCodexHome(params.home);
  const connectedServiceId = home === 'connectedService' ? normalizeTrimmedString(params.connectedServiceId) : null;
  const connectedServiceProfileId = home === 'connectedService'
    ? normalizeTrimmedString(params.connectedServiceProfileId)
    : null;
  const homePath = normalizeTrimmedString(params.homePath);

  return {
    v: 1,
    providerId: 'codex',
    provider: {
      backendMode: params.backendMode,
      ...(vendorSessionId ? { vendorSessionId } : {}),
      ...(home ? { home } : {}),
      ...(connectedServiceId ? { connectedServiceId } : {}),
      ...(connectedServiceProfileId ? { connectedServiceProfileId } : {}),
      ...(homePath ? { homePath } : {}),
      providerExtra: {
        owner: 'codex',
        schemaId: 'codex.agentRuntimeDescriptorExtra',
        ...buildCodexRuntimeDescriptorProviderExtra({
          backendMode: params.backendMode,
          vendorSessionId,
          home,
          connectedServiceId,
          connectedServiceProfileId,
          homePath,
        }),
      },
    },
  };
}
