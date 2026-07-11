import {
  DaemonVoiceCredentialDeleteResponseSchema,
  DaemonVoiceCredentialMintClientAuthResponseSchema,
  DaemonVoiceCredentialStatusResponseSchema,
  DaemonVoiceCredentialStoreResponseSchema,
  DaemonVoiceProviderCatalogResponseSchema,
  type DaemonVoiceCredentialProtection,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  buildElevenLabsConversationAuthAudience,
  ElevenLabsProvisionRequestSchema,
  ElevenLabsProvisionResponseSchema,
  type ElevenLabsProvisionRequest,
} from '../../protocol/voice/index.js';

type Invoke = (method: string, payload: unknown, signal?: AbortSignal | null) => Promise<unknown>;

export class ElevenLabsVoiceUiClientError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'ElevenLabsVoiceUiClientError';
    this.code = code;
  }
}

function parse<T>(schema: Readonly<{ safeParse(value: unknown): { success: true; data: T } | { success: false } }>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ElevenLabsVoiceUiClientError('invalid_response');
  if ((parsed.data as { ok?: boolean }).ok === false) {
    throw new ElevenLabsVoiceUiClientError(String((parsed.data as { errorCode?: unknown }).errorCode ?? 'provider_error'));
  }
  return parsed.data;
}

export type ElevenLabsVoiceCatalogItem = Readonly<{
  voiceId: string;
  name: string;
  category: string | null;
  previewUrl: string | null;
  labels: Readonly<Record<string, string>> | null;
}>;

export function createElevenLabsVoiceUiClient(input: Readonly<{ invoke: Invoke }>) {
  const providerId = 'realtime_elevenlabs';
  const credentialKind = 'api_key';
  return Object.freeze({
    async credentialStatus(): Promise<Readonly<{ exists: boolean; protection: DaemonVoiceCredentialProtection }>> {
      const response = parse(DaemonVoiceCredentialStatusResponseSchema, await input.invoke(
        RPC_METHODS.DAEMON_VOICE_CREDENTIAL_STATUS,
        { providerId, credentialKind },
      ));
      if (!response.ok) throw new ElevenLabsVoiceUiClientError('invalid_response');
      return { exists: response.exists, protection: response.protection };
    },
    async storeCredential(secret: string): Promise<Readonly<{ protection: DaemonVoiceCredentialProtection }>> {
      const response = parse(DaemonVoiceCredentialStoreResponseSchema, await input.invoke(
        RPC_METHODS.DAEMON_VOICE_CREDENTIAL_STORE,
        { providerId, credentialKind, secret, validationCatalog: 'voices' },
      ));
      if (!response.ok) throw new ElevenLabsVoiceUiClientError('invalid_response');
      return { protection: response.protection };
    },
    async deleteCredential(): Promise<boolean> {
      const response = parse(DaemonVoiceCredentialDeleteResponseSchema, await input.invoke(
        RPC_METHODS.DAEMON_VOICE_CREDENTIAL_DELETE,
        { providerId, credentialKind },
      ));
      if (!response.ok) throw new ElevenLabsVoiceUiClientError('invalid_response');
      return response.deleted;
    },
    async mintConversationAuth(params: Readonly<{ agentId: string; textOnly: boolean; signal?: AbortSignal | null }>) {
      const response = parse(DaemonVoiceCredentialMintClientAuthResponseSchema, await input.invoke(
        RPC_METHODS.DAEMON_VOICE_CREDENTIAL_MINT_CLIENT_AUTH,
        { providerId, credentialKind, audience: buildElevenLabsConversationAuthAudience(params) },
        params.signal,
      ));
      if (!response.ok) throw new ElevenLabsVoiceUiClientError('invalid_response');
      if (params.textOnly && response.artifact.kind === 'signed_url') return Object.freeze({ kind: 'signed_url' as const, value: response.artifact.value });
      if (!params.textOnly && response.artifact.kind === 'sdk_token') return Object.freeze({ kind: 'token' as const, value: response.artifact.value });
      throw new ElevenLabsVoiceUiClientError('invalid_response');
    },
    async listVoices(signal?: AbortSignal | null): Promise<readonly ElevenLabsVoiceCatalogItem[]> {
      const response = parse(DaemonVoiceProviderCatalogResponseSchema, await input.invoke(
        RPC_METHODS.DAEMON_VOICE_CREDENTIAL_PROVIDER_CATALOG,
        { providerId, credentialKind, catalog: 'voices' },
        signal,
      ));
      if (!response.ok) throw new ElevenLabsVoiceUiClientError('invalid_response');
      return Object.freeze(response.items.map((item) => {
        const labels: Record<string, string> = {};
        for (const [key, value] of Object.entries(item.metadata)) {
          if (!['category', 'previewUrl'].includes(key) && typeof value === 'string') labels[key] = value;
        }
        return Object.freeze({
          voiceId: item.id,
          name: item.name,
          category: typeof item.metadata.category === 'string' && item.metadata.category ? item.metadata.category : null,
          previewUrl: typeof item.metadata.previewUrl === 'string' && item.metadata.previewUrl ? item.metadata.previewUrl : null,
          labels: Object.keys(labels).length > 0 ? Object.freeze(labels) : null,
        });
      }));
    },
    async provision(request: ElevenLabsProvisionRequest, signal?: AbortSignal | null) {
      const parsedRequest = ElevenLabsProvisionRequestSchema.parse(request);
      return parse(ElevenLabsProvisionResponseSchema, await input.invoke(
        RPC_METHODS.DAEMON_VOICE_ELEVENLABS_PROVISION,
        parsedRequest,
        signal,
      ));
    },
  });
}
