import type { AgentSessionCatalogResult } from '@happier-dev/plugin-sdk/agents/runtime';
import type { SkillCatalogItemV1 } from '@happier-dev/protocol/runtime/catalog/skills';

/** Shared public projection for live and retained native Session catalogs. */
export function projectNativeSkillCatalog(agentId: string, result: AgentSessionCatalogResult): Readonly<{
  skills: readonly SkillCatalogItemV1[];
  unsupported?: true;
  diagnostic?: string;
}> {
  if (result.status !== 'ok' || result.kind !== 'skills') {
    return { unsupported: true, skills: [], diagnostic: result.status === 'ok'
      ? 'native_skill_catalog_kind_mismatch' : result.diagnostic.code };
  }
  return { skills: result.items.map(item => ({
    ...item,
    origin: 'vendor',
    backendId: agentId,
    agentId,
  })) };
}
