import type { ConnectedAccountPurposeDeclaration, PluginConnectedAccountDescriptorContributionV2 } from '@happier-dev/plugin-sdk/connected-accounts';
import { MUSE_ACCOUNT_SERVICE } from '@happier-dev/plugin-sdk/connected-accounts';

export {
  MUSE_ACCOUNT_SERVICE,
  MUSE_CODE_CREDENTIAL_ENV_KEY,
  META_API_KEY_ENV_KEY,
} from '@happier-dev/plugin-sdk/connected-accounts';

export const MUSE_ACCOUNT_SERVICE_ID = MUSE_ACCOUNT_SERVICE.localId;
export const MUSE_NATIVE_PURPOSE = 'muse-native';
export const META_INFERENCE_PURPOSE = 'meta-inference';
export const META_UPSTREAM_PURPOSE = 'meta-upstream';
export const MUSE_NATIVE_AUTH_FILE_ID = 'muse/auth.json';
export const META_INFERENCE_HEADERS = { 'x-api-version': '1.0.0' } as const;
export const MUSE_NATIVE_HOME = {
  environmentKey: 'XDG_CONFIG_HOME', defaultRelativePath: '.config',
  materializedRootOverlay: { privateEntries: ['muse'] },
} as const;

/** The account token and inference key Muse stores; a Session transcript masks both. */
const MUSE_SECRET_CREDENTIAL_KEYS = ['accountToken', 'inferenceKey'] as const;

export const museAccountDescriptor = {
  title: 'Muse',
  capabilities: ['usage'],
  usageIdentity: { providerId: 'meta' },
  authentication: {
    account: { artifactId: 'connected-account-authentication', exportName: 'activate' },
    defaultModeId: 'device',
    modes: [
      // Meta's device endpoint rejects the browser preflight; native apps keep Account execution.
      { id: 'device', kind: 'oauthDeviceCode', title: 'Sign in with Meta', scopes: [], outcomeReconciliation: 'none', browserReachability: 'unreachable',
        secretCredentialKeys: [...MUSE_SECRET_CREDENTIAL_KEYS] },
      { id: 'api-key', kind: 'manual', apiKey: true, title: 'API key', outcomeReconciliation: 'none',
        // Meta documents dashboard keys at dev.meta.ai: shown once, prefixed LLM_ (research/MUSE-AUTH-REFERENCES-1112 §F).
        setup: { url: 'https://dev.meta.ai/', checklist: ['Sign in at [dev.meta.ai] and create an API key.', 'Copy it now, Meta shows it only once, and paste it here.'] },
        credentialFieldKeys: { apiKey: 'inferenceKey' },
        fields: [{ id: 'apiKey', title: 'Meta API key', schema: { type: 'string', minLength: 1 }, secret: true,
          presentation: { placeholder: 'LLM_…' } }] },
      { id: 'native-import', kind: 'manual', title: 'Import native login', credentialOrigin: 'native_import', outcomeReconciliation: 'none',
        secretCredentialKeys: [...MUSE_SECRET_CREDENTIAL_KEYS],
        fields: [{ id: 'source', title: 'Source', schema: { type: 'string', enum: ['native'] }, secret: false, default: 'native',
          presentation: { control: 'select', options: [{ value: 'native', title: 'Muse login' }] } }] },
    ],
  },
} as const satisfies Omit<PluginConnectedAccountDescriptorContributionV2, 'id'>;

export const museNativeConnectedAccountPurpose = {
  purpose: MUSE_NATIVE_PURPOSE, service: MUSE_ACCOUNT_SERVICE_ID,
  materializationKinds: ['files', 'environment'], credentialKinds: ['oauth', 'token'],
} as const satisfies ConnectedAccountPurposeDeclaration;
