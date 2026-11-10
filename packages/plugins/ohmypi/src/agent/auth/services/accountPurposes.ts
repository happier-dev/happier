import type { ConnectedAccountPurposeDeclaration } from '@happier-dev/plugin-sdk/connected-accounts';
import { MUSE_ACCOUNT_SERVICE, MUSE_CODE_CREDENTIAL_ENV_KEY, META_API_KEY_ENV_KEY } from '@happier-dev/plugins-muse/connected-account-service';
import { KIMI_CONNECTED_ACCOUNT_SERVICE, KIMI_CODE_API_KEY_ENV, KIMI_CODE_API_BASE_ENV } from '@happier-dev/plugins-kimi/connected-account-service';
import { GROK_CONNECTED_ACCOUNT_SERVICE } from '@happier-dev/plugins-grok/connected-account-service';
import { GEMINI_CONNECTED_ACCOUNT_SERVICE } from '@happier-dev/plugins-gemini/connected-account-service';
import { GITHUB_CONNECTED_ACCOUNT_SERVICE } from '@happier-dev/plugins-scm-github/connected-account-service';
import { CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1 } from '@happier-dev/protocol/agents/claude/connected-account-materialization';

type OhMyPiNativeAccountRoute = Readonly<{
  nativeProvider: string;
  materializationKey: string;
  launchEnvironmentKey: string;
  nativeBaseEnvironmentKey?: string;
}>;

type OhMyPiConnectedAccountPurpose = Readonly<{
  purpose: string;
  service: Readonly<{ pluginId: string; localId: string }>;
  credentialKinds: NonNullable<ConnectedAccountPurposeDeclaration['credentialKinds']>;
  nativeRoutes: readonly OhMyPiNativeAccountRoute[];
  additionalEnvironmentKeys?: readonly string[];
  clearEnvironmentKeys?: readonly string[];
  fileCredential?: Readonly<{ fileId: string; environmentKey: string }>;
}>;

export const OH_MY_PI_CONNECTED_ACCOUNT_PURPOSES: readonly OhMyPiConnectedAccountPurpose[] = [{
  purpose: 'openai-codex',
  service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
  nativeRoutes: [{ nativeProvider: 'openai-codex', materializationKey: 'OPENAI_CODEX_OAUTH_TOKEN', launchEnvironmentKey: 'OPENAI_CODEX_OAUTH_TOKEN' }],
  credentialKinds: ['oauth'],
}, {
  purpose: 'openai',
  service: { pluginId: 'happier.voice.openai', localId: 'openai' },
  nativeRoutes: [{ nativeProvider: 'openai', materializationKey: 'OPENAI_API_KEY', launchEnvironmentKey: 'OPENAI_API_KEY' }],
  credentialKinds: ['token'],
}, {
  purpose: 'claude-subscription',
  service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' },
  nativeRoutes: [{ nativeProvider: 'anthropic',
    materializationKey: CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.oauth.accessTokenEnvironmentKey,
    launchEnvironmentKey: CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.oauth.accessTokenEnvironmentKey }],
  credentialKinds: ['token', 'oauth'],
}, {
  purpose: 'anthropic',
  service: { pluginId: 'happier.agent.claude', localId: 'anthropic' },
  nativeRoutes: [{ nativeProvider: 'anthropic', materializationKey: 'ANTHROPIC_API_KEY', launchEnvironmentKey: 'ANTHROPIC_API_KEY' }],
  credentialKinds: ['token'],
}, {
  purpose: 'gemini',
  service: GEMINI_CONNECTED_ACCOUNT_SERVICE,
  nativeRoutes: [{ nativeProvider: 'google', materializationKey: 'GEMINI_API_KEY', launchEnvironmentKey: 'GEMINI_API_KEY' }],
  additionalEnvironmentKeys: ['GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'],
  clearEnvironmentKeys: ['GOOGLE_API_KEY'],
  fileCredential: { fileId: 'google-service-account.json', environmentKey: 'GOOGLE_APPLICATION_CREDENTIALS' },
  credentialKinds: ['token'],
}, {
  purpose: 'kimi-code',
  service: KIMI_CONNECTED_ACCOUNT_SERVICE,
  nativeRoutes: [{ nativeProvider: 'kimi-code', materializationKey: 'HAPPIER_KIMI_ACCESS_TOKEN',
    nativeBaseEnvironmentKey: KIMI_CODE_API_BASE_ENV, launchEnvironmentKey: KIMI_CODE_API_KEY_ENV }],
  credentialKinds: ['token', 'oauth'],
}, {
  purpose: 'xai',
  service: GROK_CONNECTED_ACCOUNT_SERVICE,
  nativeRoutes: [
    { nativeProvider: 'xai-oauth', materializationKey: 'XAI_OAUTH_TOKEN', launchEnvironmentKey: 'XAI_OAUTH_TOKEN' },
    { nativeProvider: 'xai', materializationKey: 'XAI_API_KEY', launchEnvironmentKey: 'XAI_API_KEY' },
  ],
  credentialKinds: ['token', 'oauth'],
}, {
  purpose: 'muse',
  service: MUSE_ACCOUNT_SERVICE,
  // A subscription also has an inference key; preserve its native subscription route.
  nativeRoutes: [
    { nativeProvider: 'muse-code', materializationKey: MUSE_CODE_CREDENTIAL_ENV_KEY, launchEnvironmentKey: MUSE_CODE_CREDENTIAL_ENV_KEY },
    { nativeProvider: 'meta', materializationKey: META_API_KEY_ENV_KEY, launchEnvironmentKey: META_API_KEY_ENV_KEY },
  ],
  credentialKinds: ['token', 'oauth'],
}, {
  purpose: 'github-copilot',
  service: GITHUB_CONNECTED_ACCOUNT_SERVICE,
  nativeRoutes: [{ nativeProvider: 'github-copilot', materializationKey: 'COPILOT_GITHUB_TOKEN', launchEnvironmentKey: 'COPILOT_GITHUB_TOKEN' }],
  credentialKinds: ['token', 'oauth'],
}];

/** One projection for host launch declarations and isolation. */
export function ohMyPiPurposeEnvironmentKeys(row: OhMyPiConnectedAccountPurpose): readonly string[] {
  return [...new Set([...row.nativeRoutes.flatMap(route => [route.materializationKey,
    ...(route.nativeBaseEnvironmentKey ? [route.nativeBaseEnvironmentKey] : [])]),
    ...(row.additionalEnvironmentKeys ?? [])])];
}

export function ohMyPiPurposeOwnedEnvironmentKeys(row: OhMyPiConnectedAccountPurpose): readonly string[] {
  return [...new Set([...row.nativeRoutes.map(route => route.launchEnvironmentKey), ...ohMyPiPurposeEnvironmentKeys(row),
    ...(row.clearEnvironmentKeys ?? []),
    ...(row.fileCredential ? [row.fileCredential.environmentKey] : []),
  ])];
}
