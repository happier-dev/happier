import { CONNECTED_ACCOUNT_ACCESS_ONLY_EXPORT_CONTRACT_V1, CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/plugin-sdk/connected-accounts';
import type { ConnectedAccountPurposeDeclaration, PluginConnectedAccountAccessOnlyExportV1, PluginConnectedAccountDescriptorContributionV2 } from '@happier-dev/plugin-sdk/connected-accounts';

export const MUSE_ACCOUNT_SERVICE_ID = 'muse-account';
export const MUSE_ACCOUNT_SERVICE = { pluginId: 'happier.agent.muse', localId: MUSE_ACCOUNT_SERVICE_ID } as const;
export const MUSE_NATIVE_PURPOSE = 'muse-native';
export const META_INFERENCE_PURPOSE = 'meta-inference';
export const META_UPSTREAM_PURPOSE = 'meta-upstream';
export const MUSE_NATIVE_AUTH_FILE_ID = 'muse/auth.json';
export const MUSE_CODE_CREDENTIAL_ENV_KEY = 'MUSE_CODE_CREDENTIAL';
export const META_API_KEY_ENV_KEY = 'META_API_KEY';
export const META_INFERENCE_HEADERS = { 'x-api-version': '1.0.0' } as const;
export const MUSE_NATIVE_HOME = {
  environmentKey: 'XDG_CONFIG_HOME', defaultRelativePath: '.config',
  materializedRootOverlay: { privateEntries: ['muse'] },
} as const;

const museAccessOnlyExport = {
  contractVersion: CONNECTED_ACCOUNT_ACCESS_ONLY_EXPORT_CONTRACT_V1,
  accessTokenKey: 'accountToken', expiresAtMsKey: 'expiresAtMs',
  metadataKeys: ['credentialMode', 'nativeMechanism', 'nativeApiBaseUrl', 'nativeObtainedVia',
    'nativeExpiresAt', 'nativeSubsActive', 'nativeUserEmail', 'nativeUserFullName'],
} satisfies PluginConnectedAccountAccessOnlyExportV1;

export const museAccountDescriptor = {
  title: 'Muse',
  usageIdentity: { providerId: 'meta' },
  authentication: {
    account: { artifactId: 'connected-account-authentication', exportName: 'activate' },
    defaultModeId: 'device',
    modes: [
      // Meta's device endpoint rejects the browser preflight; native apps keep Account execution.
      { id: 'device', kind: 'oauthDeviceCode', accessOnlyExport: museAccessOnlyExport, title: 'Sign in with Meta', scopes: [], outcomeReconciliation: 'none', browserReachability: 'unreachable' },
      { id: 'api-key', kind: 'manual', apiKey: true, title: 'API key', outcomeReconciliation: 'none',
        directExport: { contractVersion: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 },
        credentialFieldKeys: { apiKey: 'inferenceKey' },
        fields: [{ id: 'apiKey', title: 'Meta API key', schema: { type: 'string', minLength: 1 }, secret: true }] },
      { id: 'native-import', kind: 'manual', accessOnlyExport: museAccessOnlyExport, title: 'Import native login', credentialOrigin: 'native_import', outcomeReconciliation: 'none',
        fields: [{ id: 'source', title: 'Source', schema: { type: 'string', enum: ['native'] }, secret: false, default: 'native',
          presentation: { control: 'select', options: [{ value: 'native', title: 'Muse login' }] } }] },
    ],
  },
} as const satisfies Omit<PluginConnectedAccountDescriptorContributionV2, 'id'>;

export const museNativeConnectedAccountPurpose = {
  purpose: MUSE_NATIVE_PURPOSE, service: MUSE_ACCOUNT_SERVICE_ID,
  materializationKinds: ['files', 'environment'], credentialKinds: ['oauth', 'token'],
} as const satisfies ConnectedAccountPurposeDeclaration;
