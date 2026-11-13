import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import { fetchWithCredentialRedirectRefusal } from '@happier-dev/cli-common/homeTarget';
import { MACHINE_HTTP_LOCAL_CAPABILITY_HEADER } from '@happier-dev/iroh-native/node';
import { formatQualifiedPluginActionId, parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { QualifiedConnectedAccountPurposeV1, TeamResourceConnectedServiceSelectionV2 } from '@happier-dev/protocol';
import { PROVIDER_BROKER_OPEN_HTTP_PATH_V1, PROVIDER_BROKER_ACTION_EXECUTE_PATH_V3, ProviderBrokerActionExecuteResponseV3Schema,
  ProviderBrokerActionOpenResponseV3Schema, type ProviderBrokerActionOpenRequestV3,
  type ProviderBrokerActionOpenResponseV3 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import type { ProviderBrokerMachineCarrierTunnel } from '@/daemon/peer/iroh/providerBrokerMachineCarrierTunnelOpen';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import type { ExecuteTeamCredentialBrokerAction as ExecutePurposeBrokerAction } from '@/daemon/connectedServices/purposeBindings/teamDirectMaterialAdmission';

export type TeamCredentialBrokerActionInput = Readonly<{
  teamId: string;
  selection: Extract<TeamResourceConnectedServiceSelectionV2, { deliveryMode: 'brokered' }>;
  action: Readonly<{ pluginId: string; localId: string }>;
  purpose: QualifiedConnectedAccountPurposeV1;
  pluginVersion: string;
  operationId: string;
  input: JsonValue;
  signal: AbortSignal;
  beforeHandlerInvocation?: () => void | Promise<void>;
}>;
type TeamCredentialBrokerActionTransport = Readonly<{
  initiatorMachineId: string;
  openBroker(request: ProviderBrokerActionOpenRequestV3, signal: AbortSignal): Promise<ProviderBrokerActionOpenResponseV3>;
  openTunnel(request: Readonly<{ brokerOpen: Extract<ProviderBrokerActionOpenResponseV3, { ok: true }>;
    signal: AbortSignal }>): Promise<ProviderBrokerMachineCarrierTunnel>;
  fetchImpl?: typeof fetch;
}>;

/** Uses the admitted root's signed HTTP projection for the one Home open. */
export function createTeamCredentialBrokerActionPurposeExecutor(host: Omit<TeamCredentialBrokerActionTransport, 'openBroker'> & Readonly<{
  openBroker(request: ProviderBrokerActionOpenRequestV3, signal: AbortSignal,
    requestHeaders: Readonly<Record<string, string>>): Promise<ProviderBrokerActionOpenResponseV3>;
}>): ExecutePurposeBrokerAction {
  return async input => await executeTeamCredentialBrokerActionForPurposeBindings({ ...input, ...host,
    openBroker: async (request, signal) => {
      const requestHeaders = await input.resolveRequestHeaders?.({ method: 'POST',
        path: PROVIDER_BROKER_OPEN_HTTP_PATH_V1, body: request, signal });
      if (!requestHeaders) throw new PluginError({ code: 'plugin_connected_account_credential_unavailable',
        message: 'The Action requester authority is unavailable' });
      return await host.openBroker(request, signal, requestHeaders);
    },
  });
}

/** The purpose owner has selected BROKERED; this adapter only projects its wire input. */
export async function executeTeamCredentialBrokerActionForPurposeBindings(input:
  Parameters<ExecutePurposeBrokerAction>[0]
  & TeamCredentialBrokerActionTransport): Promise<ActionExecuteResult> {
  const [selected] = input.teamResourceSelections;
  const action = parseQualifiedPluginActionId(input.subject.actionId);
  // V3 carries one declared purpose/source. Mixing or dropping selections
  // would execute with a different credential scope than the admitted Action.
  if (input.teamResourceSelections.length !== 1 || !selected || selected.selection.deliveryMode !== 'brokered' || !action) {
    throw new PluginError({ code: 'plugin_connected_account_team_resource_unavailable',
      message: 'This Action credential scope cannot execute through its Team broker' });
  }
  return await executeTeamCredentialBrokerAction({ ...input, teamId: selected.teamId,
    selection: selected.selection, action, purpose: selected.purpose,
    pluginVersion: input.subject.pluginVersion, operationId: input.subject.operationId,
  });
}

/** One finite declared Action over the existing authenticated broker carrier. */
export async function executeTeamCredentialBrokerAction(input: TeamCredentialBrokerActionInput & TeamCredentialBrokerActionTransport): Promise<ActionExecuteResult> {
  input.signal.throwIfAborted();
  const actionInput = structuredClone(input.input);
  const consumer = { kind: 'action_operation' as const, operationId: input.operationId,
    actionId: formatQualifiedPluginActionId(input.action), pluginVersion: input.pluginVersion, purpose: input.purpose };
  const inputDigest = computeActionInputApprovalDigestV1(consumer.actionId, actionInput);
  const opened = ProviderBrokerActionOpenResponseV3Schema.parse(await input.openBroker({ v: 3,
    resourceId: input.selection.resourceId, initiatorMachineId: input.initiatorMachineId, consumer, inputDigest }, input.signal));
  if (!opened.ok) throw new PluginError({ code: opened.reasonCode, message: opened.reasonCode,
    ...(opened.failureCause ? { failureCause: opened.failureCause } : {}) });
  const payload = opened.authority.payload;
  if (payload.teamId !== input.teamId || payload.resourceId !== input.selection.resourceId
    || payload.initiator.machineId !== input.initiatorMachineId || payload.inputDigest !== inputDigest
    || !sameStrictJsonValue(payload.consumer, consumer)) {
    throw new PluginError({ code: 'broker_binding_changed', message: 'Broker Action authority does not match this operation' });
  }
  input.signal.throwIfAborted();
  await input.beforeHandlerInvocation?.();
  input.signal.throwIfAborted();
  const tunnel = await input.openTunnel({ brokerOpen: opened, signal: input.signal });
  try {
    input.signal.throwIfAborted();
    const response = await fetchWithCredentialRedirectRefusal(
      `http://127.0.0.1:${tunnel.localPort}${PROVIDER_BROKER_ACTION_EXECUTE_PATH_V3}`,
      { method: 'POST', headers: { 'content-type': 'application/json',
        [MACHINE_HTTP_LOCAL_CAPABILITY_HEADER]: tunnel.localCapability },
        body: JSON.stringify({ input: actionInput }), signal: input.signal }, input.fetchImpl,
      new Set([MACHINE_HTTP_LOCAL_CAPABILITY_HEADER.toLowerCase()]));
    const result = ProviderBrokerActionExecuteResponseV3Schema.safeParse(await response.json());
    if (!result.success) throw new PluginError({ code: 'broker_unavailable', message: 'Broker Action response is unavailable' });
    if (!result.data.ok) throw new PluginError({ code: result.data.reasonCode, message: result.data.reasonCode,
      ...(result.data.failureCause ? { failureCause: result.data.failureCause } : {}) });
    if (!response.ok) throw new PluginError({ code: 'broker_unavailable', message: 'Broker Action transport failed' });
    return result.data.execution;
  } finally {
    // A finite Action has no retained inference claim to retire. Closing the
    // carrier releases its sole stream and its cancellation lifetime.
    await tunnel.close();
  }
}
