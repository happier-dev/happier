import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { PreflightSessionCatalogsV1Schema, SessionSkillCatalogListResponseV1Schema, type PreflightSessionCatalogsV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import { z } from 'zod/mini';

import { normalizeAvailableCommands } from '@/agent/acp/commands/publishSlashCommands';
import { AGENTS } from '@/agent/catalog/registry';
import type { CatalogAgentLookupId } from '@/agent/catalog/ids';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import { withPreflightSessionControlsProbeEnvironment } from './preflightSessionControlsProbeEnvironment';
import type { PreflightSessionControlsProbeParams } from './preflightSessionControlsProbeAdapterTypes';

const RawCatalogsSchema = z.object({
  commands: z.nullable(z.array(z.unknown())),
  skills: z.nullable(z.array(z.unknown())),
  diagnostic: z.optional(z.string()),
});

type AgentCatalogsProbeParams = PreflightSessionControlsProbeParams & Readonly<{
  agentId: CatalogAgentLookupId;
  catalogEntry?: AgentCatalogEntry | null;
  registrySnapshot?: ResolvedContributionRegistry;
  materializedEnv?: Readonly<Record<string, string>>;
}>;

export async function probeAgentCatalogs(params: AgentCatalogsProbeParams): Promise<PreflightSessionCatalogsV1> {
  const entry = params.catalogEntry === undefined ? AGENTS[params.agentId] : params.catalogEntry;
  // Catalog transport/load failures must propagate; an absent declaration alone
  // means unsupported. The best-effort controls resolver intentionally swallows failures.
  const adapter = await entry?.getPreflightSessionControlsProbeAdapter?.();
  const raw = RawCatalogsSchema.parse(adapter?.probeCatalogsRaw
    ? await withPreflightSessionControlsProbeEnvironment({
      registrySnapshot: params.registrySnapshot ?? readCurrentContributionRegistry(), catalogEntry: entry,
      agentId: params.agentId, processEnv: params.env, materializedEnv: params.materializedEnv,
      acquireEnvironment: params.acquireEnvironment,
    }, ({ env, acquireEnvironment }) => adapter.probeCatalogsRaw!({ ...params, acquireEnvironment, probeKind: 'catalogs', env }))
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
