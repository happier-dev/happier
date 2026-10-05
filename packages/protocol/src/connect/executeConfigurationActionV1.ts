import { accountSettingsParse } from '../account/settings/accountSettings.js';
import { removeAgentConnectedAccountDefaultsForDeletedTarget } from '../account/settings/connectedServicesSettings.js';
import { writeAgentDefaultChoice, type AgentDefaultChoiceAgent } from './agentDefaultChoices.js';
import { readBuiltInLegacyConnectedServiceIdForQualifiedService } from './connectedServiceBindings.js';
import { updateQualifiedConnectedAccountLabel } from './connectedServiceProfilePreferences.js';
import { encodeQualifiedConnectedAccountV4StructuredQueryValue } from './qualifiedConnectedAccountsV4QueryCodec.js';
import { buildQualifiedConnectedAccountGroupMutationRequestV4 } from './qualifiedConnectedAccountGroupRequestsV4.js';
import { QualifiedConnectedAccountGroupRefSchema, QualifiedConnectedAccountGroupResponseV4Schema, QualifiedConnectedAccountSuccessV4Schema, sameQualifiedConnectedAccountGroupRef, type QualifiedConnectedAccountGroupRef } from './qualifiedConnectedAccountsV4.js';
import { assertConnectedAccountOperationTransportV1, ConnectedAccountDaemonControlResponseSchema, type ConnectedAccountDaemonControlCommand } from './connectedAccountDaemonRpcV1.js';
import {
  CONNECTED_SERVICE_CONFIGURATION_ACTION_INPUT_SCHEMAS_V1 as inputs,
  reorderConnectedServicePoolMembersV1,
  type ConnectedServiceConfigurationActionIdV1,
} from './configurationActionsV1.js';

type QuotaResetInput = ReturnType<(typeof inputs)['connectedServices.quota.reset']['parse']>;
export type ConnectedServiceConfigurationActionHostV1 = Readonly<{
  /** Authenticated transport for the invocation's exact Home. */
  request(input: Readonly<{ method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; body?: unknown }>): Promise<unknown>;
  mutateSettings(mutate: (raw: Readonly<Record<string, unknown>>) => Record<string, unknown>): Promise<void>;
  resolveAgent(agentId: string, machineId?: string): Promise<AgentDefaultChoiceAgent | null>;
  resetQuota(input: QuotaResetInput): Promise<unknown>;
  controlCommand?(machineId: string, command: ConnectedAccountDaemonControlCommand): Promise<unknown>;
  setIdentityPrivacy?: (hidden: boolean) => void;
  assertCurrent(): void;
}>;

function readGroup(value: unknown, expected: QualifiedConnectedAccountGroupRef) {
  const { group } = QualifiedConnectedAccountGroupResponseV4Schema.parse(value);
  if (!sameQualifiedConnectedAccountGroupRef(group.ref, expected)) {
    throw Object.assign(new Error('qualified_connected_accounts_inconsistent_peer'), { code: 'qualified_connected_accounts_inconsistent_peer' });
  }
  return group;
}

/** Thin Action adapter over the existing settings writers, pool endpoints and reset RPC. */
export async function executeConnectedServiceConfigurationActionV1(
  host: ConnectedServiceConfigurationActionHostV1,
  actionId: ConnectedServiceConfigurationActionIdV1,
  input: unknown,
): Promise<unknown> {
  host.assertCurrent();
  switch (actionId) {
    case 'connectedServices.accounts.rename': {
      const { account, label } = inputs[actionId].parse(input);
      await host.mutateSettings((raw) => {
        host.assertCurrent();
        const settings = accountSettingsParse(raw);
        return { ...raw, connectedServicesProfileLabelByKey: updateQualifiedConnectedAccountLabel({
          service: account.service,
          legacyServiceId: readBuiltInLegacyConnectedServiceIdForQualifiedService(account.service),
          accountId: account.accountId, label, labelsByKey: settings.connectedServicesProfileLabelByKey,
        }) };
      });
      break;
    }
    case 'connectedServices.pools.switchNow': {
      const body = inputs[actionId].parse(input);
      readGroup(await host.request({ method: 'POST', path: '/v4/connect/qualified/group/active-account', body }), body.group);
      break;
    }
    case 'connectedServices.pools.create': {
      const body = inputs[actionId].parse(input);
      const group = readGroup(await host.request(buildQualifiedConnectedAccountGroupMutationRequestV4('create', body)), { service: body.service, groupId: body.group.groupId });
      host.assertCurrent();
      return { group };
    }
    case 'connectedServices.pools.patch': {
      const body = inputs[actionId].parse(input);
      const group = readGroup(await host.request(buildQualifiedConnectedAccountGroupMutationRequestV4('patch', body)), { service: body.service, groupId: body.groupId });
      host.assertCurrent();
      return { group };
    }
    case 'connectedServices.pools.members.add':
    case 'connectedServices.pools.members.patch':
    case 'connectedServices.pools.members.remove': {
      const body = inputs[actionId].parse(input);
      const operation = actionId === 'connectedServices.pools.members.add' ? 'addMember' : actionId === 'connectedServices.pools.members.patch' ? 'patchMember' : 'removeMember';
      const group = readGroup(await host.request(buildQualifiedConnectedAccountGroupMutationRequestV4(operation, body)), body.group);
      host.assertCurrent();
      return { group };
    }
    case 'connectedServices.pools.delete': {
      const body = inputs[actionId].parse(input);
      QualifiedConnectedAccountSuccessV4Schema.parse(await host.request(buildQualifiedConnectedAccountGroupMutationRequestV4('delete', body)));
      host.assertCurrent();
      // Defaults identify a pool by ref, not incarnation. A recreated pool may
      // already own that same ref while the old DELETE acknowledgement is in flight.
      const encoded = encodeURIComponent(encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountGroupRefSchema, body.group));
      try {
        readGroup(await host.request({ method: 'GET', path: `/v4/connect/qualified/group?group=${encoded}` }), body.group);
        host.assertCurrent();
        return { applied: true };
      } catch (error) {
        // Only authoritative absence permits cleanup; transport/parse/peer failures
        // must not discard a potentially useful current default.
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'connect_group_not_found') throw error;
      }
      host.assertCurrent();
      await host.mutateSettings((raw) => {
        host.assertCurrent();
        const cleared = removeAgentConnectedAccountDefaultsForDeletedTarget({ settings: accountSettingsParse(raw), target: { kind: 'group', ...body.group } });
        return cleared ? { ...raw, ...cleared } : { ...raw };
      });
      break;
    }
    case 'connectedServices.pools.reorder': {
      const args = inputs[actionId].parse(input);
      const encoded = encodeURIComponent(encodeQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountGroupRefSchema, args.group));
      const group = readGroup(await host.request({ method: 'GET', path: `/v4/connect/qualified/group?group=${encoded}` }), args.group);
      await reorderConnectedServicePoolMembersV1({ group, ...('move' in args ? { move: args.move } : { accountIds: args.accountIds }),
        members: (current) => current.members.map((member) => ({ accountId: member.connectedAccountId, priority: member.priority })),
        patch: async (current, connectedAccountId, priority) => {
          host.assertCurrent();
          const request = buildQualifiedConnectedAccountGroupMutationRequestV4('patchMember', { group: current.ref, connectedAccountId, priority,
            expectedGeneration: current.generation, expectedIncarnation: current.incarnation, expectedRuntimeStateRevision: current.runtimeStateRevision });
          return readGroup(await host.request(request), args.group);
        },
      });
      break;
    }
    case 'connectedServices.accounts.default.set':
    case 'connectedServices.pools.default.set': {
      const args = inputs[actionId].parse(input);
      const agent = await host.resolveAgent(args.agentId, args.machineId);
      host.assertCurrent();
      if (!agent) return { ok: false, errorCode: 'unknown_agent', error: 'unknown_agent' };
      await host.mutateSettings((raw) => {
        host.assertCurrent();
        const written = writeAgentDefaultChoice({ agents: [agent], agentId: args.agentId, makeDefault: args.makeDefault,
          settings: accountSettingsParse(raw), target: 'account' in args ? { kind: 'account', account: args.account } : { kind: 'group', ...args.group } });
        if (!written) throw Object.assign(new Error('agent_connected_service_unavailable'), { code: 'agent_connected_service_unavailable' });
        return { ...raw, ...written };
      });
      break;
    }
    case 'connectedServices.quota.reset':
      return await host.resetQuota(inputs[actionId].parse(input));
    case 'connectedServices.quota.refresh': {
      const { account, machineId } = inputs[actionId].parse(input);
      if (!host.controlCommand) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      const admission = ConnectedAccountDaemonControlResponseSchema.parse(await host.controlCommand(machineId, {
        operation: 'describeService', service: account.service, requiredOperation: 'quota_refresh',
      }));
      host.assertCurrent();
      try {
        assertConnectedAccountOperationTransportV1(admission, account.service, { kind: 'v4' });
      } catch (error) {
        if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
          return { ok: false, errorCode: error.code, error: error.message };
        }
        throw error;
      }
      QualifiedConnectedAccountSuccessV4Schema.parse(await host.request({ method: 'POST', path: '/v4/connect/qualified/quotas/refresh', body: { ref: account } }));
      break;
    }
    case 'connectedServices.identityPrivacy.set': {
      if (!host.setIdentityPrivacy) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      host.setIdentityPrivacy(inputs[actionId].parse(input).hidden);
      break;
    }
  }
  host.assertCurrent();
  return { applied: true };
}
