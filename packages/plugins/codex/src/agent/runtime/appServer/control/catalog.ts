import type { HostRuntimeControlServiceV1 } from '@happier-dev/agents';

import {
  listCodexAppServerSkills,
  listCodexVendorPlugins,
} from '../catalog/index.js';

const CATALOG_CONTROL_UNAVAILABLE_DIAGNOSTIC = 'codex_app_server_catalog_control_unavailable';

type CatalogControlInput<TParams> = Readonly<{
  runtimeControl: HostRuntimeControlServiceV1;
  params: TParams;
}>;

type CatalogControlParams = Readonly<{
  cwd: string | null;
}>;

function unsupportedVendorPlugins(diagnostic: string): Readonly<{
  unsupported: true;
  vendorPlugins: [];
  diagnostic: string;
}> {
  return { unsupported: true, vendorPlugins: [], diagnostic };
}

function unsupportedSkills(diagnostic: string): Readonly<{
  unsupported: true;
  skills: [];
  diagnostic: string;
}> {
  return { unsupported: true, skills: [], diagnostic };
}

function normalizeCwd(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function createClient(runtimeControl: HostRuntimeControlServiceV1) {
  return {
    request: async (method: string, params?: unknown) => {
      const result = await runtimeControl.appServer.request({ method, params });
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
  };
}

function sanitizeVendorPluginsResult(
  result: Awaited<ReturnType<typeof listCodexVendorPlugins>>,
): Awaited<ReturnType<typeof listCodexVendorPlugins>> {
  return result.supported === false && result.diagnostic
    ? { ...result, diagnostic: CATALOG_CONTROL_UNAVAILABLE_DIAGNOSTIC }
    : result;
}

function sanitizeSkillsResult(
  result: Awaited<ReturnType<typeof listCodexAppServerSkills>>,
): Awaited<ReturnType<typeof listCodexAppServerSkills>> {
  return result.supported === false && result.diagnostic
    ? { ...result, diagnostic: CATALOG_CONTROL_UNAVAILABLE_DIAGNOSTIC }
    : result;
}

export async function listCodexRuntimeVendorPlugins(
  input: CatalogControlInput<CatalogControlParams>,
): Promise<unknown> {
  const cwd = normalizeCwd(input.params.cwd);
  if (!cwd) return unsupportedVendorPlugins('session_catalog_control_cwd_unavailable');
  try {
    return sanitizeVendorPluginsResult(await listCodexVendorPlugins({
      client: createClient(input.runtimeControl),
      cwd,
    }));
  } catch {
    return unsupportedVendorPlugins(CATALOG_CONTROL_UNAVAILABLE_DIAGNOSTIC);
  }
}

export async function listCodexRuntimeSkills(
  input: CatalogControlInput<CatalogControlParams>,
): Promise<unknown> {
  const cwd = normalizeCwd(input.params.cwd);
  if (!cwd) return unsupportedSkills('session_catalog_control_cwd_unavailable');
  try {
    return sanitizeSkillsResult(await listCodexAppServerSkills({
      client: createClient(input.runtimeControl),
      cwd,
    }));
  } catch {
    return unsupportedSkills(CATALOG_CONTROL_UNAVAILABLE_DIAGNOSTIC);
  }
}
