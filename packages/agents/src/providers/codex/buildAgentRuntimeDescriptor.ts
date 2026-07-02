import type { CodexBackendMode } from '../../providerSettings/definitions/codex.js';
import { buildCodexRuntimeDescriptorProviderExtra } from './runtimeDescriptorExtra.js';
import { normalizeTrimmedString } from '../../runtime/identity/runtimeDescriptorShared.js';
import { normalizeCodexHome } from './runtimeDescriptorShared.js';

export type BuildCodexAgentRuntimeDescriptorParams = Readonly<{
  backendMode: CodexBackendMode;
  providerSessionId?: string | null;
  home?: 'user' | 'connectedService' | null;
  connectedServiceId?: string | null;
  connectedServiceProfileId?: string | null;
  connectedServiceGroupId?: string | null;
  homePath?: string | null;
}>;

export type CodexAgentRuntimeDescriptorV1 = Readonly<{
  v: 1;
  providerId: 'codex';
  provider: {
    backendMode: CodexBackendMode;
    providerSessionId?: string;
    home?: 'user' | 'connectedService';
    connectedServiceId?: string;
    connectedServiceProfileId?: string;
    connectedServiceGroupId?: string;
    homePath?: string;
    providerExtra: {
      owner: 'codex';
      schemaId: 'codex.agentRuntimeDescriptorExtra';
      v: 1;
      runtimeHandle?: {
        backendMode?: CodexBackendMode;
        providerSessionId?: string;
        home?: 'user' | 'connectedService';
        connectedServiceId?: string;
        connectedServiceProfileId?: string;
        connectedServiceGroupId?: string;
        homePath?: string;
      };
    };
  };
}>;

export function buildCodexAgentRuntimeDescriptor(
  params: BuildCodexAgentRuntimeDescriptorParams,
): CodexAgentRuntimeDescriptorV1 {
  const providerSessionId = normalizeTrimmedString(params.providerSessionId);
  const home = normalizeCodexHome(params.home);
  const connectedServiceId = home === 'connectedService' ? normalizeTrimmedString(params.connectedServiceId) : null;
  const connectedServiceProfileId = home === 'connectedService'
    ? normalizeTrimmedString(params.connectedServiceProfileId)
    : null;
  const connectedServiceGroupId = home === 'connectedService'
    ? normalizeTrimmedString(params.connectedServiceGroupId)
    : null;
  const homePath = normalizeTrimmedString(params.homePath);

  return {
    v: 1,
    providerId: 'codex',
    provider: {
      backendMode: params.backendMode,
      ...(providerSessionId ? { providerSessionId } : {}),
      ...(home ? { home } : {}),
      ...(connectedServiceId ? { connectedServiceId } : {}),
      ...(connectedServiceProfileId ? { connectedServiceProfileId } : {}),
      ...(connectedServiceGroupId ? { connectedServiceGroupId } : {}),
      ...(homePath ? { homePath } : {}),
      providerExtra: {
        owner: 'codex',
        schemaId: 'codex.agentRuntimeDescriptorExtra',
        ...buildCodexRuntimeDescriptorProviderExtra({
          backendMode: params.backendMode,
          providerSessionId,
          home,
          connectedServiceId,
          connectedServiceProfileId,
          connectedServiceGroupId,
          homePath,
        }),
      },
    },
  };
}
