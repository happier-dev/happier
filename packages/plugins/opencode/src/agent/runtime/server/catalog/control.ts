import type {
  FetchRuntimeResponseV1,
  FetchRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';

import { readOpenCodeSessionRuntimeHandleFromMetadata } from '../../../identity/runtimeDescriptor.js';
import { readOpenCodeManagedServerCredentialHeaders } from '../endpoint.js';
import {
  createOpenCodeServerClient,
  isOpenCodeServerAuthFailure,
  OpenCodeServerCredentialError,
} from '../openCodeServerClient.js';

export type OpenCodeSessionCatalogControlAdapterParams = Readonly<{
  cwd?: unknown;
  metadata?: unknown;
}>;

export type OpenCodeSessionCatalogControlAdapter = Readonly<{
  listVendorPlugins?: (params: OpenCodeSessionCatalogControlAdapterParams) => Promise<unknown>;
  listSkills?: (params: OpenCodeSessionCatalogControlAdapterParams) => Promise<unknown>;
}>;

type OpenCodeRawSkill = Readonly<{
  name?: unknown;
  description?: unknown;
  location?: unknown;
}>;

type OpenCodeCatalogClient = Readonly<{
  appSkills: () => Promise<unknown>;
  dispose?: () => Promise<unknown>;
}>;

type OpenCodeCatalogClientParams = Readonly<{
  directory: string;
  baseUrlOverride?: string;
  headers?: Readonly<Record<string, string>>;
}>;

type OpenCodeServerCatalogControlAdapterDeps = Readonly<{
  createClient?: (params: OpenCodeCatalogClientParams) => Promise<OpenCodeCatalogClient>;
}>;

function unsupportedSkills(diagnostic: string): Readonly<{
  unsupported: true;
  skills: [];
  diagnostic: string;
}> {
  return { unsupported: true, skills: [], diagnostic };
}

function unsupportedVendorPlugins(): Readonly<{
  unsupported: true;
  vendorPlugins: [];
  diagnostic: 'session_catalog_control_unsupported';
}> {
  return { unsupported: true, vendorPlugins: [], diagnostic: 'session_catalog_control_unsupported' };
}

function normalizeCwd(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeOpenCodeSkills(value: unknown): Array<{
  name: string;
  displayName: string;
  description?: string;
  path?: string;
  origin: 'opencode_native';
  enabled: true;
}> {
  if (!Array.isArray(value)) return [];
  const skills = [];
  for (const raw of value) {
    const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as OpenCodeRawSkill : null;
    const name = readString(record?.name);
    if (!name) continue;
    const description = readString(record?.description);
    const path = readString(record?.location);
    skills.push({
      name,
      displayName: name,
      ...(description ? { description } : {}),
      ...(path ? { path } : {}),
      origin: 'opencode_native' as const,
      enabled: true as const,
    });
  }
  return skills;
}

async function createDefaultClient(params: OpenCodeCatalogClientParams): Promise<OpenCodeCatalogClient> {
  const baseUrl = params.baseUrlOverride?.replace(/\/+$/, '');
  if (!baseUrl) {
    return {
      appSkills: async () => [],
    };
  }
  if (!params.headers) {
    return {
      appSkills: async () => {
        throw new OpenCodeServerCredentialError(
          'OpenCode passive skill catalog listing requires a managed server credential',
        );
      },
    };
  }
  const client = createOpenCodeServerClient({
    fetch: fetchWithGlobalFetch,
    baseUrl,
    headers: params.headers,
  });
  return {
    appSkills: async () => client.appSkills({ directory: params.directory }),
  };
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function toFetchRuntimeResponse(response: Response): FetchRuntimeResponseV1 {
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: headersToRecord(response.headers),
    text: async () => await response.text(),
    json: async () => await response.json(),
    arrayBuffer: async () => await response.arrayBuffer(),
  };
}

const fetchWithGlobalFetch: FetchRuntimeServiceV1 = async (request) => {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
  });
  return toFetchRuntimeResponse(response);
};

export function createOpenCodeServerCatalogControlAdapter(
  deps: OpenCodeServerCatalogControlAdapterDeps = {},
): OpenCodeSessionCatalogControlAdapter {
  const createClient = deps.createClient ?? createDefaultClient;
  return {
    listVendorPlugins: async () => unsupportedVendorPlugins(),
    listSkills: async (params) => {
      const cwd = normalizeCwd(params.cwd);
      if (!cwd) return unsupportedSkills('session_catalog_control_cwd_unavailable');
      const runtimeHandle = readOpenCodeSessionRuntimeHandleFromMetadata(params.metadata);
      if (runtimeHandle.backendMode !== 'server' || !runtimeHandle.serverBaseUrl) {
        return unsupportedSkills('session_catalog_control_unavailable');
      }

      let client: OpenCodeCatalogClient | null = null;
      try {
        const credentialHeaders = readOpenCodeManagedServerCredentialHeaders(runtimeHandle.serverBaseUrl);
        client = await createClient({
          directory: cwd,
          baseUrlOverride: runtimeHandle.serverBaseUrl,
          ...(credentialHeaders ? { headers: credentialHeaders } : {}),
        });
        return {
          supported: true,
          skills: normalizeOpenCodeSkills(await client.appSkills()),
        };
      } catch (error) {
        if (isOpenCodeServerAuthFailure(error)) {
          return unsupportedSkills('session_catalog_control_auth_failed');
        }
        return unsupportedSkills('session_catalog_control_unavailable');
      } finally {
        await client?.dispose?.().catch(() => {});
      }
    },
  };
}

export const openCodeServerCatalogControlAdapter = createOpenCodeServerCatalogControlAdapter();
