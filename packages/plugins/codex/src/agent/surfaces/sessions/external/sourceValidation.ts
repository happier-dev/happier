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

/**
 * Canonicalizes a Codex source and enforces the one rule this leaf owns: a
 * connected-service identifier is a name inside a host-owned home namespace, so
 * it must be a safe segment. Whether a requested `homePath` is one the machine
 * environment or the account's settings authorized is decided once, by the host
 * admission boundary, for every Agent; this leaf only produces the canonical
 * form both sides of that comparison use.
 */
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
    return {
      ok: true,
      source: {
        ...source,
        homePath: params.canonicalRequestedHomePath ?? params.configuredCodexHomePath,
      },
    };
  }
  return { ok: true, source };
}
