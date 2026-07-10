import type { ExternalSessionsSource } from '@happier-dev/plugin-sdk/sessions';

export {
  inferCodexExternalSessionsSourceFromHome,
  resolveDefaultCodexHomePath,
} from '../../../rollout/discovery/homeEntries.js';

export type CodexExternalSessionsSourceValidationPolicyResult =
  | Readonly<{ ok: true; source: ExternalSessionsSource }>
  | Readonly<{ ok: false; error: string }>;

export function validateCodexExternalSessionsSourcePolicy(params: Readonly<{
  source: ExternalSessionsSource;
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
