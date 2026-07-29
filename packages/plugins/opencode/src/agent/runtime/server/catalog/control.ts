import { readOpenCodeSessionRuntimeHandleFromMetadata } from '../../../identity/runtimeDescriptor.js';
import { readOpenCodeManagedServerTransport } from '../endpoint.js';
import {
  createOpenCodeServerClient,
  isOpenCodeServerAuthFailure,
} from '../openCodeServerClient.js';
import type { OpenCodeServerTransport } from '../transport.js';

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
  transport?: OpenCodeServerTransport;
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
  if (!params.transport) {
    return {
      appSkills: async () => {
        throw new Error('OpenCode passive skill catalog listing requires an active managed server transport');
      },
    };
  }
  const client = createOpenCodeServerClient({
    transport: params.transport,
  });
  return {
    appSkills: async () => client.appSkills({ directory: params.directory }),
  };
}

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
        const transport = readOpenCodeManagedServerTransport(runtimeHandle.serverBaseUrl);
        client = await createClient({
          directory: cwd,
          baseUrlOverride: runtimeHandle.serverBaseUrl,
          ...(transport ? { transport } : {}),
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
