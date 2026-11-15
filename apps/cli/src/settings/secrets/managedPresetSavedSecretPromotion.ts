import axios from '@/api/client/credentialAxios';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { readServerIdentityIdFromFeaturesSnapshot, fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createManagedPresetHydrator } from '@/machines/managed/presetHydration';
import type { StoredCredentials } from '@/persistence';
import {
  captureManagedMachinePresetSavedSecretReferencesV1,
  prepareManagedMachinePresetSavedSecretPromotionRewritesV1,
  type ManagedMachinePresetSavedSecretReferenceCaptureV1,
  type ManagedMachinePresetSavedSecretPromotionReaderV1,
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

type ManagedPresetSavedSecretOperation = Readonly<{
  credentials: StoredCredentials;
  accountId: string;
  serverHttpBaseUrl: string;
  signal?: AbortSignal;
}>;

/** Both captures share current-Home transport and the existing Account custody owner. */
async function createManagedPresetSavedSecretReader(params: ManagedPresetSavedSecretOperation): Promise<Readonly<{
  homeId: string;
  reader: ManagedMachinePresetSavedSecretPromotionReaderV1;
}> | null> {
  let features;
  try {
    features = await fetchServerFeaturesSnapshot({ serverUrl: params.serverHttpBaseUrl, token: params.credentials.token,
      projection: 'authenticated', signal: params.signal });
  } catch {
    params.signal?.throwIfAborted();
    return null;
  }
  const homeId = readServerIdentityIdFromFeaturesSnapshot(features);
  if (!homeId) return null;

  const hydrator = createManagedPresetHydrator({ credentials: params.credentials, serverUrl: params.serverHttpBaseUrl });
  return {
    homeId,
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
  };
}

/** Delete sends only actual bindings; promotion retains its complete rewrite inventory. */
export async function captureManagedMachinePresetSavedSecretReferencesForOperation(params: ManagedPresetSavedSecretOperation & Readonly<{
  resourceRef: string;
}>): Promise<ManagedMachinePresetSavedSecretReferenceCaptureV1> {
  const captured = await createManagedPresetSavedSecretReader(params);
  return captured ? captureManagedMachinePresetSavedSecretReferencesV1({ ...captured,
    resourceRef: params.resourceRef, signal: params.signal }) : { kind: 'unavailable' };
}

export async function captureManagedMachinePresetSavedSecretPromotionRewritesForOperation(params: ManagedPresetSavedSecretOperation & Readonly<{
  rewrites: readonly PresetRewriteV1[];
}>): Promise<ManagedMachinePresetSavedSecretPromotionCaptureV1> {
  const captured = await createManagedPresetSavedSecretReader(params);
  return captured ? prepareManagedMachinePresetSavedSecretPromotionRewritesV1({ ...captured,
    rewrites: params.rewrites, randomBytes: getRandomBytes, signal: params.signal }) : { kind: 'unavailable' };
}
