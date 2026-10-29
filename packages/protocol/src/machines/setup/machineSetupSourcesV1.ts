import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { MachineSetupV1Schema, type MachineSetupV1 } from '../managed/machineSetupV1.js';
import { MachineRecipeReferenceV1Schema } from './machineRecipeV1.js';
import { getMachineMetadataFieldV1, readMachineMetadataFieldV1, mutateMachineMetadataFieldV1,
  type MachineMetadataFieldDefinitionV1, type MachineMetadataFieldPortV1 } from '../machineMetadataFieldV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
const revision = () => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER));
export type MachineSetupSourceEntryV1 = { alreadyPresentAtFirstApply?: Record<string, boolean> } & (
  | Readonly<{ kind: 'accountPreset'; presetId: string; presetRevision: number; setup: MachineSetupV1 }>
  | Readonly<{ kind: 'bundledPreset'; ref: { pluginId: string; localId: string; revision: string }; setup: MachineSetupV1 }>
  | Readonly<{ kind: 'direct'; setup: MachineSetupV1; expectedDesiredRevision: number }>
);
export type MachineSetupSourceV1 = MachineSetupSourceEntryV1[];
/** Copy revision is not attachment identity; no extra identity is persisted. */
export function machineSetupSourceOriginKeyV1(source: MachineSetupSourceEntryV1): string {
  return source.kind === 'accountPreset' ? `account:${source.presetId}`
    : source.kind === 'bundledPreset' ? `bundled:${source.ref.pluginId}/${source.ref.localId}` : 'direct';
}

/** A root creation continuation delegates only its admitted setup snapshot. */
export function matchesMachineSetupCreationSourcesV1(sources: MachineSetupSourceV1,
  admitted: Readonly<{ preset: { id: string; revision: number }; setup: MachineSetupV1 }>): boolean {
  return sources.length === 2 && sources.some(source => source.kind === 'accountPreset')
    && sources.some(source => source.kind === 'direct') && sources.every(source => source.kind === 'accountPreset'
      ? sameStrictJsonValue(source, { kind: 'accountPreset', presetId: admitted.preset.id,
        presetRevision: admitted.preset.revision, setup: admitted.setup })
      : source.kind === 'direct' && sameStrictJsonValue(source,
        { kind: 'direct', expectedDesiredRevision: source.expectedDesiredRevision, setup: {} }));
}
export const MachineSetupSourceEntryV1Schema: z.ZodMiniType<MachineSetupSourceEntryV1> = lazyZodSchema(() => {
  const copy = { setup: MachineSetupV1Schema, alreadyPresentAtFirstApply: z.optional(z.record(id(), z.boolean())) };
  return z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('accountPreset'), presetId: id(), presetRevision: revision(), ...copy }),
    z.strictObject({ kind: z.literal('bundledPreset'), ref: z.strictObject({
      pluginId: MachineRecipeReferenceV1Schema.shape.pluginId,
      localId: MachineRecipeReferenceV1Schema.shape.recipeId,
      revision: z.string().check(z.trim(), z.minLength(1)),
    }), ...copy }),
    z.strictObject({ kind: z.literal('direct'), expectedDesiredRevision: revision(), ...copy }),
  ]);
});
export const MachineSetupSourceV1Schema: z.ZodMiniType<MachineSetupSourceV1> = lazyZodSchema(() => z.array(MachineSetupSourceEntryV1Schema).check(
  z.refine(sources => sources.filter(source => source.kind === 'direct').length === 1,
    { message: 'Setup has exactly one implicit direct source.' }),
  z.refine(sources => {
    const origins = sources.map(machineSetupSourceOriginKeyV1);
    return new Set(origins).size === origins.length;
  }, { message: 'Each setup source is attached once.' }),
));
export const MachineSetupExclusionV1Schema = lazyZodSchema(() => z.strictObject({
  ref: MachineRecipeReferenceV1Schema, reason: z.literal('posture_ssh_closed'),
}));
export type MachineSetupDesiredV1 = Readonly<{
  version: 1; revision: number; sources: MachineSetupSourceV1;
  exclusions: Array<z.infer<typeof MachineSetupExclusionV1Schema>>;
}>;
export const MachineSetupDesiredV1Schema: z.ZodMiniType<MachineSetupDesiredV1> = lazyZodSchema(() => z.strictObject({
  version: z.literal(1), revision: revision(), sources: MachineSetupSourceV1Schema, exclusions: z.array(MachineSetupExclusionV1Schema),
}));
export const MachineSetupDesiredV1ReadSchema = createStoredReadSchema(MachineSetupDesiredV1Schema);
export function createEmptyMachineSetupDesiredV1(): MachineSetupDesiredV1 {
  return { version: 1, revision: 0, sources: [{ kind: 'direct', setup: {}, expectedDesiredRevision: 0 }], exclusions: [] };
}
export const machineSetupMetadataFieldV1 = {
  field: 'setup', storedSchema: MachineSetupDesiredV1ReadSchema, defaultValue: createEmptyMachineSetupDesiredV1,
  equal: (left: MachineSetupDesiredV1, right: MachineSetupDesiredV1) => sameStrictJsonValue(left, right),
} satisfies MachineMetadataFieldDefinitionV1<MachineSetupDesiredV1>;
export function readMachineSetupDesiredV1(metadata: unknown) {
  return readMachineMetadataFieldV1(metadata, machineSetupMetadataFieldV1);
}
export function getMachineSetupDesiredV1(port: MachineMetadataFieldPortV1) {
  return getMachineMetadataFieldV1(port, machineSetupMetadataFieldV1);
}
/** One desired-revision fence, reusing the existing field CAS for unrelated metadata edits. */
export async function mutateMachineSetupDesiredV1(input: Readonly<{
  expectedDesiredRevision: number; sources: MachineSetupSourceV1; exclusions: MachineSetupDesiredV1['exclusions'];
}>, port: MachineMetadataFieldPortV1, options?: Readonly<{ signal?: AbortSignal }>) {
  const current = await getMachineSetupDesiredV1(port);
  if (current.status !== 'ready') return current;
  if (current.policy.revision !== input.expectedDesiredRevision
    || input.sources.some(source => source.kind === 'direct' && source.expectedDesiredRevision !== input.expectedDesiredRevision)) return { status: 'conflict' as const,
    policy: current.policy, metadataVersion: current.metadataVersion };
  const candidate = MachineSetupDesiredV1Schema.safeParse({ version: 1, revision: current.policy.revision,
    sources: input.sources, exclusions: input.exclusions });
  if (!candidate.success) return { status: 'invalid' as const };
  // The direct revision is a review fence, not a desired-content change. Only
  // changed copies advance it, so a current-copy read can be applied unchanged.
  const parsed = MachineSetupDesiredV1Schema.safeParse(sameStrictJsonValue(candidate.data, current.policy)
    ? current.policy : { ...candidate.data, revision: current.policy.revision + 1,
      sources: candidate.data.sources.map(source => source.kind === 'direct'
        ? { ...source, expectedDesiredRevision: current.policy.revision + 1 } : source) });
  if (!parsed.success) return { status: 'invalid' as const };
  return mutateMachineMetadataFieldV1({ expectedMetadataVersion: current.metadataVersion,
    expectedPolicy: current.policy, policy: parsed.data, comparison: 'field' }, port, machineSetupMetadataFieldV1, options);
}
