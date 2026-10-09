import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { PROJECT_DEFINITION_ACTION_IDS, PROJECT_DEFINITION_ACTION_INPUT_SCHEMAS } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
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
          detection.environments.push(...detected.environments);
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
}>): NonNullable<ActionExecutorDeps['projectDefinitionAction']> {
  return async ({ actionId, input, context }) => {
    const parsed = PROJECT_DEFINITION_ACTION_INPUT_SCHEMAS[actionId].safeParse(input);
    if (!parsed.success) return failure('invalid_parameters');
    const workspace = parsed.data.workspace;
    if (workspace.serverId !== params.serverId || (context.serverId && context.serverId !== params.serverId)) return failure('server_scope_mismatch');
    if (workspace.machineId !== params.machineId || (context.externalActionTarget && (context.externalActionTarget.kind !== 'machine'
      || context.externalActionTarget.machineId !== params.machineId))) return failure('target_not_local');
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
    const [definition, detection] = await Promise.all([readProjectManifest({ root }), inspectProjectDefinitions(root)]);
    context.signal?.throwIfAborted();
    if (params.acquirePluginRuntime) await inspectNativeAdapters(root, detection, params.acquirePluginRuntime, context.signal);
    context.signal?.throwIfAborted();
    const facts = await inspectProjectDefinitionExecutionFacts({ root, detection, io: params.nativeIo ?? projectNativeSystemIo,
      ...(definition.document?.status === 'valid' ? { manifest: definition.document.manifest } : {}),
      ...(context.signal ? { signal: context.signal } : {}) });
    context.signal?.throwIfAborted();
    return { definition, detection, ...facts };
  };
}

export function registerProjectDefinitionHandlers(params: Readonly<{
  rpcHandlerManager: ActionSpecRpcRegistrar; machineId: string; actionExecutor: RpcActionExecutor;
}>): void {
  registerActionSpecRpcHandlers({ rpcHandlerManager: params.rpcHandlerManager, actionExecutor: params.actionExecutor,
    actionIds: PROJECT_DEFINITION_ACTION_IDS, targetMachineId: params.machineId, defaultMachineTarget: true });
}
