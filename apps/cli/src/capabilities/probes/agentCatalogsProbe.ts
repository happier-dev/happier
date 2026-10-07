import { PreflightSessionCatalogsV1Schema, SessionSkillCatalogListResponseV1Schema, type PreflightSessionCatalogsV1 } from '@happier-dev/protocol';
import { AsyncTtlCache } from '@happier-dev/protocol/common/asyncTtlCache';
import { z } from 'zod';

import { normalizeAvailableCommands } from '@/agent/acp/commands/publishSlashCommands';
import { AGENTS } from '@/agent/catalog/registry';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import { withPreflightSessionControlsProbeEnvironment } from './preflightSessionControlsProbeEnvironment';
import type { PreflightSessionControlsProbeParams } from './preflightSessionControlsProbeAdapterTypes';

const RawCatalogsSchema = z.object({
  commands: z.array(z.unknown()).nullable(),
  skills: z.array(z.unknown()).nullable(),
  diagnostic: z.string().optional(),
});
const inflightCatalogs = new AsyncTtlCache<PreflightSessionCatalogsV1>({ successTtlMs: 0, errorTtlMs: 0 });

type AgentCatalogsProbeParams = PreflightSessionControlsProbeParams & Readonly<{
  agentId: CatalogAgentLookupId;
  catalogEntry?: AgentCatalogEntry | null;
  runtimeCacheKey?: string;
  materializedEnv?: Readonly<Record<string, string>>;
  connectedServiceSelectionCacheKey?: string | null;
  profileCacheKey?: string | null;
}>;

export async function probeAgentCatalogs(params: AgentCatalogsProbeParams): Promise<PreflightSessionCatalogsV1> {
  const entry = params.catalogEntry === undefined ? AGENTS[params.agentId] : params.catalogEntry;
  const run = async () => {
    // Catalog transport/load failures must propagate; an absent declaration alone
    // means unsupported. The best-effort controls resolver intentionally swallows failures.
    const adapter = await entry?.getPreflightSessionControlsProbeAdapter?.();
    const raw = RawCatalogsSchema.parse(adapter?.probeCatalogsRaw
      ? await withPreflightSessionControlsProbeEnvironment({
        agentId: params.agentId, processEnv: params.env, materializedEnv: params.materializedEnv,
      }, ({ env }) => adapter.probeCatalogsRaw!({ ...params, probeKind: 'catalogs', env }))
      : { commands: null, skills: null });
    const diagnostic = raw.diagnostic === undefined ? {} : { diagnostic: raw.diagnostic };
    return PreflightSessionCatalogsV1Schema.parse({
      commands: { supported: raw.commands !== null, items: normalizeAvailableCommands(raw.commands), ...diagnostic },
      skills: {
        supported: raw.skills !== null,
        items: raw.skills === null ? [] : SessionSkillCatalogListResponseV1Schema.parse({ skills: raw.skills }).skills,
        ...diagnostic,
      },
    });
  };
  // Caller-owned cancellation must never poison another caller. A runtime occurrence
  // supplies the owner identity; calls without one remain independent.
  if (params.signal || !params.runtimeCacheKey) return await run();
  const key = JSON.stringify([
    params.agentId, params.runtimeCacheKey, params.backendTarget, params.runtimeDescriptorV1,
    params.runtimeKindOverride, params.cwd, params.timeoutMs, params.bypassCache,
    params.profileCacheKey, params.connectedServiceSelectionCacheKey, params.accountSettings, params.pluginSettings,
    Object.entries(params.env ?? process.env).sort(([left], [right]) => left.localeCompare(right)),
    Object.entries(params.materializedEnv ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ]);
  // No settled result or error is retained: native project catalogs can change between calls.
  return await inflightCatalogs.runDedupe(key, run);
}
