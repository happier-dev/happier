import type { TeamCredentialOperationRequestHeaders } from '../directMaterial/teamCredentialDirectMaterialHttp';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { QualifiedConnectedAccountPurposeTeamResourceSelectionV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { PluginError } from '@happier-dev/plugin-sdk';
import { connectedAccountListedAccountOutOfScope as listedAccountOutOfScope } from '@happier-dev/cli-common/connectedAccounts';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import type { TeamCredentialDirectMaterialClient, TeamCredentialDirectMaterialOperationFailure, TeamCredentialDirectMaterialUnavailableReason } from '../directMaterial/teamCredentialDirectMaterialClient';
import { projectTeamResourceSelectionToSessionPurposeBinding, type ConnectedAccountPurposeBindingOwner, type ConnectedAccountTeamDirectMaterialOrigin, type ConnectedAccountPurposeBindingSubject } from './ConnectedAccountPurposeBindingOwner';

export function teamDirectMaterialFailure(
  reason: TeamCredentialDirectMaterialUnavailableReason,
  service: QualifiedConnectedAccountRef['service'],
): PluginError {
  switch (reason) {
    case 'preparing':
      return new PluginError({
        code: 'plugin_connected_account_direct_material_preparing',
        message: 'Shared Connected Account access is still being prepared',
        retryable: true,
        remediation: { kind: 'retry' },
      });
    case 'temporarily_unavailable':
      return new PluginError({
        code: 'plugin_connected_account_direct_material_temporarily_unavailable',
        message: 'Shared Connected Account access is temporarily unavailable',
        retryable: true,
        remediation: { kind: 'retry' },
      });
    case 'source_changed':
      return new PluginError({
        code: 'plugin_connected_account_direct_material_source_changed',
        message: 'The shared Connected Account source changed and is being updated',
        retryable: true,
        remediation: { kind: 'retry' },
      });
    case 'recipient_binding_changed':
      return new PluginError({
        code: 'plugin_connected_account_direct_material_recipient_binding_changed',
        message: 'This device needs current Account encryption material before using the shared Connected Account',
        remediation: { kind: 'openSettings', path: '/settings/account/security' },
      });
    case 'access_removed':
      return new PluginError({
        code: 'plugin_connected_account_direct_access_removed',
        message: 'Access to the shared Connected Account was removed',
        remediation: { kind: 'selectAccount', service },
      });
    case 'disabled':
      return new PluginError({
        code: 'plugin_connected_account_direct_material_disabled',
        message: 'Direct access to the shared Connected Account is disabled',
        remediation: { kind: 'selectAccount', service },
      });
    case 'unsupported_direct_source':
      return new PluginError({
        code: 'plugin_connected_account_direct_material_unsupported',
        message: 'This client cannot use the shared Connected Account directly',
        remediation: { kind: 'selectAccount', service },
      });
    case 'invalid_material':
      return new PluginError({
        code: 'plugin_connected_account_direct_material_invalid',
        message: 'The shared Connected Account material must be repaired before it can be used',
      });
    case 'resource_corrupt':
      return new PluginError({
        code: 'plugin_connected_account_direct_resource_corrupt',
        message: 'The shared Connected Account resource must be repaired before it can be used',
      });
  }
}

export function teamDirectMaterialOperationFailure(
  error: TeamCredentialDirectMaterialOperationFailure,
): PluginError {
  const remediation = error.error === 'team_authentication_required'
    || error.error === 'team_authentication_policy_unavailable'
    ? { kind: 'openSettings' as const, path: '/settings/teams/authentication' }
    : undefined;
  return new PluginError({
    code: error.error,
    message: error.error,
    ...(remediation ? { remediation } : {}),
  });
}

export type ConnectedAccountActionPurposeBindingSubject = Extract<ConnectedAccountPurposeBindingSubject, { kind: 'action_operation' }>;

/** The existing finite operation lease retains the material admitted before effects. */
export async function admitTeamDirectActionMaterialOrigins(input: Readonly<{
  subject: ConnectedAccountActionPurposeBindingSubject;
  origins: readonly ConnectedAccountTeamDirectMaterialOrigin[];
  openTeamDirect?: TeamCredentialDirectMaterialClient['open'];
  resolveRequestHeaders?: TeamCredentialOperationRequestHeaders;
  signal: AbortSignal;
}>): Promise<readonly ConnectedAccountTeamDirectMaterialOrigin[]> {
  const origins: ConnectedAccountTeamDirectMaterialOrigin[] = [];
  for (const origin of input.origins) {
    input.signal.throwIfAborted();
    if (!input.openTeamDirect) throw listedAccountOutOfScope();
    const opened = await input.openTeamDirect({
      ...(origin.teamId ? { teamId: origin.teamId } : {}),
      resourceId: origin.resourceId,
      consumer: { kind: 'action_operation', operationId: input.subject.operationId,
        actionId: input.subject.actionId, pluginVersion: input.subject.pluginVersion, purpose: origin.purpose },
      slot: { kind: 'connected_service_purpose', purpose: origin.purpose },
      disclosedMember: origin.disclosedMember,
      signal: input.signal,
      resolvePlatformOperationRequestHeaders: input.resolveRequestHeaders,
    });
    input.signal.throwIfAborted();
    if (!opened.ok) {
      if ('operationError' in opened) throw teamDirectMaterialOperationFailure(opened.operationError);
      throw teamDirectMaterialFailure(opened.reason, origin.disclosedMember.service);
    }
    origins.push(Object.freeze({ ...origin, admittedActionMaterial: opened }));
  }
  return Object.freeze(origins);
}

export type ActionPurposeBindingAdmissionInput = Omit<Parameters<ConnectedAccountPurposeBindingOwner['activatePurposeBindings']>[0], 'subject'> & Readonly<{
  subject: ConnectedAccountActionPurposeBindingSubject;
  teamResourceSelections?: readonly QualifiedConnectedAccountPurposeTeamResourceSelectionV1[];
  resolveRequestHeaders?: TeamCredentialOperationRequestHeaders;
  signal: AbortSignal;
}>;
export type BrokeredActionExecutionInput = Readonly<{
  input: JsonValue;
  beforeHandlerInvocation?: () => void | Promise<void>;
}>;
export type ExecuteTeamCredentialBrokerAction = (input: BrokeredActionExecutionInput & Readonly<{
  subject: ConnectedAccountActionPurposeBindingSubject;
  teamResourceSelections: readonly QualifiedConnectedAccountPurposeTeamResourceSelectionV1[];
  resolveRequestHeaders?: TeamCredentialOperationRequestHeaders;
  signal: AbortSignal;
}>) => Promise<ActionExecuteResult>;
export type ActionPurposeBindingAdmission =
  | Readonly<{ kind: 'local'; lease: ReturnType<ConnectedAccountPurposeBindingOwner['activatePurposeBindings']> }>
  | Readonly<{ kind: 'brokered'; execute(input: BrokeredActionExecutionInput): Promise<ActionExecuteResult> }>;

/** One mode owner for finite Action credentials, before either execution path. */
export function createActionPurposeBindingAdmission(dependencies: Readonly<{
  activatePurposeBindings: ConnectedAccountPurposeBindingOwner['activatePurposeBindings'];
  openTeamDirect?: TeamCredentialDirectMaterialClient['open'];
  executeTeamCredentialBrokerAction?: ExecuteTeamCredentialBrokerAction;
}>): (input: ActionPurposeBindingAdmissionInput) => Promise<ActionPurposeBindingAdmission> {
  return async input => {
    input.signal.throwIfAborted();
    const teamResourceSelections = input.teamResourceSelections ?? [];
    if (teamResourceSelections.some(entry => entry.selection.deliveryMode === 'brokered')) {
      const execute = dependencies.executeTeamCredentialBrokerAction;
      if (!execute) throw listedAccountOutOfScope();
      return Object.freeze({ kind: 'brokered' as const, execute: async (execution: BrokeredActionExecutionInput) => {
        input.signal.throwIfAborted();
        return await execute({ ...execution, subject: input.subject, teamResourceSelections, signal: input.signal,
          resolveRequestHeaders: input.resolveRequestHeaders });
      } });
    }
    const projections = teamResourceSelections.map(entry => {
      if (entry.selection.deliveryMode !== 'direct') throw listedAccountOutOfScope();
      const projection = projectTeamResourceSelectionToSessionPurposeBinding({ ...entry, service: entry.selection.disclosedMember.service });
      if (!projection) throw listedAccountOutOfScope();
      return projection;
    });
    const directMaterialOrigins = await admitTeamDirectActionMaterialOrigins({ subject: input.subject,
      origins: [...(input.directMaterialOrigins ?? []), ...projections.map(entry => entry.origin)],
      openTeamDirect: dependencies.openTeamDirect, signal: input.signal, resolveRequestHeaders: input.resolveRequestHeaders });
    input.signal.throwIfAborted();
    const { signal: _signal, teamResourceSelections: _teamResourceSelections, resolveRequestHeaders: _resolveRequestHeaders, ...activation } = input;
    const lease = dependencies.activatePurposeBindings({ ...activation,
      bindings: [...input.bindings, ...projections.map(entry => entry.binding)], directMaterialOrigins });
    return Object.freeze({ kind: 'local' as const, lease });
  };
}
