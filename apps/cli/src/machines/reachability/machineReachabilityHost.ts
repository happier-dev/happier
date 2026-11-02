import { networkInterfaces } from 'node:os';
import { executeRetainedSshTransition, type RetainedSshTransitionInput } from './retainedSshTransition';
import { prepareMachineRecipeProgramV1 } from '@/machines/setup/prepareMachineRecipeProgram';
import { join } from 'node:path';
import { getMachineSetupDesiredV1, mutateMachineMetadataFieldV1,
  type ActionExecutorContext } from '@happier-dev/protocol';
import type { MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { computeCanonicalDomainSeparatedHexDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { accessProviderRefsEqualV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { MachineRecipeSelectionV1Schema, type MachineRecipeSelectionV1, type MachineRecipeStepV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { MachinePresetItemV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { PluginProjectedMachineRecipeEntryV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { MachineReachabilityPlanV1Schema, type MachineReachabilityChangeV1,
  type MachineReachabilityInspectInputV1, type MachineReachabilityConfigureInputV1,
  type MachineReachabilityPlanBasisV1 } from '@happier-dev/protocol';
import type { MachineReachabilityObservationV1 } from '@happier-dev/protocol/machines/reachability/machineReachabilityPostureV1';
import { checkMachineSetupEffectPlan, createMachineSetupEffectPlan, createMachineSetupNativeBackend, findMachineSetupBlockingObservationV1,
  type MachineSetupNativeCommand, type MachineSetupNativeCommandResult } from '@happier-dev/cli-common/machineSetup';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { HostAgentIsolationLaunchContext } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { readAgentIsolationNativeIdentity } from '@/daemon/agentIsolation/agentIsolationNativeIdentity';
import { machineNativeEffectAdmission, MachineNativeEffectAdmissionError } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { buildPluginProjectionFamilyV2 } from '@/plugins/projection/families';
import { machineRecipesProjectionFamily } from '@/plugins/projection/registry/machineRecipes';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { prepareMachineSetupPlanV1 } from '@/machines/setup/prepareMachineSetupPlan';
import { resolveMachineSetupNativeEffectKeys, type MachineSetupNativeEffectsInput } from '@/machines/setup/machineSetupNativeEffects';
import { checkElevatedMachineSetupPlan, runElevatedEffect,
  type MachineElevationDependencies } from '@/machines/adminAccess/runElevatedEffect';
import { createReachabilityProviderHost } from './reachabilityProviderHost';
import { withReachabilityJoinCredential } from './prepareReachabilityJoinCredential';
import { SelectedProfileRefusal, readMachineReachabilityMetadata, observeMachineReachability,
  reachabilityPostureField, accessProviderSelectionsField } from './readMachineReachability';

export type MachineReachabilityHostDependencies = Readonly<{
  target: Readonly<{ serverId: string; machineId: string; installationId: string; custodianAccountId: string }>;
  port: MachineMetadataFieldPortV1;
  runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry;
  context: ActionExecutorContext;
  isCurrent(): Promise<boolean>;
  agentIsolation: HostAgentIsolationLaunchContext;
  happyHomeDir: string;
  elevation: Omit<MachineElevationDependencies, 'verifyCurrent' | 'connectorSecretGrant'>;
  nativeEffects: Omit<MachineSetupNativeEffectsInput, 'signal' | 'scripts' | 'plans'>;
  settleNative?(): Promise<void>;
  runtime?: NonNullable<Awaited<ReturnType<ApiMachineClient['resolveMachineSetupRuntime']>>>;
  machineAdmission?: Readonly<{ actorAccountId: string; custodianAccountId: string }>;
  installationPublicKey?: Uint8Array;
  installationIdentityFile?: string;
  runNative?: (command: MachineSetupNativeCommand) => Promise<MachineSetupNativeCommandResult>;
  readNetworkInterfaces?: typeof networkInterfaces;
  publish(observation: MachineReachabilityObservationV1): Promise<MachineReachabilityObservationV1>;
}>;

const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
  ? error.code : 'machine_reachability_unavailable';

/** A public role code is a diagnostic, never a host-control exception. */
class NativeRoleFailure extends Error {
  constructor(readonly code: string, readonly refused: boolean, readonly unsettled = false) { super(code); }
}

function providerHost(deps: MachineReachabilityHostDependencies, actionId: string, isCurrent = deps.isCurrent) {
  const requestId = deps.context.actionRequestId;
  const runNative = deps.runNative;
  if (!requestId) return refuse('admission_unavailable');
  return createReachabilityProviderHost({ runtimeRegistry: deps.runtimeRegistry, target: deps.target,
    parent: { actionId, requestId }, context: deps.context, isCurrent,
    native: { env: process.env, upstreamUrl: null, readNetworkInterfaces: deps.readNetworkInterfaces ?? networkInterfaces,
      ...(runNative ? { runCommand: async request => {
        const result = await runNative({ executable: request.command, args: [...request.args],
          env: Object.fromEntries(Object.entries(request.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) });
        return { command: request.command, args: request.args, exitCode: result.code ?? 1, stdout: result.stdout, stderr: result.stderr };
      } } : {}) } });
}

async function readCredentialPreparation(deps: MachineReachabilityHostDependencies) {
  const isolation = deps.agentIsolation.read();
  if (!isolation?.enabled || isolation.status.kind !== 'effective') return refuse('credential_unavailable');
  const observation = await deps.elevation.observe();
  const identity = await readAgentIsolationNativeIdentity(deps.context.signal, undefined, observation.daemonPrimaryGroup ?? undefined);
  if (!observation.daemonUsername || observation.daemonUid === null || !observation.daemonPrimaryGroup
    || identity.agentUid === observation.daemonUid || !identity.groups
    || identity.groups.agentGroupIds.includes(identity.groups.daemonGroupId)) return refuse('credential_unavailable');
  const stillIsolated = deps.agentIsolation.read();
  if (!stillIsolated?.enabled || stillIsolated.status.kind !== 'effective') return refuse('credential_unavailable');
  const review: NonNullable<MachineReachabilityPlanBasisV1['credentialFileReview']> = {
    purpose: 'network.join', path: credentialFilePath(deps.target.installationId),
    owner: 'root', group: 'root', mode: 0o600, ownerUid: 0, groupGid: 0,
  };
  return { review, observation };
}

const credentialDirectory: Extract<MachineRecipeStepV1, { kind: 'directory' }> = {
  id: 'access-provider-credential-directory', kind: 'directory', path: '/run/happier-machine-credentials',
  owner: 'root', group: 'root', mode: 0o700, protectedAncestors: true,
};
function credentialFilePath(installationId: string) {
  return join(credentialDirectory.path, `${encodeURIComponent(installationId)}.setup-key`);
}

/** Review binds the operation; P20 observes native satisfaction again at execution. */
function reviewedPlanDigest(basis: MachineReachabilityPlanBasisV1) {
  const operation = { ...basis, recipePlans: basis.recipePlans.map(({ plan, ...position }) => {
    const { v: _version, planDigest: _digest, ...contents } = plan;
    return { ...position, planDigest: createMachineSetupEffectPlan(contents).planDigest };
  }) };
  return computeCanonicalDomainSeparatedHexDigest('happier-machine-reachability-plan-v1',
    [createCanonicalJsonSigningInput(operation)]);
}

async function prepare(input: MachineReachabilityInspectInputV1, deps: MachineReachabilityHostDependencies,
  actionId: 'machines.reachability.inspect' | 'machines.reachability.configure') {
  if (input.machineId !== deps.target.machineId || input.serverId && input.serverId !== deps.target.serverId) return refuse('target_mismatch');
  if (!await deps.isCurrent()) return refuse('approval_stale');
  const state = await readMachineReachabilityMetadata(deps.port);
  const providers = providerHost(deps, actionId);
  const change = input.change;
  let observation: MachineReachabilityObservationV1 | undefined;
  const occurrences: MachineReachabilityPlanBasisV1['occurrences'] = [];
  const recipePlans: MachineReachabilityPlanBasisV1['recipePlans'] = [];
  let credentialFileReview: MachineReachabilityPlanBasisV1['credentialFileReview'];
  let membershipSelection: MachineRecipeSelectionV1 | undefined;
  let membershipEntry: MachineReachabilityPlanBasisV1['recipePlans'][number] | undefined;
  const nativeProfiles: NonNullable<MachineReachabilityPlanBasisV1['nativeProfiles']> = [];
  if (change?.kind === 'posture') {
    if (!state.posture) return refuse('machine_reachability_posture_unavailable');
    if (!sameStrictJsonValue(change.posture.management, state.posture.management)
      || change.posture.defaultServiceIngress.kind !== 'none') return refuse('machine_reachability_closure_unsupported');
    if (change.posture.revision !== state.posture.revision + 1
      && !sameStrictJsonValue(change.posture, state.posture)) return refuse('plan_changed');
  }
  if (change?.kind === 'privateNetwork') {
    const selected = await providers.prepareRole(change.selection, change.intent,
      change.intent === 'join' && change.selection.credentialRefs.some(ref => ref.purpose === 'network.join')
        ? { setupCredentialFile: credentialFilePath(deps.target.installationId) } : {});
    if (!selected.ok) return refuse(selected.errorCode);
    if (!selected.definition.capabilities.includes('privateNetwork')) return refuse('access_provider_target_unsupported');
    if (selected.kind === 'plugin' && state.selections.some(selection => accessProviderRefsEqualV1(selection.provider, selected.selection.provider)
      && !sameStrictJsonValue(selection, selected.selection))) return refuse('provider_conflict');
    try {
      observation = await observeMachineReachability({ state, providers,
        additionalSelection: selected.selection, isCurrent: deps.isCurrent });
    } catch (error) {
      if (!(error instanceof SelectedProfileRefusal)) throw error;
      return { ok: false as const, errorCode: error.code, error: error.code, effectAttempted: false };
    }
    if (selected.kind === 'plugin') {
      const occurrenceId = deps.runtimeRegistry.contributes.occurrenceIdsByPluginId?.[selected.contribution.pluginId];
      if (!occurrenceId || deps.runtimeRegistry.readPluginOccurrenceId(selected.contribution.pluginId) !== occurrenceId) return refuse('admission_unavailable');
      occurrences.push({ provider: selected.contribution.identity, occurrenceId });
    }
    let credentialPreparation: Awaited<ReturnType<typeof readCredentialPreparation>> | undefined;
    if (change.intent === 'join') {
      const credential = selected.selection.credentialRefs.find(reference => reference.purpose === 'network.join');
      if (!credential && selected.kind === 'plugin') return refuse('needsAuth');
      if (credential) {
        if (credential.credentialRef.kind !== 'savedSecret') return refuse('credential_unavailable');
        credentialPreparation = await readCredentialPreparation(deps);
        credentialFileReview = credentialPreparation.review;
      }
    }
    const observed = observation.privateNetworks.find(network => accessProviderRefsEqualV1(network.provider, selected.selection.provider));
    const builtinProgram = selected.kind === 'builtin' && observed
      ? await providers.prepareMembership(selected.selection, change.intent, observed,
        credentialFileReview ? { setupCredentialFile: credentialFileReview.path } : {}) : undefined;
    if (selected.kind === 'builtin' && !builtinProgram) return refuse('invalid_action_output');
    if (builtinProgram && !builtinProgram.ok) return { ...builtinProgram, effectAttempted: false };
    const membership = builtinProgram?.ok ? builtinProgram.recipe : selected.definition.membership?.[change.intent];
    if (builtinProgram?.ok && 'kind' in selected.selection.provider) nativeProfiles.push({
      provider: selected.selection.provider, ...builtinProgram.profile });
    const install = change.intent === 'join' ? selected.definition.install : undefined;
    if (install || membership || credentialPreparation) {
      const desired = await getMachineSetupDesiredV1(deps.port);
      if (desired.status !== 'ready') return refuse(`machine_setup_content_${desired.status}`);
      const items: MachinePresetItemV1[] = [];
      if (install) {
        if (install.kind !== 'recipe') return refuse('access_provider_target_unsupported');
        const recipeRef = install.ref;
        const recipeOccurrenceId = deps.runtimeRegistry.contributes.occurrenceIdsByPluginId?.[recipeRef.pluginId];
        if (!recipeOccurrenceId || deps.runtimeRegistry.readPluginOccurrenceId(recipeRef.pluginId) !== recipeOccurrenceId) return refuse('admission_unavailable');
        occurrences.push({ provider: { pluginId: recipeRef.pluginId, localId: recipeRef.recipeId }, occurrenceId: recipeOccurrenceId });
        items.push({ kind: 'setupRecipe' as const, selection: { ref: recipeRef, inputs: {} } });
      }
      const membershipIndex = membership ? items.length : undefined;
      let inlineEntry: PluginProjectedMachineRecipeEntryV1 | undefined;
      if (membership && selected.kind === 'plugin') {
        const pluginId = selected.contribution.pluginId, pluginVersion = selected.contribution.pluginVersion;
        if (!pluginVersion) return refuse('admission_unavailable');
        const ref = { pluginId, recipeId: membership.id, revision: membership.revision };
        if (install?.kind === 'recipe' && sameStrictJsonValue(install.ref, ref)) return refuse('provider_conflict');
        const selection = MachineRecipeSelectionV1Schema.parse({ ref, inputs: selected.input });
        membershipSelection = selection;
        items.push({ kind: 'setupRecipe', selection });
        inlineEntry = { id: buildQualifiedPluginContributionKey({ pluginId, localId: membership.id }),
          pluginId, pluginVersion, definition: membership };
      }
      if (items.length) {
        const credentialObservation = credentialPreparation?.observation;
        const planned = await prepareMachineSetupPlanV1({ input: { homeId: deps.target.serverId, machineId: deps.target.machineId,
          mode: 'effects', sources: [{ kind: 'direct',
            setup: { items } }] },
          current: desired, signal: deps.context.signal, ...(deps.runNative ? { runNative: deps.runNative } : {}),
          ...(credentialObservation ? { readAdminAccessObservation: async () => credentialObservation } : {}),
          readRecipes: async () => [...(inlineEntry ? [inlineEntry] : []), ...Object.values(buildPluginProjectionFamilyV2({ registry: deps.runtimeRegistry.contributes,
            generation: deps.runtimeRegistry.generation }, machineRecipesProjectionFamily).entriesById)],
        });
        if ('ok' in planned && !planned.ok) return refuse(planned.errorCode);
        if (!('recipePlans' in planned) || !planned.recipePlans?.length) return refuse('machine_recipe_unavailable');
        // A cold client is truthfully unavailable here. Retain its concrete
        // reviewed program for full native admission, then recheck it after
        // installing prerequisites; it cannot authorize APPLY in this state.
        if (planned.support.some(fact => fact.itemIndex !== membershipIndex
          && (fact.status === 'unsupported' || fact.status === 'unavailable'))) return refuse('machine_recipe_native_unavailable');
        recipePlans.push(...planned.recipePlans);
      }
      if (membership && builtinProgram?.ok) {
        let capturedIdentity = credentialPreparation?.observation;
        const plan = await prepareMachineRecipeProgramV1({ machineId: deps.target.machineId,
          desiredRevision: desired.policy.revision, recipe: membership, program: 'steps', inputs: builtinProgram.inputs,
          backend: createMachineSetupNativeBackend({ signal: deps.context.signal,
            ...(deps.runNative ? { run: deps.runNative } : {}) }), signal: deps.context.signal,
          readTargetFacts: async () => {
            capturedIdentity ??= await deps.elevation.observe();
            return { 'daemon.username': capturedIdentity.daemonUsername, 'daemon.primaryGroup': capturedIdentity.daemonPrimaryGroup };
          } });
        if (!plan) return refuse('machine_recipe_unavailable');
        membershipEntry = { sourceIndex: 0, itemIndex: items.length, plan };
        recipePlans.push(membershipEntry);
      }
      membershipEntry ??= membershipSelection ? recipePlans.find(entry => entry.plan.basis.kind === 'setup'
        && sameStrictJsonValue(entry.plan.basis.selection, membershipSelection)) : undefined;
      if (credentialPreparation) {
        const plan = await checkMachineSetupEffectPlan({ basis: { kind: 'setup', machineId: deps.target.machineId,
          desiredRevision: desired.policy.revision }, steps: [credentialDirectory],
          backend: createMachineSetupNativeBackend({ signal: deps.context.signal,
            ...(deps.runNative ? { run: deps.runNative } : {}) }) });
        if (plan.nativeFacts.some(fact => fact.status === 'unsupported' || fact.status === 'unavailable')) return refuse('machine_recipe_native_unavailable');
        const membershipPosition = membershipEntry ? recipePlans.indexOf(membershipEntry) : -1;
        recipePlans.splice(membershipPosition < 0 ? recipePlans.length : membershipPosition, 0,
          { sourceIndex: 0, itemIndex: items.length + (builtinProgram?.ok ? 1 : 0), plan });
      }
    }
  }
  if (!await deps.isCurrent()) return refuse('approval_stale');
  observation ??= await observeMachineReachability({ state, providers, isCurrent: deps.isCurrent });
  const basis: MachineReachabilityPlanBasisV1 | undefined = change ? { machineId: deps.target.machineId,
    installationId: deps.target.installationId, currentPostureRevision: state.posture?.revision ?? null,
    currentSelections: state.selections, change, occurrences, recipePlans,
    ...(nativeProfiles.length ? { nativeProfiles } : {}),
    ...(credentialFileReview ? { credentialFileReview } : {}) } : undefined;
  const plan = basis ? MachineReachabilityPlanV1Schema.parse({ basis, reviewedPlanDigest: reviewedPlanDigest(basis) }) : undefined;
  // Protocol parsing produces the closed review copy. Keep the reference from
  // that same plan, so prerequisite filtering cannot accidentally execute the
  // membership program before its protected credential is materialized.
  const reviewedMembership = membershipEntry && plan?.basis.recipePlans.find(entry => sameStrictJsonValue(entry, membershipEntry));
  return { state, providers, observation, plan, membershipEntry: reviewedMembership };
}

export async function inspectMachineReachability(input: MachineReachabilityInspectInputV1, deps: MachineReachabilityHostDependencies) {
  const prepared = await prepare(input, deps, 'machines.reachability.inspect');
  if ('ok' in prepared) return prepared;
  const observation = await deps.publish(prepared.observation);
  return { machineId: deps.target.machineId, ...prepared.state, observation,
    ...(prepared.plan ? { plan: prepared.plan } : {}) };
}

export async function executeMachineReachabilityTransition(input: MachineReachabilityConfigureInputV1, deps: MachineReachabilityHostDependencies) {
  const prepared = await prepare(input, deps, 'machines.reachability.configure');
  if ('ok' in prepared) return prepared;
  const plan = prepared.plan;
  if (!plan
    || reviewedPlanDigest(input.reviewedPlanBasis) !== input.reviewedPlanDigest
    || plan.reviewedPlanDigest !== input.reviewedPlanDigest) return { ok: false as const,
      errorCode: 'plan_changed', error: 'plan_changed', effectAttempted: false };
  const operationId = deps.context.operationAcceptance?.operationId;
  if (!operationId || deps.context.operationAcceptance?.actionId !== 'machines.reachability.configure') return refuse('operation_unavailable');
  const readKeys = () => resolveMachineSetupNativeEffectKeys({ ...deps.nativeEffects,
    plans: plan.basis.recipePlans.map(entry => entry.plan), signal: deps.context.signal });
  try {
  const keys = await readKeys();
  return await machineNativeEffectAdmission.run({ operation: { operationId, kind: 'machines.reachability.configure', signal: deps.context.signal }, keys,
    ...(deps.settleNative ? { settleNative: deps.settleNative } : {}) }, async native => {
    let currentState = prepared.state;
    const current = deps.isCurrent;
    const providers = providerHost(deps, 'machines.reachability.configure', current);
    let selectionRecordWritten = false;
    let metadataOutcomeUnknown = false;
    const write = async (change: MachineReachabilityChangeV1, joining = false) => {
      if (!await current()) return refuse('plan_changed');
      if (change.kind === 'posture') {
        const result = await mutateMachineMetadataFieldV1({ expectedMetadataVersion: currentState.metadataVersion,
          expectedPolicy: currentState.posture, policy: change.posture, comparison: 'field' }, deps.port, reachabilityPostureField,
          { signal: deps.context.signal });
        if (result.status === 'applied' || result.status === 'unchanged' || result.status === 'satisfied') {
          currentState = { ...currentState, metadataVersion: result.metadataVersion, posture: result.policy };
          return result.status;
        }
        if (result.status === 'outcomeUnknown') metadataOutcomeUnknown = true;
        return refuse(result.status === 'conflict' ? 'plan_changed' : 'machine_metadata_unavailable');
      }
      const result = await mutateMachineMetadataFieldV1({ expectedMetadataVersion: currentState.metadataVersion,
          expectedPolicy: currentState.selections, policy: joining
            ? currentState.selections.some(selection => sameStrictJsonValue(selection, change.selection))
              ? currentState.selections : [
                ...currentState.selections.filter(selection => !('kind' in change.selection.provider)
                  || !accessProviderRefsEqualV1(selection.provider, change.selection.provider)), change.selection]
            : currentState.selections.filter(selection => !sameStrictJsonValue(selection, change.selection)), comparison: 'field' },
          deps.port, accessProviderSelectionsField, { signal: deps.context.signal });
      if (result.status === 'outcomeUnknown') metadataOutcomeUnknown = true;
      if (result.status === 'applied' || result.status === 'unchanged' || result.status === 'satisfied') {
        if (joining && !prepared.state.selections.some(selection => sameStrictJsonValue(selection, change.selection))) selectionRecordWritten = true;
        currentState = { ...currentState, metadataVersion: result.metadataVersion, selections: result.policy };
        return result.status;
      }
      return refuse(result.status === 'conflict' ? 'plan_changed' : 'machine_metadata_unavailable');
    };
    let status: 'applied' | 'unchanged' | 'outcome_unknown' = 'applied';
    let failureCode: string | undefined;
    let knownFailure: ActionExecuteFailure | undefined;
    let anyNativeEffectPossible = false;
    let setupApplied = false;
    let roleMayHaveChangedMembership = false;
    let cleanupConfirmed = true;
    const restorePriorSelection = async () => {
      if (!selectionRecordWritten) return true;
      try {
        if (!await current()) return false;
        const restored = await mutateMachineMetadataFieldV1({ expectedMetadataVersion: currentState.metadataVersion,
          expectedPolicy: currentState.selections, policy: prepared.state.selections, comparison: 'field' }, deps.port,
        accessProviderSelectionsField, { signal: deps.context.signal });
        if (restored.status === 'applied' || restored.status === 'unchanged' || restored.status === 'satisfied') {
          currentState = { ...currentState, metadataVersion: restored.metadataVersion, selections: restored.policy };
          selectionRecordWritten = false;
          return true;
        }
        return false;
      } catch { return false; }
    };
    try {
      if (!await current()) return refuse('plan_changed');
      if (input.change.kind === 'posture') {
        const written = await write(input.change);
        status = written === 'unchanged' || written === 'satisfied' ? 'unchanged' : 'applied';
      } else {
        const change = input.change;
        const membershipEntry = prepared.membershipEntry;
        // A daemon-user role cannot consume a root-only connector file. Native
        // membership must be the descriptor-owned P20 program, never a second
        // privileged plugin dispatcher or a daemon-readable secret copy.
        if (!membershipEntry) return refuse('access_provider_target_unsupported');
        const inspectSelectedProfile = async () => {
          if (!await current()) return refuse('plan_changed');
          let outcome: Awaited<ReturnType<typeof providers.invoke>>;
          try {
            outcome = await machineNativeEffectAdmission.runStage(native, () =>
              providers.invoke(change.selection, 'inspect'));
          } catch (error) {
            if (isPluginError(error) && error.code === 'plugin_exec_termination_incomplete') {
              machineNativeEffectAdmission.markUnsettled(native);
              throw new NativeRoleFailure(error.code, false, true);
            }
            throw error;
          }
          if (!outcome.ok) {
            if (outcome.errorCode === 'plugin_exec_termination_incomplete') machineNativeEffectAdmission.markUnsettled(native);
            throw new NativeRoleFailure(outcome.errorCode, true, outcome.errorCode === 'plugin_exec_termination_incomplete');
          }
          if (outcome.result.kind !== 'confirmed') {
            throw new NativeRoleFailure(outcome.result.code, true);
          }
          if (outcome.result.facts.state === 'unknown') throw new NativeRoleFailure('native_status_unknown', true);
        };
        // The original complete plan was admitted before these prerequisites.
        // Do not grant or disclose the connector until the native client exists
        // and its exact selected profile can be checked by the ordinary role.
        const prerequisites = plan.basis.recipePlans.filter(entry => entry !== membershipEntry);
        if (prerequisites.length) {
          const previouslyAttempted = anyNativeEffectPossible;
          let prerequisiteEffectsApplied = false;
          const installed = await machineNativeEffectAdmission.runStage(native, async () => {
            anyNativeEffectPossible = true;
            return runElevatedEffect({ machineId: deps.target.machineId, operationId, signal: deps.context.signal,
              onSetupApplied: result => { prerequisiteEffectsApplied = result.completedStepIds.length > 0; },
              effect: { kind: 'setupOperation', plans: prerequisites.map(({ plan }) => ({ plan })) } },
            { ...deps.elevation, verifyCurrent: current });
          });
          if (installed.outcome !== 'applied') {
            if (installed.outcome === 'not_applied' || installed.outcome === 'needs_attendance') anyNativeEffectPossible = previouslyAttempted;
            return refuse('reasonCode' in installed ? installed.reasonCode
              : installed.outcome === 'needs_attendance' ? 'needs_attendance' : 'outcome_unknown');
          }
          anyNativeEffectPossible = previouslyAttempted || prerequisiteEffectsApplied;
          setupApplied = true;
          deps.context.operationProgress?.update({ phase: 'setup_applied' });
        }
        // Reobserve the captured reviewed native program after installation;
        // do not prepare a second parent or execute a daemon membership Action.
        const refreshedMembership = { ...membershipEntry, plan: await checkMachineSetupEffectPlan({
          basis: membershipEntry.plan.basis, steps: membershipEntry.plan.steps,
          ...(membershipEntry.plan.checks ? { checks: membershipEntry.plan.checks } : {}),
          ...(membershipEntry.plan.selectedCheckIds ? { selectedCheckIds: membershipEntry.plan.selectedCheckIds } : {}),
          backend: createMachineSetupNativeBackend({ signal: deps.context.signal,
            ...(deps.runNative ? { run: deps.runNative } : {}) }),
        }) };
        const blocked = findMachineSetupBlockingObservationV1(refreshedMembership.plan);
        if (blocked) return refuse(blocked.reason ?? 'machine_recipe_native_unavailable');
        // Inspect owns selected-profile refusal without receiving a join key.
        // Only the descriptor's reviewed root P20 program changes membership.
        await inspectSelectedProfile();
        if (change.intent === 'join') {
          const credentialCurrent = current;
          if (!await credentialCurrent()) return refuse('plan_changed');
          const membershipAlreadySatisfied = refreshedMembership.plan.nativeFacts.every(fact => fact.status === 'satisfied');
          if (membershipAlreadySatisfied) {
            await write(change, true);
          } else if (!plan.basis.credentialFileReview) {
            // An already-authenticated builtin can resume its observed profile
            // without launching an interactive login or requiring a setup key.
            // It uses the same admitted P20 program; no daemon role mutates it.
            await write(change, true);
            const previouslyAttempted = anyNativeEffectPossible;
            let membershipEffectsApplied = false;
            const installed = await machineNativeEffectAdmission.runStage(native, () => {
              anyNativeEffectPossible = true;
              roleMayHaveChangedMembership = true;
              return runElevatedEffect({ machineId: deps.target.machineId, operationId, signal: deps.context.signal,
                onSetupApplied: result => { membershipEffectsApplied = result.completedStepIds.length > 0; },
                effect: { kind: 'setupOperation', plans: [{ plan: refreshedMembership.plan }] } },
                { ...deps.elevation, verifyCurrent: credentialCurrent });
            });
            if (installed.outcome !== 'applied') {
              if (installed.outcome === 'not_applied' || installed.outcome === 'needs_attendance') {
                anyNativeEffectPossible = previouslyAttempted;
                roleMayHaveChangedMembership = false;
              }
              return refuse('reasonCode' in installed ? installed.reasonCode
                : installed.outcome === 'needs_attendance' ? 'needs_attendance' : 'outcome_unknown');
            }
            anyNativeEffectPossible = previouslyAttempted || membershipEffectsApplied;
            roleMayHaveChangedMembership = membershipEffectsApplied;
            setupApplied = true;
            deps.context.operationProgress?.update({ phase: 'setup_applied' });
          } else {
          const review = plan.basis.credentialFileReview;
          if (!deps.runtime || !deps.machineAdmission || !deps.installationPublicKey) return refuse('credential_unavailable');
          await withReachabilityJoinCredential({ selection: change.selection, target: deps.target, runtime: deps.runtime,
            machineAdmission: deps.machineAdmission, installationPublicKey: deps.installationPublicKey,
            ...(deps.installationIdentityFile ? { installationIdentityFile: deps.installationIdentityFile } : {}),
            context: deps.context, signal: deps.context.signal ?? new AbortController().signal, isCurrent: credentialCurrent }, async grant => {
            const file: Extract<MachineRecipeStepV1, { kind: 'file' }> = { id: 'access-provider-setup-key', kind: 'file',
              path: review.path, owner: review.owner, group: review.group, mode: review.mode,
              content: { kind: 'secretGrant', grantRef: grant.grantRef } };
            const elevation: MachineElevationDependencies = { ...deps.elevation, verifyCurrent: credentialCurrent,
              connectorSecretGrant: { ...grant.grantRequest, ...(deps.installationIdentityFile ? { installationIdentityFile: deps.installationIdentityFile } : {}) } };
            const setup = await getMachineSetupDesiredV1(deps.port);
            if (setup.status !== 'ready') return refuse('machine_setup_content_unavailable');
            const basis = { kind: 'setup' as const, machineId: deps.target.machineId, desiredRevision: setup.policy.revision };
            const staged = await checkElevatedMachineSetupPlan({ machineId: deps.target.machineId, operationId, basis,
              steps: [file], signal: deps.context.signal }, elevation);
            if (!staged) return refuse('needs_attendance');
            if (staged.nativeFacts.some(fact => fact.facts.present === true && fact.status !== 'satisfied')) return refuse('foreign_effect_conflict');
            const fileAlreadyPresent = staged.nativeFacts.some(fact => fact.facts.present === true);
            let fileMayExist = fileAlreadyPresent;
            try {
              await write(change, true);
              const previouslyAttempted = anyNativeEffectPossible;
              const plans = [staged, refreshedMembership.plan]
                .map(plan => ({ plan }));
              const installed = await machineNativeEffectAdmission.runStage(native, async () => {
                fileMayExist = true;
                cleanupConfirmed = false;
                anyNativeEffectPossible = true;
                roleMayHaveChangedMembership = true;
                return runElevatedEffect({ machineId: deps.target.machineId, operationId, signal: deps.context.signal,
                  effect: { kind: 'setupOperation', plans } }, elevation);
              });
              if (installed.outcome !== 'applied') {
                if (installed.outcome === 'not_applied' || installed.outcome === 'needs_attendance') {
                  anyNativeEffectPossible = previouslyAttempted;
                  roleMayHaveChangedMembership = false;
                  fileMayExist = fileAlreadyPresent;
                  cleanupConfirmed = !fileMayExist;
                }
                return refuse('reasonCode' in installed ? installed.reasonCode
                  : installed.outcome === 'needs_attendance' ? 'needs_attendance' : 'outcome_unknown');
              }
              setupApplied = true;
              deps.context.operationProgress?.update({ phase: 'setup_applied' });
            } finally {
              if (fileMayExist) {
                cleanupConfirmed = false;
                try {
                const { content: _grantContent, ...fileIdentity } = file;
                const removal = await checkElevatedMachineSetupPlan({ machineId: deps.target.machineId, operationId, basis,
                  steps: [{ ...fileIdentity, state: 'absent', expectedContentDigest: grant.contentDigest }], signal: deps.context.signal }, elevation);
                if (!removal) return refuse('recoveryRequired');
                const cleaned = await machineNativeEffectAdmission.runStage(native, () => {
                  anyNativeEffectPossible = true;
                  return runElevatedEffect({ machineId: deps.target.machineId, operationId, signal: deps.context.signal,
                    effect: { kind: 'setupOperation', plans: [{ plan: removal }] } }, elevation);
                });
                if (cleaned.outcome !== 'applied') return refuse('recoveryRequired');
                cleanupConfirmed = true;
                } catch { return refuse('recoveryRequired'); }
              }
            }
          });
          }
        } else {
          if (!currentState.selections.some(selection => sameStrictJsonValue(selection, change.selection))) return refuse('provider_conflict');
          const left = await machineNativeEffectAdmission.runStage(native, () => {
            anyNativeEffectPossible = true;
            roleMayHaveChangedMembership = true;
            return runElevatedEffect({ machineId: deps.target.machineId, operationId, signal: deps.context.signal,
              effect: { kind: 'setupOperation', plans: [{ plan: refreshedMembership.plan }] } }, { ...deps.elevation, verifyCurrent: current });
          });
          if (left.outcome !== 'applied') {
            if (left.outcome === 'not_applied' || left.outcome === 'needs_attendance') {
              anyNativeEffectPossible = false;
              roleMayHaveChangedMembership = false;
            }
            return refuse('reasonCode' in left ? left.reasonCode
              : left.outcome === 'needs_attendance' ? 'needs_attendance' : 'outcome_unknown');
          }
        }
        const observed = await observeMachineReachability({ state: currentState, providers,
          additionalSelection: change.selection, isCurrent: current });
        const network = observed.privateNetworks.find(network => accessProviderRefsEqualV1(network.provider, change.selection.provider));
        if (!network || network.state !== (change.intent === 'join' ? 'ready' : 'stopped')) return refuse('outcome_unknown');
        if (change.intent === 'leave') await write(change);
      }
    } catch (error) {
      failureCode = errorCode(error);
      if (error instanceof NativeRoleFailure && error.unsettled) machineNativeEffectAdmission.markUnsettled(native);
      if (isPluginError(error) && error.code === 'plugin_exec_termination_incomplete') machineNativeEffectAdmission.markUnsettled(native);
      const definiteRefusal = error instanceof NativeRoleFailure ? error.refused
        : !roleMayHaveChangedMembership && (!anyNativeEffectPossible || setupApplied);
      if (!metadataOutcomeUnknown && cleanupConfirmed && definiteRefusal
        && (anyNativeEffectPossible || await restorePriorSelection())) {
        knownFailure = { ok: false, errorCode: failureCode, error: failureCode, effectAttempted: anyNativeEffectPossible,
          ...(setupApplied ? { details: { setupOutcome: 'applied' } } : {}) };
      } else {
        status = 'outcome_unknown';
        if (!cleanupConfirmed || selectionRecordWritten && !anyNativeEffectPossible || metadataOutcomeUnknown) failureCode = 'recoveryRequired';
      }
    }
    const observed = await observeMachineReachability({ state: currentState, providers,
      isCurrent: deps.isCurrent }).catch(error => {
        if (isPluginError(error) && error.code === 'plugin_exec_termination_incomplete') {
          machineNativeEffectAdmission.markUnsettled(native);
          knownFailure = undefined;
          status = 'outcome_unknown';
          if (failureCode !== 'recoveryRequired') failureCode = error.code;
        }
        return { ...prepared.observation,
        management: { ...prepared.observation.management, providers: prepared.observation.management.providers
          .map(provider => ({ provider: provider.provider, state: 'unknown' as const })) },
        privateNetworks: prepared.observation.privateNetworks.map(network => ({ provider: network.provider,
          networkIdentity: null, displayName: null, dnsName: null, addresses: [], interfaceName: null,
          sourceRanges: [], magicDnsEnabled: null, state: 'unknown' as const })),
      };
    });
    let observation: MachineReachabilityObservationV1;
    try { observation = await deps.publish(observed); }
    catch {
      // Publication is not native outcome authority. Keep an already known
      // refusal or uncertainty, and never discard confirmed setup evidence.
      if (knownFailure) return knownFailure;
      const code = status === 'outcome_unknown' ? failureCode ?? 'outcome_unknown'
        : 'machine_reachability_publication_unavailable';
      return { ok: false as const, errorCode: code, error: code,
        effectAttempted: anyNativeEffectPossible || roleMayHaveChangedMembership || metadataOutcomeUnknown
          || currentState.metadataVersion !== prepared.state.metadataVersion,
        ...(setupApplied ? { details: { setupOutcome: 'applied' } } : {}) };
    }
    if (knownFailure) return knownFailure;
    return { status, machineId: deps.target.machineId, ...currentState, observation,
      ...(failureCode ? { errorCode: failureCode } : {}) };
  });
  } catch (error) {
    if (!(error instanceof MachineNativeEffectAdmissionError)) throw error;
    return { ok: false as const, errorCode: error.code, error: error.code, effectAttempted: false,
      ...(error.details ? { details: error.details } : {}) };
  }
}


/** The deployed Domain supplies the exact new owned Caddy bindings. Root CHECK
 * and the existing retained-SSH transaction remain the only firewall writer.
 * Reapply the admitted posture; Domain setup never chooses a new SSH policy.
 */
export async function settleMachineCaddyFirewallForHost(input: Pick<RetainedSshTransitionInput,
  'machineId' | 'installationId' | 'operationId' | 'basis' | 'port' | 'native' | 'elevation' | 'readDaemonProof' | 'signal'>
  & Readonly<{ caddy: import('@happier-dev/cli-common/machineSetup').NativeCaddySetupInput }>) {
  const state = await readMachineReachabilityMetadata(input.port);
  if (!state.posture) return refuse('required_fact_unavailable');
  if (state.posture.defaultServiceIngress.kind !== 'none') return refuse('machine_reachability_closure_unsupported');
  const transitioned = await executeRetainedSshTransition({ ...input,
    expectedMetadataVersion: state.metadataVersion, current: state.posture, desired: state.posture,
    field: reachabilityPostureField,
    firewallIntent: { v: 1, kind: 'retainSsh', caddy: {
      ...(input.caddy.privateBinding ? { privateBinding: { ...input.caddy.privateBinding,
        sourceRanges: [...input.caddy.privateBinding.sourceRanges] } } : {}),
      publicBindings: [...(input.caddy.publicBindings ?? [])],
    }, publicSsh: state.posture.management.publicSsh } });
  if (transitioned.status !== 'applied' && transitioned.status !== 'unchanged')
    return refuse(transitioned.errorCode ?? transitioned.status);
}
