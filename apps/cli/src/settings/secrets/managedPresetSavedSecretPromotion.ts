import axios from '@/api/client/credentialAxios';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readServerIdentityIdFromFeaturesSnapshot, fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createManagedPresetHydrator } from '@/machines/managed/presetHydration';
import type { StoredCredentials } from '@/persistence';
import {
  prepareManagedMachinePresetSavedSecretPromotionRewritesV1,
  type ManagedMachinePresetSavedSecretPromotionCaptureV1,
} from '@happier-dev/cli-common/machines/managed';
import { managedMachineActionEndpointPathV1, ManagedListInputV1Schema, ManagedListOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { machinePresetActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import {
  ManagedMachinePresetListInputV1Schema,
  ManagedMachinePresetListResultV1Schema,
  ManagedMachinePresetRecipientCensusInputV1Schema,
  ManagedMachinePresetRecipientCensusResultV1Schema,
} from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { ManagedMachinePresetSavedSecretReferenceRewriteV1 as PresetRewriteV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { getRandomBytes } from '@/api/encryption';

const PRESET_RECIPIENT_CENSUS_PATH = '/v1/machines/presets/recipient-census';

async function postHomeJson(params: Readonly<{
  serverHttpBaseUrl: string;
  credentials: StoredCredentials;
  path: string;
  body: unknown;
  signal?: AbortSignal;
}>): Promise<unknown | null> {
  try {
    const response = await axios.post<unknown>(`${params.serverHttpBaseUrl.replace(/\/+$/u, '')}${params.path}`, params.body, {
      headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${params.credentials.token}` },
      ...(params.signal ? { signal: params.signal } : {}), validateStatus: () => true,
    });
    params.signal?.throwIfAborted();
    return response.status >= 200 && response.status < 300 ? response.data : null;
  } catch {
    params.signal?.throwIfAborted();
    return null;
  }
}

/**
 * Concrete CLI transport/custody adapter for the common opaque Preset capture.
 * It discovers exactly the authenticated current Home, never a global inventory.
 */
export async function captureManagedMachinePresetSavedSecretPromotionRewritesForOperation(params: Readonly<{
  credentials: StoredCredentials;
  accountId: string;
  serverHttpBaseUrl: string;
  rewrites: readonly PresetRewriteV1[];
  signal?: AbortSignal;
}>): Promise<ManagedMachinePresetSavedSecretPromotionCaptureV1> {
  let features;
  try {
    features = await fetchServerFeaturesSnapshot({ serverUrl: params.serverHttpBaseUrl, token: params.credentials.token,
      projection: 'authenticated', signal: params.signal });
  } catch {
    params.signal?.throwIfAborted();
    return { kind: 'unavailable' };
  }
  const homeId = readServerIdentityIdFromFeaturesSnapshot(features);
  if (!homeId) return { kind: 'unavailable' };

  const hydrator = createManagedPresetHydrator({ credentials: params.credentials, serverUrl: params.serverHttpBaseUrl });
  return await prepareManagedMachinePresetSavedSecretPromotionRewritesV1({
    homeId,
    rewrites: params.rewrites,
    randomBytes: getRandomBytes,
    signal: params.signal,
    reader: {
      accountId: params.accountId,
      listPresets: async cursor => {
        const body = ManagedMachinePresetListInputV1Schema.parse({ homeId, includeArchived: true,
          ...(cursor === undefined ? {} : { cursor }) });
        const result = ManagedMachinePresetListResultV1Schema.safeParse(await postHomeJson({
          serverHttpBaseUrl: params.serverHttpBaseUrl, credentials: params.credentials,
          path: machinePresetActionEndpointPathV1('machines.presets.list'), body, signal: params.signal,
        }));
        return result.success && result.data.kind === 'listed'
          ? { presets: result.data.presets, ...(result.data.cursor === undefined ? {} : { cursor: result.data.cursor }) }
          : null;
      },
      listManaged: async archived => {
        const body = ManagedListInputV1Schema.parse({ homeId, archived });
        const result = ManagedListOutputV1Schema.safeParse(await postHomeJson({
          serverHttpBaseUrl: params.serverHttpBaseUrl, credentials: params.credentials,
          path: managedMachineActionEndpointPathV1('machines.managed.list'), body, signal: params.signal,
        }));
        return result.success ? result.data.machines : null;
      },
      readRecipientCensus: async input => {
        const body = ManagedMachinePresetRecipientCensusInputV1Schema.safeParse(input);
        if (!body.success || body.data.homeId !== homeId || body.data.presetId === undefined) return null;
        const result = ManagedMachinePresetRecipientCensusResultV1Schema.safeParse(await postHomeJson({
          serverHttpBaseUrl: params.serverHttpBaseUrl, credentials: params.credentials,
          path: PRESET_RECIPIENT_CENSUS_PATH, body: body.data, signal: params.signal,
        }));
        return result.success ? result.data : null;
      },
      open: async input => {
        try {
          return await hydrator.openRecipientProjection({ ...input, signal: params.signal });
        } catch {
          params.signal?.throwIfAborted();
          return null;
        }
      },
      withE2eeAccountKey: async operation => {
        try {
          return await hydrator.withE2eeAccountKey(operation, params.signal);
        } catch {
          params.signal?.throwIfAborted();
          return null;
        }
      },
    },
  });
}
