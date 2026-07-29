import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderSettingsV1Schema,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';

import {
  readEncryptedAccountSettingsV2,
  readEncryptedAccountSettingsV2OrEmpty,
  upsertEncryptedAccountSettingsV2,
} from '../accountSettings';
import {
  accountScopedCryptoMaterialFromCliAccessKey,
  type CliAccessKey,
} from '../cliAccessKey';

type ProviderUiE2eAccount = Readonly<{
  baseUrl: string;
  accessKey: CliAccessKey;
}>;

export const LMSTUDIO_PROVIDER_CONTRIBUTION_KEY = 'happier.provider.lmstudio/lmstudio';
export const PROVIDER_UI_E2E_MODEL_ID = 'provider-e2e-model';

export function lmStudioProviderUiE2eBaseUrl(connectionIndex = 0): string {
  return `http://127.0.0.1:${47100 + connectionIndex}`;
}

export function buildLmStudioProviderUiE2eSettings(params: Readonly<{
  machineId: string;
  connectionCount?: number;
  connectionBaseUrls?: readonly string[];
}>): ProviderSettingsV1 {
  const connectionCount = params.connectionCount ?? 10;
  const now = Date.now();
  const connections = Array.from({ length: connectionCount }, (_, index) => {
    const origin = params.connectionBaseUrls?.[index] ?? lmStudioProviderUiE2eBaseUrl(index);
    return {
      v: 1 as const,
      id: `pc_e2e_lmstudio_${index + 1}`,
      source: {
        kind: 'contribution' as const,
        contributionKey: LMSTUDIO_PROVIDER_CONTRIBUTION_KEY,
      },
      role: 'named' as const,
      displayName: index === 0 ? 'LM Studio Personal' : index === 1 ? 'LM Studio Work' : `LM Studio ${index + 1}`,
      displayNameMode: 'custom' as const,
      endpointOverridesByMachineId: {
        [params.machineId]: [
          { endpointTemplateId: 'lmstudio-openai-responses', baseUrl: `${origin}/v1` },
          { endpointTemplateId: 'lmstudio-openai-chat', baseUrl: `${origin}/v1` },
          { endpointTemplateId: 'lmstudio-anthropic', baseUrl: origin },
        ],
      },
      revision: 1,
      createdAt: now + index,
      updatedAt: now + index,
    };
  });

  return ProviderSettingsV1Schema.parse({
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections,
    manualModelsByConnectionId: {
      pc_e2e_lmstudio_1: [{ id: PROVIDER_UI_E2E_MODEL_ID, name: 'Provider E2E Model', addedAt: now }],
      pc_e2e_lmstudio_2: [{ id: PROVIDER_UI_E2E_MODEL_ID, name: 'Provider E2E Model', addedAt: now }],
    },
  });
}

export async function hasProviderUiE2eConnectionGrant(params: Readonly<{
  connectionId: string;
  machineId: string;
}> & ProviderUiE2eAccount): Promise<boolean> {
  const current = await readEncryptedAccountSettingsV2({
    baseUrl: params.baseUrl,
    token: params.accessKey.token,
    material: accountScopedCryptoMaterialFromCliAccessKey(params.accessKey),
  });
  const providerSettings = ProviderSettingsV1Schema.parse(current.settings.providerSettingsV1);
  return providerSettings.accountGrants.some((grant) => grant.connectionId === params.connectionId)
    || providerSettings.machineGrants.some((grant) => (
      grant.connectionId === params.connectionId && grant.machineId === params.machineId
    ));
}

export async function replaceProviderUiE2eSettings(params: Readonly<{
  providerSettings: ProviderSettingsV1;
}> & ProviderUiE2eAccount): Promise<void> {
  const material = accountScopedCryptoMaterialFromCliAccessKey(params.accessKey);
  const current = await readEncryptedAccountSettingsV2OrEmpty({
    baseUrl: params.baseUrl,
    token: params.accessKey.token,
    material,
  });
  await upsertEncryptedAccountSettingsV2({
    baseUrl: params.baseUrl,
    token: params.accessKey.token,
    material,
    expectedVersion: current.settingsVersion,
    settings: {
      ...current.settings,
      providerSettingsV1: params.providerSettings,
    },
  });
}

export async function revokeProviderUiE2eConnectionGrants(params: Readonly<{
  connectionId: string;
}> & ProviderUiE2eAccount): Promise<void> {
  const material = accountScopedCryptoMaterialFromCliAccessKey(params.accessKey);
  const current = await readEncryptedAccountSettingsV2({
    baseUrl: params.baseUrl,
    token: params.accessKey.token,
    material,
  });
  const providerSettings = ProviderSettingsV1Schema.parse(current.settings.providerSettingsV1);
  await upsertEncryptedAccountSettingsV2({
    baseUrl: params.baseUrl,
    token: params.accessKey.token,
    material,
    expectedVersion: current.settingsVersion,
    settings: {
      ...current.settings,
      providerSettingsV1: ProviderSettingsV1Schema.parse({
        ...providerSettings,
        accountGrants: providerSettings.accountGrants.filter((grant) => grant.connectionId !== params.connectionId),
        machineGrants: providerSettings.machineGrants.filter((grant) => grant.connectionId !== params.connectionId),
      }),
    },
  });
}
