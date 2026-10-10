import type { StoredCredentials } from '@/persistence';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import {
  resolveMcpValueRefPlaintext,
} from '@/mcp/servers/resolveMcpValueRefPlaintext';
import {
  createSavedSecretMaterializerV1,
  SavedSecretResolutionError,
  type SavedSecretCatalogResourceInputV1,
} from '@/settings/secrets/savedSecretCatalog';

import type { ResolvedConfiguredAcpBackend } from './resolveBackend';

export function materializeConfiguredAcpEnvironment(params: Readonly<{
  backend: ResolvedConfiguredAcpBackend;
  accountSettings: Readonly<Record<string, unknown>>;
  credentials: StoredCredentials;
  processEnv?: NodeJS.ProcessEnv;
  savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
}>): Record<string, string> {
  const processEnv = params.processEnv ?? process.env;
  const savedSecretMaterializer = createSavedSecretMaterializerV1({
    accountSettings: params.accountSettings,
    settingsSecretsReadKeys: [],
    resources: params.savedSecretResources,
  });

  const env: Record<string, string> = {};
  for (const [envKey, valueRef] of Object.entries(params.backend.env)) {
    if (valueRef.t === 'savedSecret' && parseSavedSecretRefV1(valueRef.secretId)?.kind !== 'shared_resource') {
      throw new SavedSecretResolutionError({
        status: 'repair_required', reference: valueRef.secretId, consumer: 'acp', field: `env:${envKey}`,
      });
    }
    const resolved = resolveMcpValueRefPlaintext({
      valueRef,
      savedSecretMaterializer,
      processEnv,
    });
    if (
      resolved.status !== 'ready'
      && resolved.status !== 'literal_unavailable'
      && valueRef.t === 'savedSecret'
    ) {
      throw new SavedSecretResolutionError({
        status: resolved.status,
        reference: valueRef.secretId,
        consumer: 'acp',
        field: `env:${envKey}`,
      });
    }
    if (resolved.status !== 'ready') {
      throw new Error(`Missing ACP backend value for env:${envKey}`);
    }
    env[envKey] = resolved.value;
  }
  return env;
}
