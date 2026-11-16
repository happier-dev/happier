import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { MachineSetupV1Schema, mergeMachineSetupsV1, readMachineSetupAppIdentityV1, readMachineSetupRecipeIdentityV1, type MachineSetupV1, type MachinePresetItemV1 } from '../managed/machineSetupV1.js';
import { MachineRecipeReferenceV1Schema, type MachineRecipeReferenceV1 } from './machineRecipeV1.js';
import { MachineSetupSourceFactsMapV1Schema, type MachineSetupSourceFactsMapV1,
  type MachineSetupAcceptedAppRunV1, type MachineSetupFirstPresenceV1 as FirstPresence } from './machineSetupSourceFactsV1.js';
export { MachineSetupSourceFactsMapV1Schema, type MachineSetupSourceFactsMapV1,
  type MachineSetupAcceptedAppRunV1 } from './machineSetupSourceFactsV1.js';
import { AccountEncryptionModeSchema } from '../../features/payload/capabilities/encryptionCapabilities.js';
import { ManagedMachinePresetLaunchNameOverrideV1Schema,
  type ManagedMachinePresetLaunchNameOverrideV1 } from '../managed/managedMachinePresetContentCarrierV1.js';
import { getMachineMetadataFieldV1, readMachineMetadataFieldV1, mutateMachineMetadataFieldV1,
  type MachineMetadataFieldDefinitionV1, type MachineMetadataFieldPortV1 } from '../machineMetadataFieldV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
const revision = () => z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER));
export type MachineSetupSourceEntryV1 =
  | Readonly<{ kind: 'accountPreset'; presetId: string; presetRevision: number; setup: MachineSetupV1 } & (
      | { /** Author-owned mode captured with this opened local copy; never inferred from ciphertext. */
          contentEncryptionMode: 'plain' | 'e2ee';
          /** A locally retained opaque recipe-input edit, replayed only through the Action wire. */
          presetContentOverride?: ManagedMachinePresetLaunchNameOverrideV1 }
      /** Retained copies predate captured modes; only the stored reader admits this branch. */
      | { contentEncryptionMode?: never; presetContentOverride?: never }
    )>
  | Readonly<{ kind: 'bundledPreset'; ref: { pluginId: string; localId: string; revision: string }; setup: MachineSetupV1 }>
  | Readonly<{ kind: 'direct'; setup: MachineSetupV1 }>
;
export type MachineSetupSourceV1 = MachineSetupSourceEntryV1[];
export const MachineSetupAppOriginV1Schema = lazyZodSchema(() => z.strictObject({
  sourceIndex: revision(), itemIndex: revision(), kind: z.enum(['new', 'retained', 'unknown']),
}));
export type MachineSetupAppOriginV1 = z.infer<typeof MachineSetupAppOriginV1Schema>;

/** Missing correspondence is not evidence that an admitted app is new. */
export function readMachineSetupAppOriginsV1(currentSources: MachineSetupSourceV1,
  proposedSources: MachineSetupSourceV1): MachineSetupAppOriginV1[] {
  const counts = (sources: MachineSetupSourceV1) => {
    const values = new Map<string, number>();
    for (const source of sources) for (const item of source.setup.items ?? []) {
      if (item.kind !== 'app') continue;
      const identity = readMachineSetupAppIdentityV1(item);
      if (identity !== undefined) values.set(identity, (values.get(identity) ?? 0) + 1);
    }
    return values;
  };
  const incumbent = counts(currentSources);
  const proposed = counts(proposedSources);
  return proposedSources.flatMap((source, sourceIndex) => (source.setup.items ?? []).flatMap((item, itemIndex) => {
    if (item.kind !== 'app') return [];
    const identity = readMachineSetupAppIdentityV1(item);
    const count = identity === undefined ? 0 : incumbent.get(identity) ?? 0;
    const kind: MachineSetupAppOriginV1['kind'] = identity === undefined || proposed.get(identity) !== 1 || count > 1 ? 'unknown'
      : count === 0 ? 'new' : 'retained';
    return [{ sourceIndex, itemIndex, kind }];
  }));
}
/** Copy revision is not attachment identity; no extra identity is persisted. */
export function machineSetupSourceOriginKeyV1(source: MachineSetupSourceEntryV1): string {
  return source.kind === 'accountPreset' ? `account:${source.presetId}`
    : source.kind === 'bundledPreset' ? `bundled:${source.ref.pluginId}/${source.ref.localId}` : 'direct';
}
type SetupItem = Exclude<MachinePresetItemV1, { kind: 'app' }>;
export function machineSetupItemKeyV1(item: SetupItem): string {
  return createCanonicalJsonSigningInput(item);
}
/** Selected recipes keep their coordinates in the full certified source copies. */
export function selectMachineSetupRecipeItemsV1(setups: readonly MachineSetupV1[],
  exclusions: readonly MachineSetupExclusionV1[], executionSources?: readonly MachineSetupV1[]):
  readonly Readonly<{ sourceIndex: number; itemIndex: number; item: SetupItem; execute: boolean }>[] {
  const selected: { sourceIndex: number; itemIndex: number; item: SetupItem; execute: boolean }[] = [];
  for (const [sourceIndex, setup] of setups.entries()) {
    const executing = executionSources && new Set((executionSources[sourceIndex]?.items ?? [])
      .flatMap(item => item.kind === 'app' ? [] : [machineSetupItemKeyV1(item)]));
    for (const [itemIndex, item] of (setup.items ?? []).entries()) {
      if (item.kind === 'app' || isMachineSetupRecipeExcludedV1(item.selection.ref, exclusions)) continue;
      selected.push({ sourceIndex, itemIndex, item,
        execute: !executing || executing.has(machineSetupItemKeyV1(item)) });
    }
  }
  return selected;
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

/** Confirmed script completion is target-owned and bound to its ordered inputs. */
function projectMachineSetupScriptExecution(currentSources: MachineSetupSourceV1,
  proposedSources: MachineSetupSourceV1, sourceFacts: MachineSetupSourceFactsMapV1 | undefined,
  changedOnly: boolean): MachineSetupV1[] {
  const pending = new Map(Object.entries(sourceFacts ?? {}).map(([origin, facts]) => [origin, new Set(facts.pendingScripts)]));
  const recovering = [...pending.values()].some(indices => indices.size > 0);
  if (!changedOnly && !recovering) return proposedSources.map(source => source.setup);
  const current = mergeMachineSetupsV1(currentSources.map(source => source.setup));
  const proposed = mergeMachineSetupsV1(proposedSources.map(source => source.setup));
  const sameToolchain = current.ok && proposed.ok && sameStrictJsonValue(current.setup.toolchain, proposed.setup.toolchain);
  const previous = new Map(currentSources.map(source => [machineSetupSourceOriginKeyV1(source), source.setup]));
  return proposedSources.map(source => {
    const origin = machineSetupSourceOriginKeyV1(source);
    const saved = previous.get(origin);
    return { ...source.setup, ...(source.setup.scripts ? { scripts: source.setup.scripts.map((script, index) => {
      const completed = sameToolchain && sameStrictJsonValue(saved?.secretRefs, source.setup.secretRefs)
        && sameStrictJsonValue(saved?.scripts?.[index], script)
        && (!recovering || !pending.get(origin)?.has(index));
      // Keep the full source coordinates used by finiteCommand failure.step.
      return completed && script.body ? { ...script, body: '' } : script;
    }) } : {}) };
  });
}

/** Full copies remain saved; Update and partial recovery share one execution projection. */
export function projectMachineSetupSourceChangeExecutionV1(currentSources: MachineSetupSourceV1,
  proposedSources: MachineSetupSourceV1, mergedSetup: MachineSetupV1, currentExclusions: readonly MachineSetupExclusionV1[],
  options: Readonly<{ currentSourceFacts?: MachineSetupSourceFactsMapV1; mode?: 'update' | 'recovery' }> = {}):
  Readonly<{ ok: true; sources: MachineSetupV1[]; setup: MachineSetupV1 }>
  | Extract<ReturnType<typeof mergeMachineSetupsV1>, { ok: false }> {
  const current = mergeMachineSetupsV1(currentSources.map(source => source.setup));
  if (!current.ok) return current;
  const scriptSources = projectMachineSetupScriptExecution(currentSources, proposedSources, options.currentSourceFacts, options.mode !== 'recovery');
  // Scripts run after recipes and toolchain setup. Confirmed partial script
  // progress therefore retains those completed effects, like an Update.
  const recoveringScripts = Object.values(options.currentSourceFacts ?? {}).some(facts => facts.pendingScripts?.length);
  if (options.mode === 'recovery' && !recoveringScripts) return { ok: true, sources: scriptSources,
    setup: { ...mergedSetup, scripts: scriptSources.flatMap(source => source.scripts ?? []) } };
  const unchangedToolchain = sameStrictJsonValue(current.setup.toolchain, mergedSetup.toolchain);
  const oldItems = new Set(selectMachineSetupRecipeItemsV1(currentSources.map(source => source.setup), currentExclusions)
    .map(({ item }) => machineSetupItemKeyV1(item)));
  const sources = proposedSources.map((source, index) => {
    const { toolchain, ...setup } = scriptSources[index]!;
    return { ...setup, ...(!unchangedToolchain && toolchain ? { toolchain } : {}),
      ...(source.setup.items ? { items: source.setup.items.filter(item => item.kind === 'app' || !oldItems.has(machineSetupItemKeyV1(item))) } : {}),
    };
  });
  const { toolchain, ...setup } = mergedSetup;
  return { ok: true, sources, setup: { ...setup, ...(!unchangedToolchain && toolchain ? { toolchain } : {}),
    ...(mergedSetup.items ? { items: mergedSetup.items.filter(item => item.kind === 'app' || !oldItems.has(machineSetupItemKeyV1(item))) } : {}),
    scripts: sources.flatMap(source => source.scripts ?? []),
  } };
}

export type MachineSetupDetachedItemV1 = Readonly<{
  itemKey: string; item: SetupItem; initialPresence: FirstPresence | 'unknown'; selected: boolean;
}>;
/** Preset detachment defaults to Keep in direct. Direct removal forgets desired intent; native Remove needs first-absent evidence. */
export function reviewMachineSetupSourceChangeV1(input: Readonly<{
  currentSources: MachineSetupSourceV1; currentSourceFacts?: MachineSetupSourceFactsMapV1;
  proposedSources: MachineSetupSourceV1; removeItemKeys?: readonly string[];
}>): Readonly<{ ok: true; sources: MachineSetupSourceV1; detached: readonly MachineSetupDetachedItemV1[] }>
  | Readonly<{ ok: false; errorCode: 'plan_changed' | 'remove_unsupported'; error: string }> {
  const proposed = new Set(input.proposedSources.flatMap(source => (source.setup.items ?? [])
    .flatMap(item => item.kind === 'app' ? [] : [readMachineSetupRecipeIdentityV1(item.selection.ref)])));
  const selected = new Set(input.removeItemKeys ?? []);
  if (selected.size !== (input.removeItemKeys ?? []).length) return { ok: false, errorCode: 'plan_changed', error: 'plan_changed' };
  const seen = new Set<string>();
  const detachedFromPreset = new Set<string>();
  const firstPresentByKey = readMachineSetupFirstPresentV1(input.currentSources, input.currentSourceFacts);
  const detached: MachineSetupDetachedItemV1[] = [];
  for (const source of input.currentSources) for (const item of source.setup.items ?? []) {
    if (item.kind === 'app') continue;
    const itemKey = machineSetupItemKeyV1(item);
    const carriedToDirect = source.kind !== 'direct' && input.proposedSources.some(copy => copy.kind === 'direct'
      && copy.setup.items?.some(candidate => candidate.kind !== 'app' && machineSetupItemKeyV1(candidate) === itemKey))
      && !input.proposedSources.some(copy => copy.kind !== 'direct'
        && copy.setup.items?.some(candidate => candidate.kind !== 'app'
          && readMachineSetupRecipeIdentityV1(candidate.selection.ref) === readMachineSetupRecipeIdentityV1(item.selection.ref)));
    if (proposed.has(readMachineSetupRecipeIdentityV1(item.selection.ref)) && !carriedToDirect) continue;
    if (source.kind !== 'direct') detachedFromPreset.add(itemKey);
    if (seen.has(itemKey)) continue;
    seen.add(itemKey);
    const first = firstPresentByKey.get(itemKey);
    if (selected.has(itemKey) && first !== 'absent') return { ok: false, errorCode: 'remove_unsupported', error: 'remove_unsupported' };
    detached.push({ itemKey, item, initialPresence: first ?? 'unknown', selected: selected.has(itemKey) });
  }
  if ([...selected].some(key => !seen.has(key))) return { ok: false, errorCode: 'plan_changed', error: 'plan_changed' };
  const kept = detached.filter(item => !item.selected && detachedFromPreset.has(item.itemKey));
  if (!kept.length) return { ok: true, sources: input.proposedSources, detached };
  const sources = input.proposedSources.map(source => {
    if (source.kind !== 'direct') return source;
    const carried = new Set((source.setup.items ?? []).flatMap(item => item.kind === 'app' ? [] : [machineSetupItemKeyV1(item)]));
    return { ...source, setup: { ...source.setup,
      items: [...source.setup.items ?? [], ...kept.filter(entry => !carried.has(entry.itemKey)).map(entry => entry.item)] } };
  });
  return { ok: true, sources, detached };
}

/** A root creation continuation delegates only its admitted setup snapshot. */
export function matchesMachineSetupCreationSourcesV1(sources: MachineSetupSourceV1,
  admitted: Readonly<{ preset: { id: string; revision: number; contentEncryptionMode: 'plain' | 'e2ee' }; setup: MachineSetupV1 }>): boolean {
  return sources.length === 2 && sources.some(source => source.kind === 'accountPreset')
    && sources.some(source => source.kind === 'direct') && sources.every(source => source.kind === 'accountPreset'
      ? sameStrictJsonValue(source, { kind: 'accountPreset', presetId: admitted.preset.id,
        presetRevision: admitted.preset.revision, contentEncryptionMode: admitted.preset.contentEncryptionMode,
        setup: admitted.setup })
      : source.kind === 'direct' && sameStrictJsonValue(source,
        { kind: 'direct', setup: {} }));
}
const accountPresetReference = lazyZodSchema(() => z.strictObject({
  kind: z.literal('accountPreset'), presetId: id(), presetRevision: revision(),
}));
const accountPresetSource = lazyZodSchema(() => z.extend(accountPresetReference, {
  contentEncryptionMode: AccountEncryptionModeSchema,
  presetContentOverride: z.optional(ManagedMachinePresetLaunchNameOverrideV1Schema),
}));
const accountPresetCopy = lazyZodSchema(() => z.extend(accountPresetSource, { setup: MachineSetupV1Schema }));
const bundledPresetReference = lazyZodSchema(() => z.strictObject({
  kind: z.literal('bundledPreset'), ref: z.strictObject({
    pluginId: MachineRecipeReferenceV1Schema.shape.pluginId,
    localId: MachineRecipeReferenceV1Schema.shape.recipeId,
    revision: z.string().check(z.trim(), z.minLength(1)),
  }),
}));
/** Compact attachment identity shared by source copies and public observations. */
export const MachineSetupPresetReferenceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  accountPresetReference, bundledPresetReference,
]));
export type MachineSetupPresetReferenceV1 = z.infer<typeof MachineSetupPresetReferenceV1Schema>;

export const MachineSetupSourceEntryV1Schema: z.ZodMiniType<MachineSetupSourceEntryV1> = defineStoredReadProjection<z.ZodMiniType<MachineSetupSourceEntryV1>>(
  lazyZodSchema(() => z.discriminatedUnion('kind', [
    accountPresetCopy,
    z.extend(bundledPresetReference, { setup: MachineSetupV1Schema }),
    z.strictObject({ kind: z.literal('direct'), setup: MachineSetupV1Schema }),
  ])),
  () => z.union([
    createStoredReadSchema(accountPresetCopy),
    createStoredReadSchema(z.extend(accountPresetReference, {
      setup: MachineSetupV1Schema,
      // Known malformed current fields must not fall through to the legacy branch.
      contentEncryptionMode: z.optional(z.never()),
      presetContentOverride: z.optional(z.never()),
    })),
    createStoredReadSchema(MachineSetupNonAccountPresetSourceEntryV1Schema),
  ]),
);
/** Saved Account Presets are local opened copies. They are never an Action/Home wire operand. */
export type MachineSetupNonAccountPresetSourceEntryV1 = Exclude<MachineSetupSourceEntryV1, { kind: 'accountPreset' }>;
export const MachineSetupNonAccountPresetSourceEntryV1Schema: z.ZodMiniType<MachineSetupNonAccountPresetSourceEntryV1> = lazyZodSchema(() => {
  const copy = { setup: MachineSetupV1Schema };
  return z.discriminatedUnion('kind', [
    z.extend(bundledPresetReference, copy),
    z.strictObject({ kind: z.literal('direct'), ...copy }),
  ]);
});
/** A saved encrypted preset crosses Home by address only; its setup stays with the keyholding target. */
export const MachineSetupOpaquePresetSourceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('accountPresetOpaque'), presetId: id(), presetRevision: z.int().check(z.gte(0)),
  /** Persisted author mode, verified by the server against the saved Preset. */
  contentEncryptionMode: AccountEncryptionModeSchema,
  /** Optional keyholder-sealed setup edit for this exact preset snapshot. */
  presetContentOverride: z.optional(ManagedMachinePresetLaunchNameOverrideV1Schema),
}));
export type MachineSetupOpaquePresetSourceV1 = z.infer<typeof MachineSetupOpaquePresetSourceV1Schema>;

/** Input sources are carried through Actions. Only the daemon's local source model carries preset setup bytes. */
export const MachineSetupSourceApplyEntryV1Schema = lazyZodSchema(() => z.union([
  MachineSetupNonAccountPresetSourceEntryV1Schema,
  MachineSetupOpaquePresetSourceV1Schema,
]));
export type MachineSetupSourceApplyEntryV1 = z.infer<typeof MachineSetupSourceApplyEntryV1Schema>;
/** Canonical Action-wire identity for a setup source, including opaque saved presets. */
export function machineSetupSourceApplyOriginKeyV1(source: MachineSetupSourceApplyEntryV1): string {
  return source.kind === 'accountPresetOpaque' ? `account:${source.presetId}` : machineSetupSourceOriginKeyV1(source);
}
export const MachineSetupSourceApplyV1Schema = lazyZodSchema(() => z.array(MachineSetupSourceApplyEntryV1Schema).check(
  z.refine(sources => sources.filter(source => source.kind === 'direct').length === 1,
    { message: 'Setup has exactly one implicit direct source.' }),
  z.refine(sources => new Set(sources.map(machineSetupSourceApplyOriginKeyV1)).size === sources.length,
    { message: 'Each setup source is attached once.' }),
));
export type MachineSetupSourceApplyV1 = z.infer<typeof MachineSetupSourceApplyV1Schema>;

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
export function isMachineSetupRecipeExcludedV1(ref: MachineRecipeReferenceV1, exclusions: readonly MachineSetupExclusionV1[]): boolean {
  return exclusions.some(entry => sameStrictJsonValue(entry.ref, ref));
}
export function areMachineSetupExclusionsBoundV1(setups: readonly MachineSetupV1[], exclusions: readonly MachineSetupExclusionV1[]): boolean {
  return MachineSetupExclusionsV1Schema.safeParse(exclusions).success && exclusions.every(exclusion => setups.some(setup =>
    setup.items?.some(item => item.kind !== 'app' && sameStrictJsonValue(item.selection.ref, exclusion.ref))));
}
export type MachineSetupDesiredV1 = Readonly<{
  version: 1; revision: number; sources: MachineSetupSourceV1;
  exclusions: Array<z.infer<typeof MachineSetupExclusionV1Schema>>;
  sourceFacts?: MachineSetupSourceFactsMapV1;
  /** Original opened request retained only for exact retry of unfinished scripts. */
  pendingScriptSources?: MachineSetupSourceV1;
}>;
export const MachineSetupDesiredV1Schema: z.ZodMiniType<MachineSetupDesiredV1> = lazyZodSchema(() => z.strictObject({
  version: z.literal(1), revision: revision(), sources: MachineSetupSourceV1Schema, exclusions: z.array(MachineSetupExclusionV1Schema),
  sourceFacts: z.optional(MachineSetupSourceFactsMapV1Schema),
  pendingScriptSources: z.optional(MachineSetupSourceV1Schema),
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
  pendingScriptSources?: MachineSetupSourceV1;
}>, port: MachineMetadataFieldPortV1, options?: Readonly<{ signal?: AbortSignal }>) {
  const current = await getMachineSetupDesiredV1(port);
  if (current.status !== 'ready') return current;
  if (current.policy.revision !== input.expectedDesiredRevision) return { status: 'conflict' as const,
    policy: current.policy, metadataVersion: current.metadataVersion };
  const sourceFacts = mergeMachineSetupSourceFacts(current.policy, input.sources, input.observedSourceFacts);
  const candidate = MachineSetupDesiredV1Schema.safeParse({ version: 1, revision: current.policy.revision,
    sources: input.sources, exclusions: input.exclusions, ...(sourceFacts ? { sourceFacts } : {}),
    ...(input.pendingScriptSources && Object.values(sourceFacts ?? {}).some(facts => facts.pendingScripts?.length)
      ? { pendingScriptSources: input.pendingScriptSources } : {}),
  });
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
  const recovering = Object.values(current.sourceFacts ?? {}).some(facts => facts.pendingScripts?.length);
  let execution: MachineSetupV1[] | undefined;
  for (const [sourceIndex, source] of sources.entries()) {
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
    let pendingScripts = observed[origin]?.pendingScripts;
    if (pendingScripts === undefined && recovering) {
      execution ??= projectMachineSetupScriptExecution(current.sources, sources, current.sourceFacts, false);
      pendingScripts = execution[sourceIndex]?.scripts?.flatMap((script, index) => script.body ? [index] : []);
    }
    if (Object.keys(firstPresence).length || acceptedAppRuns.length || pendingScripts?.length) facts[origin] = {
      ...(Object.keys(firstPresence).length ? { firstPresence } : {}),
      ...(acceptedAppRuns.length ? { acceptedAppRuns } : {}),
      ...(pendingScripts?.length ? { pendingScripts } : {}),
    };
  }
  return Object.keys(facts).length ? facts : undefined;
}
