import { randomUUID } from 'node:crypto';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import type {
  HostAgentIsolationLaunchContext,
  HostRequesterExecutionIdentity,
} from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import {
  authorizeWorkspaceEffectLaunch,
  runWorkspaceEffectChild,
} from '@/workspaces/activation/workspaceEffectProcess';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import {
  createWorkspaceEffectScmRegistry,
  prepareAdmittedScmEffect,
  type AdmittedScmEffect,
} from '@/workspaces/activation/workspaceEffect';
import { resolveCwd } from '@/scm/runtime';

/** One local repository operation (a read, or a Manage write), executed whole by the member-owned Workspace effect child. */
export type MemberScmReadEffect = Readonly<{
  kind: 'scm_read';
  /** The member folder; the child runs with it as its working directory. */
  workspaceRoot: string;
  /** The selected Project root, resolved by the member child, never by the daemon. */
  root?: string;
  method: string;
  input: unknown;
  scm: AdmittedScmEffect;
}>;

const unavailable = (code = 'agent_isolation_unavailable') =>
  new PluginError({
    code,
    message: 'Source control could not run as the member',
    retryable: false,
    details: { reason: code, phase: 'native_execution_preparation' },
  });

/**
 * Daemon side. Repository work in a member folder (a Can use member's read, or Manage's read
 * or write) touches member-controlled Git metadata and config (state files may be symlinks or
 * FIFOs; config may name hooks), so the daemon never opens a path in the member folder:
 * Git and every metadata read run in the existing member Workspace effect child
 * (`workspace-effect`, the Project Open/Sync member owner), as the member OS user.
 */
export async function readScmAsMember(
  input: Readonly<{
    agentIsolation: HostAgentIsolationLaunchContext;
    requesterIdentity: Extract<
      HostRequesterExecutionIdentity,
      { kind: 'isolated' }
    >;
    workspaceRoot: string;
    root?: string;
    method: string;
    input: unknown;
    signal: AbortSignal;
  }>,
): Promise<unknown> {
  // Lexical only: the member child resolves links as the member.
  if (
    input.root !== undefined &&
    !isCanonicalAbsolutePathInsideRoot(input.workspaceRoot, input.root)
  ) {
    return {
      success: false,
      errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
      error: 'Path is outside your folder',
    };
  }
  const executable =
    input.agentIsolation.read()?.launch?.managedHappierBinaryPath;
  if (!executable) throw unavailable();
  const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
  try {
    const admitted = await prepareAdmittedScmEffect({
      registry: lease.registry,
    });
    const effect: MemberScmReadEffect = {
      kind: 'scm_read',
      workspaceRoot: input.workspaceRoot,
      ...(input.root !== undefined ? { root: input.root } : {}),
      method: input.method,
      input: input.input,
      scm: admitted.effect,
    };
    const launch = await authorizeWorkspaceEffectLaunch({
      agentIsolation: input.agentIsolation,
      requesterIdentity: input.requesterIdentity,
      signal: input.signal,
      assertCurrent: () => {
        input.signal.throwIfAborted();
        admitted.assertCurrent();
      },
      managedHappierBinaryPath: executable,
      workspaceRoot: input.workspaceRoot,
    });
    let result: { value: unknown } | undefined;
    let failure: unknown;
    const outcome = await runWorkspaceEffectChild({
      launch,
      signal: input.signal,
      id: randomUUID(),
      effect,
      refusal: unavailable,
      services: {
        onEffectsIssued: async () => {},
        complete: async () => {
          throw unavailable('workspace_effect_protocol_invalid');
        },
        fail: async (error: Error) => {
          failure = error;
        },
        completeScmRead: async (value: unknown) => {
          result = { value };
        },
      },
    });
    if (outcome.failure !== undefined) throw outcome.failure;
    if (failure) throw failure;
    input.signal.throwIfAborted();
    if (!outcome.settled || !result)
      throw unavailable('workspace_effect_outcome_unknown');
    return result.value;
  } finally {
    await lease.release();
  }
}

/** Member child side: the same SCM handlers, confined to the member folder, with Git run directly
 * as the member. The daemon already decided which method may run here; the child adds no decision. */
export async function executeMemberScmRead(
  effect: MemberScmReadEffect,
  signal: AbortSignal,
): Promise<unknown> {
  const folder =
    effect.root !== undefined
      ? resolveCwd(effect.root, effect.workspaceRoot, {
          kind: 'restrictedRoots',
          roots: [effect.workspaceRoot],
        })
      : { ok: true as const, cwd: effect.workspaceRoot };
  if (!folder.ok)
    return {
      success: false,
      errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
      error: folder.error,
    };
  const registry = await createWorkspaceEffectScmRegistry(effect.scm, {});
  try {
    const { registerScmHandlers } = await import('@/rpc/handlers/scm');
    const handlers = new Map<string, RpcHandler>();
    registerScmHandlers(
      {
        registerHandler: (method, handler) => {
          handlers.set(method, handler);
        },
      },
      folder.cwd,
      {
        registry: registry.registry,
        accessPolicy: { kind: 'restrictedRoots', roots: [folder.cwd] },
        admittedLocalRepositoryOperation: true,
      },
    );
    const handler = handlers.get(effect.method);
    if (!handler) throw unavailable('machine_manage_required');
    const context: RpcHandlerContext = { signal };
    return await handler(effect.input, context);
  } finally {
    await registry.dispose();
  }
}
