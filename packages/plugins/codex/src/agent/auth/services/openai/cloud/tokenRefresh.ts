import {
  ConnectedServiceCredentialRecordV1Schema,
  type ConnectedServiceCredentialRecordV1,
} from '@happier-dev/plugin-sdk/experimental/cloud/auth';

export type CodexChatGptTokensRefreshBridgeResponse = Readonly<{
  accessToken: string;
  chatgptAccountId: string | null;
  chatgptPlanType: string | null;
}>;

type ConnectedAccountOauthRefreshResult = Readonly<{
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  expiresAt: number | null;
}>;

export type RefreshCodexOauthTokens = (params: Readonly<{
  serviceId: 'openai-codex';
  refreshToken: string;
  now: number;
}>) => Promise<ConnectedAccountOauthRefreshResult>;

function requireCodexOauthCredentialRecord(record: ConnectedServiceCredentialRecordV1): Extract<ConnectedServiceCredentialRecordV1, { kind: 'oauth' }> {
  if (record.kind !== 'oauth') {
    throw new Error(`Expected openai-codex OAuth credential record, got ${record.kind}`);
  }
  if (record.serviceId !== 'openai-codex') {
    throw new Error(`Expected openai-codex credential record, got ${record.serviceId}`);
  }
  return record;
}

export async function refreshCodexChatGptTokensForBridge(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  chatgptPlanType: string | null;
  now: number;
  refreshOauthTokens: RefreshCodexOauthTokens;
  persistUpdatedRecord?: (record: ConnectedServiceCredentialRecordV1) => Promise<void>;
}>): Promise<Readonly<{
  codexResponse: CodexChatGptTokensRefreshBridgeResponse;
  updatedRecord: ConnectedServiceCredentialRecordV1;
}>> {
  const record = requireCodexOauthCredentialRecord(params.record);
  const refreshed = await params.refreshOauthTokens({
    serviceId: 'openai-codex',
    refreshToken: record.oauth.refreshToken,
    now: params.now,
  });
  const updatedRecord = ConnectedServiceCredentialRecordV1Schema.parse({
    ...record,
    updatedAt: Math.max(0, Math.trunc(params.now)),
    expiresAt: refreshed.expiresAt,
    oauth: {
      ...record.oauth,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      idToken: refreshed.idToken,
    },
  });
  await params.persistUpdatedRecord?.(updatedRecord);
  return {
    codexResponse: {
      accessToken: refreshed.accessToken,
      chatgptAccountId: record.oauth.providerAccountId,
      chatgptPlanType: params.chatgptPlanType,
    },
    updatedRecord,
  };
}
