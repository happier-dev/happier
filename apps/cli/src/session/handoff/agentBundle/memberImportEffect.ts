import type { HandoffImportResultV1 } from '@happier-dev/agents';
import { loadAdmittedPluginProcessRegistrations } from '@/plugins/runtime/lifecycle/activation/admittedProcessPlugins';
import type { AdmittedBackgroundServicePlugin } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessSource';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { ensureSessionHandoffWorkspaceCwd } from '../paths/sessionHandoffWorkspaceCwd';
import type { SessionHandoffAgentBundle } from '../types';

/** A Can use member's Session import, run whole by the member Workspace effect
 * child (`workspace-effect`) with the member folder as its working directory.
 * Plugin descriptors come from their sole admission owner on the daemon. */
export type MemberSessionImportEffect = Readonly<{
  kind: 'session_import';
  workspaceRoot: string;
  agentId: string;
  plugins: readonly AdmittedBackgroundServicePlugin[];
  generation: number;
  bundle: SessionHandoffAgentBundle;
  targetDirectory: string;
  workspace?: Readonly<{ rootPath: string; sessionRelativeCwd: string }>;
}>;

/** The Agent's native result, or its typed failure, for the host to project once. */
export type MemberSessionImportRecord =
  | Readonly<{ t: 'imported'; value: HandoffImportResultV1 }>
  | Readonly<{ t: 'failed'; code: string; message: string }>;

function readCode(error: unknown): string {
  return error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'target_import_failed';
}

/** Runs as the requester's member OS user, with the member's HOME: the cwd and the
 * Agent's own session import are the member's effects, never the host's. */
async function importAsMember(
  request: MemberSessionImportEffect,
  signal: AbortSignal,
): Promise<HandoffImportResultV1> {
  if (request.workspace) {
    await ensureSessionHandoffWorkspaceCwd({
      workspaceRootPath: request.workspace.rootPath,
      sessionRelativeCwd: request.workspace.sessionRelativeCwd,
      targetPath: request.targetDirectory,
    });
  }
  signal.throwIfAborted();
  // Host services stay with the daemon; the import runs with the member's own process authority.
  const registry = await loadAdmittedPluginProcessRegistrations(
    request.plugins,
    request.generation,
    async () => createUnavailablePluginServices(),
  );
  try {
    const lease = registry.agentRuntimesByAgentId.get(request.agentId);
    if (!lease)
      throw Object.assign(new Error('The admitted Agent is unavailable in the member process'), {
        code: 'agent_version_unsupported',
      });
    if (!lease.hasPrimaryRuntime)
      throw Object.assign(new Error('The Agent has no runtime to import a handoff'), {
        code: 'agent_version_unsupported',
      });
    const runtime = await lease.createRuntime({ signal });
    const handoff = runtime.surfaces?.handoff;
    if (!handoff)
      throw Object.assign(new Error('The Agent cannot import a handoff'), {
        code: 'agent_version_unsupported',
      });
    const context = await lease.createAgentRuntimeSurfaceInvocationContext({
      cwd: request.targetDirectory,
    });
    const imported = await handoff.importBundle(
      { bundle: request.bundle, targetDirectory: request.targetDirectory },
      context,
    );
    if (!imported.ok)
      throw Object.assign(new Error(imported.message ?? imported.code), {
        code: imported.code,
      });
    return imported.value;
  } finally {
    await registry.dispose();
  }
}

/** Member child side: the cwd and the Agent's own Session import, as the member. */
export async function executeMemberSessionImport(
  effect: MemberSessionImportEffect,
  signal: AbortSignal,
): Promise<MemberSessionImportRecord> {
  try {
    return { t: 'imported', value: await importAsMember(effect, signal) };
  } catch (error) {
    signal.throwIfAborted();
    return {
      t: 'failed',
      code: readCode(error),
      message:
        error instanceof Error && error.message ? error.message : readCode(error),
    };
  }
}
