import { createHash } from 'node:crypto';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { PROJECT_DEFINITION_ACTION_IDS, PROJECT_DEFINITION_ACTION_INPUT_SCHEMAS, type ProjectDefinitionActionId, type ProjectDefinitionWorkspace } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import type { ProjectDefinitionDetectionV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { inspectProjectDefinitions, inspectProjectDefinitionExecutionFacts } from '@/workspaces/projectSetup/projectDefinitionInspection';
import { readProjectDefinitionFile } from '@/workspaces/projectSetup/nativeDefinitionFiles';
import { readProjectManifest, updateProjectManifest } from '@/workspaces/projectSetup/projectManifestFile';
import type { ProjectNativeCommandIo } from '@/workspaces/projectSetup/projectNativeResolution';
import { projectNativeSystemIo } from '@/workspaces/projectSetup/projectNativeSystemIo';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { validatePath, validateWorkspaceInspectionPath } from './pathSecurity';
import type { FilesystemAccessPolicy } from './fileSystem/accessPolicy/filesystemAccessPolicy';
import { registerActionSpecRpcHandlers, type ActionSpecRpcRegistrar } from './registerActionSpecRpcHandlers';
import type { RpcActionExecutor } from './_actionDispatchAdapter';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import type { ProjectSetupInspection } from '@/workspaces/projectSetup/projectSetupPreparation';
import { projectSetupInspectionFailure } from '@/workspaces/projectSetup/projectSetupInspectionFailure';
import { isReviewedServiceMoveChild } from '@/api/externalActionExecutionAuthorization';
import { logger } from '@/ui/logger';
import { selectProjectDefinitionRead } from '@/workspaces/projectSetup/projectDefinitionRead';

type NativeInspectionRuntimeLease = Readonly<{
  registry: Pick<ResolvedExecutablePluginRuntimeRegistry, 'contributes' | 'resolveProjectNativeAdapter'>;
  release(): Promise<void>;
}>;

function failure(code: string) { return { ok: false as const, errorCode: code, error: code }; }

/** Passive contributions consume the installed catalog and selected-occurrence lifecycle owner. */
async function inspectNativeAdapters(root: string, detection: ProjectDefinitionDetectionV1, acquire: () => Promise<NativeInspectionRuntimeLease>, signal?: AbortSignal): Promise<void> {
  const diagnose = (file: string, code: string) => {
    detection.coverage = 'partial';
    detection.diagnostics.push({ file, code });
  };
  let runtime: NativeInspectionRuntimeLease;
  try { runtime = await acquire(); }
  catch { signal?.throwIfAborted(); diagnose('.happier/project.json', 'native_adapter_registry_unavailable'); return; }
  try {
    for (const target of runtime.registry.contributes.activationTargets) {
      for (const declaration of target.manifest.contributes.projectNativeAdapters) {
        if (!declaration.roles.includes('detect')) continue;
        signal?.throwIfAborted();
        const files: { file: string; content: string }[] = [];
        for (const file of declaration.files) {
          const read = await readProjectDefinitionFile(root, file);
          signal?.throwIfAborted();
          if (read.kind === 'read') files.push({ file, content: read.content });
          else if (read.kind === 'refused') diagnose(file, read.code);
        }
        // Static listing and an unrelated checkout never import an executable detector.
        if (files.length === 0) continue;
        const adapter = { pluginId: target.pluginId, localId: declaration.id };
        const selected = await runtime.registry.resolveProjectNativeAdapter(adapter, 'detect');
        signal?.throwIfAborted();
        if (selected.kind !== 'ready') { diagnose(files[0]!.file, selected.code); continue; }
        try {
          if (!selected.lease.isCurrent()) { diagnose(files[0]!.file, 'native_adapter_retired'); continue; }
          const detect = selected.lease.runtime.detect;
          if (!detect) { diagnose(files[0]!.file, 'native_adapter_unsupported'); continue; }
          const detected = await detect({ root, adapter, files }, signal ? { signal } : undefined);
          signal?.throwIfAborted();
          if (!selected.lease.isCurrent()) { diagnose(files[0]!.file, 'native_adapter_retired'); continue; }
          detection.entries.push(...detected.entries);
          detection.toolchains.push(...detected.toolchains);
          detection.devcontainers.push(...detected.devcontainers);
          detection.diagnostics.push(...detected.diagnostics);
          if (detected.tools) (detection.tools ??= []).push(...detected.tools);
          if (detected.coverage === 'partial') detection.coverage = 'partial';
        } catch (error) {
          signal?.throwIfAborted();
          diagnose(files[0]!.file, error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'native_adapter_detection_failed');
        }
      }
    }
  } finally { await runtime.release(); }
}

/** Local effect dependency of the full Action executor, never a standalone mutation RPC. */
export function createProjectDefinitionAction(params: Readonly<{
  serverId: string; machineId: string; workingDirectory: string; accessPolicy: FilesystemAccessPolicy;
  acquirePluginRuntime?: () => Promise<NativeInspectionRuntimeLease>;
  nativeIo?: ProjectNativeCommandIo;
  /** Captured requester/private-review boundary; the host owns its native lifetime and uses inspectProjectSetupReadiness. */
  inspectSetup?: (input: Readonly<{ workspace: ProjectDefinitionWorkspace; root: string; context: ActionExecutorContext;
    reviewSetupConsent?: true }>) => Promise<ProjectSetupInspection>;
}>): NonNullable<ActionExecutorDeps['projectDefinitionAction']> {
  return async ({ actionId, input, context }) => {
    const phase = async <T>(name: string, read: () => T | Promise<T>): Promise<T> => {
      const startedAt = performance.now();
      let status: 'completed' | 'failed' = 'failed';
      try { const result = await read(); status = 'completed'; return result; }
      finally { logger.debug('[ProjectDefinition] inspection phase', { phase: name, status,
        actionId, requestId: context.actionRequestId, machineId: params.machineId,
        durationMs: Math.round(performance.now() - startedAt) }); }
    };
    const parsed = PROJECT_DEFINITION_ACTION_INPUT_SCHEMAS[actionId].safeParse(input);
    if (!parsed.success) return failure('invalid_parameters');
    const workspace = parsed.data.workspace;
    if (!await isServerProfileHomeIdentity(params.serverId, workspace.serverId)
      || context.serverId && !await isServerProfileHomeIdentity(params.serverId, context.serverId)) return failure('server_scope_mismatch');
    if (workspace.machineId !== params.machineId) return failure('target_not_local');
    if (context.externalActionTarget && (context.externalActionTarget.kind !== 'machine'
      || context.externalActionTarget.machineId !== params.machineId)) {
      const authorization = context.externalActionExecutionAuthorization;
      if (actionId !== 'projects.inspect' || !authorization || !await isReviewedServiceMoveChild({ authorization,
        envelope: context.originalActionEnvelope, actionId, machineId: params.machineId, params: parsed.data,
        ...(context.signal ? { signal: context.signal } : {}) })) return failure('target_not_local');
    }
    const absolute = validateWorkspaceInspectionPath(expandHomeDirPath(workspace.rootPath));
    if (!absolute.valid || !absolute.resolvedPath) return failure('access_denied');
    const authorized = validatePath(absolute.resolvedPath, params.workingDirectory, [], params.accessPolicy);
    if (!authorized.valid || !authorized.resolvedPath) return failure('access_denied');
    context.signal?.throwIfAborted();
    const root = authorized.resolvedPath;
    if (actionId === 'projects.manifest.update') {
      const request = PROJECT_DEFINITION_ACTION_INPUT_SCHEMAS[actionId].parse(input);
      return await updateProjectManifest({ root, expectedBasis: request.expectedBasis, bytes: request.bytes });
    }
    const request = PROJECT_DEFINITION_ACTION_INPUT_SCHEMAS['projects.inspect'].parse(input);
    const needsDiscovery = !['editor', 'detail', 'setup', 'placement', 'execution'].includes(request.read?.kind ?? 'scripts');
    const [definition, detection] = await phase('definition_files', () => Promise.all([readProjectManifest({ root }),
      needsDiscovery ? inspectProjectDefinitions(root) : Promise.resolve<ProjectDefinitionDetectionV1>({
        entries: [], toolchains: [], devcontainers: [], coverage: 'complete', diagnostics: [],
      })]));
    context.signal?.throwIfAborted();
    if (needsDiscovery && params.acquirePluginRuntime) await phase('native_adapters', () => inspectNativeAdapters(root, detection, params.acquirePluginRuntime!, context.signal));
    context.signal?.throwIfAborted();
    const selection = selectProjectDefinitionRead(definition, detection, request.read);
    const facts = selection.candidateEntries.length > 0 || selection.commandManifest || selection.includeTools || selection.includeExecutionInputs
      ? await phase('execution_facts', () => inspectProjectDefinitionExecutionFacts({ root,
      detection: { ...selection.detection, entries: request.read?.kind === 'detail' ? selection.entries : detection.entries },
      io: params.nativeIo ?? projectNativeSystemIo,
      ...(selection.commandManifest ? { manifest: selection.commandManifest } : {}),
      entries: selection.candidateEntries, includeTools: selection.includeTools, includeExecutionInputs: selection.includeExecutionInputs,
      includeInvocation: selection.includeInvocation,
      ...(request.read?.kind === 'execution' && request.read.command ? { command: request.read.command } : {}),
      ...(context.signal ? { signal: context.signal } : {}) })) : { importCandidates: [], commands: [], tools: [] };
    context.signal?.throwIfAborted();
    let setup: ProjectSetupInspection = { setupReadiness: { kind: 'unknown', code: 'project_setup_requester_review_unavailable' } };
    if (params.inspectSetup && (selection.includeSetup || request.reviewSetupConsent)) {
      try { setup = await phase('setup_readiness', () => params.inspectSetup!({ workspace, root, context,
        ...('reviewSetupConsent' in parsed.data && parsed.data.reviewSetupConsent ? { reviewSetupConsent: true as const } : {}) })); }
      catch (error) { setup = projectSetupInspectionFailure(error, context.signal); }
    }
    context.signal?.throwIfAborted();
    const { setupReadiness, setupReview, setupConsent } = setup;
    const output = { definition: selection.definition, ...(selection.definitionScope ? { definitionScope: selection.definitionScope } : {}), detection: selection.detection,
      ...(selection.read.kind === 'scripts' || selection.read.kind === 'guidance'
        || (selection.read.kind === 'overview' || selection.read.kind === 'rail') && definition.document?.status !== 'valid'
        ? { detectionSummary: selection.detectionSummary } : {}), ...facts,
      ...(selection.read.kind === 'tools' ? { importCandidates: [], commands: [] } : {}),
      ...(selection.includeSetup || request.reviewSetupConsent ? { setupReadiness } : {}),
      ...(request.reviewSetupConsent || selection.read.kind === 'setup' ? { setupReview, setupConsent } : {}) };
    // Revalidation still observes the checkout afresh; an equal projection is not resent. The
    // hash covers the serialized bytes this producer would send, in its fixed field order.
    const revision = `sha256:${createHash('sha256').update(JSON.stringify(output)).digest('hex')}`;
    return request.ifRevision === revision ? { unchanged: true as const, revision } : { revision, ...output };
  };
}

export function registerProjectDefinitionHandlers(params: Readonly<{
  rpcHandlerManager: ActionSpecRpcRegistrar; machineId: string; actionExecutor: RpcActionExecutor<ProjectDefinitionActionId>;
}>): void {
  registerActionSpecRpcHandlers<ProjectDefinitionActionId>({ rpcHandlerManager: params.rpcHandlerManager, actionExecutor: params.actionExecutor,
    actionIds: PROJECT_DEFINITION_ACTION_IDS, targetMachineId: params.machineId, defaultMachineTarget: true });
}
