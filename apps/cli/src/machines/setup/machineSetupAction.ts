import { homedir } from 'node:os';
import type { ActionExecuteResult, ActionExecutorDeps } from '@happier-dev/protocol';
import { MachineSetupResolveResultV1Schema, MachineSetupReportInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineSetupApplyTargetV1, MachineSetupRemoveInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { listSecretReferenceOverlayV1BindingNames, readSecretReferenceOverlayV1Reference } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { machineSetupSourceOriginKeyV1, machineSetupItemKeyV1,
  type MachineSetupSourceV1, type MachineSetupSourceFactsMapV1 } from '@happier-dev/protocol';
import type { MachineSetupEffectPlanV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createInvocationSavedSecretOperationContextV1 } from "@/settings/secrets/savedSecretOperationContext";
import { refreshSavedSecretCatalogForOperation } from "@/settings/secrets/hydrateSavedSecretCatalog";
import { createProjectNativeInvocationCustody, type ProjectSetupOperationContext } from '@/workspaces/projectSetup/projectSetupExecution';
import { applyMachineSetup, removeMachineSetup, prepareMachineSetupStages } from './applyMachineSetup';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';
import type { OwnerRemainderPort } from '@/daemon/processes/endOwnerRemainder';
import { prepareMachineSetupPlanV1 } from './prepareMachineSetupPlan';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { buildPluginProjectionFamilyV2 } from '@/plugins/projection/families';
import { machineRecipesProjectionFamily, machineSetupPresetsProjectionFamily } from '@/plugins/projection/registry/machineRecipes';
import type { MachineSetupNativeCommand, MachineSetupNativeCommandResult } from '@happier-dev/cli-common/machineSetup';
import { resolveInstalledMachineEffectCli } from '../adminAccess/runElevatedEffect';
import { requestMachineSetupHome, type MachineSetupInstallation } from './machineSetupHomeRequest';
import { prepareMachineSetupApps, type MachineSetupAppPreparationHost } from './prepareMachineSetupApps';
import { prepareMachineSetupAcceptedAppRuns } from './acceptedAppRuns';
import { machineSetupPlansRequireAdministratorV1, readMachineSetupInitialPresenceV1 } from '@happier-dev/cli-common/machineSetup';
import { prepareMachineSetupUpdatesPlanV1 } from './machineSetupUpdatesAction';
import { logger } from '@/ui/logger';

export type MachineSetupTargetAction = (params: Readonly<{
  input: MachineSetupApplyTargetV1; context: RpcActionExecutorContext; signal?: AbortSignal;
}>) => Promise<unknown>;

function observeInitialPresence(sources: MachineSetupSourceV1,
  recipePlans: readonly { sourceIndex: number; itemIndex: number; plan: MachineSetupEffectPlanV1;
    initialPresence?: 'present' | 'absent' | 'unknown' }[]): MachineSetupSourceFactsMapV1 {
  const observed = new Map<string, 'present' | 'absent' | undefined>();
  for (const entry of recipePlans) {
    const item = sources[entry.sourceIndex]?.setup.items?.[entry.itemIndex];
    if (!item || item.kind === 'app') continue;
    const key = machineSetupItemKeyV1(item);
    const next = entry.initialPresence === 'unknown' ? undefined
      : entry.initialPresence ?? readMachineSetupInitialPresenceV1(entry.plan);
    observed.set(key, observed.get(key) === 'present' || next === 'present' ? 'present'
      : observed.has(key) && observed.get(key) !== next ? undefined : next);
  }
  const sourceFacts: MachineSetupSourceFactsMapV1 = {};
  for (const source of sources) {
    const firstPresence: Record<string, 'present' | 'absent'> = {};
    for (const item of source.setup.items ?? []) {
      if (item.kind === 'app') continue;
      const key = machineSetupItemKeyV1(item);
      const first = observed.get(key);
      if (first !== undefined) firstPresence[key] = first;
    }
    if (Object.keys(firstPresence).length) sourceFacts[machineSetupSourceOriginKeyV1(source)] = { firstPresence };
  }
  return sourceFacts;
}

/** Saved copies use the captured content port; new selections demand exact native checks. */
export function createMachineSetupPlanAction(params: Readonly<{
  apiMachine: Pick<ApiMachineClient, 'getMachineSetupDesiredSnapshot'> & Partial<Pick<ApiMachineClient,
    'resolveMachineSetupRuntime' | 'captureMachineAdminAccess' | 'refreshMachineSetupUpdates' | 'publishMachineSetupUpdates'>>;
  machineId: string; homeId: string;
  installation?: MachineSetupInstallation;
  acquirePluginRuntimeRegistryLease?: () => Promise<PluginRuntimeRegistryLease>;
  runNative?: (command: MachineSetupNativeCommand) => Promise<MachineSetupNativeCommandResult>;
  appPreparation?: MachineSetupAppPreparationHost;
}>): NonNullable<ActionExecutorDeps['machineSetupPlan']> {
  return async ({ input, context, signal }: Parameters<NonNullable<ActionExecutorDeps['machineSetupPlan']>>[0]
    & Readonly<{ context: RpcActionExecutorContext }>) => {
    const fail = (code: string) => ({ ok: false as const, errorCode: code, error: code });
    if ('targets' in input) return fail('target_mismatch');
    if ((signal ?? context.signal)?.aborted) return fail('cancelled');
    if (input.machineId !== params.machineId || input.homeId !== params.homeId) return fail('target_mismatch');
    if (context.machineAdmission && (context.machineAdmission.machineId !== params.machineId
      || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent())) return fail('machine_admission_changed');
    if (context.externalActionExecutionAuthorization?.binding.managedContinuation && input.sources !== undefined) {
      if (input.mode !== 'effects' || !params.installation || !params.apiMachine.resolveMachineSetupRuntime) return fail('admission_unavailable');
      try {
        const lifetime = signal ?? context.signal;
        const runtime = await params.apiMachine.resolveMachineSetupRuntime({ ...(lifetime ? { signal: lifetime } : {}),
          ...(context.machineAdmission ? { machineAdmission: context.machineAdmission } : {}),
          ...(context.verifyMachineAdmissionCurrent ? { verifyMachineAdmissionCurrent: context.verifyMachineAdmissionCurrent } : {}) });
        if (!runtime || !runtime.isCurrent || !await runtime.isCurrent()) return fail('target_unavailable');
        const admitted = MachineSetupResolveResultV1Schema.parse(await requestMachineSetupHome({ runtime, context,
          installation: params.installation, homeId: params.homeId, actionId: 'machines.setup.plan', path: '/v1/machines/setup/resolve',
          body: { homeId: input.homeId, machineId: input.machineId, sources: input.sources }, ...(lifetime ? { signal: lifetime } : {}) }));
        if (!('sources' in admitted) || !sameStrictJsonValue(admitted.sources, input.sources)) return fail('machine_setup_response_invalid');
        if (!await runtime.isCurrent()) return fail('target_unavailable');
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code : (signal ?? context.signal)?.aborted ? 'cancelled' : 'machine_setup_request_failed';
        return fail(code);
      }
    }
    const current = await params.apiMachine.getMachineSetupDesiredSnapshot();
    if ((signal ?? context.signal)?.aborted) return fail('cancelled');
    if (input.updates) {
      if (current.status !== 'ready') return fail(`machine_setup_content_${current.status}`);
      if (!params.apiMachine.refreshMachineSetupUpdates || !params.apiMachine.publishMachineSetupUpdates) return fail('target_unavailable');
      const options = { ...(signal ?? context.signal ? { signal: signal ?? context.signal } : {}),
        ...(params.runNative ? { runNative: params.runNative } : {}) };
      try {
        const updates = input.mode === 'effects'
          ? await prepareMachineSetupUpdatesPlanV1({ machineId: params.machineId, scope: input.updates.scope, ...options })
          : { observation: await params.apiMachine.refreshMachineSetupUpdates(options) };
        if (input.mode === 'effects') await params.apiMachine.publishMachineSetupUpdates(updates.observation);
        return { desiredRevision: current.policy.revision, sources: current.policy.sources,
          exclusions: current.policy.exclusions, support: [], updates,
          ...(input.mode === 'effects' ? { review: { target: { homeId: input.homeId, machineId: input.machineId },
            administratorRequired: 'plan' in updates && updates.plan ? machineSetupPlansRequireAdministratorV1([updates.plan]) : null,
            downtime: 'plan' in updates && updates.plan ? updates.plan.steps.length ? 'possible' as const : 'none' as const : 'unknown' as const,
          } } : {}),
        };
      } catch (error) {
        const code = (signal ?? context.signal)?.aborted ? 'cancelled'
          : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code : 'machine_setup_request_failed';
        return fail(code);
      }
    }
    let recipeLease: PluginRuntimeRegistryLease | undefined;
    let result: Awaited<ReturnType<typeof prepareMachineSetupPlanV1>>;
    try {
      result = await prepareMachineSetupPlanV1({ input, current,
        ...(params.apiMachine.captureMachineAdminAccess ? { readAdminAccessObservation: params.apiMachine.captureMachineAdminAccess().observe } : {}),
        ...(signal ?? context.signal ? { signal: signal ?? context.signal } : {}),
        ...(params.runNative ? { runNative: params.runNative } : {}), readRecipes: async () => {
        const acquire = params.acquirePluginRuntimeRegistryLease
          ?? (await import('@/plugins/runtime/reload/runtimeLease')).acquireAuthoritativePluginRuntimeRegistryLease;
        recipeLease = await acquire();
        return Object.values(buildPluginProjectionFamilyV2({ registry: recipeLease.registry.contributes,
          generation: recipeLease.registry.generation }, machineRecipesProjectionFamily).entriesById);
      } });
    } finally { await recipeLease?.release(); }
    if ((signal ?? context.signal)?.aborted) return fail('cancelled');
    if ('errorCode' in result) return result;
    return prepareMachineSetupApps(input, result, { ...context, ...(signal ? { signal } : {}) }, {
      ...params.appPreparation, ...(params.installation ? { installationId: params.installation.installationId } : {}),
    });
  };
}

/** Receiving target only. Home owns the exact accessible preset/snapshot;
 * this installed runtime owns process and Account secret custody. */
type MachineSetupActionParameters = Readonly<{
  ownerRemainder?: OwnerRemainderPort;
  apiMachine: ApiMachineClient;
  machineId: string;
  homeId: string;
  installation: MachineSetupInstallation;
}>;

export function createMachineSetupAction(params: MachineSetupActionParameters): MachineSetupTargetAction {
  return createMachineSetupTargetAction(params, 'apply');
}

export function createMachineSetupRemoveAction(params: MachineSetupActionParameters): (request: Readonly<{
  input: MachineSetupRemoveInputV1; context: RpcActionExecutorContext; signal?: AbortSignal;
}>) => Promise<unknown> {
  const remove = createMachineSetupTargetAction(params, 'remove');
  return request => remove({ ...request, input: { ...request.input, recipePlans: [] } });
}

function createMachineSetupTargetAction(params: MachineSetupActionParameters, mode: 'apply' | 'remove'): MachineSetupTargetAction {
  return async ({ input, context, signal }) => {
    const fail = (code: string): ActionExecuteResult => ({ ok: false, errorCode: code, error: code });
    const lifetime = signal ?? context.signal ?? new AbortController().signal;
    if (input.machineId !== params.machineId || input.homeId !== params.homeId) return fail('target_mismatch');
    const admission = context.machineAdmission;
    if (!context.externalActionExecutionAuthorization) return fail('admission_unavailable');
    if (admission && (admission.machineId !== params.machineId || admission.installationId !== params.installation.installationId
      || !context.verifyMachineAdmissionCurrent)) return fail('machine_admission_changed');
    const runtime = await params.apiMachine.resolveMachineSetupRuntime({ signal: lifetime,
      ...(admission ? { machineAdmission: admission } : {}),
      ...(context.verifyMachineAdmissionCurrent ? { verifyMachineAdmissionCurrent: context.verifyMachineAdmissionCurrent } : {}) });
    if (!runtime || runtime.machineId !== params.machineId || !runtime.isCurrent || !await runtime.isCurrent()) return fail('target_unavailable');
    const terminalSessions = params.apiMachine.getFiniteTerminalSessions();
    if (!terminalSessions) return fail('target_unavailable');
    const custodianAccountId = readAccountIdFromToken(runtime.credentials.token);
    if (!custodianAccountId || admission && admission.custodianAccountId !== custodianAccountId) return fail('credential_unavailable');
    const requesterAccountId = admission?.actorAccountId ?? custodianAccountId;
    const request = async (path: string, body: unknown, requestSignal?: AbortSignal): Promise<unknown> => {
      return requestMachineSetupHome({ runtime, context, installation: params.installation, homeId: params.homeId,
        actionId: mode === 'remove' ? 'machines.setup.remove' : 'machines.setup.apply', path, body, ...(requestSignal ? { signal: requestSignal } : {}) });
    };
    const run = async (operation: ProjectSetupOperationContext): Promise<ActionExecuteResult> => {
      const operationId = operation.operationAcceptance?.operationId ?? operation.actionRequestId;
      const cancellationSignal = AbortSignal.any([operation.signal, lifetime]);
      if (!operationId || cancellationSignal.aborted) return fail(cancellationSignal.aborted ? 'cancelled' : 'admission_unavailable');
      const custody = createProjectNativeInvocationCustody(operation);
      let secretContext: ReturnType<typeof createInvocationSavedSecretOperationContextV1> | undefined;
      let creation: Readonly<{ managedId: string; preset: Readonly<{ id: string; revision: number }> }> | undefined;
      let recipeLease: PluginRuntimeRegistryLease | undefined;
      const acquireRecipes = async () => recipeLease ??= await (
        (await import('@/plugins/runtime/reload/runtimeLease')).acquireAuthoritativePluginRuntimeRegistryLease)();
      let reportedRunning = false;
      let nativeStarted = false;
      const report = async (state: 'running' | 'succeeded' | 'failed', errorCode?: string) => {
        if (!creation) return;
        await request('/v1/machines/setup/report', MachineSetupReportInputV1Schema.parse({ homeId: input.homeId, machineId: input.machineId,
          presetId: creation.preset.id, presetRevision: creation.preset.revision, managedId: creation.managedId, state,
          operation: { operationId }, ...(errorCode ? { errorCode } : {}) }));
      };
      try {
        const desired = params.apiMachine.captureMachineSetupDesired();
        const current = await desired.read();
        if (current.status !== 'ready') return fail(`machine_setup_content_${current.status}`);
        if (current.policy.revision !== input.desiredRevision) return fail('plan_changed');
        // Admission captured this desired snapshot and installed runtime once.
        // Finite stages consume it; only local cancellation retires this work.
        // Final publication still uses the desired owner's revision-aware CAS.
        const isActive = async () => !cancellationSignal.aborted;
        const retainedByOrigin = new Map(current.policy.sources.map(source => [machineSetupSourceOriginKeyV1(source), source]));
        const sources = input.sources;
        const exclusions = input.exclusions ?? current.policy.exclusions;
        const managedContinuation = context.externalActionExecutionAuthorization?.binding.managedContinuation;
        if (managedContinuation) {
          // Creation continuation consumes the Home's exact retained snapshot;
          // ordinary approved copies do not require live Preset certification.
          const resolved = MachineSetupResolveResultV1Schema.parse(await request('/v1/machines/setup/resolve', {
            homeId: input.homeId, machineId: input.machineId, sources,
          }, cancellationSignal));
          if (!('sources' in resolved) || !sameStrictJsonValue(resolved.sources, sources)) return fail('machine_setup_response_invalid');
          creation = resolved.creation;
        }
        const personalPresetCopies: MachineSetupSourceV1 = [];
        for (const source of sources) {
          const retained = retainedByOrigin.get(machineSetupSourceOriginKeyV1(source));
          if (retained && sameStrictJsonValue(retained, source)) continue;
          if (Object.values(source.setup.secretRefs?.bindings ?? {})
            .some(binding => parseSavedSecretRefV1(binding.ref).kind === 'personal')) {
            if (source.kind === 'accountPreset') personalPresetCopies.push(source);
            else if (requesterAccountId !== custodianAccountId) return fail('credential_unavailable');
          }
          if (source.kind === 'bundledPreset') {
            const lease = await acquireRecipes();
            const available = Object.values(buildPluginProjectionFamilyV2({ registry: lease.registry.contributes,
              generation: lease.registry.generation }, machineSetupPresetsProjectionFamily).entriesById);
            const preset = available.find(entry => entry.pluginId === source.ref.pluginId
              && entry.definition.id === source.ref.localId && entry.definition.revision === source.ref.revision);
            if (!preset || !sameStrictJsonValue(preset.definition.setup, source.setup)) return fail('machine_setup_preset_unavailable');
          }
        }
        if (!managedContinuation && personalPresetCopies.length) {
          // The existing Home resolver owns source-Account secret custody;
          // the admitted actor need not be the Preset or Machine custodian.
          const custodySources: MachineSetupSourceV1 = [...personalPresetCopies, { kind: 'direct', setup: {} }];
          const resolved = MachineSetupResolveResultV1Schema.parse(await request('/v1/machines/setup/resolve', {
            homeId: input.homeId, machineId: input.machineId, sources: custodySources,
          }, cancellationSignal));
          if (!('sources' in resolved) || !sameStrictJsonValue(resolved.sources, custodySources)) return fail('machine_setup_response_invalid');
          creation = resolved.creation;
        }
        const candidates = sources.filter(source => source.kind === 'accountPreset');
        if (!creation && candidates.length) {
          // Current Machine-held copies need no attachment certification.
          // Only the incumbent creation snapshot can supply Report origin.
          const origin = MachineSetupResolveResultV1Schema.parse(await request('/v1/machines/setup/resolve', {
            homeId: input.homeId, machineId: input.machineId, purpose: 'creationOrigin', candidates,
          }, cancellationSignal));
          if (!('purpose' in origin) || origin.purpose !== 'creationOrigin') return fail('machine_setup_response_invalid');
          creation = origin.creation;
        }
        if (cancellationSignal.aborted) return fail('cancelled');
        const administrator = params.apiMachine.captureMachineAdminAccess();
        const setups = sources.map(source => source.setup);
        const sourceChange = input.removeItemKeys === undefined ? undefined
          : { currentSources: current.policy.sources, currentExclusions: current.policy.exclusions, sources };
        const prepared = mode === 'remove' ? undefined
          : prepareMachineSetupStages(setups, input.recipePlans, exclusions, sourceChange);
        const planned = await prepareMachineSetupPlanV1({ readAdminAccessObservation: administrator.observe,
          input: { homeId: input.homeId, machineId: input.machineId,
          sources, exclusions, ...(input.removeItemKeys === undefined ? {} : { removeItemKeys: input.removeItemKeys }),
          mode: 'effects' }, current, signal: cancellationSignal,
          ...(sourceChange && prepared?.ok ? { executionSources: prepared.sources } : {}), readRecipes: async () => {
          const lease = await acquireRecipes();
          return Object.values(buildPluginProjectionFamilyV2({ registry: lease.registry.contributes,
            generation: lease.registry.generation }, machineRecipesProjectionFamily).entriesById);
        } });
        if ('errorCode' in planned) return planned;
        const observedSourceFacts = observeInitialPresence(sources, planned.recipePlans ?? []);
        if (prepared && !prepared.ok) return prepared;
        if (mode !== 'remove') {
          const appFacts = await prepareMachineSetupAcceptedAppRuns({ input, context, isCurrent: isActive,
            signal: cancellationSignal });
          if (!appFacts) return fail('machine_setup_app_preparation_unavailable');
          for (const [origin, facts] of Object.entries(appFacts)) {
            observedSourceFacts[origin] = { ...observedSourceFacts[origin], ...facts };
          }
        }
        let secretEnvironment: Parameters<typeof applyMachineSetup>[0]['secretEnvironment'];
        const scriptSources = prepared?.sources.filter(setup => setup.scripts?.some(script => script.body)) ?? [];
        if (scriptSources.some(setup => setup.secretRefs)) {
          const snapshot = await runWithServerHttpBaseUrl(runtime.serverHttpBaseUrl, () => bootstrapAccountSettingsContext({
            credentials: runtime.credentials, mode: 'blocking', refresh: 'force', publication: 'invocation', honorAccountSettingsModeEnv: false,
            shouldCommit: () => !cancellationSignal.aborted }));
          if (snapshot.source !== 'network' || cancellationSignal.aborted) throw Object.assign(new Error('saved_secret_unavailable'), { code: 'saved_secret_unavailable' });
          secretContext = createInvocationSavedSecretOperationContextV1({ credentials: runtime.credentials, snapshot,
            serverHttpBaseUrl: runtime.serverHttpBaseUrl, isCurrent: isActive });
          const references = scriptSources.flatMap(setup => setup.secretRefs
            ? listSecretReferenceOverlayV1BindingNames(setup.secretRefs).map(name => readSecretReferenceOverlayV1Reference(setup.secretRefs!, name)!) : []);
          const secrets = await refreshSavedSecretCatalogForOperation({ expectedScopeKey: resolveAccountSettingsScopeKeyForToken(runtime.credentials.token),
            references, operationContext: secretContext, signal: cancellationSignal });
          if (cancellationSignal.aborted) throw Object.assign(new Error('saved_secret_unavailable'), { code: 'saved_secret_unavailable' });
          secretEnvironment = { accountSettings: secrets.settings, settingsSecretsReadKeys: secrets.settingsSecretsReadKeys,
            savedSecretResources: secrets.savedSecretResources };
        }
        if (cancellationSignal.aborted) return fail('cancelled');
        const io = createProjectNativeIo({ ownerRemainder: params.ownerRemainder }).environmentIo.createInvocation({ signal: cancellationSignal, retainCapture: custody.retain });
        let elevation: Parameters<typeof applyMachineSetup>[0]['elevation'];
        if (input.recipePlans.length || input.removalPlans?.length) {
          elevation = { ...administrator, installationId: params.installation.installationId, installedCli: resolveInstalledMachineEffectCli(),
            verifyCurrent: isActive };
        }
        const nativeInput = { homeId: input.homeId, machineId: input.machineId,
          ...(creation ? { preset: creation.preset } : {}), requesterAccountId, userHomeDirectory: homedir(),
          ...(elevation ? { elevation } : {}), operation, signal: cancellationSignal, terminalSessions,
          settleNative: () => custody.release(),
          onSetupApplied: (plans, result) => {
            if (!result.initialPresence) return;
            const firstPresence = result.initialPresence;
            const nativeSourceFacts = observeInitialPresence(sources, input.recipePlans.map(entry => ({ ...entry,
              initialPresence: firstPresence[plans.indexOf(entry.plan)] ?? 'unknown',
            })));
            for (const source of sources) {
              const origin = machineSetupSourceOriginKeyV1(source);
              observedSourceFacts[origin] = { ...observedSourceFacts[origin],
                firstPresence: nativeSourceFacts[origin]?.firstPresence };
            }
          },
          onAdmitted: async () => {
            await report('running'); reportedRunning = Boolean(creation);
          },
          isCurrent: isActive,
          environmentIo: io, ...(creation ? { managedId: creation.managedId } : {}),
          resolveSetupScriptServiceEffects: async (serviceIds: readonly string[]) => {
            const lease = await acquireRecipes();
            return await lease.registry.projectManagedServices.resolveSetupScriptServiceEffects({
              serverId: input.homeId, machineId: input.machineId, serviceIds, signal: cancellationSignal,
            });
          },
          terminalCustody: { kind: 'machine', serverId: params.homeId, machineId: params.machineId,
            homeServerIdentityId: context.externalActionExecutionAuthorization!.binding.serverIdentityId,
            installationId: params.installation.installationId, requesterAccountId, rootPath: homedir() } } satisfies
          Omit<Parameters<typeof applyMachineSetup>[0], 'setup' | 'recipePlans'>;
        nativeStarted = true;
        const result = mode === 'remove' ? await removeMachineSetup({ ...nativeInput,
          plans: (planned.removalPlans ?? []).map(entry => entry.plan) })
          : await applyMachineSetup({ ...nativeInput, setup: [...setups], recipePlans: input.recipePlans,
            removalPlans: planned.removalPlans, exclusions, ...(sourceChange ? { sourceChange } : {}),
            ...(secretEnvironment ? { secretEnvironment } : {}) }, prepared);
        // Read-only preparation can fail before native admission. Its captures
        // still belong to this operation and must physically settle as well.
        await custody.release();
        // An unconfirmed physical outcome is retained by the same finite
        // owner; it is not a failed creation stage or permission to retry.
        if (!result.ok && (result.errorCode === 'outcome_uncertain' || result.errorCode === 'outcome_unknown' || result.errorCode === 'stop_unconfirmed'
          || result.errorCode === 'native_toolchain_termination_incomplete' || result.errorCode === 'plugin_exec_termination_incomplete')) return result;
        if (result.ok) {
          if (cancellationSignal.aborted) return fail('cancelled');
          const written = await desired.apply({ expectedDesiredRevision: current.policy.revision, sources,
            exclusions, observedSourceFacts }, { signal: cancellationSignal });
          if (written.status !== 'applied' && written.status !== 'unchanged' && written.status !== 'satisfied') {
            const code = written.status === 'conflict' ? 'plan_changed' : `machine_setup_content_${written.status}`;
            throw Object.assign(new Error(code), { code });
          }
        }
        if (reportedRunning) await report(result.ok ? 'succeeded' : 'failed', result.ok ? undefined : result.errorCode);
        return result;
      } catch (error) {
        // Capture release waits on physical native process settlement, even
        // when cancellation or an uncertain native observation preceded it.
        await custody.release();
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code : cancellationSignal.aborted ? 'cancelled' : 'machine_setup_apply_failed';
        try { if (reportedRunning) await report('failed', code); } catch { return fail('machine_setup_report_failed'); }
        return fail(code);
      } finally {
        try { await recipeLease?.release(); }
        finally {
          custody.dispose(); secretContext?.withdrawCatalog();
          if (nativeStarted) {
            try { await params.apiMachine.refreshMachineSetupUpdates(); }
            catch (error) { logger.warn('[Machine setup] Updates observation refresh failed after settlement', error); }
          }
        }
      }
    };
    // Detached replay has no retained operation. Bind observation once, as the
    // managed native adapter does; an update port alone is not acceptance.
    const result = context.operationAcceptance && context.operationOwnerUpdate ? await run({ ...context, actionRequestId: context.actionRequestId ?? undefined,
      resumeActionRequest: context.resumeActionRequest === true ? true : undefined,
      signal: context.signal ?? lifetime, operationOwnerUpdate: context.operationOwnerUpdate,
      operationProgress: context.operationProgress ?? { update() {} } })
      : await params.apiMachine.observeActionExecution({ actionId: mode === 'remove' ? 'machines.setup.remove' : 'machines.setup.apply', input, actionRequestId: context.actionRequestId ?? undefined,
        rpcContext: context, execute: run });
    return result.ok ? result.result : result;
  };
}
