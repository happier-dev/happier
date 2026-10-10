/**
 * MCP value ref resolution (CLI/runtime)
 *
 * Resolves MCP settings value references into plaintext strings at runtime:
 * - literal values may include `${VAR}` templates expanded from `processEnv`
 * - savedSecret values use the admitted SavedSecret catalog materializer
 */

import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import type { McpValueRefV1 } from '@happier-dev/protocol';
import type {
  SavedSecretMaterializerV1,
  SavedSecretResolutionFailureStatusV1,
} from '@/settings/secrets/savedSecretCatalog';

export {
  deriveSettingsSecretsKeyForCredentials,
  deriveSettingsSecretsReadKeysForCredentials,
} from '@/settings/secrets/settingsSecretsKey';

export type McpValueRefPlaintextResolution =
  | Readonly<{ status: 'ready'; value: string }>
  | Readonly<{ status: 'literal_unavailable' }>
  | Readonly<{ status: SavedSecretResolutionFailureStatusV1 }>;

export function resolveMcpValueRefPlaintext(params: Readonly<{
  valueRef: McpValueRefV1;
  savedSecretMaterializer?: SavedSecretMaterializerV1;
  processEnv: NodeJS.ProcessEnv;
}>): McpValueRefPlaintextResolution {
  if (params.valueRef.t === 'literal') {
    const expanded = expandEnvironmentVariables({ __VALUE__: params.valueRef.v }, params.processEnv, { warnOnUndefined: false })
      .__VALUE__;
    if (typeof expanded !== 'string') return { status: 'literal_unavailable' };
    if (params.valueRef.v.includes('${') && expanded.includes('${')) return { status: 'literal_unavailable' };
    return { status: 'ready', value: expanded };
  }

  if (!params.savedSecretMaterializer) return { status: 'temporarily_unavailable' };
  const resolved = params.savedSecretMaterializer.resolve(params.valueRef.secretId);
  return resolved.status === 'ready' ? { status: 'ready', value: resolved.value } : resolved;
}
