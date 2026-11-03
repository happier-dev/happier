import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import type { PluginProjectedMachineRecipeEntryV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { machineRecipeInputConstraintsSatisfiedV1, type MachineRecipeTargetFactsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { isMachineSetupRecipeExcludedV1, type MachineSetupDetachedItemV1,
  type MachineSetupExclusionV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import type { MachineSetupRemovalOfferV1, MachineSetupRemovalPlanV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { findMachineSetupBlockingObservationV1, machineSetupPlansRequireAdministratorV1, type MachineSetupBackend } from '@happier-dev/cli-common/machineSetup';
import { prepareMachineRecipeProgramV1 } from './prepareMachineRecipeProgram';

/** The source-change owner reads first-presence from the Machine's sibling source facts. */
export async function prepareMachineSetupRemovalsV1(input: Readonly<{
  machineId: string; desiredRevision: number;
  detached: readonly MachineSetupDetachedItemV1[];
  exclusions?: readonly MachineSetupExclusionV1[];
  recipes: readonly PluginProjectedMachineRecipeEntryV1[];
  backend: Pick<MachineSetupBackend, 'observe'>;
  readTargetFacts?: () => Promise<MachineRecipeTargetFactsV1>;
  signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true; removalOffers: readonly MachineSetupRemovalOfferV1[]; removalPlans: readonly MachineSetupRemovalPlanV1[] }>
  | Readonly<{ ok: false; errorCode: 'remove_unsupported'; error: 'remove_unsupported' }>> {
  const removalOffers: MachineSetupRemovalOfferV1[] = [];
  const removalPlans: MachineSetupRemovalPlanV1[] = [];
  const recipes = new Map(input.recipes.map(entry => [JSON.stringify([
    entry.pluginId, entry.definition.id, entry.definition.revision,
  ]), entry.definition]));
  for (const detached of input.detached) {
    input.signal?.throwIfAborted();
    const excludedUnselected = !detached.selected
      && isMachineSetupRecipeExcludedV1(detached.item.selection.ref, input.exclusions ?? []);
    const reason: Extract<MachineSetupRemovalOfferV1, { status: 'notEligible' }>['reason'] = detached.initialPresence === 'present' ? 'preExisting'
      : detached.initialPresence === 'unknown' ? 'unknownOrigin' : excludedUnselected ? 'needsCheck' : 'unsupported';
    let eligible = false;
    let plan: MachineSetupRemovalPlanV1['plan'] | undefined;
    if (detached.initialPresence === 'absent' && !excludedUnselected) {
      const { ref, inputs } = detached.item.selection;
      const recipe = recipes.get(JSON.stringify([ref.pluginId, ref.recipeId, ref.revision]));
      if (recipe && (detached.item.kind !== 'softwareRecipe' || recipe.software === true)
        && isValidPluginJsonSchemaValue(compilePluginJsonSchema(recipe.inputSchema), inputs)
        && machineRecipeInputConstraintsSatisfiedV1(recipe, inputs)) {
        plan = await prepareMachineRecipeProgramV1({ machineId: input.machineId,
          desiredRevision: input.desiredRevision, selection: detached.item.selection,
          recipe, program: 'removeSteps', backend: input.backend,
          ...(input.readTargetFacts ? { readTargetFacts: input.readTargetFacts } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (plan) {
          const blocked = findMachineSetupBlockingObservationV1(plan);
          // The admitted root interpreter checks administrator-only facts before
          // mutation. An unprivileged preview cannot decide those facts for it.
          eligible = !blocked || blocked.status === 'unavailable' && blocked.reason === 'needs_admin_to_check'
            && machineSetupPlansRequireAdministratorV1([plan]);
        }
      }
    }
    input.signal?.throwIfAborted();
    if (detached.selected && !eligible) return { ok: false,
      errorCode: 'remove_unsupported', error: 'remove_unsupported' };
    removalOffers.push(eligible
      ? { itemKey: detached.itemKey, item: detached.item, status: 'eligible', selected: detached.selected }
      : { itemKey: detached.itemKey, item: detached.item, status: 'notEligible', selected: false, reason });
    if (detached.selected && plan) removalPlans.push({ itemKey: detached.itemKey, plan });
  }
  return { ok: true, removalOffers, removalPlans };
}
