import { PreflightSessionCatalogsV1Schema, SessionSkillCatalogListResponseV1Schema, type PreflightSessionCatalogsV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
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

type AgentCatalogsProbeParams = PreflightSessionControlsProbeParams & Readonly<{
  agentId: CatalogAgentLookupId;
  catalogEntry?: AgentCatalogEntry | null;
  materializedEnv?: Readonly<Record<string, string>>;
}>;

export async function probeAgentCatalogs(params: AgentCatalogsProbeParams): Promise<PreflightSessionCatalogsV1> {
  const entry = params.catalogEntry === undefined ? AGENTS[params.agentId] : params.catalogEntry;
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
}
