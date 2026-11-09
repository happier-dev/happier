import type { ConnectedAccountPurposeDeclaration, PluginConnectedAccountDescriptorContributionV2 } from '@happier-dev/plugin-sdk/connected-accounts';

export const MUSE_ACCOUNT_SERVICE_ID = 'muse-account';
export const MUSE_ACCOUNT_SERVICE = { pluginId: 'happier.agent.muse', localId: MUSE_ACCOUNT_SERVICE_ID } as const;
export const MUSE_NATIVE_PURPOSE = 'muse-native';
export const META_INFERENCE_PURPOSE = 'meta-inference';
export const META_UPSTREAM_PURPOSE = 'meta-upstream';
export const MUSE_NATIVE_AUTH_FILE_ID = 'muse/auth.json';
export const MUSE_NATIVE_HOME = {
  environmentKey: 'XDG_CONFIG_HOME', defaultRelativePath: '.config',
  materializedRootOverlay: { privateEntries: ['muse'] },
} as const;

export const museAccountDescriptor = {
  title: 'Muse',
  usageIdentity: { providerId: 'meta' },
  authentication: {
    defaultModeId: 'device',
    modes: [
      { id: 'device', kind: 'oauthDeviceCode', title: 'Sign in with Meta', scopes: [], outcomeReconciliation: 'none' },
      { id: 'api-key', kind: 'manual', apiKey: true, title: 'API key', outcomeReconciliation: 'none',
        credentialFieldKeys: { apiKey: 'inferenceKey' },
        fields: [{ id: 'apiKey', title: 'Meta API key', schema: { type: 'string', minLength: 1 }, secret: true }] },
      { id: 'native-import', kind: 'manual', title: 'Import native login', credentialOrigin: 'native_import', outcomeReconciliation: 'none',
        fields: [{ id: 'source', title: 'Source', schema: { type: 'string', enum: ['native'] }, secret: false, default: 'native',
          presentation: { control: 'select', options: [{ value: 'native', title: 'Muse login' }] } }] },
    ],
  },
} as const satisfies Omit<PluginConnectedAccountDescriptorContributionV2, 'id'>;

export const museNativeConnectedAccountPurpose = {
  purpose: MUSE_NATIVE_PURPOSE, service: MUSE_ACCOUNT_SERVICE_ID,
  materializationKinds: ['files', 'environment'], credentialKinds: ['oauth', 'token'],
} as const satisfies ConnectedAccountPurposeDeclaration;
