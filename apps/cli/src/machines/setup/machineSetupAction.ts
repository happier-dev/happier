import { prepareMachineSetupSecretEnvironment } from './secretEnvironment';
import { MACHINE_SETUP_APPLY_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { PluginError } from '@happier-dev/plugin-sdk';
import { observeMachineSetupInitialPresence } from './initialPresence';
import { homedir } from 'node:os';
import type { ActionExecuteResult, ActionExecutorDeps } from '@happier-dev/protocol';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { MachineSetupResolveResultV1Schema, MachineSetupResolvedSourceV1Schema, type MachineSetupReportInputV1,
  machineSetupSourceApplyOriginKeyV1,
  type MachineSetupResolvedSourceV1, type MachineSetupSourceApplyV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineSetupNativeSshHostKeyV1 } from '@happier-dev/protocol/machines/setup/backupReceiverV1';
import type { MachineSetupApplyTargetV1, MachineSetupRemoveInputV1, MachineSetupPlanResultV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createActionExecuteFailureError, projectActionFailureCauseV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { isMachineSetupRecipeItemV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { machineSetupSourceOriginKeyV1, reviewMachineSetupSourceChangeV1,
  MachineSetupSourceV1Schema, type MachineSetupDesiredV1, type MachineSetupSourceV1 } from '@happier-dev/protocol';
import { mutateMachineSetupDesiredV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { createProjectNativeInvocationCustody, type ProjectSetupOperationContext } from '@/workspaces/projectSetup/projectSetupExecution';
import { applyMachineSetup, removeMachineSetup, prepareMachineSetupStages, isMachineSetupResultUnsettled } from './applyMachineSetup';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';
import { projectBackupReceiverPlanResults } from './backupReceiverResult';
import type { OwnerRemainderPort } from '@/daemon/processes/endOwnerRemainder';
import { prepareMachineSetupPlanV1, type MachineSetupLocalPlanInputV1, type MachineSetupLocalPlanResultV1 } from './prepareMachineSetupPlan';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import { buildPluginProjectionFamilyV2 } from '@/plugins/projection/families';
import { machineRecipesProjectionFamily, machineSetupPresetsProjectionFamily } from '@/plugins/projection/registry/machineRecipes';
import type { MachineSetupNativeCommand, MachineSetupNativeCommandResult } from '@happier-dev/cli-common/machineSetup';
import { resolveMachineEffectCli } from '../adminAccess/machineEffectCli';
import { machineSetupTargetUnavailable, requestMachineSetupHome, type MachineSetupInstallation } from './machineSetupHomeRequest';
import { hasOnlyLocalSetupSources } from './machineSetupPlanHomeSources';
import { prepareMachineSetupApps, type MachineSetupAppPreparationHost } from './prepareMachineSetupApps';
import { prepareMachineSetupAcceptedAppRuns } from './acceptedAppRuns';
import { machineSetupPlansRequireAdministratorV1 } from '@happier-dev/cli-common/machineSetup';
import { prepareMachineSetupUpdatesPlanV1 } from './machineSetupUpdatesAction';
import { logger } from '@/ui/logger';
import type { AccessProviderSelectionV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { withReachabilityJoinCredential } from '../reachability/prepareReachabilityJoinCredential';
import { builtinTailscaleMembershipSelection } from '../reachability/readMachineReachability';
import { accessProviderRefsEqualV1 } from '@happier-dev/protocol/plugins/contributions/accessProviders';
import { createManagedPresetHydrator } from '../managed/presetHydration';
import { readRequesterAccountActionTransportContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { hydrateManagedOpaqueSetupSourcesV1, projectManagedOpaqueSetupSourcesV1,
  readRetainedManagedOpaqueSetupSourcesV1 } from '@happier-dev/cli-common/machines/managed';

export type MachineSetupTargetAction = (params: Readonly<{
  input: MachineSetupApplyTargetV1; context: RpcActionExecutorContext; signal?: AbortSignal;
}>) => Promise<unknown>;


function actionSourcesForHome(sources: MachineSetupSourceApplyV1,
  retained: ReadonlyMap<string, MachineSetupSourceV1[number]> = new Map()): MachineSetupSourceApplyV1 {
  // Bundled presets are already locally declared and checked below. The Home
  // resolver owns only saved-preset recipient projections plus the direct arm.
  return sources.filter(source => source.kind !== 'bundledPreset' && !retained.has(machineSetupSourceApplyOriginKeyV1(source)));
}

type HomeSetupCopyRequest = Readonly<{ sources: MachineSetupSourceApplyV1 }>
  | Readonly<{ candidatePreset: Readonly<{ presetId: string; presetRevision: number }> }>;
type HomeSetupCopyResult = ReturnType<typeof MachineSetupResolveResultV1Schema.parse>;

function readMachineSetupCandidateScope(current: MachineSetupDesiredV1, candidate: NonNullable<MachineSetupApplyTargetV1['candidatePreset']>) {
  const index = current.sources.findIndex(source => source.kind === 'accountPreset' && source.presetId === candidate.presetId);
  const attached = current.sources[index];
  if (attached?.kind !== 'accountPreset' || candidate.presetRevision < attached.presetRevision) return null;
  if (candidate.presetRevision > attached.presetRevision) return { index, attached, mode: 'update' as const };
  return current.sourceFacts?.[machineSetupSourceOriginKeyV1(attached)]?.pendingScripts?.length
    ? { index, attached, mode: 'recovery' as const } : null;
}

/** Signed creation keeps its original snapshot; ordinary edits resolve only new copies. */
async function resolveHomeMachineSetupCopies(sources: MachineSetupSourceApplyV1, creation: boolean,
  request: (body: HomeSetupCopyRequest) => Promise<unknown>): Promise<HomeSetupCopyResult | null> {
  if (creation) {
    const result = MachineSetupResolveResultV1Schema.safeParse(await request({ sources }));
    return result.success ? result.data : null;
  }
  const resolved = await Promise.all(sources.map(async source => {
    if (source.kind !== 'accountPresetOpaque') return source;
    const result = MachineSetupResolveResultV1Schema.safeParse(await request({ candidatePreset: {
      presetId: source.presetId, presetRevision: source.presetRevision,
    } }));
    if (!result.success || !('sources' in result.data)) return null;
    const copy = result.data.sources.find(candidate => candidate.kind === 'accountPresetOpaque');
    return copy?.kind === 'accountPresetOpaque' ? { ...copy,
      ...(source.presetContentOverride === undefined ? {} : { presetContentOverride: source.presetContentOverride }) } : null;
  }));
  if (resolved.some(source => source === null)) return null;
  return { sources: resolved.filter(source => source !== null) };
}

async function resolveLocalMachineSetupSources(params: Readonly<{
  sources: MachineSetupSourceApplyV1;
  resolved: HomeSetupCopyResult | null;
  runtime: Pick<NonNullable<Awaited<ReturnType<ApiMachineClient['resolveMachineSetupRuntime']>>>, 'credentials' | 'serverHttpBaseUrl'>;
  context: RpcActionExecutorContext;
  retained?: ReadonlyMap<string, MachineSetupSourceV1[number]>;
  signal?: AbortSignal;
}>): Promise<Readonly<{ sources: MachineSetupSourceV1; resolvedSources: MachineSetupResolvedSourceV1;
  creation?: Readonly<{ managedId: string; preset: Readonly<{ id: string; revision: number }> }> }> | null> {
  const resolved = params.resolved;
  if (!resolved || !('sources' in resolved)) return null;
  const pending = params.sources.filter(source => !params.retained?.has(machineSetupSourceApplyOriginKeyV1(source)));
  const requested = actionSourcesForHome(pending);
  let responseIndex = 0;
  const aligned = pending.map(source => source.kind === 'bundledPreset'
    ? source : resolved.sources[responseIndex++]);
  if (responseIndex !== resolved.sources.length) return null;
  const resolvedSources = MachineSetupResolvedSourceV1Schema.safeParse(aligned);
  if (!resolvedSources.success) return null;
  const finish = (sources: MachineSetupSourceV1) => {
    let index = 0;
    return { sources: params.sources.map(source => params.retained?.get(machineSetupSourceApplyOriginKeyV1(source)) ?? sources[index++]!),
      resolvedSources: resolvedSources.data,
      ...(resolved.creation === undefined ? {} : { creation: resolved.creation }) };
  };
  if (hasOnlyLocalSetupSources(pending)) {
    if (!sameStrictJsonValue(resolved.sources, requested)) return null;
    return finish(pending);
  }
  // Home selects the actor's recipient envelope; installed custody still owns native effects.
  const requester = readRequesterAccountActionTransportContext(params.context.externalActionExecutionAuthorization);
  const binding = params.context.externalActionExecutionAuthorization?.binding;
  const foreignWithoutCustody = !requester && binding !== undefined && binding.accountId !== binding.custodianAccountId;
  const hydrator = createManagedPresetHydrator({ credentials: requester?.credentials ?? params.runtime.credentials,
    serverUrl: params.runtime.serverHttpBaseUrl });
  const opened = await hydrateManagedOpaqueSetupSourcesV1({ sources: requested, resolvedSources: resolved.sources,
    open: async source => {
      // Another person's E2EE copy opens only with their own admitted custody, never the custodian's key.
      // Plain content is server-readable by contract and uses no key.
      if (foreignWithoutCustody && source.mode === 'e2ee') throw createActionExecuteFailureError({ ok: false,
        errorCode: 'requester_account_context_unavailable', error: 'requester_account_context_unavailable', effectAttempted: false });
      return await hydrator.openRecipientProjection({ presetId: source.presetId,
        mode: source.mode, projection: source.projection, signal: params.signal });
    } });
  if (!opened) return null;
  let index = 0;
  const local = pending.map(source => source.kind === 'bundledPreset' ? source : opened[index++]);
  if (index !== opened.length) return null;
  const parsed = MachineSetupSourceV1Schema.safeParse(local);
  return parsed.success ? finish(parsed.data) : null;
}

function projectMachineSetupPlanResult(result: MachineSetupLocalPlanResultV1,
  resolvedSources?: MachineSetupResolvedSourceV1, wireSources?: MachineSetupSourceApplyV1): MachineSetupPlanResultV1 {
  const sources = wireSources ?? projectManagedOpaqueSetupSourcesV1(result.sources);
  if (resolvedSources === undefined) return { ...result, sources };
  const projections = new Map(resolvedSources.map(source => [machineSetupSourceApplyOriginKeyV1(source), source]));
  return { ...result, sources, resolvedSources: sources.map(source => source.kind === 'accountPresetOpaque'
    ? projections.get(machineSetupSourceApplyOriginKeyV1(source)) ?? null : source) };
}

/** Saved copies use the captured content port; new selections demand exact native checks. */
export function createMachineSetupPlanAction(params: Readonly<{
  apiMachine: Pick<ApiMachineClient, 'getMachineSetupDesiredSnapshot'> & Partial<Pick<ApiMachineClient,
    'resolveMachineSetupRuntime' | 'captureMachineAdminAccess' | 'refreshMachineSetupUpdates' | 'publishMachineSetupUpdates'
    | 'getMachineSetupObservationSnapshot'>>;
  machineId: string; homeId: string;
  installation?: MachineSetupInstallation;
  acquirePluginRuntimeRegistryLease?: () => Promise<PluginRuntimeRegistryLease>;
  runNative?: (command: MachineSetupNativeCommand) => Promise<MachineSetupNativeCommandResult>;
  appPreparation?: MachineSetupAppPreparationHost;
}>): NonNullable<ActionExecutorDeps['machineSetupPlan']> {
  return async ({ input, context, signal }: Parameters<NonNullable<ActionExecutorDeps['machineSetupPlan']>>[0]
    & Readonly<{ context: RpcActionExecutorContext }>) => {
    const fail = (code: string) => ({ ok: false as const, errorCode: code, error: code });
    const withAdministratorPrerequisite = async (plan: MachineSetupPlanResultV1 | ActionExecuteFailure): Promise<MachineSetupPlanResultV1 | ActionExecuteFailure> => {
      if ('errorCode' in plan || plan.review?.administratorRequired !== true) return plan;
      // The same captured policy consumed by elevation owns None. Ask remains
      // usable with attendance. Setup observes protected firewall facts without prompting.
      const access = params.apiMachine.captureMachineAdminAccess?.();
      if (!access || (await access.readPolicy()).mode !== 'none') return plan;
      return { ...plan, review: { ...plan.review, administratorUnavailable: { reasonCode: 'mode_none' } } };
    };
    if ('targets' in input) return fail('target_mismatch');
    if ((signal ?? context.signal)?.aborted) return fail('cancelled');
    if (input.machineId !== params.machineId || input.homeId !== params.homeId) return fail('target_mismatch');
    if (context.machineAdmission && (context.machineAdmission.machineId !== params.machineId
      || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent())) return fail('machine_admission_changed');
    const { sources: wireSources, candidatePreset, ...inputWithoutSources } = input;
    let reviewedWireSources = wireSources;
    let localInput: MachineSetupLocalPlanInputV1 = inputWithoutSources;
    let resolvedSources: MachineSetupResolvedSourceV1 | undefined;
    let candidateScope: NonNullable<ReturnType<typeof readMachineSetupCandidateScope>> | undefined;
    const current = await params.apiMachine.getMachineSetupDesiredSnapshot();
    if ((signal ?? context.signal)?.aborted) return fail('cancelled');
    const requestHomeSources = async (body: HomeSetupCopyRequest) => {
      const lifetime = signal ?? context.signal;
      let runtimeRefusal: Parameters<typeof machineSetupTargetUnavailable>[1];
      const runtime = await params.apiMachine.resolveMachineSetupRuntime!({ ...(lifetime ? { signal: lifetime } : {}),
        onUnavailable: reason => { runtimeRefusal = reason; },
        ...(context.machineAdmission ? { machineAdmission: context.machineAdmission } : {}),
        ...(context.verifyMachineAdmissionCurrent ? { verifyMachineAdmissionCurrent: context.verifyMachineAdmissionCurrent } : {}) });
      if (!runtime || !runtime.isCurrent || !await runtime.isCurrent()) return {
        failure: machineSetupTargetUnavailable('installed_runtime', runtimeRefusal ?? 'runtime_closed'),
      };
      const request = async (copy: HomeSetupCopyRequest) => await requestMachineSetupHome({ runtime, context,
        installation: params.installation!, homeId: params.homeId, actionId: 'machines.setup.plan',
        path: '/v1/machines/setup/resolve', body: { homeId: input.homeId, machineId: input.machineId, ...copy },
        presetReview: candidatePreset !== undefined,
        ...(lifetime ? { signal: lifetime } : {}) });
      if ('sources' in body) return { runtime, admitted: await resolveHomeMachineSetupCopies(body.sources,
        context.externalActionExecutionAuthorization?.binding.managedContinuation !== undefined, request) };
      const result = MachineSetupResolveResultV1Schema.safeParse(await request(body));
      return { runtime, admitted: result.success ? result.data : null };
    };
    const resolveHomeSources = async (body: HomeSetupCopyRequest, sources?: MachineSetupSourceApplyV1,
      retained?: ReadonlyMap<string, MachineSetupSourceV1[number]>): Promise<
        { failure: ActionExecuteFailure } | { sources: MachineSetupSourceV1 }
      > => {
      const request = await requestHomeSources(body);
      if (request.failure) return { failure: request.failure };
      const { runtime, admitted } = request;
      if (!admitted || !('sources' in admitted)) return { failure: fail('machine_setup_response_invalid') };
      const references = sources ?? admitted.sources.map(source => {
        if (source.kind !== 'accountPresetOpaque') return source;
        const { presetContent: _content, ...reference } = source;
        return reference;
      });
      const resolved = await resolveLocalMachineSetupSources({ sources: references, resolved: admitted, runtime, context,
        signal: signal ?? context.signal, ...(retained ? { retained } : {}) });
      if (!resolved) return { failure: fail('machine_setup_response_invalid') };
      if (!await runtime.isCurrent()) return { failure: machineSetupTargetUnavailable('installed_runtime', 'runtime_closed') };
      resolvedSources = resolved.resolvedSources;
      return { sources: resolved.sources };
    };
    if (candidatePreset !== undefined) {
      if (current.status !== 'ready') return fail(`machine_setup_content_${current.status}`);
      if (!params.installation || !params.apiMachine.resolveMachineSetupRuntime) return fail('admission_unavailable');
      const scope = readMachineSetupCandidateScope(current.policy, candidatePreset);
      if (!scope) return fail('plan_changed');
      try {
        const opened = await resolveHomeSources({ candidatePreset });
        if ('failure' in opened) return opened.failure;
        const candidate = opened.sources.find(source => source.kind === 'accountPreset'
          && source.presetId === candidatePreset.presetId && source.presetRevision === candidatePreset.presetRevision);
        if (!candidate || opened.sources.length !== 2) return fail('machine_setup_response_invalid');
        if (scope.mode === 'recovery' && !sameStrictJsonValue(scope.attached, candidate)) return fail('plan_changed');
        candidateScope = scope;
        localInput = { ...inputWithoutSources, sources: scope.mode === 'recovery' ? current.policy.sources
          : current.policy.sources.map((source, index) => index === scope.index ? candidate : source) };
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code : (signal ?? context.signal)?.aborted ? 'cancelled' : 'machine_setup_request_failed';
        return { ok: false, ...normalizeActionExecutorThrownError(error, 'machines.setup.plan'), errorCode: code };
      }
    } else if (wireSources !== undefined) {
      const managedContinuation = context.externalActionExecutionAuthorization?.binding.managedContinuation;
      const needsOpaqueOpen = !hasOnlyLocalSetupSources(wireSources);
      if ((managedContinuation && input.mode !== 'effects') || ((managedContinuation || needsOpaqueOpen)
        && (!params.installation || !params.apiMachine.resolveMachineSetupRuntime))) return fail('admission_unavailable');
      try {
        let localSources: MachineSetupSourceV1;
        if (!managedContinuation && !needsOpaqueOpen) {
          localSources = wireSources;
        } else {
          const retained = !managedContinuation && current.status === 'ready'
            ? readRetainedManagedOpaqueSetupSourcesV1(wireSources, current.policy.sources) : undefined;
          const opened = await resolveHomeSources({ sources: actionSourcesForHome(wireSources, retained) }, wireSources, retained);
          if ('failure' in opened) return opened.failure;
          localSources = opened.sources;
        }
        localInput = { ...inputWithoutSources, sources: localSources };
        const capturedSources = localSources;
        reviewedWireSources = wireSources.map((source, index) => {
          const local = capturedSources[index];
          return source.kind === 'accountPresetOpaque' && local?.kind === 'accountPreset' && local.setupRevision !== undefined
            ? { ...source, setupRevision: local.setupRevision } : source;
        });
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code : (signal ?? context.signal)?.aborted ? 'cancelled' : 'machine_setup_request_failed';
        return { ok: false, ...normalizeActionExecutorThrownError(error, 'machines.setup.plan'), errorCode: code };
      }
    }
    // Current setup is the admitted local copy. Only an explicit proposal
    // resolves new preset content; source edits or access loss cannot withdraw it.
    if (input.updates) {
      if (current.status !== 'ready') return fail(`machine_setup_content_${current.status}`);
      if (!params.apiMachine.refreshMachineSetupUpdates || !params.apiMachine.publishMachineSetupUpdates) return fail('target_unavailable');
      const options = { ...(signal ?? context.signal ? { signal: signal ?? context.signal } : {}),
        ...(params.runNative ? { runNative: params.runNative } : {}) };
      try {
        const updates = input.mode === 'effects'
          ? await prepareMachineSetupUpdatesPlanV1({ machineId: params.machineId, ...input.updates, ...options })
          : { observation: await params.apiMachine.refreshMachineSetupUpdates(options) };
        if (input.mode === 'effects') await params.apiMachine.publishMachineSetupUpdates(updates.observation);
        return withAdministratorPrerequisite(projectMachineSetupPlanResult({ desiredRevision: current.policy.revision, sources: current.policy.sources,
          exclusions: current.policy.exclusions, support: [], updates,
          ...(input.mode === 'effects' ? { review: { target: { homeId: input.homeId, machineId: input.machineId },
            administratorRequired: 'plan' in updates && updates.plan ? machineSetupPlansRequireAdministratorV1([updates.plan]) : null,
            downtime: 'plan' in updates && updates.plan
              ? input.updates.hold || !updates.plan.steps.length ? 'none' as const : 'possible' as const
              : 'unknown' as const,
          } } : {}),
        }));
      } catch (error) {
        const code = (signal ?? context.signal)?.aborted ? 'cancelled'
          : error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code : 'machine_setup_request_failed';
        return fail(code);
      }
    }
    let registryLease: PluginRuntimeRegistryLease | undefined;
    const readRegistry = async () => {
      const acquire = params.acquirePluginRuntimeRegistryLease
        ?? (await import('@/plugins/runtime/reload/runtimeLease')).acquireAuthoritativePluginRuntimeRegistryLease;
      registryLease ??= await acquire();
      return registryLease.registry;
    };
    let result: Awaited<ReturnType<typeof prepareMachineSetupPlanV1>>;
    const administrator = params.apiMachine.captureMachineAdminAccess?.();
    const installationId = params.installation?.installationId;
    const requestId = context.actionRequestId;
    const lifetime = signal ?? context.signal;
    try {
      result = await prepareMachineSetupPlanV1({ input: localInput, current, candidate: candidateScope,
        observation: params.apiMachine.getMachineSetupObservationSnapshot?.(),
        ...(installationId ? { installationId } : {}),
        ...(administrator ? { readAdminAccessObservation: administrator.observe } : {}),
        ...(administrator && installationId && requestId ? { firewallObservation: { requestId,
          elevation: () => ({ ...administrator, installationId, ...resolveMachineEffectCli(),
            verifyCurrent: async () => !lifetime?.aborted }),
        } } : {}),
        ...(lifetime ? { signal: lifetime } : {}),
        ...(params.runNative ? { runNative: params.runNative } : {}), readRecipes: async () => {
          const registry = await readRegistry();
          return Object.values(buildPluginProjectionFamilyV2({ registry: registry.contributes,
            generation: registry.generation }, machineRecipesProjectionFamily).entriesById);
        }, reviewAffectedServices: async serviceIds => {
          try {
            const registry = await readRegistry();
            await registry.projectManagedServices.resolveSetupScriptServiceEffects({
              serverId: input.homeId, machineId: input.machineId, serviceIds, signal: lifetime,
            });
            return undefined;
          } catch (error) {
            if (lifetime?.aborted) return fail('cancelled');
            if (error instanceof PluginError && error.code === 'plugin_managed_service_unavailable') return fail(error.code);
            throw error;
          }
        },
      });
    } finally { await registryLease?.release(); }
    if ((signal ?? context.signal)?.aborted) return fail('cancelled');
    if ('errorCode' in result) return result;
    if (params.installation && result.recipePlans) {
      const backupReceivers = projectBackupReceiverPlanResults({ machineId: params.machineId,
        installationId: params.installation.installationId, entries: result.recipePlans });
      if (backupReceivers.length) result = { ...result, backupReceivers };
    }
    const appPrepared = await prepareMachineSetupApps(localInput, result, { ...context, ...(signal ? { signal } : {}) }, {
      ...params.appPreparation, ...(params.installation ? { installationId: params.installation.installationId } : {}),
    });
    return withAdministratorPrerequisite('errorCode' in appPrepared ? appPrepared : projectMachineSetupPlanResult({ ...appPrepared,
      ...(candidatePreset === undefined ? {} : { candidatePreset }),
    }, resolvedSources,
      current.status === 'ready' && current.policy.sources.some(source => source.kind === 'accountPreset') || wireSources?.some(source => source.kind === 'accountPresetOpaque')
        ? reviewedWireSources : undefined));
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
  ingress?: Pick<RpcHandlerContext, 'signal' | 'verifyMachineAdmissionCurrent'>;
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
    const fail = (code: string): ActionExecuteFailure => ({ ok: false, errorCode: code, error: code });
    const lifetime = signal ?? context.signal ?? new AbortController().signal;
    if (input.machineId !== params.machineId || input.homeId !== params.homeId) return fail('target_mismatch');
    const admission = context.machineAdmission;
    const authorization = context.externalActionExecutionAuthorization;
    if (!authorization) return fail('admission_unavailable');
    if (admission && (admission.machineId !== params.machineId || admission.installationId !== params.installation.installationId
      || !context.verifyMachineAdmissionCurrent)) return fail('machine_admission_changed');
    let runtimeRefusal: Parameters<typeof machineSetupTargetUnavailable>[1];
    const runtime = await params.apiMachine.resolveMachineSetupRuntime({ signal: lifetime,
      onUnavailable: reason => { runtimeRefusal = reason; },
      ...(admission ? { machineAdmission: admission } : {}),
      ...(context.verifyMachineAdmissionCurrent ? { verifyMachineAdmissionCurrent: context.verifyMachineAdmissionCurrent } : {}) });
    if (!runtime || runtime.machineId !== params.machineId || !runtime.isCurrent || !await runtime.isCurrent())
      return machineSetupTargetUnavailable('installed_runtime', runtimeRefusal);
    const terminalSessions = params.apiMachine.getFiniteTerminalSessions();
    if (!terminalSessions) return machineSetupTargetUnavailable('finite_terminal');
    const custodianAccountId = readAccountIdFromToken(runtime.credentials.token);
    if (!custodianAccountId || admission && admission.custodianAccountId !== custodianAccountId) return fail('credential_unavailable');
    const requesterAccountId = admission?.actorAccountId ?? custodianAccountId;
    const request = async (path: string, body: unknown, requestSignal?: AbortSignal, presetReview = false): Promise<unknown> => {
      return requestMachineSetupHome({ runtime, context, installation: params.installation, homeId: params.homeId,
        actionId: mode === 'remove' ? 'machines.setup.remove' : 'machines.setup.apply', path, body, presetReview,
        ...(requestSignal ? { signal: requestSignal } : {}) });
    };
    const run = async (operation: ProjectSetupOperationContext): Promise<ActionExecuteResult> => {
      const operationId = operation.operationAcceptance?.operationId ?? operation.actionRequestId;
      const cancellationSignal = AbortSignal.any([operation.signal, lifetime]);
      if (!operationId || cancellationSignal.aborted) return fail(cancellationSignal.aborted ? 'cancelled' : 'admission_unavailable');
      const custody = createProjectNativeInvocationCustody(operation);
      let secrets: Awaited<ReturnType<typeof prepareMachineSetupSecretEnvironment>> | undefined;
      let processCredentials: Promise<Awaited<ReturnType<ApiMachineClient['prepareConnectedAccountProcessEnvironment']>>> | undefined;
      let creation: Readonly<{ managedId: string; preset: Readonly<{ id: string; revision: number }> }> | undefined;
      let recipeLease: PluginRuntimeRegistryLease | undefined;
      const acquireRecipes = async () => recipeLease ??= await (
        (await import('@/plugins/runtime/reload/runtimeLease')).acquireAuthoritativePluginRuntimeRegistryLease)();
      let reportedRunning = false;
      let nativeStarted = false;
      let tailnetReconnect: Awaited<ReturnType<ApiMachineClient['admitTailnetMembershipReconnect']>>;
      let receiverHostKeys: readonly MachineSetupNativeSshHostKeyV1[] = [];
      const phase = mode === 'remove' ? 'machines.setup.remove' : 'machines.setup.apply';
      const report = async (state: 'running' | 'succeeded' | 'failed', errorCode?: string) => {
        if (!creation) return;
        try {
          await request('/v1/machines/setup/report', { homeId: input.homeId, machineId: input.machineId,
            presetId: creation.preset.id, presetRevision: creation.preset.revision, managedId: creation.managedId, state,
            operation: { operationId }, ...(errorCode ? { errorCode } : {}) } satisfies MachineSetupReportInputV1);
        } catch (error) {
          if (state === 'running') throw error;
          // Publishing a settled outcome cannot replace the native result.
          logger.warn('[Machine setup] Native outcome report failed', projectActionFailureCauseV1(error, phase));
        }
      };
      try {
        const desired = params.apiMachine.captureMachineSetupDesired();
        const current = await desired.read();
        if (current.status !== 'ready') return fail(`machine_setup_content_${current.status}`);
        const candidateScope = input.candidatePreset ? readMachineSetupCandidateScope(current.policy, input.candidatePreset) : undefined;
        if (candidateScope === null) return fail('plan_changed');
        // A failed script publishes the approved sources and its unfinished
        // ordinals. Exact Workflow retry keeps the frozen review, while the
        // desired owner supplies that progress; ordinary stale reviews still fail.
        const mayContinueScripts = mode === 'apply' && input.removeItemKeys === undefined
          && current.policy.revision > input.desiredRevision
          && authorization.binding.workflowActionOrigin !== undefined
          && Object.values(current.policy.sourceFacts ?? {}).some(facts => facts.pendingScripts?.length);
        if (current.policy.revision !== input.desiredRevision && !mayContinueScripts) return fail('plan_changed');
        // Admission captured this desired snapshot and installed runtime once.
        // Finite stages consume it; only local cancellation retires this work.
        // Final publication still uses the desired owner's revision-aware CAS.
        const isActive = async () => !cancellationSignal.aborted;
        const managedContinuation = context.externalActionExecutionAuthorization?.binding.managedContinuation;
        const wireSources = input.sources;
        let sources: MachineSetupSourceV1;
        const retained = managedContinuation ? undefined : readRetainedManagedOpaqueSetupSourcesV1(wireSources, current.policy.sources);
        if (managedContinuation || !hasOnlyLocalSetupSources(wireSources)) {
          const resolved = await resolveHomeMachineSetupCopies(actionSourcesForHome(wireSources, retained),
            managedContinuation !== undefined, async body => await request('/v1/machines/setup/resolve', {
              homeId: input.homeId, machineId: input.machineId, ...body,
            }, cancellationSignal, input.candidatePreset !== undefined));
          const opened = await resolveLocalMachineSetupSources({ sources: wireSources, resolved, runtime, context,
            signal: cancellationSignal, ...(retained ? { retained } : {}) });
          if (!opened) return fail('machine_setup_response_invalid');
          sources = opened.sources;
          creation = opened.creation;
        } else {
          sources = wireSources;
        }
        const originalSources = sources;
        const continuingScripts = mayContinueScripts
          && sameStrictJsonValue(current.policy.pendingScriptSources ?? current.policy.sources, originalSources)
          && sameStrictJsonValue(current.policy.exclusions, input.exclusions ?? current.policy.exclusions);
        if (current.policy.revision !== input.desiredRevision && !continuingScripts) return fail('plan_changed');
        let proposedSources = originalSources;
        if (candidateScope && input.candidatePreset) {
          const { presetId, presetRevision } = input.candidatePreset;
          const { index, attached, mode } = candidateScope;
          const candidate = originalSources[index];
          if (candidate?.kind !== 'accountPreset'
            || candidate.presetId !== presetId || candidate.presetRevision !== presetRevision
            || continuingScripts && mode !== 'recovery'
            || mode === 'recovery' && !sameStrictJsonValue(candidate, attached)) return fail('plan_changed');
          proposedSources = current.policy.sources.map((source, sourceIndex) => sourceIndex === index ? candidate : source);
        }
        const reviewedRecipePlans = continuingScripts ? [] : input.recipePlans;
        if (continuingScripts) sources = current.policy.sources;
        else {
          const change = reviewMachineSetupSourceChangeV1({ currentSources: current.policy.sources,
            currentSourceFacts: current.policy.sourceFacts, proposedSources,
            ...(input.removeItemKeys === undefined ? {} : { removeItemKeys: input.removeItemKeys }) });
          if (!change.ok) return change;
          if (candidateScope && !sameStrictJsonValue(change.sources, originalSources)) return fail('plan_changed');
          sources = change.sources;
        }
        const retainedByOrigin = new Map(current.policy.sources.map(source => [machineSetupSourceOriginKeyV1(source), source]));
        const exclusions = input.exclusions ?? current.policy.exclusions;
        for (const source of sources) {
          const retained = retainedByOrigin.get(machineSetupSourceOriginKeyV1(source));
          if (retained && sameStrictJsonValue(retained, source)) continue;
          if (Object.values(source.setup.secretRefs?.bindings ?? {})
            .some(binding => parseSavedSecretRefV1(binding.ref).kind === 'personal')) {
            // Saved-preset source custody was already verified by the one
            // opaque Home resolve above. Direct and bundled inputs have no
            // such owner projection and retain their existing refusal.
            if (source.kind !== 'accountPreset' && requesterAccountId !== custodianAccountId) return fail('credential_unavailable');
          }
          if (source.kind === 'bundledPreset') {
            const lease = await acquireRecipes();
            const available = Object.values(buildPluginProjectionFamilyV2({ registry: lease.registry.contributes,
              generation: lease.registry.generation }, machineSetupPresetsProjectionFamily).entriesById);
            const preset = available.find(entry => entry.pluginId === source.ref.pluginId
              && entry.definition.id === source.ref.localId && entry.definition.revision === source.ref.revision);
            if (!preset) return fail('machine_setup_preset_unavailable');
            // Input review fills recipe selections; every authored reference, item order and other setup field stays exact.
            const authored = preset.definition.setup;
            const structure = { ...source.setup, ...(source.setup.items ? {
              items: source.setup.items.map((item, index) => {
                const expected = authored.items?.[index];
                return isMachineSetupRecipeItemV1(item) && expected && isMachineSetupRecipeItemV1(expected)
                  ? { ...item, selection: { ...item.selection, inputs: expected.selection.inputs } } : item;
              }),
            } : {}) };
            if (!sameStrictJsonValue(authored, structure)) return fail('machine_setup_preset_unavailable');
          }
        }
        const candidates = projectManagedOpaqueSetupSourcesV1(sources)
          .filter(source => source.kind === 'accountPresetOpaque');
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
        const readElevation = () => ({ ...administrator, installationId: params.installation.installationId,
          ...resolveMachineEffectCli(), verifyCurrent: isActive });
        const setups = sources.map(source => source.setup);
        const sourceChange = { currentSources: current.policy.sources, currentSourceFacts: current.policy.sourceFacts,
          currentExclusions: current.policy.exclusions, sources, candidateSourceIndex: candidateScope?.index,
          mode: candidateScope?.mode ?? (continuingScripts || input.removeItemKeys === undefined
            ? 'recovery' as const : 'update' as const) };
        const prepared = mode === 'remove' ? undefined
          : prepareMachineSetupStages(setups, reviewedRecipePlans, exclusions, sourceChange);
        let credentialSelection: AccessProviderSelectionV1 | undefined;
        const planned = await prepareMachineSetupPlanV1({ readAdminAccessObservation: administrator.observe,
          installationId: params.installation.installationId,
          firewallObservation: { requestId: operationId, elevation: readElevation },
          onCredentialSelection: selection => {
            if (credentialSelection && !sameStrictJsonValue(credentialSelection, selection)) {
              throw Object.assign(new Error('invalid_machine_recipe_inputs'), { code: 'invalid_machine_recipe_inputs' });
            }
            credentialSelection = selection;
          },
          input: { homeId: input.homeId, machineId: input.machineId,
          sources, exclusions, ...(input.removeItemKeys === undefined ? {} : { removeItemKeys: input.removeItemKeys }),
          mode: 'effects' }, current, signal: cancellationSignal,
          ...(prepared?.ok ? { executionSources: prepared.sources } : {}), readRecipes: async () => {
          const lease = await acquireRecipes();
          return Object.values(buildPluginProjectionFamilyV2({ registry: lease.registry.contributes,
            generation: lease.registry.generation }, machineRecipesProjectionFamily).entriesById);
        } });
        if ('errorCode' in planned) return planned;
        // The admitted root owns its exact reviewed plan, including Manage edits.
        // Direct target requests still need the installed recipe's review.
        if (mode === 'apply' && context.operationAcceptance?.actionId !== MACHINE_SETUP_APPLY_ACTION_ID_V1) {
          const recipePlans = planned.recipePlans ?? [];
          if (recipePlans.length !== reviewedRecipePlans.length || recipePlans.some((entry, index) => {
            const reviewed = reviewedRecipePlans[index];
            return !reviewed || entry.sourceIndex !== reviewed.sourceIndex || entry.itemIndex !== reviewed.itemIndex
              || entry.plan.planDigest !== reviewed.plan.planDigest;
          })) return fail('plan_changed');
        }
        const observedSourceFacts = observeMachineSetupInitialPresence(sources, planned.recipePlans ?? []);
        if (prepared && !prepared.ok) return prepared;
        if (mode !== 'remove') {
          const appFacts = await prepareMachineSetupAcceptedAppRuns({ input, localSources: sources, context, isCurrent: isActive,
            signal: cancellationSignal });
          if (!appFacts) return fail('machine_setup_app_preparation_unavailable');
          for (const [origin, facts] of Object.entries(appFacts)) {
            observedSourceFacts[origin] = { ...observedSourceFacts[origin], ...facts };
          }
        }
        secrets = await prepareMachineSetupSecretEnvironment({ credentials: runtime.credentials,
          serverHttpBaseUrl: runtime.serverHttpBaseUrl, sources: prepared?.sources ?? [],
          signal: cancellationSignal, isCurrent: isActive });
        const secretEnvironment = secrets.environment;
        if (cancellationSignal.aborted) return fail('cancelled');
        const io = createProjectNativeIo({ ownerRemainder: params.ownerRemainder }).environmentIo.createInvocation({ signal: cancellationSignal, retainCapture: custody.retain });
        const elevation = reviewedRecipePlans.length || input.removalPlans?.length ? readElevation() : undefined;
        const completedScripts = new Set<number>();
        const ingress = params.ingress;
        const canRetainTailnetDispatch = ingress && credentialSelection
          && accessProviderRefsEqualV1(credentialSelection.provider, builtinTailscaleMembershipSelection.provider);
        const nativeInput = { homeId: input.homeId, machineId: input.machineId,
          ...(canRetainTailnetDispatch ? { onTailnetMembershipDispatch: async () => {
            tailnetReconnect = await params.apiMachine.admitTailnetMembershipReconnect(ingress, cancellationSignal);
          } } : {}),
          produceProcessEnvironment: async (environment: Readonly<Record<string, string>>, processSignal: AbortSignal) => {
            processCredentials ??= params.apiMachine.prepareConnectedAccountProcessEnvironment({
              authorization, requesterAccountId, ...(context.sessionActionOrigin?.caller.sessionId ? { sessionId: context.sessionActionOrigin.caller.sessionId } : {}),
              operationId, actionId: mode === 'remove' ? 'machines.setup.remove' : 'machines.setup.apply', signal: cancellationSignal });
            return await (await processCredentials).produce(environment, processSignal);
          },
          ...(input.preset ? { preset: input.preset } : creation ? { preset: creation.preset } : {}), requesterAccountId, userHomeDirectory: homedir(),
          ...(elevation ? { elevation } : {}), operation, signal: cancellationSignal, terminalSessions,
          settleNative: () => custody.release(),
          onScriptCompleted: index => { completedScripts.add(index); },
          onSetupApplied: (plans, result) => {
            receiverHostKeys = result.sshHostKeys ?? [];
            if (!result.initialPresence) return;
            const firstPresence = result.initialPresence;
            const nativeSourceFacts = observeMachineSetupInitialPresence(sources, reviewedRecipePlans.map(entry => ({ ...entry,
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
          // PTY custody names the admitted runtime's routing profile, like every
          // other terminal owner; the portable Home birth is homeServerIdentityId.
          terminalCustody: { kind: 'machine', serverId: runtime.serverId, machineId: params.machineId,
            homeServerIdentityId: authorization.binding.serverIdentityId,
            installationId: params.installation.installationId, requesterAccountId, rootPath: homedir() } } satisfies Omit<Parameters<typeof applyMachineSetup>[0], 'setup' | 'recipePlans'>;
        const executeNative = (connectorSecretGrant?: NonNullable<typeof elevation>['connectorSecretGrant']) => {
          nativeStarted = true;
          return mode === 'remove' ? removeMachineSetup({ ...nativeInput,
          plans: (planned.removalPlans ?? []).map(entry => entry.plan) })
          : applyMachineSetup({ ...nativeInput, ...(connectorSecretGrant && elevation ? {
            elevation: { ...elevation, connectorSecretGrant },
          } : {}), setup: [...setups], recipePlans: reviewedRecipePlans,
            authoredSource: { sources: wireSources,
              ...(input.candidatePreset === undefined ? {} : { candidatePreset: input.candidatePreset }),
              ...(input.exclusions === undefined ? {} : { exclusions: input.exclusions }),
              ...(input.removeItemKeys === undefined ? {} : { removeItemKeys: input.removeItemKeys }) },
            removalPlans: planned.removalPlans, exclusions, sourceChange,
            ...(secretEnvironment ? { secretEnvironment } : {}) }, prepared);
        };
        const result = credentialSelection && mode === 'apply' ? await (async () => {
          const identity = readInstallationIdentityIfExistsSync();
          if (!identity || identity.installationId !== params.installation.installationId) return fail('credential_unavailable');
          return withReachabilityJoinCredential({ selection: credentialSelection,
            target: { serverId: params.homeId, machineId: params.machineId, installationId: identity.installationId },
            runtime, machineAdmission: { actorAccountId: requesterAccountId, custodianAccountId },
            installationPublicKey: decodeBase64(identity.publicKey, 'base64url'),
            context: { ...context, ...operation, signal: cancellationSignal }, signal: cancellationSignal,
            isCurrent: isActive }, grant => executeNative(grant.grantRequest));
        })() : await executeNative();
        // Read-only preparation can fail before native admission. Its captures
        // still belong to this operation and must physically settle as well.
        await custody.release();
        // An unconfirmed physical outcome is retained by the same finite
        // owner; it is not a failed creation stage or permission to retry.
        if (isMachineSetupResultUnsettled(result)) return result;
        // A confirmed script failure also proves recipes and toolchain finished,
        // even when the first script failed before any completion callback.
        if (result.ok || completedScripts.size > 0 || result.errorCode === 'machine_setup_setup_failed') {
          if (cancellationSignal.aborted) return fail('cancelled');
          const reconnectedPort = await tailnetReconnect?.currentPort(cancellationSignal);
          if (mode === 'apply' && prepared?.ok) {
            let ordinal = 0;
            for (const [sourceIndex, source] of sources.entries()) {
              const origin = machineSetupSourceOriginKeyV1(source);
              const previouslyPending = new Set(candidateScope === undefined ? undefined : current.policy.sourceFacts?.[origin]?.pendingScripts);
              const pendingScripts = (prepared.sources[sourceIndex]?.scripts ?? []).flatMap((script, index) => {
                const completed = completedScripts.has(ordinal++);
                if (script.body) return completed ? [] : [index];
                // A scoped update never claims completion of an omitted script.
                return previouslyPending.has(index) && source.setup.scripts?.[index]?.body ? [index] : [];
              });
              observedSourceFacts[origin] = { ...observedSourceFacts[origin], pendingScripts };
            }
          }
          const desiredWrite = { expectedDesiredRevision: current.policy.revision, sources,
            exclusions, observedSourceFacts,
            ...(!sameStrictJsonValue(sources, originalSources) ? { pendingScriptSources: originalSources } : {}),
          };
          let written = reconnectedPort
            ? await mutateMachineSetupDesiredV1(desiredWrite, reconnectedPort, { signal: cancellationSignal })
            : await desired.apply(desiredWrite, { signal: cancellationSignal });
          if (!reconnectedPort && (written.status === 'locked' || written.status === 'unavailable')) {
            // Admitted, confirmed work finishes: a reconnect with identical content keys
            // writes through the current port under the same revision CAS. A changed key
            // (rotation or revocation) leaves the effects applied and the record unsaved.
            const currentDesired = desired.current();
            if (!currentDesired) {
              throw Object.assign(new Error('machine_setup_record_not_saved'), { code: 'machine_setup_record_not_saved' });
            }
            written = await currentDesired.apply(desiredWrite, { signal: cancellationSignal });
          }
          if (written.status !== 'applied' && written.status !== 'unchanged' && written.status !== 'satisfied') {
            const code = written.status === 'conflict' ? 'plan_changed' : `machine_setup_content_${written.status}`;
            throw Object.assign(new Error(code), { code });
          }
          if (result.ok && mode === 'apply') {
            try { await params.apiMachine.publishMachineSetupApplied(reviewedRecipePlans.map(entry => entry.plan)); }
            catch (error) { logger.warn('[Machine setup] Applied inventory publication failed', error); }
          }
        }
        if (reportedRunning) await report(result.ok ? 'succeeded' : 'failed', result.ok ? undefined : result.errorCode);
        if (result.ok && mode === 'apply') {
          const backupReceivers = projectBackupReceiverPlanResults({ machineId: params.machineId,
            installationId: params.installation.installationId, entries: input.recipePlans,
            nativeHostKeys: receiverHostKeys, planIndexOffset: planned.removalPlans?.length ?? 0 });
          if (backupReceivers.length) return { ok: true, result: {
            ...result.result, backupReceivers,
          } };
        }
        return result;
      } catch (error) {
        // Capture release waits on physical native process settlement, even
        // when cancellation or an uncertain native observation preceded it.
        await custody.release();
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code : cancellationSignal.aborted ? 'cancelled' : 'machine_setup_apply_failed';
        if (reportedRunning) await report('failed', code);
        return { ok: false, ...normalizeActionExecutorThrownError(error, phase), errorCode: code };
      } finally {
        tailnetReconnect?.dispose();
        try { await processCredentials?.then(prepared => prepared.dispose(), () => undefined); }
        finally {
          try { await recipeLease?.release(); }
          finally {
            custody.dispose(); secrets?.dispose();
            if (nativeStarted) {
              try { await params.apiMachine.refreshMachineSetupUpdates(); }
              catch (error) { logger.warn('[Machine setup] Updates observation refresh failed after settlement', error); }
            }
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
