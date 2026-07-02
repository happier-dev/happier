import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

type AuthRecord = Record<string, unknown>;

export type OpenCodeAuthMaterializationInput = Readonly<{
  openaiCodex?: ConnectedServiceCredentialRecordV1 | null;
  openai?: ConnectedServiceCredentialRecordV1 | null;
  claudeSubscription?: ConnectedServiceCredentialRecordV1 | null;
  anthropic?: ConnectedServiceCredentialRecordV1 | null;
}>;

export type OpenCodeAuthEnvironmentInput = OpenCodeAuthMaterializationInput & Readonly<{
  managedServerStatePath?: string | null;
}>;

function requireTokenCredential(
  record: ConnectedServiceCredentialRecordV1,
  serviceId: string,
): Extract<ConnectedServiceCredentialRecordV1, { kind: 'token' }> {
  if (record.kind !== 'token') {
    throw new Error(`OpenCode ${serviceId} auth requires token credentials`);
  }
  return record;
}

function requireOauthCredential(
  record: ConnectedServiceCredentialRecordV1,
  serviceId: string,
): Extract<ConnectedServiceCredentialRecordV1, { kind: 'oauth' }> {
  if (record.kind !== 'oauth') {
    throw new Error(`OpenCode ${serviceId} auth requires OAuth credentials`);
  }
  return record;
}

function materializeToken(record: ConnectedServiceCredentialRecordV1, serviceId: string): AuthRecord {
  const tokenRecord = requireTokenCredential(record, serviceId);
  return {
    type: 'api',
    key: tokenRecord.token.token,
  };
}

function materializeClaudeSubscription(record: ConnectedServiceCredentialRecordV1): AuthRecord {
  if (record.kind !== 'token') {
    throw new Error('Claude subscription OAuth credentials require setup-token materialization for OpenCode');
  }
  return materializeToken(record, 'claude-subscription');
}

function materializeOauth(record: ConnectedServiceCredentialRecordV1, serviceId: string): AuthRecord {
  const oauthRecord = requireOauthCredential(record, serviceId);
  const oauth = oauthRecord.oauth;
  return {
    type: 'oauth',
    access: oauth.accessToken,
    refresh: oauth.refreshToken,
    expires: oauthRecord.expiresAt,
    ...(oauth.providerAccountId ? { accountId: oauth.providerAccountId } : {}),
  };
}

export function buildOpenCodeAuthContent(input: OpenCodeAuthMaterializationInput): string {
  const auth: AuthRecord = {};

  if (input.openaiCodex) {
    auth.openai = materializeOauth(input.openaiCodex, 'openai-codex');
  } else if (input.openai) {
    auth.openai = materializeToken(input.openai, 'openai');
  }

  if (input.claudeSubscription) {
    auth.anthropic = materializeClaudeSubscription(input.claudeSubscription);
  } else if (input.anthropic) {
    auth.anthropic = materializeToken(input.anthropic, 'anthropic');
  }

  return JSON.stringify(auth);
}

export function materializeOpenCodeAuthEnvironment(input: OpenCodeAuthEnvironmentInput): Readonly<{
  env: Readonly<Record<string, string>>;
}> {
  return {
    env: {
      OPENCODE_AUTH_CONTENT: buildOpenCodeAuthContent(input),
      ...(input.managedServerStatePath ? {
        HAPPIER_OPENCODE_SERVER_STATE_PATH: input.managedServerStatePath,
      } : {}),
    },
  };
}
