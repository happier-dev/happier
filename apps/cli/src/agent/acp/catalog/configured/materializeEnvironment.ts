import type { StoredCredentials } from '@/persistence';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { listValueRefSecretIdsV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';
import {
  resolveValueRefPlaintext,
} from '@/settings/valueRefs/resolveValueRefPlaintext';
import {
  SavedSecretResolutionError,
  type SavedSecretCatalogResourceInputV1,
  type SavedSecretMaterializerV1,
} from '@/settings/secrets/savedSecretCatalog';

import type { ResolvedConfiguredAcpBackend } from './resolveBackend';

export function materializeConfiguredAcpEnvironment(params: Readonly<{
  backend: ResolvedConfiguredAcpBackend;
  accountSettings: Readonly<Record<string, unknown>>;
  credentials?: StoredCredentials;
  processEnv?: NodeJS.ProcessEnv;
  savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
  savedSecretMaterializer: SavedSecretMaterializerV1;
}>): Record<string, string> {
  const processEnv = params.processEnv ?? process.env;
  const savedSecretMaterializer = params.savedSecretMaterializer;

  const env: Record<string, string> = {};
  for (const [envKey, valueRef] of Object.entries(params.backend.env)) {
    for (const secretId of listValueRefSecretIdsV1(valueRef)) {
      if (parseSavedSecretRefV1(secretId).kind !== 'shared_resource') {
        throw new SavedSecretResolutionError({
          status: 'repair_required', reference: secretId, consumer: 'acp', field: `env:${envKey}`,
        });
      }
    }
    const resolved = resolveValueRefPlaintext({
      valueRef,
      savedSecretMaterializer,
      processEnv,
    });
    if (
      resolved.status !== 'ready'
      && resolved.status !== 'literal_unavailable'
      && resolved.status !== 'session_attested_unavailable'
    ) {
      throw new SavedSecretResolutionError({
        status: resolved.status,
        reference: resolved.reference,
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
