import { join } from 'node:path';

import {
  defineAuthMaterialization as defineConnectedServiceAuthMaterialization,
  parseCredentialRecord as readConnectedServiceCredentialRecord,
} from '@happier-dev/plugin-sdk/connected-accounts';

import { importGeminiChatSessionForResume } from '../../connectedServices/chatSessionFiles.js';

const geminiAuthMaterialization = defineConnectedServiceAuthMaterialization([
  { serviceId: 'gemini', inputKey: 'gemini' },
] as const);

export const GEMINI_SUPPORTED_CONNECTED_SERVICE_IDS = geminiAuthMaterialization.serviceIds;
export const GEMINI_MATERIALIZED_HOME_CREDENTIAL_ENTRIES = Object.freeze([
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
] as const);

type GeminiConnectedServiceId = typeof GEMINI_SUPPORTED_CONNECTED_SERVICE_IDS[number];
type GeminiAuthMaterializationDiagnostic = Readonly<{
  code: string;
  providerId: 'gemini';
  serviceId: 'gemini';
  severity: 'blocking' | 'warning';
  reason?: string;
}>;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readStringRecord(value: unknown): Readonly<Record<string, string | undefined>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entryValue === 'string') result[key] = entryValue;
  }
  return result;
}

function readNestedRecord(record: Readonly<Record<string, unknown>>, keys: readonly string[]) {
  for (const key of keys) {
    const nested = readRecord(record[key]);
    if (nested) return nested;
  }
  return null;
}

function readGoogleGenAiVertexMetadataEnv(raw: unknown): Record<string, string> {
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
    GOOGLE_GENAI_USE_VERTEXAI: '1',
    ...(project ? { GOOGLE_CLOUD_PROJECT: project } : {}),
    ...(location ? { GOOGLE_CLOUD_LOCATION: location } : {}),
    ...(apiKey ? { GOOGLE_API_KEY: apiKey } : {}),
  };
}

function resolveGoogleGenAiConnectedServiceTokenEnv(options: Readonly<{
  token?: unknown;
  raw?: unknown;
}>): Record<string, string> {
  const vertexEnv = readGoogleGenAiVertexMetadataEnv(options.raw);
  if (Object.keys(vertexEnv).length > 0) return vertexEnv;

  const apiKey = readString(options.token);
  return apiKey ? { GEMINI_API_KEY: apiKey, GOOGLE_API_KEY: apiKey } : {};
}

export const readGeminiConnectedServiceId:
  (selection: unknown) => GeminiConnectedServiceId | null = geminiAuthMaterialization.readConnectedServiceId;
export const createGeminiAuthMaterializationInput: <TRecord>(
  serviceId: GeminiConnectedServiceId,
  record: TRecord,
) => Readonly<Record<string, TRecord>> = geminiAuthMaterialization.createAuthMaterializationInput;

export async function materializeGeminiAuthEnvironment(
  input: Readonly<Record<string, unknown>>,
): Promise<Readonly<{
  env: Record<string, string>;
  diagnostics?: readonly GeminiAuthMaterializationDiagnostic[];
}>> {
  const record = readConnectedServiceCredentialRecord(input.gemini);
  if (!record) return { env: {} };
  if (record.kind !== 'token') {
    return {
      env: {},
      diagnostics: [{
        code: 'gemini_oauth_deferred_api_key_or_vertex_required',
        providerId: 'gemini',
        serviceId: 'gemini',
        severity: 'blocking',
      }],
    };
  }

  const rootDir = readString(input.rootDir);
  const homeDir = rootDir ? join(rootDir, 'home') : null;
  const tokenEnv = resolveGoogleGenAiConnectedServiceTokenEnv({
    token: record.token.token,
    raw: record.token.raw,
  });
  const env: Record<string, string> = {
    ...(homeDir
      ? {
        HOME: homeDir,
        GEMINI_CLI_HOME: homeDir,
      }
      : {}),
    GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false',
    GOOGLE_APPLICATION_CREDENTIALS: '',
    ...tokenEnv,
  };
  if (process.platform === 'win32' && homeDir) {
    env.USERPROFILE = homeDir;
  }

  const diagnostics: GeminiAuthMaterializationDiagnostic[] = [];
  const vendorResumeId = readString(input.vendorResumeId);
  if (vendorResumeId && homeDir) {
    try {
      const importResult = await importGeminiChatSessionForResume({
        targetHomeDir: homeDir,
        sourceEnv: readStringRecord(input.processEnv) ?? process.env,
        cwd: readString(input.sessionDirectory),
        vendorResumeId,
      });
      if (!importResult.imported && importResult.reason && importResult.reason !== 'already_present') {
        diagnostics.push({
          code: 'gemini_chat_session_import_skipped',
          providerId: 'gemini',
          serviceId: 'gemini',
          severity: 'warning',
          reason: importResult.reason,
        });
      }
    } catch {
      diagnostics.push({
        code: 'gemini_chat_session_import_failed',
        providerId: 'gemini',
        serviceId: 'gemini',
        severity: 'warning',
        reason: 'exception',
      });
    }
  }

  return {
    env,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}
