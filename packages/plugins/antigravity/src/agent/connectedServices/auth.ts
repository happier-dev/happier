import { join } from 'node:path';

import {
  defineConnectedServiceAuthMaterialization,
  readConnectedServiceCredentialRecord,
  type ConnectedServiceCredentialRecordV1,
} from '@happier-dev/plugin-sdk/experimental/cloud/auth';

import type { AntigravityConnectedServiceId } from './serviceIds.js';

export const ANTIGRAVITY_MATERIALIZED_HOME_CREDENTIAL_ENTRIES = Object.freeze([
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'ANTIGRAVITY_AUTH_MODE',
  'GEMINI_FORCE_ENCRYPTED_FILE_STORAGE',
  'GOOGLE_APPLICATION_CREDENTIALS',
] as const);

export const ANTIGRAVITY_AUTH_ISOLATION_ENV_KEYS = ANTIGRAVITY_MATERIALIZED_HOME_CREDENTIAL_ENTRIES;

type TokenCredentialRecord = Extract<ConnectedServiceCredentialRecordV1, { kind: 'token' }>;
type AntigravityAuthMaterializationDiagnostic = Readonly<{
  code: string;
  providerId: 'antigravity';
  serviceId: 'gemini';
  severity: 'blocking' | 'warning';
  reason?: string;
}>;

const antigravityAuthMaterialization = defineConnectedServiceAuthMaterialization([
  { serviceId: 'gemini', inputKey: 'gemini' },
] as const);

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNestedRecord(record: Readonly<Record<string, unknown>>, keys: readonly string[]) {
  for (const key of keys) {
    const nested = readRecord(record[key]);
    if (nested) return nested;
  }
  return null;
}

function readGoogleGenAiVertexMetadataEnv(
  raw: unknown,
  options: Readonly<{ vertexEnv?: Readonly<Record<string, string>> }> = {},
): Record<string, string> {
  const rawRecord = readRecord(raw);
  const nestedGemini = rawRecord ? readNestedRecord(rawRecord, ['gemini']) : null;
  const vertex = rawRecord
    ? readNestedRecord(rawRecord, ['vertexAi', 'vertexAI', 'vertex_ai', 'vertex'])
      ?? (nestedGemini ? readNestedRecord(nestedGemini, ['vertexAi', 'vertexAI', 'vertex_ai', 'vertex']) : null)
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
    ...(options.vertexEnv ?? {}),
    GOOGLE_GENAI_USE_VERTEXAI: '1',
    ...(project ? { GOOGLE_CLOUD_PROJECT: project } : {}),
    ...(location ? { GOOGLE_CLOUD_LOCATION: location } : {}),
    ...(apiKey ? { GOOGLE_API_KEY: apiKey } : {}),
  };
}

function resolveGoogleGenAiConnectedServiceTokenEnv(options: Readonly<{
  token?: unknown;
  raw?: unknown;
  vertexEnv?: Readonly<Record<string, string>>;
}>): Record<string, string> {
  const vertexEnv = readGoogleGenAiVertexMetadataEnv(options.raw, {
    ...(options.vertexEnv ? { vertexEnv: options.vertexEnv } : {}),
  });
  if (Object.keys(vertexEnv).length > 0) return vertexEnv;

  const apiKey = readString(options.token);
  return apiKey ? { GEMINI_API_KEY: apiKey, GOOGLE_API_KEY: apiKey } : {};
}

export const readAntigravityConnectedServiceId:
  (selection: unknown) => AntigravityConnectedServiceId | null =
    antigravityAuthMaterialization.readConnectedServiceId;

export const createAntigravityAuthMaterializationInput =
  antigravityAuthMaterialization.createAuthMaterializationInput;

function materializedHomeEnv(rootDir: string | null): Record<string, string> {
  if (!rootDir) return {};
  const homeDir = join(rootDir, 'home');
  return {
    HOME: homeDir,
    GEMINI_CLI_HOME: homeDir,
    ...(process.platform === 'win32' ? { USERPROFILE: homeDir } : {}),
  };
}

function materializeTokenEnv(record: TokenCredentialRecord): Record<string, string> {
  return resolveGoogleGenAiConnectedServiceTokenEnv({
    token: record.token.token,
    raw: record.token.raw,
    vertexEnv: { ANTIGRAVITY_AUTH_MODE: 'vertex' },
  });
}

export async function materializeAntigravityAuthEnvironment(
  input: Readonly<Record<string, unknown>>,
): Promise<Readonly<{
  env: Record<string, string>;
  diagnostics?: readonly AntigravityAuthMaterializationDiagnostic[];
}>> {
  const record = readConnectedServiceCredentialRecord(input.gemini);
  if (!record) return { env: {} };

  if (record.kind !== 'token') {
    return {
      env: {},
      diagnostics: [{
        code: 'antigravity_gemini_oauth_not_portable_local_agy_login_required',
        providerId: 'antigravity',
        serviceId: 'gemini',
        severity: 'blocking',
      }],
    };
  }

  const rootDir = readString(input.rootDir);
  return {
    env: {
      ...materializedHomeEnv(rootDir),
      GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false',
      GOOGLE_APPLICATION_CREDENTIALS: '',
      ...materializeTokenEnv(record),
    },
  };
}
