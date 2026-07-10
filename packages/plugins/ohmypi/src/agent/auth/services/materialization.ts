import {
  defineConnectedServiceAuthMaterialization,
  readConnectedServiceCredentialRecord,
  requireConnectedServiceOauthCredentialRecordWithExpiry,
  requireConnectedServiceTokenCredentialRecord,
} from '@happier-dev/plugin-sdk/experimental/cloud/auth';

const ohMyPiAuthMaterialization = defineConnectedServiceAuthMaterialization([
  { serviceId: 'openai-codex', inputKey: 'openaiCodex' },
  { serviceId: 'openai', inputKey: 'openai' },
  { serviceId: 'claude-subscription', inputKey: 'claudeSubscription' },
  { serviceId: 'anthropic', inputKey: 'anthropic' },
  { serviceId: 'gemini', inputKey: 'gemini' },
] as const);

export const OH_MY_PI_SUPPORTED_AUTH_SERVICE_IDS = ohMyPiAuthMaterialization.serviceIds;
type OhMyPiSupportedAuthServiceId = typeof OH_MY_PI_SUPPORTED_AUTH_SERVICE_IDS[number];

export const readOhMyPiConnectedServiceId:
  (selection: unknown) => OhMyPiSupportedAuthServiceId | null = ohMyPiAuthMaterialization.readConnectedServiceId;
export const createOhMyPiAuthMaterializationInput = ohMyPiAuthMaterialization.createAuthMaterializationInput;

export async function materializeOhMyPiAuthEnvironment(
  input: Readonly<Record<string, unknown>>,
): Promise<Readonly<{ env: Record<string, string> }>> {
  const env: Record<string, string> = {};
  const openaiCodex = readConnectedServiceCredentialRecord(input.openaiCodex);
  const openai = readConnectedServiceCredentialRecord(input.openai);
  const claudeSubscription = readConnectedServiceCredentialRecord(input.claudeSubscription);
  const anthropic = readConnectedServiceCredentialRecord(input.anthropic);
  const gemini = readConnectedServiceCredentialRecord(input.gemini);

  if (openaiCodex) {
    env.OPENAI_CODEX_OAUTH_TOKEN = requireConnectedServiceOauthCredentialRecordWithExpiry(openaiCodex).oauth.accessToken;
  }

  if (openai) {
    env.OPENAI_API_KEY = requireConnectedServiceTokenCredentialRecord(openai).token.token;
  }

  if (claudeSubscription) {
    env.ANTHROPIC_OAUTH_TOKEN = requireConnectedServiceTokenCredentialRecord(claudeSubscription, {
      message: 'Claude subscription OAuth credentials are not supported. Reconnect using a Claude setup-token.',
    }).token.token;
  }

  if (anthropic) {
    env.ANTHROPIC_API_KEY = requireConnectedServiceTokenCredentialRecord(anthropic, {
      message: 'Anthropic OAuth credentials are not supported. Reconnect using an Anthropic API key.',
    }).token.token;
  }

  if (gemini) {
    env.GEMINI_API_KEY = requireConnectedServiceTokenCredentialRecord(gemini, {
      message: 'Gemini OAuth credentials are not supported. Reconnect using a Gemini API key.',
    }).token.token;
  }

  return { env };
}
