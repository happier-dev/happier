import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { MachineSetupV1Schema, readMachineSetupAppIdentityV1, type MachineSetupV1, type MachinePresetItemV1 } from '../managed/machineSetupV1.js';
import { MachineRecipeReferenceV1Schema } from './machineRecipeV1.js';
import { StoredAppPresetInputV1Schema, type StoredAppPresetInputV1 } from '../../deployments/storedAppInputV1.js';
import { WorkflowRunIdV1Schema } from '../../workflows/workflowIdsV1.js';
import { getMachineMetadataFieldV1, readMachineMetadataFieldV1, mutateMachineMetadataFieldV1,
  type MachineMetadataFieldDefinitionV1, type MachineMetadataFieldPortV1 } from '../machineMetadataFieldV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
const revision = () => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER));
type FirstPresence = 'present' | 'absent';
const firstPresence = z.enum(['present', 'absent']);
/** Address only: authenticated Run progress, never native settlement, proves app completion. */
export type MachineSetupAcceptedAppRunV1 = Readonly<{
  intent: StoredAppPresetInputV1;
  authoredKey?: string;
  homeId: string;
  runId: string;
  sourceKey: string;
  blockId: string;
  actionId: 'deployments.deploy' | 'deployments.templates.instantiate';
}>;
export type MachineSetupSourceFactsMapV1 = Record<string, Readonly<{
  firstPresence?: Record<string, FirstPresence>;
  acceptedAppRuns?: MachineSetupAcceptedAppRunV1[];
}>>;
/** Native target facts belong to this Machine, never to Home-certified copies. */
export const MachineSetupSourceFactsMapV1Schema: z.ZodMiniType<MachineSetupSourceFactsMapV1> = lazyZodSchema(() => z.record(id(), z.strictObject({
  firstPresence: z.optional(z.record(id(), firstPresence)),
  acceptedAppRuns: z.optional(z.array(z.strictObject({
    intent: StoredAppPresetInputV1Schema, authoredKey: z.optional(id()), homeId: id(), runId: WorkflowRunIdV1Schema,
    sourceKey: id(), blockId: id(), actionId: z.enum(['deployments.deploy', 'deployments.templates.instantiate']),
  }))),
})));
export type MachineSetupSourceEntryV1 =
  | Readonly<{ kind: 'accountPreset'; presetId: string; presetRevision: number; setup: MachineSetupV1 }>
  | Readonly<{ kind: 'bundledPreset'; ref: { pluginId: string; localId: string; revision: string }; setup: MachineSetupV1 }>
  | Readonly<{ kind: 'direct'; setup: MachineSetupV1 }>
;
export type MachineSetupSourceV1 = MachineSetupSourceEntryV1[];
export const MachineSetupAppOriginV1Schema = lazyZodSchema(() => z.strictObject({
  sourceIndex: revision(), itemIndex: revision(), kind: z.enum(['new', 'retained', 'unknown']),
}));
export type MachineSetupAppOriginV1 = z.infer<typeof MachineSetupAppOriginV1Schema>;

/** Copy revision is not attachment identity; no extra identity is persisted. */
export function machineSetupSourceOriginKeyV1(source: MachineSetupSourceEntryV1): string {
  return source.kind === 'accountPreset' ? `account:${source.presetId}`
    : source.kind === 'bundledPreset' ? `bundled:${source.ref.pluginId}/${source.ref.localId}` : 'direct';
}
type SetupItem = Exclude<MachinePresetItemV1, { kind: 'app' }>;
export function machineSetupItemKeyV1(item: SetupItem): string {
  return createCanonicalJsonSigningInput(item);
}
export function readMachineSetupFirstPresentV1(sources: MachineSetupSourceV1,
  sourceFacts: MachineSetupSourceFactsMapV1 = {}): ReadonlyMap<string, FirstPresence | undefined> {
  const values = new Map<string, FirstPresence | undefined>();
  for (const source of sources) for (const item of source.setup.items ?? []) {
    if (item.kind === 'app') continue;
    const key = machineSetupItemKeyV1(item);
    const observed = sourceFacts[machineSetupSourceOriginKeyV1(source)]?.firstPresence?.[key];
    const previous = values.get(key);
    values.set(key, observed === 'present' || previous === 'present' ? 'present'
      : observed === 'absent' || previous === 'absent' ? 'absent' : undefined);
  }
  return values;
}

/** A root creation continuation delegates only its admitted setup snapshot. */
export function matchesMachineSetupCreationSourcesV1(sources: MachineSetupSourceV1,
  admitted: Readonly<{ preset: { id: string; revision: number }; setup: MachineSetupV1 }>): boolean {
  return sources.length === 2 && sources.some(source => source.kind === 'accountPreset')
    && sources.some(source => source.kind === 'direct') && sources.every(source => source.kind === 'accountPreset'
      ? sameStrictJsonValue(source, { kind: 'accountPreset', presetId: admitted.preset.id,
        presetRevision: admitted.preset.revision, setup: admitted.setup })
      : source.kind === 'direct' && sameStrictJsonValue(source,
        { kind: 'direct', setup: {} }));
}
export const MachineSetupSourceEntryV1Schema: z.ZodMiniType<MachineSetupSourceEntryV1> = lazyZodSchema(() => {
  const copy = { setup: MachineSetupV1Schema };
  return z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('accountPreset'), presetId: id(), presetRevision: revision(), ...copy }),
    z.strictObject({ kind: z.literal('bundledPreset'), ref: z.strictObject({
      pluginId: MachineRecipeReferenceV1Schema.shape.pluginId,
      localId: MachineRecipeReferenceV1Schema.shape.recipeId,
      revision: z.string().check(z.trim(), z.minLength(1)),
    }), ...copy }),
    z.strictObject({ kind: z.literal('direct'), ...copy }),
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
  ref: MachineRecipeReferenceV1Schema, reason: z.literal('not_selected'),
}));
export type MachineSetupExclusionV1 = z.infer<typeof MachineSetupExclusionV1Schema>;
export const MachineSetupExclusionsV1Schema = lazyZodSchema(() => z.array(MachineSetupExclusionV1Schema).check(
  z.refine(exclusions => exclusions.every((entry, index) => !exclusions.slice(0, index)
    .some(previous => sameStrictJsonValue(previous.ref, entry.ref))),
  { message: 'Each excluded recipe reference is reviewed once.' }),
));
export type MachineSetupDesiredV1 = Readonly<{
  version: 1; revision: number; sources: MachineSetupSourceV1;
  exclusions: Array<z.infer<typeof MachineSetupExclusionV1Schema>>;
  sourceFacts?: MachineSetupSourceFactsMapV1;
}>;
export const MachineSetupDesiredV1Schema: z.ZodMiniType<MachineSetupDesiredV1> = lazyZodSchema(() => z.strictObject({
  version: z.literal(1), revision: revision(), sources: MachineSetupSourceV1Schema, exclusions: z.array(MachineSetupExclusionV1Schema),
  sourceFacts: z.optional(MachineSetupSourceFactsMapV1Schema),
}));
export const MachineSetupDesiredV1ReadSchema = createStoredReadSchema(MachineSetupDesiredV1Schema);
export function createEmptyMachineSetupDesiredV1(): MachineSetupDesiredV1 {
  return { version: 1, revision: 0, sources: [{ kind: 'direct', setup: {} }], exclusions: [] };
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
  /** Receiving native settlement only; public Action inputs have no provenance map. */
  observedSourceFacts?: MachineSetupSourceFactsMapV1;
}>, port: MachineMetadataFieldPortV1, options?: Readonly<{ signal?: AbortSignal }>) {
  const current = await getMachineSetupDesiredV1(port);
  if (current.status !== 'ready') return current;
  if (current.policy.revision !== input.expectedDesiredRevision) return { status: 'conflict' as const,
    policy: current.policy, metadataVersion: current.metadataVersion };
  const sourceFacts = mergeMachineSetupSourceFacts(current.policy, input.sources, input.observedSourceFacts);
  const candidate = MachineSetupDesiredV1Schema.safeParse({ version: 1, revision: current.policy.revision,
    sources: input.sources, exclusions: input.exclusions, ...(sourceFacts ? { sourceFacts } : {}) });
  if (!candidate.success) return { status: 'invalid' as const };
  // Only desired-content changes advance the review revision.
  const parsed = MachineSetupDesiredV1Schema.safeParse(sameStrictJsonValue(candidate.data, current.policy)
    ? current.policy : { ...candidate.data, revision: current.policy.revision + 1 });
  if (!parsed.success) return { status: 'invalid' as const };
  return mutateMachineMetadataFieldV1({ expectedMetadataVersion: current.metadataVersion,
    expectedPolicy: current.policy, policy: parsed.data, comparison: 'field' }, port, machineSetupMetadataFieldV1, options);
}

/** Preserve fresh incumbent facts; an existing unknown item never acquires a later first observation. */
function mergeMachineSetupSourceFacts(current: MachineSetupDesiredV1, sources: MachineSetupSourceV1,
  observed: MachineSetupSourceFactsMapV1 = {}): MachineSetupSourceFactsMapV1 | undefined {
  const incumbent = readMachineSetupFirstPresentV1(current.sources, current.sourceFacts);
  const facts: MachineSetupSourceFactsMapV1 = {};
  for (const source of sources) {
    const origin = machineSetupSourceOriginKeyV1(source);
    const firstPresence: Record<string, FirstPresence> = {};
    for (const item of source.setup.items ?? []) {
      if (item.kind === 'app') continue;
      const key = machineSetupItemKeyV1(item);
      const value = incumbent.has(key) ? incumbent.get(key) : observed[origin]?.firstPresence?.[key];
      if (value !== undefined) firstPresence[key] = value;
    }
    const acceptedAppRuns: MachineSetupAcceptedAppRunV1[] = [];
    for (const item of source.setup.items ?? []) {
      if (item.kind !== 'app') continue;
      const identity = readMachineSetupAppIdentityV1(item);
      // Keyless legacy addresses remain inert history, never inferred identity.
      // Retaining them does not let a reader classify that legacy app as installed.
      const candidates = identity === undefined
        ? [...(current.sourceFacts?.[origin]?.acceptedAppRuns ?? []), ...(observed[origin]?.acceptedAppRuns ?? [])]
          .filter(reference => readMachineSetupAppIdentityV1({ kind: 'app', definition: reference.intent,
            ...(reference.authoredKey ? { authoredKey: reference.authoredKey } : {}) }) === undefined)
        : [...Object.values(current.sourceFacts ?? {}), ...Object.values(observed)].flatMap(facts => facts.acceptedAppRuns ?? [])
          .filter(reference => readMachineSetupAppIdentityV1({ kind: 'app', definition: reference.intent,
            ...(reference.authoredKey ? { authoredKey: reference.authoredKey } : {}) }) === identity);
      // Preserve ambiguity instead of selecting the first completed candidate.
      for (const reference of candidates) if (!acceptedAppRuns.some(retained => sameStrictJsonValue(retained, reference)))
        acceptedAppRuns.push(reference);
    }
    if (Object.keys(firstPresence).length || acceptedAppRuns.length) facts[origin] = {
      ...(Object.keys(firstPresence).length ? { firstPresence } : {}),
      ...(acceptedAppRuns.length ? { acceptedAppRuns } : {}),
    };
  }
  return Object.keys(facts).length ? facts : undefined;
}
