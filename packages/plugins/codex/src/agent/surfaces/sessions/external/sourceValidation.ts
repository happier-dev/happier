import type {
  AgentExternalSessionSource,
} from '@happier-dev/plugin-sdk/sessions/external';

import type { CodexExternalSessionSource } from './models.js';

export {
  inferCodexExternalSessionsSourceFromHome,
  resolveDefaultCodexHomePath,
} from '../../../rollout/discovery/homeEntries.js';

export type CodexExternalSessionsSourceValidationPolicyResult =
  | Readonly<{ ok: true; source: CodexExternalSessionSource }>
  | Readonly<{ ok: false; error: string }>;

export function inferCodexExternalSessionsActiveServerDir(
  source: AgentExternalSessionSource,
): string | null {
  const homePath = typeof source.homePath === 'string'
    ? source.homePath.trim()
    : '';
  if (!homePath) return null;
  const normalized = homePath.replaceAll('\\', '/');
  const marker = '/daemon/connected-services/homes/';
  const markerIndex = normalized.lastIndexOf(marker);
  return markerIndex > 0 ? normalized.slice(0, markerIndex) : null;
}

export function validateCodexExternalSessionsSourcePolicy(params: Readonly<{
  source: CodexExternalSessionSource;
  configuredCodexHomePath: string;
  canonicalRequestedHomePath: string | null;
  isSafeConnectedServiceId: (raw: unknown) => boolean;
}>): CodexExternalSessionsSourceValidationPolicyResult {
  const { source } = params;
  if (source.kind !== 'codexHome') return { ok: false, error: 'provider/source mismatch' };
  if (source.home === 'connectedService' && !params.isSafeConnectedServiceId(source.connectedServiceId)) {
    return { ok: false, error: 'invalid connectedServiceId' };
  }
  if (source.home === 'user') {
    if (params.canonicalRequestedHomePath && params.canonicalRequestedHomePath !== params.configuredCodexHomePath) {
      return { ok: false, error: 'source homePath override is not allowed' };
    }
    return {
      ok: true,
      source: {
        ...source,
        homePath: params.configuredCodexHomePath,
      },
    };
  }
  return { ok: true, source };
}
