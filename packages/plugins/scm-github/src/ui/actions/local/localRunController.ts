import { PluginError } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated, type PluginActionInputById } from '@happier-dev/plugin-sdk/actions';
import type { PluginUiActionControlController, PluginUiActionControlExecution, PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { pluginJsonValuesEqual, ProtocolWorkspaceWorkerPreferenceMutationResultV1Schema,
  ProtocolWorkspaceWorkerPreferenceReadResultV1Schema } from '@happier-dev/plugin-sdk/protocol';
import type { PluginUiActionOperationHostReadResultV1 } from '@happier-dev/plugin-sdk/protocol';
import {
  LocalActInspectionV1Schema, LocalActRunResultV1Schema, LocalRunSelectionV1Schema, LOCAL_ACT_ACTION_IDS,
  type LocalActInspection, type LocalActRunSeedV1, type LocalActRunFormResult, type LocalRunSelection,
} from '../../../actions/local/contracts.js';
import { buildLocalActCommandV1, projectLocalActRunnerRequirementsV1, validateLocalActWorkflowSelectionV1,
  type LocalActRunnerRequirementsV1 } from '../../../actions/local/command.js';
import { GITHUB_PLUGIN_ID } from '../../../observations/githubProviderContracts.js';

type Preference = LocalActInspection['preference'];
export type LocalRunOperationRef = PluginActionInputById['projects.execution.output.open'];
export type LocalRunSnapshot = Readonly<{
  selection: LocalRunSelection; inspection: LocalActInspection | null; loading: boolean; inspectionError: string | null;
  runnerRequirements: LocalActRunnerRequirementsV1 | null;
  machineDisplayName: string | null;
  permissionPending: boolean; permissionNeedsObservation: boolean;
  permissionResult: PluginUiActionControlExecution | null; lastResult: unknown; error: string | null;
  runState: 'idle' | 'submitting' | 'accepted' | 'uncertain'; operationRef: LocalRunOperationRef | null;
  operation: PluginUiActionOperationHostReadResultV1['operation'];
  operationObservation: PluginUiActionOperationHostReadResultV1['observation'];
  operationWorkspace: LocalRunSelection['workspace'] | null;
}>;

/** Admit an actual host reply once. Outer failures never become domain success. */
function actionValue(response: unknown): unknown {
  if (response !== null && typeof response === 'object' && 'ok' in response) {
    if (response.ok === false) {
      const code = 'errorCode' in response && typeof response.errorCode === 'string' ? response.errorCode : 'local_act_action_failed';
      throw new PluginError({ code });
    }
    if (response.ok === true && 'result' in response) return response.result;
  }
  return response;
}
function keep<T>(before: T | undefined, next: T): T { return before !== undefined && pluginJsonValuesEqual(before, next) ? before : next; }
function keyedRows<T>(before: readonly T[], next: readonly T[], key: (row: T) => string): readonly T[] {
  const baseline = new Map(before.map(row => [key(row), row]));
  const rows = next.map(row => keep(baseline.get(key(row)), row));
  return before.length === rows.length && rows.every((row, index) => row === before[index]) ? before : rows;
}
function reconcilePreference(previous: Preference, next: Preference): Preference {
  const value = previous.status === 'ready' && next.status === 'ready'
    ? { ...next, preference: keep(previous.preference, next.preference) } : next;
  return keep(previous, value);
}
function reconcileSelection(previous: LocalRunSelection, next: LocalRunSelection): LocalRunSelection {
  return keep(previous, { ...next, workspace: keep(previous.workspace, next.workspace),
    platforms: keyedRows(previous.platforms, next.platforms, row => row.label),
    ...(next.matrix ? { matrix: keep(previous.matrix, next.matrix) } : {}),
    ...(next.variables ? { variables: keyedRows(previous.variables ?? [], next.variables, row => row.name) } : {}),
    ...(next.environmentBindings ? { environmentBindings: keep(previous.environmentBindings, next.environmentBindings) } : {}),
  });
}

/** The semantic producer owns reconciliation, keyed within one workflow scope. */
export function reconcileLocalActInspectionV1(previous: LocalActInspection | null, next: LocalActInspection): LocalActInspection {
  if (!previous || !pluginJsonValuesEqual(previous.workspace, next.workspace) || previous.workflowPath !== next.workflowPath) return next;
  let workflow = next.workflow;
  if (workflow && previous.workflow) {
    const stableJobs = keyedRows(previous.workflow.jobs, workflow.jobs, row => row.id);
    const events = keep(previous.workflow.events, workflow.events);
    workflow = events === previous.workflow.events && stableJobs === previous.workflow.jobs
      ? previous.workflow : { events, jobs: stableJobs };
  }
  const admitted = { ...next, workspace: previous.workspace, tool: keep(previous.tool, next.tool),
    workflows: keep(previous.workflows, next.workflows), secretRequirements: keyedRows(previous.secretRequirements, next.secretRequirements, row => row.name),
    preferenceAddress: previous.preferenceAddress, preference: reconcilePreference(previous.preference, next.preference),
    ...(workflow ? { workflow } : {}) };
  return pluginJsonValuesEqual(previous, admitted) ? previous : admitted;
}

/** A mounted Account lifetime only; no watcher, cache, output subscription or timer. */
export function createLocalRunControllerV1(options: Readonly<{
  accountId: string; seed: LocalActRunSeedV1; host: Pick<PluginUiHostApi, 'executeAction'>;
}>) {
  let lifetime = new AbortController();
  let inspectionRequest: AbortController | null = null;
  let runPreflightSignal: AbortSignal | null = null;
  let preparedRun: Readonly<{ selection: LocalRunSelection; signal: AbortSignal }> | null = null;
  let preparedPermission: Readonly<{ signal: AbortSignal }> | null = null;
  let retired = false;
  const listeners = new Set<() => void>();
  let state: LocalRunSnapshot = {
    selection: { workspace: options.seed.workspace, workflowPath: options.seed.workflowPath ?? '', event: options.seed.event ?? '',
      ...(options.seed.yamlJobId ? { yamlJobId: options.seed.yamlJobId } : {}), platforms: [], architecture: '' },
    inspection: null, loading: false, inspectionError: null, machineDisplayName: null, permissionPending: false, permissionNeedsObservation: false,
    runnerRequirements: null,
    permissionResult: null, lastResult: null, error: null, runState: 'idle', operationRef: null, operationWorkspace: null,
    operation: null, operationObservation: 'unavailable',
  };
  const publish = (patch: Partial<LocalRunSnapshot>) => {
    if (retired || !Object.entries(patch).some(([key, value]) => state[key as keyof LocalRunSnapshot] !== value)) return;
    const selection = patch.selection ?? state.selection;
    const inspection = patch.inspection === undefined ? state.inspection : patch.inspection;
    const runnerRequirements = inspection?.workflow === state.inspection?.workflow && selection.yamlJobId === state.selection.yamlJobId
      ? state.runnerRequirements : inspection?.workflow
        ? projectLocalActRunnerRequirementsV1(inspection.workflow, selection.yamlJobId, state.runnerRequirements) : null;
    state = { ...state, ...patch, runnerRequirements }; for (const listener of listeners) listener();
  };
  const invoke = async (id: string, input: LocalRunSelection | { workspace: LocalRunSelection['workspace']; workflowPath?: string }, signal: AbortSignal) =>
    actionValue(await options.host.executeAction({ pluginId: GITHUB_PLUGIN_ID, localId: id }, input, { signal }));
  const installPreference = (preference: Preference) => {
    if (state.inspection) publish({ inspection: reconcileLocalActInspectionV1(state.inspection, { ...state.inspection, preference }) });
  };
  const observeRunPermission = async (signal: AbortSignal): Promise<void> => {
    try { await controller.observePermission(); }
    catch { if (!signal.aborted) publish({ permissionNeedsObservation: true }); }
  };
  const allowControl = {
    async prepare({ signal: hostSignal }: Readonly<{ signal: AbortSignal }>): Promise<Readonly<{ input: PluginActionInputById['projects.worker.preferences.set'] }> | null> {
      const inspection = state.inspection;
      const observed = inspection?.preference;
      if (hostSignal.aborted || retired || preparedPermission || state.permissionPending || state.permissionNeedsObservation
        || !inspection || observed?.status !== 'ready' || observed.preference.allowAdHoc) return null;
      const signal = lifetime.signal;
      const input = { workspace: inspection.preferenceAddress, expectedRevision: observed.revision,
        expected: observed.provenance === 'default' ? { kind: 'absent' as const } : { kind: 'value' as const, value: observed.preference },
        next: { ...observed.preference, allowAdHoc: true } };
      preparedPermission = { signal };
      publish({ permissionPending: true, error: null });
      return { input };
    },
    onSettled(execution: PluginUiActionControlExecution): void {
      const submitted = preparedPermission;
      preparedPermission = null;
      if (!submitted || submitted.signal.aborted || retired) return;
      publish({ permissionResult: execution });
      try {
        if (!execution.ok) {
          publish({ error: execution.errorCode, permissionNeedsObservation: execution.errorCode !== 'action_not_admitted' });
          return;
        }
        if (isPluginActionApprovalRequestCreated(execution.result)) return;
        const result = ProtocolWorkspaceWorkerPreferenceMutationResultV1Schema.parse(execution.result);
        publish({ permissionNeedsObservation: result.status === 'outcomeUnknown' });
        if ('preference' in result) installPreference({ status: 'ready', preference: result.preference,
          revision: result.revision, provenance: result.provenance });
        else if (result.status === 'locked' || result.status === 'invalid' || result.status === 'unavailable') installPreference({ status: result.status });
      } catch (error) {
        publish({ error: error instanceof PluginError ? error.code : 'local_act_permission_unknown', permissionNeedsObservation: true });
      } finally { publish({ permissionPending: false }); }
    },
  } satisfies PluginUiActionControlController;
  const runControl = {
    async prepare({ signal: hostSignal }: Readonly<{ signal: AbortSignal }>): Promise<Readonly<{ input: ReturnType<typeof buildLocalActCommandV1> }> | null> {
      if (hostSignal.aborted || !controller.canRun()) return null;
      const signal = lifetime.signal;
      const selected = state.selection;
      runPreflightSignal = signal;
      publish({ runState: 'submitting', error: null });
      try {
        const inspection = await controller.inspect(hostSignal);
        if (!inspection || hostSignal.aborted || signal.aborted || retired) {
          if (!signal.aborted) publish({ runState: 'idle' });
          return null;
        }
        if (inspection.tool.kind !== 'ready') throw new PluginError({ code: inspection.tool.code });
        if (inspection.preference.status !== 'ready') throw new PluginError({ code: 'preferences_unavailable' });
        if (!inspection.preference.preference.allowAdHoc) throw new PluginError({ code: 'ad_hoc_disabled' });
        if (!inspection.workflow) throw new PluginError({ code: inspection.workflowError ?? 'workflow_unavailable' });
        const validation = validateLocalActWorkflowSelectionV1(selected, inspection.workflow);
        if (validation.kind === 'refused') throw new PluginError({ code: validation.code });
        const command = buildLocalActCommandV1(selected, inspection.tool.executablePath);
        preparedRun = { selection: selected, signal };
        return { input: command };
      } catch (error) {
        if (!signal.aborted) {
          const code = error instanceof PluginError ? error.code : 'local_act_preparation_unavailable';
          publish({ error: code, runState: 'idle' });
          if (code === 'ad_hoc_disabled' && !hostSignal.aborted) await observeRunPermission(signal);
        }
        return null;
      } finally { if (runPreflightSignal === signal) runPreflightSignal = null; }
    },
    async onSettled(execution: PluginUiActionControlExecution): Promise<void> {
      const submitted = preparedRun;
      if (retired || !submitted) return;
      preparedRun = null;
      const { selection: selected, signal } = submitted;
      publish({ lastResult: execution });
      if (!execution.ok) {
        const code = execution.errorCode;
        publish({ error: code, runState: code === 'action_not_admitted' || code === 'ad_hoc_disabled' || code === 'preferences_unavailable' ? 'idle' : 'uncertain' });
        if (code === 'ad_hoc_disabled' && !signal.aborted) await observeRunPermission(signal);
        return;
      }
      try {
        const value = LocalActRunResultV1Schema.parse(execution.result);
        if (isPluginActionApprovalRequestCreated(value)) { publish({ runState: 'idle' }); return; }
        // The closed setup-hold arm carries kind; accepted results do not.
        if (!('kind' in value)) {
          const attachment = value.operation.domainRef;
          if (value.operation.actionId !== 'projects.compute.exec' || attachment?.kind !== 'projectCommand'
            || attachment.machineId !== selected.workspace.machineId || attachment.serverId !== selected.workspace.serverId
            || attachment.workspaceRefId !== selected.workspace.workspaceId) throw new PluginError({ code: 'local_act_operation_target_mismatch' });
          const operationRef = {
            serverId: selected.workspace.serverId, machineId: value.operation.scope.machineId, operationId: value.operation.operationId,
          };
          publish({ runState: 'accepted', operationRef, operationWorkspace: selected.workspace,
            operation: value.operation, operationObservation: 'available' });
          if (!signal.aborted) {
            try { await options.host.executeAction('projects.execution.output.open', operationRef); }
            catch { publish({ error: 'local_act_output_open_unavailable' }); }
          }
        } else publish({ runState: 'idle' });
      } catch (error) {
        publish({ error: error instanceof PluginError ? error.code : 'local_act_acceptance_unknown', runState: 'uncertain' });
      }
    },
  } satisfies PluginUiActionControlController;
  const controller = {
    accountId: options.accountId,
    allowControl,
    runControl,
    getSnapshot: () => state,
    receiveMachineDisplayName(address: Pick<LocalRunSelection['workspace'], 'serverId' | 'machineId'>, name: string | null) {
      if (retired || address.serverId !== state.selection.workspace.serverId || address.machineId !== state.selection.workspace.machineId) return;
      publish({ machineDisplayName: name });
    },
    receiveOperation(ref: LocalRunOperationRef, observed: PluginUiActionOperationHostReadResultV1) {
      if (retired || !state.operationRef || !pluginJsonValuesEqual(ref, state.operationRef)) return;
      const operation = observed.operation;
      if (operation && (operation.operationId !== ref.operationId || operation.scope.machineId !== ref.machineId
        || operation.scope.accountId !== options.accountId || operation.actionId !== 'projects.compute.exec')) return;
      publish({ operation: keep(state.operation, operation), operationObservation: observed.observation });
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async inspect(hostSignal?: AbortSignal) {
      if (retired) return;
      inspectionRequest?.abort();
      const request = new AbortController(); inspectionRequest = request;
      const scope = lifetime.signal;
      const cancel = () => request.abort(); scope.addEventListener('abort', cancel, { once: true });
      hostSignal?.addEventListener('abort', cancel, { once: true });
      if (hostSignal?.aborted) request.abort();
      publish({ loading: true, inspectionError: null, error: null });
      const requested = state.selection;
      try {
        const value = await invoke(LOCAL_ACT_ACTION_IDS.inspect, { workspace: requested.workspace,
          ...(requested.workflowPath ? { workflowPath: requested.workflowPath } : {}) }, request.signal);
        if (request.signal.aborted || retired) return;
        if (isPluginActionApprovalRequestCreated(value)) { publish({ lastResult: value }); return; }
        const next = LocalActInspectionV1Schema.parse(value);
        if (!pluginJsonValuesEqual(next.workspace, requested.workspace) || next.workflowPath !== (requested.workflowPath || undefined)) {
          throw new PluginError({ code: 'local_act_inspection_scope_mismatch' });
        }
        const inspection = reconcileLocalActInspectionV1(state.inspection, next);
        publish({ inspection });
        return inspection;
      } catch (error) {
        if (!request.signal.aborted) {
          const code = error instanceof PluginError ? error.code : 'local_act_inspection_unavailable';
          publish({ error: code, inspectionError: code });
        }
      } finally {
        scope.removeEventListener('abort', cancel);
        hostSignal?.removeEventListener('abort', cancel);
        if (inspectionRequest === request) publish({ loading: false });
      }
    },
    setSelection(input: unknown) {
      if (retired) return;
      const next = LocalRunSelectionV1Schema.parse(input);
      const selection = reconcileSelection(state.selection, next);
      if (selection === state.selection) return;
      const machineChanged = state.selection.workspace.serverId !== selection.workspace.serverId
        || state.selection.workspace.machineId !== selection.workspace.machineId;
      const scopeChanged = !pluginJsonValuesEqual(state.selection.workspace, selection.workspace) || state.selection.workflowPath !== selection.workflowPath;
      const retiringUnsentRun = scopeChanged && runPreflightSignal === lifetime.signal;
      if (scopeChanged) {
        lifetime.abort(); lifetime = new AbortController(); inspectionRequest?.abort();
      }
      publish({ selection, ...(machineChanged ? { machineDisplayName: null } : {}), ...(scopeChanged ? { inspection: null, loading: false, permissionPending: false,
        permissionNeedsObservation: false, permissionResult: null, lastResult: null, error: null, inspectionError: null,
        ...(retiringUnsentRun ? { runState: 'idle' as const } : {}) } : {}) });
      if (scopeChanged) void controller.inspect();
    },
    async observePermission() {
      if (retired) return;
      const signal = lifetime.signal;
      const workspace = { serverId: state.selection.workspace.serverId, refId: state.selection.workspace.workspaceId };
      const value = actionValue(await options.host.executeAction('projects.worker.preferences.get', { workspace }, { signal }));
      if (signal.aborted || retired) return;
      if (isPluginActionApprovalRequestCreated(value)) { publish({ lastResult: value }); return; }
      installPreference(ProtocolWorkspaceWorkerPreferenceReadResultV1Schema.parse(value));
      publish({ permissionNeedsObservation: false, permissionResult: null });
    },
    canRun() {
      const inspection = state.inspection;
      const settled = state.operationObservation === 'available' && state.operation !== null
        && (state.operation.state === 'succeeded' || state.operation.state === 'failed' || state.operation.state === 'cancelled');
      return !retired && !state.loading && !state.inspectionError && !state.permissionPending && !state.permissionNeedsObservation
        && state.runState !== 'submitting' && state.runState !== 'uncertain'
        && (state.runState !== 'accepted' || settled)
        && inspection?.tool.kind === 'ready' && inspection.preference.status === 'ready' && inspection.preference.preference.allowAdHoc
        && Boolean(state.selection.architecture.trim()) && Boolean(inspection.workflow)
        && validateLocalActWorkflowSelectionV1(state.selection, inspection.workflow!).kind === 'ready';
    },
    async openOutput() {
      const ref = state.operationRef;
      if (ref && !retired) return await options.host.executeAction('projects.execution.output.open', ref);
    },
    async stop() {
      const ref = state.operationRef;
      if (ref && !retired) return await options.host.executeAction('action.operations.cancel', ref);
    },
    async invoke(operation: { kind: 'readSelection' } | { kind: 'setSelection'; selection: LocalRunSelection }): Promise<LocalActRunFormResult> {
      if (retired) return { status: 'unavailable' };
      if (operation.kind === 'readSelection') return { status: 'applied', selection: state.selection };
      controller.setSelection(operation.selection); return { status: 'applied' };
    },
    dispose() { retired = true; lifetime.abort(); inspectionRequest?.abort(); listeners.clear(); },
  };
  return controller;
}
export type LocalRunController = ReturnType<typeof createLocalRunControllerV1>;
