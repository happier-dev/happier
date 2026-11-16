import { evaluateInputPredicate } from '@happier-dev/protocol/inputs';
import {
  MachineRecipeTargetFactUnavailableErrorV1, resolveMachineRecipeStepInputsV1, isMachineRecipeImageTargetFactV1,
  resolveMachineRecipeCredentialSelectionV1,
  type MachineRecipeV1, type MachineRecipeCheckV1, type MachineRecipeStepV1,
  type MachineRecipeTargetFactsV1, type MachineRecipeSelectionV1, type MachineSetupStepObservationV1,
  type MachineSetupEffectPlanV1, type MachineSetupPreparationBasisV1, type MachineSetupBoundTargetBasisV1,
} from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { createMachineSetupEffectPlan, isMachineSetupPackageUnavailableV1,
  isMachineSetupPackageManagerUnavailableV1, type MachineSetupBackend } from '@happier-dev/cli-common/machineSetup';
import type { AccessProviderSelectionV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { machineConnectorCredentialFilePath as credentialFilePath } from '@happier-dev/cli-common/machineSetup/credentialFile';

/** Setup and declared removal share declaration expansion and native observation. */
export async function prepareMachineRecipeProgramV1(input: Readonly<{
  installationId?: string;
  onCredentialSelection?: (selection: AccessProviderSelectionV1) => void;
  recipe: MachineRecipeV1; program: 'steps' | 'removeSteps';
  backend: Pick<MachineSetupBackend, 'observe' | 'readTargetFacts'>;
  readTargetFacts?: () => Promise<MachineRecipeTargetFactsV1>;
  signal?: AbortSignal;
}> & (Readonly<{ basis: MachineSetupPreparationBasisV1 | MachineSetupBoundTargetBasisV1; machineId?: never; desiredRevision?: never }>
  | Readonly<{ basis?: never; machineId: string; desiredRevision: number }>)
  & (Readonly<{ selection: MachineRecipeSelectionV1; inputs?: never }>
  | Readonly<{ selection?: never; inputs: unknown }>)): Promise<MachineSetupEffectPlanV1 | undefined> {
  const recipeInputs = input.selection === undefined ? input.inputs : input.selection.inputs;
  const declarations = input.recipe[input.program];
  if (declarations === undefined) return undefined;
  const invalidInputs = () => Object.assign(new Error('invalid_machine_recipe_inputs'), { code: 'invalid_machine_recipe_inputs' });
  const checksById = new Map<string, MachineRecipeCheckV1>();
  const factsByCheck = new Map<string, MachineSetupStepObservationV1>();
  const selectedCheckIds = new Set<string>();
  const steps: MachineRecipeStepV1[] = [];
  let targetFacts: MachineRecipeTargetFactsV1 | undefined = input.installationId
    ? { 'invocation.credentialFile': credentialFilePath(input.installationId) } : undefined;
  let daemonFactsRead = false;
  const resolve = async (declaration: NonNullable<typeof declarations>[number] | NonNullable<MachineRecipeV1['checks']>[number]) => {
    input.signal?.throwIfAborted();
    const credentialSelection = (() => {
      if (declaration.kind !== 'file' || declaration.content?.kind !== 'secretGrant'
        || !('credentialSelection' in declaration.content)) return undefined;
      try { return resolveMachineRecipeCredentialSelectionV1(declaration.content, recipeInputs); }
      catch { throw invalidInputs(); }
    })();
    if (credentialSelection && (!input.installationId || !input.machineId)) throw new MachineRecipeTargetFactUnavailableErrorV1('invocation.credentialFile');
    // Image preparation loads only the declaration compiler. Account/grant
    // services remain outside that graph unless an online recipe selects one.
    const credentialGrant = credentialSelection ? await (async () => {
      const [{ machineSecretGrantSubjectKey }, { reachabilityConnectorSubject }] = await Promise.all([
        import('@happier-dev/deployment-protocol'), import('../reachability/prepareReachabilityJoinCredential'),
      ]);
      return machineSecretGrantSubjectKey(reachabilityConnectorSubject(credentialSelection,
        { machineId: input.machineId!, installationId: input.installationId! }));
    })() : undefined;
    const resolvedDeclaration = credentialSelection && declaration.kind === 'file'
      ? { ...declaration, content: { kind: 'secretGrant' as const, grantRef: credentialGrant! } }
      : declaration;
    const resolveCurrent = () => {
      try {
        return resolvedDeclaration.kind === 'kernel'
          ? resolveMachineRecipeStepInputsV1(resolvedDeclaration, recipeInputs, targetFacts)
          : resolveMachineRecipeStepInputsV1(resolvedDeclaration, recipeInputs, targetFacts);
      } catch (error) {
        if (error instanceof MachineRecipeTargetFactUnavailableErrorV1) throw error;
        throw invalidInputs();
      }
    };
    for (;;) {
      try {
        const resolved = resolveCurrent();
        if (credentialSelection) input.onCredentialSelection?.(credentialSelection);
        return resolved;
      }
      catch (error) {
        if (!(error instanceof MachineRecipeTargetFactUnavailableErrorV1) || !error.fact
          || targetFacts && error.fact in targetFacts) throw error;
        let acquired: MachineRecipeTargetFactsV1 | undefined;
        if (isMachineRecipeImageTargetFactV1(error.fact)) acquired = await input.backend.readTargetFacts?.([error.fact]);
        else if (!daemonFactsRead) {
          daemonFactsRead = true;
          acquired = await input.readTargetFacts?.();
        }
        if (!acquired || !(error.fact in acquired)) throw error;
        targetFacts = { ...targetFacts, ...acquired };
        input.signal?.throwIfAborted();
      }
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
  return createMachineSetupEffectPlan({ basis: input.basis ?? { kind: 'setup', machineId: input.machineId,
    desiredRevision: input.desiredRevision, ...(input.selection === undefined ? {} : { selection: input.selection }) }, steps, nativeFacts,
    ...(checks.length ? { checks, checkFacts: checks.map(check => factsByCheck.get(check.id)!),
      selectedCheckIds: checks.filter(check => selectedCheckIds.has(check.id)).map(check => check.id) } : {}) });
}
