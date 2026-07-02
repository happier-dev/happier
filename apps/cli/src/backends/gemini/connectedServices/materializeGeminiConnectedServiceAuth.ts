import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { join } from 'node:path';

import { requireConnectedServiceOauthCredentialRecord } from '@/daemon/connectedServices/shared/connectedServiceCredentialRecord';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

export const GEMINI_ACP_AUTH_METHOD_ENV = 'HAPPIER_GEMINI_ACP_AUTH_METHOD';
export const GEMINI_ACP_AUTH_META_ENV = 'HAPPIER_GEMINI_ACP_AUTH_META';

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readStringMap(value: unknown): Record<string, string> | null {
  const record = readRecord(value);
  if (!record) return null;
  const entries = Object.entries(record)
    .map(([key, entry]) => [key, readString(entry)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function readCredentialRaw(record: ConnectedServiceCredentialRecordV1): Record<string, unknown> | null {
  return readRecord(record.kind === 'oauth' ? record.oauth.raw : record.token.raw);
}

function readNestedRecord(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const nested = readRecord(record[key]);
    if (nested) return nested;
  }
  return null;
}

function readVertexMetadata(raw: Record<string, unknown> | null): Record<string, string> {
  const vertex = raw
    ? readNestedRecord(raw, ['vertexAi', 'vertexAI', 'vertex_ai', 'vertex'])
      ?? readNestedRecord(readNestedRecord(raw, ['gemini']) ?? {}, ['vertexAi', 'vertexAI', 'vertex_ai', 'vertex'])
    : null;
  if (!vertex) return {};

  const project = readString(vertex.project)
    ?? readString(vertex.projectId)
    ?? readString(vertex.googleCloudProject)
    ?? readString(vertex.GOOGLE_CLOUD_PROJECT);
  const location = readString(vertex.location)
    ?? readString(vertex.googleCloudLocation)
    ?? readString(vertex.GOOGLE_CLOUD_LOCATION);
  const apiKey = readString(vertex.apiKey)
    ?? readString(vertex.googleApiKey)
    ?? readString(vertex.GOOGLE_API_KEY);

  return {
    GOOGLE_GENAI_USE_VERTEXAI: '1',
    ...(project ? { GOOGLE_CLOUD_PROJECT: project } : {}),
    ...(location ? { GOOGLE_CLOUD_LOCATION: location } : {}),
    ...(apiKey ? { GOOGLE_API_KEY: apiKey } : {}),
  };
}

function readGatewayAuthMeta(raw: Record<string, unknown> | null): Record<string, unknown> | null {
  const meta = raw
    ? readNestedRecord(raw, ['gateway'])
      ?? readNestedRecord(readNestedRecord(raw, ['_meta']) ?? {}, ['gateway'])
      ?? readNestedRecord(readNestedRecord(raw, ['gemini']) ?? {}, ['gateway'])
    : null;
  if (!meta) return null;

  const baseUrl = readString(meta.baseUrl);
  const headers = readStringMap(meta.headers);
  const gateway = {
    ...(baseUrl ? { baseUrl } : {}),
    ...(headers ? { headers } : {}),
  };
  return Object.keys(gateway).length > 0 ? { gateway } : null;
}

export async function materializeGeminiConnectedServiceAuth(params: Readonly<{
  rootDir: string;
  record: ConnectedServiceCredentialRecordV1;
}>): Promise<Readonly<{ env: Record<string, string> }>> {
  const raw = readCredentialRaw(params.record);

  // Gemini CLI uses oauth-personal when it can find local OAuth credentials at ~/.gemini/oauth_creds.json.
  // We materialize an isolated HOME so the spawned Gemini process can authenticate without requiring
  // user-interactive `gemini auth` on the remote machine.
  const homeDir = join(params.rootDir, 'home');
  const oauthCredsPath = join(homeDir, '.gemini', 'oauth_creds.json');

  if (params.record.kind === 'oauth') {
    const record = requireConnectedServiceOauthCredentialRecord(params.record);
    await writeJsonAtomic(oauthCredsPath, {
      access_token: record.oauth.accessToken,
      token_type: record.oauth.tokenType ?? 'Bearer',
      scope: record.oauth.scope ?? 'https://www.googleapis.com/auth/cloud-platform',
      ...(record.oauth.refreshToken ? { refresh_token: record.oauth.refreshToken } : {}),
      ...(record.oauth.idToken ? { id_token: record.oauth.idToken } : {}),
      ...(typeof record.expiresAt === 'number' ? { expires_at: record.expiresAt } : {}),
    });
  }

  const vertexEnv = readVertexMetadata(raw);
  const gatewayAuthMeta = readGatewayAuthMeta(raw);
  const tokenEnv: Record<string, string> = params.record.kind === 'token' && !gatewayAuthMeta
    ? { GEMINI_API_KEY: params.record.token.token, GOOGLE_API_KEY: params.record.token.token }
    : {};
  const env: Record<string, string> = {
    HOME: homeDir,
    GEMINI_CLI_HOME: homeDir,
    GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false',
    GOOGLE_APPLICATION_CREDENTIALS: '',
    ...tokenEnv,
    ...vertexEnv,
  };
  if (process.platform === 'win32') {
    env.USERPROFILE = homeDir;
  }
  if (gatewayAuthMeta) {
    env[GEMINI_ACP_AUTH_METHOD_ENV] = 'gateway';
    env[GEMINI_ACP_AUTH_META_ENV] = JSON.stringify(gatewayAuthMeta);
  }

  return {
    env,
  };
}
