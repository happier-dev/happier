import type { ActionExecuteFailure } from '../actions/actionExecutionResult.js';
import type { ActionId } from '../actions/actionIds.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../actions/executor/types.js';
import { actionInputIssueFailure } from '../actions/executor/actionInputValidation.js';
import type { PluginProjectedMachineRecipeEntryV1 } from '../daemon/contributionRegistryProjection.js';
import type { JsonValue } from '../json/strictJsonValue.js';
import { MachineRecipeReferenceV1Schema, type MachineRecipeReferenceV1 } from '../machines/setup/machineRecipeV1.js';
import { buildQualifiedPluginContributionKey } from '../plugins/contributionIdentity.js';
import { z } from 'zod/mini';
import { MachineSetupToolchainSoftwareChoiceV1Schema,
  projectMachineSetupToolchainSoftwareOptionsV1 } from '../plugins/contributions/projectNativeAdapters.js';
import type { InputOption } from './inputFields.js';
import { readNonEmptyString } from './inputRecords.js';
import { readInputPath } from './inputPredicates.js';

export const MachineSetupSoftwareChoiceV1Schema = z.union([
  MachineRecipeReferenceV1Schema, MachineSetupToolchainSoftwareChoiceV1Schema,
]);
export type MachineSetupSoftwareChoiceV1 = z.infer<typeof MachineSetupSoftwareChoiceV1Schema>;

/** The same declaration family serves recipe presentation, Software browsing and reviewed target selections. */
export async function resolveMachineSetupSoftwareOptions(params: Readonly<{
  deps: Pick<ActionExecutorDeps, 'machineRecipesRead'>;
  ctx: ActionExecutorContext;
  actionId: ActionId | null;
  input: Readonly<Record<string, unknown>>;
  softwareOnly: boolean;
  values?: readonly JsonValue[];
}>): Promise<ActionExecuteFailure | Readonly<{
  ok: true;
  result: readonly InputOption[];
  machineRecipeDetails?: readonly PluginProjectedMachineRecipeEntryV1[];
}>> {
  const { deps, ctx, input } = params;
  const fieldPath = readNonEmptyString(input.fieldPath);
  const recipeField = params.actionId === 'machines.setup.plan' && fieldPath === 'sources.0.setup.items.0.selection.ref'
    || params.actionId === 'machines.setup.apply' && fieldPath === 'targets.0.sources.0.setup.items.0.selection.ref';
  let recipeRefs: MachineRecipeReferenceV1[] | undefined;
  let pickedToolchain = false;
  if (params.values !== undefined) {
    recipeRefs = [];
    for (const [index, value] of params.values.entries()) {
      const parsed = (recipeField || !params.softwareOnly ? MachineRecipeReferenceV1Schema : MachineSetupSoftwareChoiceV1Schema).safeParse(value);
      if (!parsed.success) return actionInputIssueFailure({ code: 'invalid_selection', path: ['values', index] });
      if ('kind' in parsed.data) pickedToolchain = true;
      else recipeRefs.push(parsed.data);
    }
  }
  // These are reviewed operands, not the caller's default Home or Machine.
  const targetPath = recipeField && params.actionId === 'machines.setup.apply' ? 'targets.0.' : '';
  const homeId = readNonEmptyString(readInputPath(input, `${targetPath}homeId`));
  const machineId = readNonEmptyString(readInputPath(input, `${targetPath}machineId`));
  const offerings = !recipeField && !homeId && !machineId;
  if (!offerings && (!homeId || !machineId)) return { ok: false, errorCode: 'missing_option_dependency', error: 'missing_option_dependency',
    details: { requiredDraftPath: `${targetPath}${homeId ? 'machineId' : 'homeId'}` } };
  const unavailable = { ok: false as const, errorCode: 'unavailable', error: 'unavailable' };
  if (!deps.machineRecipesRead) return unavailable;
  const catalog = await deps.machineRecipesRead({ ...(offerings ? { offerings: true as const } : { homeId: homeId!, machineId: machineId! }),
    ...(recipeRefs === undefined ? {} : { recipeRefs }) }, ctx);
  if ('ok' in catalog) return catalog;
  ctx.signal?.throwIfAborted();
  // Direct software discovery includes native configuration entries; a recipe-ref
  // field cannot accept them. Never substitute the caller's OS for target facts.
  const includeToolchains = params.softwareOnly && !recipeField && (params.values === undefined || pickedToolchain);
  if (!offerings && includeToolchains && (!catalog.target || pickedToolchain && !readNonEmptyString(catalog.target.arch))) return unavailable;
  const toolchains = includeToolchains
    ? projectMachineSetupToolchainSoftwareOptionsV1(offerings ? undefined : catalog.target) : [];
  const available = catalog.entries.filter(entry => !params.softwareOnly || entry.definition.software === true);
  let chosen = available;
  if (recipeRefs !== undefined) {
    const byId = new Map(available.map(entry => [entry.id, entry]));
    chosen = [];
    for (const ref of recipeRefs) {
      const entry = byId.get(buildQualifiedPluginContributionKey({ pluginId: ref.pluginId, localId: ref.recipeId }));
      if (!entry || entry.definition.revision !== ref.revision) return unavailable;
      chosen.push(entry);
    }
  }
  return { ok: true, result: [...chosen.map(entry => ({
    value: { pluginId: entry.pluginId, recipeId: entry.definition.id, revision: entry.definition.revision },
    label: typeof entry.definition.title === 'string' ? entry.definition.title : entry.definition.title.fallback,
    version: entry.pluginVersion,
    ...(entry.definition.icon ? { icon: entry.definition.icon } : {}),
    ...(entry.source ? { source: entry.source } : {}),
    ...(entry.brand ? { brand: entry.brand } : {}),
    ...(entry.definition.description ? { description: typeof entry.definition.description === 'string'
      ? entry.definition.description : entry.definition.description.fallback } : {}),
  })), ...toolchains], ...(!params.softwareOnly || offerings || recipeRefs === undefined || recipeRefs.length === 0 ? {} : { machineRecipeDetails: chosen }) };
}
