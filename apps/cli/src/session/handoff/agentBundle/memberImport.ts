import { randomUUID } from 'node:crypto';
import { resolveMachineAgentExecutionPlacementV1 } from '@happier-dev/protocol/machines/agentIsolationV1';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { requiresRequesterWorkspaceCapture } from '@/api/machine/machineRpcAuthorization';
import { privateProjectCheckoutRefusal } from '@/workspaces/activation/privateProjectCheckout';
import {
  selectHostRequesterExecutionIdentity,
  resolveHostRequesterAgentExecutionIdentity,
  type HostAgentIsolationLaunchContext,
} from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { prepareAgentIsolationMemberForIntent } from '@/daemon/agentIsolation/prepareNativeOperation';
import { buildMemberAgentInstallEnvironment } from '@/capabilities/installJobs/memberInstallEnvironment';
import {
  authorizeWorkspaceEffectLaunch,
  runWorkspaceEffectChild,
} from '@/workspaces/activation/workspaceEffectProcess';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import type {
  ImportedSessionHandoffBundle,
  SessionHandoffAgentBundle,
} from '../types';
import {
  projectImportedSessionHandoffState,
  SessionHandoffTypedImportError,
  readSessionHandoffTypedImportFailureCode,
} from './import';
import type {
  MemberSessionImportEffect,
  MemberSessionImportRecord,
} from './memberImportEffect';

export type MemberSessionHandoffImportDeps = Readonly<{
  agentIsolation?: HostAgentIsolationLaunchContext;
  resolveHostHomeServerIdentityId?: () => Promise<string | null>;
  platform?: NodeJS.Platform;
}>;

export type MemberSessionHandoffImport = Readonly<{
  /** The member's own folder; the handoff directory must be inside it. */
  workspaceRoot: string;
  import(
    input: Readonly<{
      bundle: SessionHandoffAgentBundle;
      targetPath: string;
      sessionStorageMode: 'direct' | 'persisted';
      workspace?: Readonly<{ rootPath: string; sessionRelativeCwd: string }>;
      signal: AbortSignal;
    }>,
  ): Promise<ImportedSessionHandoffBundle>;
}>;

/**
 * Session import and cwd creation on another person's separate-users Machine run as
 * the requester's member OS user with the member's HOME (owner ruling 2026-11-15).
 * The same capture decision as the workspace copy decides it; the custodian, Manage
 * grantees and Machines without separate users keep today's import.
 */
export async function prepareMemberSessionHandoffImport(
  context: RpcHandlerContext | undefined,
  deps: MemberSessionHandoffImportDeps = {},
): Promise<MemberSessionHandoffImport | undefined> {
  const admission = context?.machineAdmission;
  if (!context || !admission || !requiresRequesterWorkspaceCapture(admission))
    return undefined;
  const placement = resolveMachineAgentExecutionPlacementV1({
    policy: deps.agentIsolation?.read() ?? { enabled: false },
    platform: deps.platform ?? process.platform,
  });
  if (placement !== 'member') return undefined;
  const unavailable = () =>
    Object.assign(new Error('Member execution setup is unavailable'), {
      code: 'agent_isolation_unavailable',
    });
  const agentIsolation = deps.agentIsolation;
  if (!agentIsolation?.readMember) throw unavailable();
  const homeServerIdentityId =
    (await deps.resolveHostHomeServerIdentityId?.()) ??
    context.requesterSessionBootstrap?.homeServerIdentityId ??
    context.callerInputAuthorization?.binding.serverIdentityId;
  if (!homeServerIdentityId) throw unavailable();
  const selected = resolveHostRequesterAgentExecutionIdentity(
    selectHostRequesterExecutionIdentity({
      rpcContext: context,
      hostHomeServerIdentityId: homeServerIdentityId,
      sessionRequester: context.requesterSessionBootstrap?.attribution,
      sessionRequesterHomeServerIdentityId:
        context.requesterSessionBootstrap?.homeServerIdentityId,
    }),
  );
  if (selected.kind !== 'isolated') throw unavailable();
  const requesterIdentity = { ...selected, homeServerIdentityId };
  const observed = await prepareAgentIsolationMemberForIntent(agentIsolation, {
    requesterIdentity,
    rpcContext: context,
    signal: context.signal,
  });
  const workspaceRoot = observed.identity.workspaceRoot;
  return {
    workspaceRoot,
    import: async (input) => {
      const inside = (path: string) =>
        isCanonicalAbsolutePathInsideRoot(workspaceRoot, path);
      if (
        !inside(input.targetPath) ||
        (input.workspace && !inside(input.workspace.rootPath))
      ) {
        throw privateProjectCheckoutRefusal(
          'workspace_private_checkout_review_required',
        );
      }
      const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
      try {
        const registry = lease.registry;
        const pluginId = registry.contributes.agents.find(
          (agent) => agent.id === input.bundle.agentId,
        )?.identity?.pluginId;
        const plugins = pluginId
          ? registry.readAdmittedBackgroundServicePlugins?.([pluginId])
          : undefined;
        if (!plugins?.length)
          throw new Error(
            `Unsupported handoff provider: ${input.bundle.agentId}`,
          );
        const executable =
          agentIsolation.read()?.launch?.managedHappierBinaryPath;
        if (!executable) throw unavailable();
        const effect: MemberSessionImportEffect = {
          kind: 'session_import',
          workspaceRoot,
          agentId: input.bundle.agentId,
          plugins,
          generation: registry.generation,
          bundle: input.bundle,
          targetDirectory: input.targetPath,
          ...(input.workspace ? { workspace: input.workspace } : {}),
        };
        // The member Workspace effect child, with the member's HOME for the Agent's own state.
        const launch = await authorizeWorkspaceEffectLaunch({
          agentIsolation,
          requesterIdentity: selected,
          signal: input.signal,
          assertCurrent: () => input.signal.throwIfAborted(),
          managedHappierBinaryPath: executable,
          workspaceRoot,
          env: buildMemberAgentInstallEnvironment(observed.identity.home),
        });
        let record: MemberSessionImportRecord | undefined;
        let failure: unknown;
        const outcome = await runWorkspaceEffectChild({
          launch,
          signal: input.signal,
          id: randomUUID(),
          effect,
          refusal: (code) => Object.assign(unavailable(), { code }),
          services: {
            onEffectsIssued: async () => {},
            complete: async () => {
              throw unavailable();
            },
            fail: async (error: Error) => {
              failure = error;
            },
            completeSessionImport: async (value: MemberSessionImportRecord) => {
              record = value;
            },
          },
        });
        if (outcome.failure !== undefined) throw outcome.failure;
        if (failure) throw failure;
        input.signal.throwIfAborted();
        if (!outcome.settled || !record)
          throw Object.assign(new Error('The member import outcome is unknown'), {
            code: 'workspace_effect_outcome_unknown',
          });
        if (record.t === 'failed') {
          const typed = readSessionHandoffTypedImportFailureCode(record);
          throw typed
            ? new SessionHandoffTypedImportError({
                code: typed,
                message: record.message,
              })
            : Object.assign(new Error(record.message), { code: record.code });
        }
        return await projectImportedSessionHandoffState({
          value: record.value,
          agentId: input.bundle.agentId,
          targetPath: input.targetPath,
          sessionStorageMode: input.sessionStorageMode,
        });
      } finally {
        await lease.release();
      }
    },
  };
}
