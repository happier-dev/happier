import type { CliActionDepsParams } from './types';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { decideUserPluginChange, requestUserPluginChange } from '@/plugins/daemon/changeClient';
import type { DaemonPluginChangeService } from '@/plugins/daemon/changeService';
import { readPluginInstallApprovalPendingReview } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { executePluginDevLoopAction } from '@/plugins/devLoop/actions';
import type { executePluginSettingsAdministrationAction } from '@/plugins/settings/administration';
import type { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import type { createMarketplaceIndexService } from '@/plugins/store/marketplace/service';
import { createPluginPermissionGrantActionExecutor } from '@/plugins/runtime/lifecycle/permissions/pluginPermissionGrantActionExecutor';
import { createPluginWebhookActionExecutor } from '@/plugins/runtime/webhooks/pluginWebhookActionExecutor';
import type { executePluginExternalSessionAction } from '../externalSessions/pluginExternalSessionActionExecutor';
export type CliPluginAdministrationActionDeps = Pick<ActionExecutorDeps, 'pluginsDevLoopAction' | 'pluginSettingsAdministrationAction' | 'pluginPermissionGrantAction' | 'pluginWebhookAction' | 'pluginSessionHookManagementAction' | 'externalSessionAction'> & Readonly<{
  pluginChangeServices: Readonly<{ requestUserPluginChange?: typeof requestUserPluginChange; decideUserPluginChange?: typeof decideUserPluginChange }>;
  pluginInstallApprovalChangeServices: Readonly<{ requestUserPluginChange?: typeof requestUserPluginChange }>;
  resolvePluginInstallWorkspaceRoot: (input: unknown, signal?: AbortSignal) => Promise<string | undefined>;
}>;
export function createCliPluginAdministrationActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'externalSessionPluginAdmissionOwner' | 'happyHomeDir' | 'pluginChangeService' | 'revalidatePluginActionCallerMaterialization' | 'savedSecretOperationContext' | 'serverHttpBaseUrl'>,
  { approvalsStore, notSupported, readRecord, resolveCurrentSessionValue }: Readonly<{
    approvalsStore: ReturnType<typeof createCliApprovalsArtifactStore> | null;
    notSupported: () => never;
    readRecord: (value: unknown) => Record<string, unknown>;
    resolveCurrentSessionValue: (key: 'path' | 'host' | 'machineId', signal?: AbortSignal) => Promise<string | null>;
  }>,
): CliPluginAdministrationActionDeps {
  const pluginChangeService = params.pluginChangeService;
  const pluginChangeServices = pluginChangeService ? {
    requestUserPluginChange: async (input: Parameters<typeof requestUserPluginChange>[0]) => {
      const { requestUserPluginChange } = await import("@/plugins/daemon/changeClient");
      return requestUserPluginChange(input, {
      ensureDaemon: async () => undefined,
      requestChange: pluginChangeService.requestPluginChange,
      decideChange: pluginChangeService.decidePluginChange,
    });
    },
    decideUserPluginChange: async (input: Parameters<typeof decideUserPluginChange>[0]) => {
      const { decideUserPluginChange } = await import("@/plugins/daemon/changeClient");
      return decideUserPluginChange(input, {
      ensureDaemon: async () => undefined,
      readStatus: pluginChangeService.statusPluginChange,
      decideChange: pluginChangeService.decidePluginChange,
    });
    },
  } : {};
  const pluginInstallApprovalChangeServices = pluginChangeService ? {
    requestUserPluginChange: async (input: Parameters<typeof requestUserPluginChange>[0]) => {
      const { requestUserPluginChange } = await import("@/plugins/daemon/changeClient");
      return requestUserPluginChange(input, {
      ensureDaemon: async () => undefined,
      // The Action's ordinary approval remains authoritative even when this
      // exact source is already trusted by the daemon's install policy.
      requestChange: (request: Parameters<DaemonPluginChangeService['requestPluginChange']>[0],
        options?: Parameters<DaemonPluginChangeService['requestPluginChange']>[1]) =>
        pluginChangeService.requestPluginChange(request, { ...options, retainReview: true }),
      decideChange: pluginChangeService.decidePluginChange,
    });
    },
  } : {};

  const resolvePluginInstallWorkspaceRoot = async (input: unknown, signal?: AbortSignal) => {
    const request = readRecord(input);
    const source = readRecord(request.source);
    // Remote candidates and installed updates have no Session-relative trust
    // decision. Global callers must not look up a synthetic bound Session.
    if (source.kind === 'marketplace' || source.kind === 'installed'
      || request.kind === 'npm' || request.kind === 'archive') return undefined;
    return await resolveCurrentSessionValue('path', signal) ?? undefined;
  };
  const pluginPermissionGrantAction = params.credentials
    ? createPluginPermissionGrantActionExecutor({
      credentials: params.credentials,
      ...(params.revalidatePluginActionCallerMaterialization
        ? { revalidateCallerMaterialization: params.revalidatePluginActionCallerMaterialization }
        : {}),
    })
    : null;
  const pluginWebhookAction = params.credentials
    ? createPluginWebhookActionExecutor({
      credentials: params.credentials,
      ...(params.revalidatePluginActionCallerMaterialization
        ? { revalidateCallerMaterialization: params.revalidatePluginActionCallerMaterialization }
        : {}),
    })
    : null;
  return {
pluginsDevLoopAction: async ({ actionId, input, context }) => {
      const accountEnablement = (actionId === 'plugins.enable' || actionId === 'plugins.disable') && readRecord(input).scope === 'account';
      if (accountEnablement) {
        if (!params.credentials) return notSupported();
        const requesterAccountId = context.externalActionCredential?.accountId
          ?? context.externalActionExecutionAuthorization?.binding.accountId;
        if (requesterAccountId && requesterAccountId !== readAccountIdFromToken(params.credentials.token)) {
          return { ok: false, errorCode: 'permission_denied', error: 'permission_denied' };
        }
      }
      const marketplaceInstall = actionId === 'plugins.install' && input !== null && typeof input === 'object'
        && 'source' in input && input.source !== null && typeof input.source === 'object'
        && 'kind' in input.source && input.source.kind === 'marketplace';
      if (marketplaceInstall) {
        if (!params.credentials || !approvalsStore) return notSupported();
        const requesterAccountId = context.externalActionCredential?.accountId
          ?? context.externalActionExecutionAuthorization?.binding.accountId;
        if (requesterAccountId && requesterAccountId !== readAccountIdFromToken(params.credentials.token)) {
          // Machine placement grants no custody of a foreign requester's private
          // source catalog. The incumbent Action admission failure stays explicit.
          return { ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' };
        }
      }
      const operation = async () => {
        const [{ createCliRegistryHostV1 }, { executePluginDevLoopAction }, { createMarketplaceIndexService }] = await Promise.all([import("@/registries/createCliRegistryHost"), import("@/plugins/devLoop/actions"), import("@/plugins/store/marketplace/service")]);
        const registry = marketplaceInstall && params.credentials && approvalsStore
          ? createCliRegistryHostV1({ credentials: params.credentials,
            port: approvalsStore.promptLibraryStore.organization, signal: context.signal,
            operationContext: params.savedSecretOperationContext }) : null;
        const approvedInstallReview = actionId === 'plugins.install' && context.presentUserApproval && approvalsStore
          ? readPluginInstallApprovalPendingReview(readRecord(await approvalsStore.approvalsGet({
              artifactId: context.presentUserApproval.artifactId,
              serverId: null,
            })).preview)
          : null;
        if (actionId === 'plugins.install' && context.presentUserApproval && !approvedInstallReview) {
          return { ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' };
        }
        return await executePluginDevLoopAction({ actionId, input,
          happyHomeDir: params.happyHomeDir,
          workspaceRoot: actionId === 'plugins.install'
            ? await resolvePluginInstallWorkspaceRoot(input, context.signal)
            : actionId === 'plugins.scaffold'
              ? await resolveCurrentSessionValue('path', context.signal) ?? undefined
              : undefined,
          context,
        }, {
          ...pluginChangeServices,
          ...(accountEnablement && params.credentials ? { account: { credentials: params.credentials,
            serverUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl() } } : {}),
          ...(actionId === 'plugins.install' ? { installEffectAdmitted: true as const } : {}),
          ...(registry ? { marketplaceIndexService: createMarketplaceIndexService({ happyHomeDir: params.happyHomeDir,
            readRegistrySources: registry.readSources }) } : {}),
          ...(approvedInstallReview ? { approvedInstallReview } : {}),
        });
      };
      return params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, operation) : operation();
    },
pluginSettingsAdministrationAction: Object.assign(async ({ actionId, input, context }: Parameters<NonNullable<ActionExecutorDeps['pluginSettingsAdministrationAction']>>[0]) => {
      const { executePluginSettingsAdministrationAction } = await import("@/plugins/settings/administration");
      return (
      await executePluginSettingsAdministrationAction({
        actionId,
        input,
        happyHomeDir: params.happyHomeDir,
        ...(context.actionCaller ? { actionCaller: context.actionCaller } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      })
    );
    }, {
      admitInput: async ({ actionId, input, context }: Parameters<NonNullable<ActionExecutorDeps['pluginSettingsAdministrationAction']>>[0]) => {
        const { executePluginSettingsAdministrationAction } = await import("@/plugins/settings/administration");
        return (
        await executePluginSettingsAdministrationAction.admitInput({
          actionId,
          input,
          happyHomeDir: params.happyHomeDir,
          ...(context.actionCaller ? { actionCaller: context.actionCaller } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        })
      );
      },
    }),
pluginPermissionGrantAction: async (args) => pluginPermissionGrantAction
      ? await pluginPermissionGrantAction(args)
      : { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },
pluginWebhookAction: async (args) => pluginWebhookAction
      ? await pluginWebhookAction(args)
      : { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' },
pluginSessionHookManagementAction: async (args) => {
      const hookManagementAction =
        params.externalSessionPluginAdmissionOwner?.hookManagementAction;
      if (!hookManagementAction) {
        return {
          ok: false,
          errorCode: 'unsupported_action',
          error: `unsupported_action:${args.actionId}`,
        };
      }
      const execution = await hookManagementAction(
        args.actionId,
        args.input,
        {
          surface: 'action',
          ...(args.signal ? { signal: args.signal } : {}),
        },
      );
      return execution.ok ? execution.result : execution;
    },
externalSessionAction: async (args) => {
      const { executePluginExternalSessionAction } = await import("../externalSessions/pluginExternalSessionActionExecutor");
      return params.credentials
      ? await executePluginExternalSessionAction(
          { ...args, credentials: params.credentials },
          params.externalSessionPluginAdmissionOwner?.materializeStart
            ? {
                materializeStart:
                  params.externalSessionPluginAdmissionOwner.materializeStart,
              }
            : {},
        )
      : { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    },
pluginChangeServices,
pluginInstallApprovalChangeServices,
resolvePluginInstallWorkspaceRoot
  };
}
