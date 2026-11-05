import { MachineSetupPlanInputV1Schema, MachineSetupPlanResultV1Schema, MachineSetupObservationReasonV1Schema, machineSetupSourceOriginKeyV1, machineSetupItemKeyV1, reviewMachineSetupSourceChangeV1, projectMachineSetupSourceChangeExecutionV1, areMachineSetupExclusionsBoundV1, isMachineSetupRecipeExcludedV1, mergeMachineSetupsV1, type MachineSetupPlanInputV1, type MachineSetupPlanResultV1, type MachineSetupV1, type getMachineSetupDesiredV1 } from '@happier-dev/protocol';
import { readMachineSetupAppOriginsV1, selectMachineSetupRecipeItemsV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import type { PluginProjectedMachineRecipeEntryV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { machineRecipeInputConstraintsSatisfiedV1,
  MachineRecipeTargetFactUnavailableErrorV1, type MachineRecipeTargetFactsV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { MachineAdminAccessObservationV1 } from '@happier-dev/protocol/machines/adminAccessV1';
import { createMachineSetupNativeBackend, createMachineSetupEffectPlan, buildUserManagerGroupRefreshStep, findMachineSetupBlockingObservationV1, machineSetupPlansRequireAdministratorV1, machineSetupStepChangesDaemonGroupsV1,
  type MachineSetupNativeCommand, type MachineSetupNativeCommandResult } from '@happier-dev/cli-common/machineSetup';
import { readMachineSetupStepImpact } from './machineSetupImpacts';
import { prepareMachineRecipeProgramV1 } from './prepareMachineRecipeProgram';
import { prepareMachineSetupRemovalsV1 } from './prepareMachineSetupRemovals';
import { readMachineSetupSessionRefreshRequirement, type DaemonGroupRefreshNative } from '@/daemon/service/userManagerGroups';
import { userInfo } from 'node:os';

/** Saved-copy reads stay inert; newly selected declarations use the native observer. */
export async function prepareMachineSetupPlanV1(params: Readonly<{
  input: MachineSetupPlanInputV1;
  current: Awaited<ReturnType<typeof getMachineSetupDesiredV1>>;
  /** Receiving Apply reuses its prepared changed operands. */
  executionSources?: readonly MachineSetupV1[];
  readRecipes?: () => Promise<readonly PluginProjectedMachineRecipeEntryV1[] | undefined>;
  readAdminAccessObservation?: () => Promise<MachineAdminAccessObservationV1>;
  signal?: AbortSignal;
  runNative?: (command: MachineSetupNativeCommand) => Promise<MachineSetupNativeCommandResult>;
  groupRefreshNative?: DaemonGroupRefreshNative;
}>): Promise<MachineSetupPlanResultV1 | ActionExecuteFailure> {
  const fail = (code: string): ActionExecuteFailure => ({ ok: false, errorCode: code, error: code });
  const input = MachineSetupPlanInputV1Schema.parse(params.input);
  const current = params.current;
  if (current.status !== 'ready') return { ok: false, errorCode: `machine_setup_content_${current.status}`,
    error: `machine_setup_content_${current.status}` };
  const change = input.sources !== undefined || input.removeItemKeys !== undefined
    ? reviewMachineSetupSourceChangeV1({ currentSources: current.policy.sources, currentSourceFacts: current.policy.sourceFacts,
      proposedSources: input.sources ?? current.policy.sources,
      ...(input.removeItemKeys === undefined ? {} : { removeItemKeys: input.removeItemKeys }) }) : undefined;
  if (change && !change.ok) return change;
  const sources = change?.sources ?? current.policy.sources;
  const exclusions = input.exclusions ?? current.policy.exclusions;
  const reviewing = input.sources !== undefined || input.exclusions !== undefined || input.mode !== undefined
    || input.removeItemKeys !== undefined;
  if (reviewing && !areMachineSetupExclusionsBoundV1(sources.map(source => source.setup), exclusions)) return fail('invalid_parameters');
  let executionSources: readonly MachineSetupV1[] | undefined;
  if (reviewing) {
    const merged = mergeMachineSetupsV1(sources.map(source => source.setup));
    if (!merged.ok) return merged;
    if (input.removeItemKeys !== undefined) {
      if (params.executionSources) executionSources = params.executionSources;
      else {
        const execution = projectMachineSetupSourceChangeExecutionV1(current.policy.sources, sources,
          merged.setup, current.policy.exclusions);
        if (!execution.ok) return execution;
        executionSources = execution.sources;
      }
    }
  }
  // Retention belongs to an exact item in the same canonical source identity,
  // not the whole source. Adding B must not recertify a retained unavailable A.
  const savedByOrigin = input.sources !== undefined || input.removeItemKeys !== undefined
    ? new Map(current.policy.sources.map(source => [machineSetupSourceOriginKeyV1(source),
      new Set((source.setup.items ?? []).flatMap(item => item.kind === 'app' ? [] : [machineSetupItemKeyV1(item)]))])) : undefined;
  const defaultKept = new Set(change?.detached.filter(entry => !entry.selected).map(entry => entry.itemKey));
  const recipeItems = selectMachineSetupRecipeItemsV1(sources.map(source => source.setup), exclusions, executionSources);
  const proposed = (input.mode !== undefined || input.sources !== undefined ? recipeItems : []).map(entry => {
    const source = sources[entry.sourceIndex]!;
    const key = machineSetupItemKeyV1(entry.item);
    return { ...entry, retained: !isMachineSetupRecipeExcludedV1(entry.item.selection.ref, current.policy.exclusions)
      && (savedByOrigin?.get(machineSetupSourceOriginKeyV1(source))?.has(key) === true
        || source.kind === 'direct' && defaultKept.has(key)) };
  });
  const selected = proposed.filter(entry => !entry.retained || input.mode !== undefined && entry.execute);
  const executing = new Set(recipeItems.filter(entry => entry.execute).map(entry => `${entry.sourceIndex}:${entry.itemIndex}`));
  const support: MachineSetupPlanResultV1['support'] = sources.flatMap((source, sourceIndex) =>
    (source.setup.items ?? []).flatMap((item, itemIndex) => item.kind !== 'app'
      && !executing.has(`${sourceIndex}:${itemIndex}`)
      ? [] : [{ sourceIndex, itemIndex, status: 'unsupported', reason: 'required_fact_unavailable' }]));
  const recipePlans: NonNullable<MachineSetupPlanResultV1['recipePlans']> = [];
  let targetFacts: Promise<MachineRecipeTargetFactsV1> | undefined;
  const readTargetFacts = () => targetFacts ??= (async () => {
    // Reached bindings in setup and removal share one P10 observation.
    let observation: MachineAdminAccessObservationV1 | undefined;
    try { observation = await params.readAdminAccessObservation?.(); }
    catch { throw new MachineRecipeTargetFactUnavailableErrorV1(); }
    params.signal?.throwIfAborted();
    return { 'daemon.primaryGroup': observation?.daemonPrimaryGroup ?? null,
      'daemon.username': observation?.daemonUsername ?? null };
  })();
  const backend = createMachineSetupNativeBackend({ ...(params.signal ? { signal: params.signal } : {}),
    ...(params.runNative ? { run: params.runNative } : {}) });
  let recipes: readonly PluginProjectedMachineRecipeEntryV1[] | undefined;
  if (selected.length || change?.detached.some(entry => entry.initialPresence === 'absent'
    && (entry.selected || !isMachineSetupRecipeExcludedV1(entry.item.selection.ref, exclusions)))) {
    try { recipes = await params.readRecipes?.(); }
    catch { if (selected.length) return fail('machine_recipe_unavailable'); }
    if (!recipes && selected.length) return fail('machine_recipe_unavailable');
    recipes ??= [];
    for (const { item } of selected) {
      const { ref, inputs } = item.selection;
      const recipe = recipes.find(entry => entry.pluginId === ref.pluginId && entry.definition.id === ref.recipeId
        && entry.definition.revision === ref.revision)?.definition;
      if (!recipe) return fail('machine_recipe_unavailable');
      if (item.kind === 'softwareRecipe' && recipe.software !== true) return fail('invalid_machine_recipe_kind');
      if (!isValidPluginJsonSchemaValue(compilePluginJsonSchema(recipe.inputSchema), inputs)
        || !machineRecipeInputConstraintsSatisfiedV1(recipe, inputs)) return fail('invalid_machine_recipe_inputs');
    }
  }
  if (recipes) {
    for (const { item, sourceIndex, itemIndex, retained, execute } of proposed) {
      if (!execute) continue;
      const { ref, inputs } = item.selection;
      const recipe = recipes.find(entry => entry.pluginId === ref.pluginId && entry.definition.id === ref.recipeId
        && entry.definition.revision === ref.revision)?.definition;
      if (!recipe || retained && (item.kind === 'softwareRecipe' && recipe.software !== true
        || !isValidPluginJsonSchemaValue(compilePluginJsonSchema(recipe.inputSchema), inputs)
        || !machineRecipeInputConstraintsSatisfiedV1(recipe, inputs))) continue;
      try {
        const plan = await prepareMachineRecipeProgramV1({ machineId: input.machineId,
          desiredRevision: current.policy.revision, selection: item.selection, recipe, program: 'steps',
          backend, readTargetFacts, ...(params.signal ? { signal: params.signal } : {}) });
        if (!plan) return fail('machine_recipe_unavailable');
        recipePlans.push({ sourceIndex, itemIndex, plan });
      } catch (error) {
        if (params.signal?.aborted) return fail('cancelled');
        if (error instanceof MachineRecipeTargetFactUnavailableErrorV1) return fail(error.code);
        if (error && typeof error === 'object' && 'code' in error && error.code === 'invalid_machine_recipe_inputs') {
          if (retained) continue;
          return fail(error.code);
        }
        if (error && typeof error === 'object' && 'code' in error && error.code === 'plugin_exec_termination_incomplete') return fail(error.code);
        return fail('machine_recipe_native_unavailable');
      }
    }
  }
  let removals: Awaited<ReturnType<typeof prepareMachineSetupRemovalsV1>> | undefined;
  if (change?.detached.length) {
    try {
      removals = await prepareMachineSetupRemovalsV1({ machineId: input.machineId,
        desiredRevision: current.policy.revision, detached: change.detached, recipes: recipes ?? [], exclusions,
        backend, readTargetFacts, ...(params.signal ? { signal: params.signal } : {}) });
      if (!removals.ok) return removals;
    } catch (error) {
      if (params.signal?.aborted) return fail('cancelled');
      if (error instanceof MachineRecipeTargetFactUnavailableErrorV1) return fail(error.code);
      if (error && typeof error === 'object' && 'code' in error && error.code === 'plugin_exec_termination_incomplete') return fail(error.code);
      return fail('machine_recipe_native_unavailable');
    }
  }
  const selectedEntries = [...(removals?.ok ? removals.removalPlans : []), ...recipePlans];
  let selectedPlans = selectedEntries.map(entry => entry.plan);
  const requiresSessionRefresh = input.mode
    ? await readMachineSetupSessionRefreshRequirement(selectedPlans, params.groupRefreshNative) : undefined;
  if (requiresSessionRefresh?.scope === 'userServices' && selectedPlans.some(plan => plan.steps.some(step =>
    step.kind === 'group' && step.name === 'docker' && machineSetupStepChangesDaemonGroupsV1(step, requiresSessionRefresh.username)))) {
    // One reviewed refresh follows every membership effect. The native owner
    // re-observes it after earlier steps, including initially satisfied managers.
    const entry = selectedEntries.at(-1)!;
    const step = buildUserManagerGroupRefreshStep(params.groupRefreshNative?.user ?? userInfo());
    const fact = await backend.observe(step);
    const { v: _v, planDigest: _digest, ...contents } = entry.plan;
    entry.plan = createMachineSetupEffectPlan({ ...contents, steps: [...contents.steps, step],
      nativeFacts: [...contents.nativeFacts, fact] });
    selectedPlans = selectedEntries.map(entry => entry.plan);
  }
  for (const { sourceIndex, itemIndex, plan } of recipePlans) {
    const blocked = findMachineSetupBlockingObservationV1(plan);
    const reason = blocked ? MachineSetupObservationReasonV1Schema.safeParse(blocked.reason) : undefined;
    const entry = support.find(entry => entry.sourceIndex === sourceIndex && entry.itemIndex === itemIndex)!;
    entry.status = blocked?.status ?? (plan.nativeFacts.some(fact => fact.status === 'drifted') ? 'drifted' : 'satisfied');
    if (blocked) entry.reason = reason?.success ? reason.data : 'required_fact_unavailable';
    else delete entry.reason;
  }
  const review = input.mode ? (() => {
    const executingSetups = executionSources ?? sources.map(source => source.setup);
    const unsupportedScriptCheck = executingSetups.some(setup => setup.scripts?.some(script => script.body && script.check?.requiredFacts?.length));
    const incomplete = support.some(entry => entry.status === 'unsupported' || entry.status === 'unavailable')
      || support.length !== recipePlans.length || unsupportedScriptCheck;
    let possible = requiresSessionRefresh !== undefined;
    let unknown = incomplete;
    for (const setup of executingSetups) {
      if (setup.toolchain) unknown = true;
      for (const script of setup.scripts ?? []) if (script.body) {
        // The native preflight cannot yet interpret these declared facts.
        if (script.check?.requiredFacts?.length) continue;
        const impact = script.affects ?? 'none';
        if (impact !== 'none') possible = true;
        // A free-form script is not a declaration of all its host effects.
        else unknown = true;
      }
    }
    for (const plan of selectedPlans) {
      for (const [stepIndex, step] of plan.steps.entries()) {
        const impact = readMachineSetupStepImpact(step);
        if (impact && impact !== 'none') possible = true;
        const observation = plan.nativeFacts[stepIndex];
        if (observation?.status !== 'satisfied' && impact !== 'none') unknown = true;
      }
    }
    return { target: { homeId: input.homeId, machineId: input.machineId },
      // This is the execution owner's existing gate, not an OS/user guess.
      administratorRequired: machineSetupPlansRequireAdministratorV1(selectedPlans) ? true : incomplete ? null : false,
      ...(requiresSessionRefresh ? { requiresSessionRefresh } : {}),
      downtime: possible ? 'possible' : unknown ? 'unknown' : 'none' };
  })() : undefined;
  // Reuse this Plan's admitted declaration read. Labels never create catalog
  // demand or turn retained/excluded/unavailable recipes into admission work.
  const reviewedRefs = new Set([
    ...sources.flatMap(source => (source.setup.items ?? []).flatMap(item => item.kind === 'app' ? [] : [item.selection.ref])),
    ...(change?.detached ?? []).map(entry => entry.item.selection.ref),
  ].map(ref => JSON.stringify([ref.pluginId, ref.recipeId, ref.revision])));
  const recipeTitles = recipes?.filter(entry => reviewedRefs.has(JSON.stringify([
    entry.pluginId, entry.definition.id, entry.definition.revision,
  ]))).map(entry => ({ ref: { pluginId: entry.pluginId, recipeId: entry.definition.id, revision: entry.definition.revision },
    title: entry.definition.title }));
  return MachineSetupPlanResultV1Schema.parse({ desiredRevision: current.policy.revision,
    sources, exclusions, ...(current.policy.sourceFacts ? { sourceFacts: current.policy.sourceFacts } : {}),
    ...(sources.some(source => source.setup.items?.some(item => item.kind === 'app'))
      ? { appOrigins: readMachineSetupAppOriginsV1(current.policy.sources, sources) } : {}),
    ...(input.removeItemKeys === undefined ? {} : { removeItemKeys: input.removeItemKeys }),
    ...(removals?.ok ? { removalOffers: removals.removalOffers, removalPlans: removals.removalPlans } : {}),
    ...(recipeTitles === undefined ? {} : { recipeTitles }),
    support, ...(input.mode !== undefined || recipePlans.length ? { recipePlans } : {}),
    ...(review ? { review } : {}),
  });
}
