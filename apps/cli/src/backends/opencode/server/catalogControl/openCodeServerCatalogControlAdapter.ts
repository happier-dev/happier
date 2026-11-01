import { normalizeOpenCodeAppSkills } from '@happier-dev/protocol';

import { readOpenCodeSessionRuntimeHandleFromMetadata } from '@/backends/opencode/utils/opencodeSessionAffinity';
import type { SessionCatalogControlAdapter } from '@/session/catalogControls/sessionCatalogControlTypes';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { createOpenCodeServerRuntimeClient, type OpenCodeServerRuntimeClient } from '../client';
import { withSharedManagedOpenCodeServerAccess } from '../sharedManagedServer';

type OpenCodeCatalogClient = Pick<OpenCodeServerRuntimeClient, 'appSkills' | 'dispose'>;
type OpenCodeCatalogClientParams = Readonly<{
  directory: string;
  baseUrlOverride?: string;
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

async function createDefaultClient(params: OpenCodeCatalogClientParams): Promise<OpenCodeCatalogClient> {
  return await createOpenCodeServerRuntimeClient({
    directory: params.directory,
    messageBuffer: new MessageBuffer(),
    ...(params.baseUrlOverride ? { baseUrlOverride: params.baseUrlOverride } : {}),
  });
}

export function createOpenCodeServerCatalogControlAdapter(
  deps: OpenCodeServerCatalogControlAdapterDeps = {},
): SessionCatalogControlAdapter {
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

      return await withSharedManagedOpenCodeServerAccess(async () => {
        let client: OpenCodeCatalogClient | null = null;
        try {
          client = await createClient({
            directory: cwd,
            baseUrlOverride: runtimeHandle.serverBaseUrl!,
          });
          return {
            supported: true,
            skills: normalizeOpenCodeAppSkills(await client.appSkills()),
          };
        } catch {
          return unsupportedSkills('session_catalog_control_unavailable');
        } finally {
          await client?.dispose().catch(() => {});
        }
      }, runtimeHandle.serverBaseUrl);
    },
  };
}

export const openCodeServerCatalogControlAdapter = createOpenCodeServerCatalogControlAdapter();
