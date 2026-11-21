import { clientActionUnavailable } from '@happier-dev/protocol/actions/clientDispatchV1';
import { isLocalServicePresentationActionIdV1 } from '@happier-dev/protocol/local/services/actionIdsV1';
import { DaemonLocalServiceLauncherOpenPreviewResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { buildLocalServiceDeclarationPreviewLandingUrlV1, DaemonLocalServicePreviewOpenOrCreateResponseV1Schema } from '@happier-dev/protocol/local/services/preview/v1';
import type { BrowserViewTargetV1 } from '@happier-dev/protocol/browser/target/v1';
import { configuration } from '@/configuration';
import { openBrowser } from '@/ui/openBrowser';
import type { CliActionDepsParams } from './types';
import { LocalServiceInventoryCountResponseV1Schema } from '@happier-dev/protocol/local/services/inventory/v1';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DaemonLocalServiceLauncherSnapshotResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { createTargetedActionRpcRequestV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { createUnavailableRuntimeActionExecutor } from '@happier-dev/protocol/actions/executor/dispatch';
import { DaemonLocalServiceLauncherStartRequestV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { LocalServiceActionRequestV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { parseLocalServiceDomainActionRpcRequest, resolveLocalServiceDomainActionRpcBinding, resolveLocalServiceActionKindForRuntimeActionId } from '@happier-dev/protocol/actions/specs/localServices';
import { requiresAgentEgressRedaction } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { DaemonLocalServicePublicPreviewCreateResponseV1Schema, DaemonLocalServicePublicPreviewRevokeResponseV1Schema, LocalServicePublicPreviewSnapshotV1Schema, redactLocalServicePublicPreviewCreateResponseForAgentEgress, redactLocalServicePublicPreviewRevokeResponseForAgentEgress, redactLocalServicePublicPreviewSnapshotForAgentEgress } from '@happier-dev/protocol/local/services/public/v1';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { readMachineRpcRequestDisposition } from '@/session/transport/rpc/machineRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { CliMachineActionCall } from './machineTransport';
import type { CliProjectAdmission } from './projectAdmission';
export type CliLocalServiceActionDeps = Pick<ActionExecutorDeps, 'homeRuntimeTaskRpc' | 'prepareLocalServiceStartApproval' | 'runtimeActionExecute'>;
export type CliLocalServiceHost = Readonly<{
  callMachineAction: CliMachineActionCall;
  projectHomeId: string;
  projectHomeAdmission: CliProjectAdmission['projectHomeAdmission'];
  withProjectHome: CliProjectAdmission['withProjectHome'];
  executionRunActionFailure: (code: string, message?: string, details?: unknown) => Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>;
}>;
export function createCliLocalServiceClientActionExecutor(
  fallback?: ActionExecutorDeps['clientActionExecute'],
): NonNullable<ActionExecutorDeps['clientActionExecute']> {
  return async args => args.context.surface === 'cli' && args.context.authority === 'present_user'
    && isLocalServicePresentationActionIdV1(args.actionId) ? await args.execute()
    : fallback ? await fallback(args) : clientActionUnavailable(args.actionId);
}

function destinationUrl(target: BrowserViewTargetV1 | undefined, serverId: string): string | null {
  if (target?.kind === 'externalUrl') return target.url;
  return target?.kind === 'localServicePreview' ? buildLocalServiceDeclarationPreviewLandingUrlV1(configuration.webappUrl,
    { serverId, machineId: target.machineId, targetId: target.targetId }) : null;
}

export function createCliLocalServiceActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'machineActionDirectTargetTransport' | 'serverId'>,
  host: CliLocalServiceHost,
): CliLocalServiceActionDeps {
  const { callMachineAction, projectHomeId, projectHomeAdmission, withProjectHome, executionRunActionFailure } = host;
  return {
    homeRuntimeTaskRpc: async ({ machineId, method, request, context }) => {
      try {
        return await callMachineAction({ machineId, serverId: context.serverId ?? params.serverId,
          method: method === 'detect' ? RPC_METHODS.CAPABILITIES_DETECT : RPC_METHODS.CAPABILITIES_INVOKE,
          request, context, effectActionId: 'home.runtime.restart', exactMachine: true, timeoutMs: null,
          ...(context.authority ? { authority: context.authority } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        });
      } catch (error) {
        const { readMachineRpcRequestDisposition } = await import("@/session/transport/rpc/machineRpc");
        if (readMachineRpcRequestDisposition(error) === 'notSent') {
          return { ok: false, errorCode: 'request_not_sent', error: 'request_not_sent' };
        }
        throw error;
      }
    },
    prepareLocalServiceStartApproval: async ({ input, context }) => {
      const unavailable = { ok: false as const, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' };
      const denied = await projectHomeAdmission(input.workspace?.serverId, context);
      if (denied) return denied;
      if (!context.surface) return unavailable;
      const raw = await withProjectHome(() => callMachineAction({ machineId: input.machineId, serverId: projectHomeId,
        method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
        request: { machineId: input.machineId, startReview: { request: input, surface: context.surface } },
        context, exactMachine: true, ...(context.signal ? { signal: context.signal } : {}) }));
      const response = DaemonLocalServiceLauncherSnapshotResponseV1Schema.safeParse(raw);
      return response.success && response.data.startReview ? response.data.startReview : unavailable;
    },
    runtimeActionExecute: async (args) => {
      const isStart = args.actionId === 'localServices.launcher.start';
      const controlKind = resolveLocalServiceActionKindForRuntimeActionId(args.actionId);
      const domainRpc = resolveLocalServiceDomainActionRpcBinding(args.actionId);
      const presentation = isLocalServicePresentationActionIdV1(args.actionId);
      if (presentation && (args.context.surface !== 'cli' || args.context.authority !== 'present_user')) {
        return createUnavailableRuntimeActionExecutor()(args);
      }
      if (!isStart && !domainRpc && !controlKind) {
        return createUnavailableRuntimeActionExecutor()(args);
      }
      const spec = getActionSpec(args.actionId);
      const admittedInput = spec.inputSchema.safeParse(args.input);
      if (!admittedInput.success) return executionRunActionFailure('invalid_parameters');
      const parsedStart = !domainRpc && isStart
        ? DaemonLocalServiceLauncherStartRequestV1Schema.safeParse(admittedInput.data) : null;
      const parsed = domainRpc ? parseLocalServiceDomainActionRpcRequest(args.actionId, admittedInput.data) : isStart
        ? parsedStart
        : LocalServiceActionRequestV1Schema.safeParse(admittedInput.data);
      if (!parsed?.success) return executionRunActionFailure('invalid_parameters');
      const request = parsed.data;
      const machineId = 'target' in request ? request.target.machineId : request.machineId;
      const denied = await projectHomeAdmission(parsedStart?.success ? parsedStart.data.workspace?.serverId : undefined, args.context);
      if (denied) return denied;
      const method = spec.bindings?.rpcMethod;
      if (!method) return executionRunActionFailure('runtime_action_disabled');
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return executionRunActionFailure('not_authenticated');
      }
      args.context.signal?.throwIfAborted();
      const response = await withProjectHome(() => callMachineAction({ machineId, serverId: projectHomeId,
        method, request: domainRpc ? request : createTargetedActionRpcRequestV1(request, { kind: 'machine', machineId },
          { defaultSessionId: args.context.defaultSessionId }),
        authority: args.context.authority, authorization: args.context.rpcSessionAuthorization,
        context: args.context, effectActionId: args.actionId, exactMachine: true, timeoutMs: null,
        ...(args.context.signal ? { signal: args.context.signal } : {}),
      }));
      const failure = ActionExecuteFailureSchema.safeParse(response);
      if (failure.success) return failure.data;
      const countProjection = args.actionId === 'localServices.inventory.list' && 'projection' in request && request.projection === 'count';
      const result = countProjection ? LocalServiceInventoryCountResponseV1Schema.parse(response) : domainRpc && 'snapshotResponseSchema' in domainRpc
        ? domainRpc.snapshotResponseSchema.parse(response).snapshot : response;
      if (presentation && controlKind !== 'copy_url') {
        const launcher = controlKind === 'open_preview' ? null : DaemonLocalServiceLauncherOpenPreviewResponseV1Schema.parse(result);
        if (launcher?.status === 'unavailable') return launcher;
        const target = launcher ? launcher.browserTarget
          : DaemonLocalServicePreviewOpenOrCreateResponseV1Schema.parse(result).preview.resource.browserTarget;
        const url = destinationUrl(target, projectHomeId);
        if (!url) return executionRunActionFailure('local_service_destination_unavailable');
        args.context.signal?.throwIfAborted();
        if (!await openBrowser(url)) return executionRunActionFailure('browser_unavailable', undefined, { destinationUrl: url });
      }
      if (requiresAgentEgressRedaction(args.context)) {
        if (args.actionId === 'localServices.publicPreview.status') return redactLocalServicePublicPreviewSnapshotForAgentEgress(LocalServicePublicPreviewSnapshotV1Schema.parse(result));
        if (args.actionId === 'localServices.publicPreview.create') return redactLocalServicePublicPreviewCreateResponseForAgentEgress(DaemonLocalServicePublicPreviewCreateResponseV1Schema.parse(result));
        if (args.actionId === 'localServices.publicPreview.revoke') return redactLocalServicePublicPreviewRevokeResponseForAgentEgress(DaemonLocalServicePublicPreviewRevokeResponseV1Schema.parse(result));
      }
      return result;
    }
  };
}
