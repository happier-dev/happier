import { evaluateInputPredicate } from '@happier-dev/protocol/inputs';
import { MachineRecipeTargetFactUnavailableErrorV1, resolveMachineRecipeStepInputsV1, type MachineRecipeV1, type MachineRecipeCheckV1, type MachineRecipeStepV1, type MachineRecipeTargetFactsV1, type MachineRecipeSelectionV1, type MachineSetupStepObservationV1, type MachineSetupEffectPlanV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { createMachineSetupEffectPlan, isMachineSetupPackageUnavailableV1,
  isMachineSetupPackageManagerUnavailableV1, type MachineSetupBackend } from '@happier-dev/cli-common/machineSetup';

/** Setup and declared removal share declaration expansion and native observation. */
export async function prepareMachineRecipeProgramV1(input: Readonly<{
  machineId: string; desiredRevision: number;
  recipe: MachineRecipeV1; program: 'steps' | 'removeSteps';
  backend: Pick<MachineSetupBackend, 'observe'>;
  readTargetFacts?: () => Promise<MachineRecipeTargetFactsV1>;
  signal?: AbortSignal;
}> & (Readonly<{ selection: MachineRecipeSelectionV1; inputs?: never }>
  | Readonly<{ selection?: never; inputs: unknown }>)): Promise<MachineSetupEffectPlanV1 | undefined> {
  const recipeInputs = input.selection === undefined ? input.inputs : input.selection.inputs;
  const declarations = input.recipe[input.program];
  if (declarations === undefined) return undefined;
  const invalidInputs = () => Object.assign(new Error('invalid_machine_recipe_inputs'), { code: 'invalid_machine_recipe_inputs' });
  const checksById = new Map<string, MachineRecipeCheckV1>();
  const factsByCheck = new Map<string, MachineSetupStepObservationV1>();
  const selectedCheckIds = new Set<string>();
  const steps: MachineRecipeStepV1[] = [];
  let targetFacts: MachineRecipeTargetFactsV1 | undefined;
  const resolve = async (declaration: NonNullable<typeof declarations>[number] | NonNullable<MachineRecipeV1['checks']>[number]) => {
    input.signal?.throwIfAborted();
    const resolveCurrent = () => {
      try {
        return declaration.kind === 'kernel'
          ? resolveMachineRecipeStepInputsV1(declaration, recipeInputs, targetFacts)
          : resolveMachineRecipeStepInputsV1(declaration, recipeInputs, targetFacts);
      } catch (error) {
        if (error instanceof MachineRecipeTargetFactUnavailableErrorV1) throw error;
        throw invalidInputs();
      }
    };
    try { return resolveCurrent(); }
    catch (error) {
      if (!(error instanceof MachineRecipeTargetFactUnavailableErrorV1) || targetFacts !== undefined) throw error;
      targetFacts = await input.readTargetFacts?.();
      input.signal?.throwIfAborted();
      return resolveCurrent();
    }
  };
  for (const declaration of declarations) {
    let matches = true;
    const branchChecks = new Set<string>();
    for (const condition of declaration.when ?? []) {
      if ('input' in condition) {
        if (!evaluateInputPredicate(condition.input, recipeInputs)) { matches = false; break; }
        continue;
      }
      if (condition.ifInput && !evaluateInputPredicate(condition.ifInput, recipeInputs)) continue;
      let check = checksById.get(condition.checkId);
      if (!check) {
        const authored = input.recipe.checks?.find(candidate => candidate.id === condition.checkId);
        if (!authored) throw invalidInputs();
        const resolved = await resolve(authored);
        if (resolved.kind !== 'command' && resolved.kind !== 'package' && resolved.kind !== 'kernel') throw invalidInputs();
        check = resolved;
        checksById.set(check.id, check);
      }
      let fact = factsByCheck.get(check.id);
      if (!fact) {
        fact = await input.backend.observe(check);
        input.signal?.throwIfAborted();
        factsByCheck.set(check.id, fact);
      }
      branchChecks.add(check.id);
      const status = isMachineSetupPackageUnavailableV1(check, fact) ? 'packageUnavailable'
        : isMachineSetupPackageManagerUnavailableV1(check, fact) ? 'packageManagerUnavailable' : fact.status;
      if (!condition.status.some(expected => expected === status)) { matches = false; break; }
    }
    if (!matches) continue;
    const step = await resolve(declaration);
    if (step.kind === 'kernel') throw invalidInputs();
    steps.push(step);
    for (const checkId of branchChecks) selectedCheckIds.add(checkId);
  }
  const checks = (input.recipe.checks ?? []).flatMap(check => {
    const resolved = checksById.get(check.id);
    return resolved ? [resolved] : [];
  });
  const nativeFacts: MachineSetupStepObservationV1[] = [];
  for (const step of steps) {
    input.signal?.throwIfAborted();
    nativeFacts.push(await input.backend.observe(step));
  }
  input.signal?.throwIfAborted();
  return createMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: input.machineId,
    desiredRevision: input.desiredRevision, ...(input.selection === undefined ? {} : { selection: input.selection }) }, steps, nativeFacts,
    ...(checks.length ? { checks, checkFacts: checks.map(check => factsByCheck.get(check.id)!),
      selectedCheckIds: checks.filter(check => selectedCheckIds.has(check.id)).map(check => check.id) } : {}) });
}
