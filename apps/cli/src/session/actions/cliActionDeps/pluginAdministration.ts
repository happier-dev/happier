import type { CliActionDepsParams } from './types';
import type { ActionExecutorContext, ActionExecutorDeps, ActionExecuteFailure } from '@happier-dev/protocol';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { decideUserPluginChange, requestUserPluginChange } from '@/plugins/daemon/changeClient';
import type { DaemonPluginChangeService } from '@/plugins/daemon/changeService';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { executePluginDevLoopAction } from '@/plugins/devLoop/actions';
import type { executePluginSettingsAdministrationAction } from '@/plugins/settings/administration';
import type { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import type { createMarketplaceIndexService } from '@/plugins/store/marketplace/service';
import { createPluginPermissionGrantActionExecutor } from '@/plugins/runtime/lifecycle/permissions/pluginPermissionGrantActionExecutor';
import { createPluginWebhookActionExecutor } from '@/plugins/runtime/webhooks/pluginWebhookActionExecutor';
import type { executePluginExternalSessionAction } from '../externalSessions/pluginExternalSessionActionExecutor';

export function pluginInstallUsesAccountRegistry(source: Readonly<Record<string, unknown>>): boolean {
  return source.kind === 'marketplace' || source.kind === 'gitCatalog';
}
export type CliPluginAdministrationActionDeps = Pick<ActionExecutorDeps, 'pluginsDevLoopAction' | 'pluginSettingsAdministrationAction' | 'pluginPermissionGrantAction' | 'pluginWebhookAction' | 'pluginSessionHookManagementAction' | 'externalSessionAction'> & Readonly<{
  pluginInstallApprovalChangeServices: Readonly<{ requestUserPluginChange?: typeof requestUserPluginChange }>;
  resolvePluginInstallWorkspaceRoot: (input: unknown, signal?: AbortSignal) => Promise<string | undefined>;
  resolvePluginInstallRegistry: (context: ActionExecutorContext) => Promise<
    Readonly<{ ok: true; registry: ReturnType<typeof createCliRegistryHostV1> | null }> | ActionExecuteFailure
  >;
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
    if (pluginInstallUsesAccountRegistry(source) || source.kind === 'installed' || source.kind === 'git'
      || request.kind === 'npm' || request.kind === 'archive') return undefined;
    return await resolveCurrentSessionValue('path', signal) ?? undefined;
  };
  const resolvePluginInstallRegistry: CliPluginAdministrationActionDeps['resolvePluginInstallRegistry'] = async context => {
    if (!params.credentials || !approvalsStore) return { ok: true, registry: null };
    const requesterAccountId = context.externalActionCredential?.accountId
      ?? context.externalActionExecutionAuthorization?.binding.accountId;
    if (requesterAccountId && requesterAccountId !== readAccountIdFromToken(params.credentials.token)) {
      // Machine control does not grant access to the custodian's Account catalog,
      // including existence checks performed while building an approval preview.
      return { ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' };
    }
    const { createCliRegistryHostV1 } = await import('@/registries/createCliRegistryHost');
    const createRegistry = () => createCliRegistryHostV1({ credentials: params.credentials,
      port: approvalsStore.promptLibraryStore.organization, signal: context.signal,
      operationContext: params.savedSecretOperationContext });
    return { ok: true, registry: params.serverHttpBaseUrl
      ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, createRegistry) : createRegistry() };
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
      const approvedInstallReview = actionId === 'plugins.install'
        ? context.approvedActionReplay?.pluginInstallReview : undefined;
      if (actionId === 'plugins.install' && context.presentUserApproval?.artifactId && !approvedInstallReview) {
        return { ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' };
      }
      const marketplaceInstall = actionId === 'plugins.install' && !approvedInstallReview
        && pluginInstallUsesAccountRegistry(readRecord(readRecord(input).source));
      if (marketplaceInstall && (!params.credentials || !approvalsStore)) return notSupported();
      const operation = async () => {
        const registryResult = marketplaceInstall ? await resolvePluginInstallRegistry(context) : null;
        if (registryResult && !registryResult.ok) return registryResult;
        const registry = registryResult?.registry ?? null;
        const [{ executePluginDevLoopAction }, { createMarketplaceIndexService }] = await Promise.all([import("@/plugins/devLoop/actions"), import("@/plugins/store/marketplace/service")]);
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
            registryHost: registry }) } : {}),
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
pluginInstallApprovalChangeServices,
resolvePluginInstallWorkspaceRoot,
resolvePluginInstallRegistry
  };
}
