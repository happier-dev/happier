import { randomUUID } from 'node:crypto';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { isScmLocalRepositoryReadRpcMethod } from '@happier-dev/protocol/actions/scmGitActionSpecs';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import type { RpcHandler, RpcHandlerContext } from '@/api/rpc/types';
import type {
  HostAgentIsolationLaunchContext,
  HostRequesterExecutionIdentity,
} from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import {
  authorizeResolvedProjectExecLaunchForHost,
  spawnAuthorizedHostExecLaunchForHost,
} from '@/plugins/runtime/invocation/services/exec';
import { createBackgroundServiceProcessServiceHost } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessBridge';
import {
  createBackgroundServiceProcessFrameDecoder,
  encodeBackgroundServiceProcessFrame,
  parseBackgroundServiceProcessMessage,
} from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessProtocol';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import {
  createWorkspaceEffectScmRegistry,
  prepareAdmittedScmEffect,
  type AdmittedScmEffect,
} from '@/workspaces/activation/workspaceEffect';
import { resolveCwd } from '@/scm/runtime';

/** One local repository read, executed whole by the member-owned Workspace effect child. */
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
 * Daemon side. A Can use member's read touches member-controlled Git metadata (state
 * files may be symlinks or FIFOs), so the daemon never opens a path in the member folder:
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
    const launch = await authorizeResolvedProjectExecLaunchForHost({
      agentIsolation: input.agentIsolation,
      requesterIdentity: input.requesterIdentity,
      signal: input.signal,
      assertCurrent: () => {
        input.signal.throwIfAborted();
        admitted.assertCurrent();
      },
      agentLaunchKind: 'workspaceExec',
      agentNativeLaunch: false,
      launch: {
        command: executable,
        args: ['workspace-effect'],
        cwd: input.workspaceRoot,
        env: {},
        maxStdoutBytes: 0,
        maxStderrBytes: 0,
      },
    });
    let transferred = false;
    try {
      const process = spawnAuthorizedHostExecLaunchForHost(launch, {
        signal: input.signal,
      });
      transferred = true;
      const id = randomUUID();
      const decoder = createBackgroundServiceProcessFrameDecoder();
      let result: { value: unknown } | undefined;
      let failure: unknown;
      let settled = false;
      const send = (value: unknown) => {
        process.child.stdin.write(encodeBackgroundServiceProcessFrame(value));
      };
      const services = createBackgroundServiceProcessServiceHost({
        signal: input.signal,
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
        send: (message) => send({ kind: 'services', message }),
      });
      const receive = (chunk: Buffer) => {
        try {
          for (const raw of decoder.push(chunk)) {
            const message = parseBackgroundServiceProcessMessage(raw);
            if (message.kind === 'services') {
              services.receive(message.message);
              continue;
            }
            if (message.kind === 'settled' && message.id === id) {
              settled = true;
              process.child.stdin.end();
              continue;
            }
            if (message.kind === 'failed' && message.id === id) {
              failure = unavailable(message.error.code);
              process.child.stdin.end();
              continue;
            }
            throw unavailable('workspace_effect_protocol_invalid');
          }
        } catch (error) {
          failure = error;
          void process.dispose('caller');
        }
      };
      process.child.stdout.on('data', receive);
      process.child.stdin.on('error', () => {});
      try {
        send({
          kind: 'run',
          id,
          context: effect,
          services: services.description,
        });
        await process.handle.wait();
        await process.dispose('caller');
        await process.waitForSettlement();
        if (failure) throw failure;
        input.signal.throwIfAborted();
        if (!settled || !result)
          throw unavailable('workspace_effect_outcome_unknown');
        return result.value;
      } finally {
        process.child.stdout.off('data', receive);
        await services.dispose();
        await process.dispose('caller');
        await process.waitForSettlement();
      }
    } finally {
      if (!transferred) await launch.release();
    }
  } finally {
    await lease.release();
  }
}

/** Member child side: the same SCM handlers, confined to the member folder, with Git run directly as the member. */
export async function executeMemberScmRead(
  effect: MemberScmReadEffect,
  signal: AbortSignal,
): Promise<unknown> {
  if (!isScmLocalRepositoryReadRpcMethod(effect.method))
    throw unavailable('machine_manage_required');
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
