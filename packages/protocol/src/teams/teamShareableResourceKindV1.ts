import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ArtifactTeamResourceKindV1Schema } from '../artifacts/artifactKindV1.js';
import { PluginCollectionContractRefV1Schema, pluginCollectionContractKeyV1 } from '../plugins/data/collectionContractRefV1.js';
import { TeamRefInputV1Schema } from './team.js';

const fixedKinds = z.enum(['sessions', 'machines', 'machinePools', 'machinePresets', 'projectSources', 'discussions', 'savedSecrets', 'credentials']);
export const TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1 = 'accountCollections';
const namedKinds = z.enum([...fixedKinds.options, ...ArtifactTeamResourceKindV1Schema.options]);
export const TeamShareableResourceKindV1Schema = z.enum([...namedKinds.options, TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1]);
export type TeamShareableResourceKindV1 = z.infer<typeof TeamShareableResourceKindV1Schema>;
export const TEAM_SHAREABLE_RESOURCE_KINDS_V1 = TeamShareableResourceKindV1Schema.options;
export const TeamSharedResourcesSummaryInputV1Schema = TeamRefInputV1Schema;
export type TeamSharedResourcesSummaryInputV1 = z.infer<typeof TeamSharedResourcesSummaryInputV1Schema>;

export const TeamSharedResourceCollectionRefV1Schema = lazyZodSchema(() => z.pick(PluginCollectionContractRefV1Schema, { pluginId: true, collectionId: true }));
export type TeamSharedResourceCollectionRefV1 = z.infer<typeof TeamSharedResourceCollectionRefV1Schema>;
const available = { status: z.literal('available'), count: z.number().check(z.int(), z.minimum(0)) };
// Reasons are the selected resource owner's existing code, carried unchanged.
const unavailable = { status: z.literal('unavailable'), count: z.null(), reason: z.string().check(z.minLength(1)) };
const collection = () => ({ kind: z.literal(TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1), collection: TeamSharedResourceCollectionRefV1Schema });
export const TeamSharedResourceSummaryRowV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: namedKinds, ...available }),
  z.strictObject({ kind: namedKinds, ...unavailable }),
  z.strictObject({ ...collection(), ...available }),
  z.strictObject({ ...collection(), ...unavailable }),
]));
export type TeamSharedResourceSummaryRowV1 = z.infer<typeof TeamSharedResourceSummaryRowV1Schema>;
export const TeamSharedResourcesSummaryV1Schema = lazyZodSchema(() => z.strictObject({
  teamId: TeamRefInputV1Schema.shape.teamId, kinds: z.array(TeamSharedResourceSummaryRowV1Schema),
}));
export type TeamSharedResourcesSummaryV1 = z.infer<typeof TeamSharedResourcesSummaryV1Schema>;

export function teamSharedResourceSummaryRowKeyV1(row: Pick<TeamSharedResourceSummaryRowV1, 'kind'> & Readonly<{ collection?: TeamSharedResourceCollectionRefV1 }>): string {
  return row.kind === TEAM_SHAREABLE_COLLECTION_RESOURCE_KIND_V1 && row.collection
    ? `${row.kind}\u0000${pluginCollectionContractKeyV1(row.collection)}` : row.kind;
}
