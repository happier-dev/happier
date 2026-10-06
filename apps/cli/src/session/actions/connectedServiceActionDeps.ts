import axios from 'axios';
import { executeConnectedServiceConfigurationActionV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { buildRecoveryCreditConsumeIdempotencyKey } from '@happier-dev/protocol/connect/recoveryCreditConsumeIdempotencyKey';
import { ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema, ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import { AccountSettingMutationV1Schema } from '@happier-dev/protocol/account/settings/accountSettingMutationV1';
import { CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD, ConnectedAccountControlCommandRequestSchema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import { qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { StoredCredentials } from '@/persistence';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { updateAccountSettingsV2OnceAgainstLatest } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { resolveConnectedServicesServerApiTimeoutMs } from '@/api/client/connectedServicesServerApiTimeout';
import { classifyActionTransportFailure } from '@/api/client/classifyServerEndpointError';

export function createCliConnectedServiceAction(params: Readonly<{
  credentials: StoredCredentials;
  serverHttpBaseUrl?: string;
  serverId?: string;
  resolveHeaders(context: ActionExecutorContext, actionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>): Readonly<Record<string, string>> | null;
  callMachineAction(input: Readonly<{ machineId: string; serverId?: string; method: string; request: unknown; signal?: AbortSignal }>): Promise<unknown>;
}>): NonNullable<ActionExecutorDeps['connectedServiceAction']> {
  return async ({ actionId, input, context, signal }) => {
    const run = async () => executeConnectedServiceConfigurationActionV1({
      assertCurrent: () => signal?.throwIfAborted(),
      request: async (request) => {
        const headers = params.resolveHeaders(context, actionId, request);
        if (!headers) throw Object.assign(new Error('action_authorization_unavailable'), { code: 'action_authorization_unavailable' });
        signal?.throwIfAborted();
        const response = await axios.request<unknown>({
          url: `${params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()}${request.path}`,
          method: request.method, headers: { ...headers, 'Content-Type': 'application/json' },
          ...(request.body === undefined ? {} : { data: request.body }),
          timeout: resolveConnectedServicesServerApiTimeoutMs(),
          ...(signal ? { signal } : {}), validateStatus: () => true,
        }).catch((error: unknown) => {
          const failure = classifyActionTransportFailure(error, {
            mutation: request.method !== 'GET', requestIssued: true,
            cancelled: signal?.aborted === true || axios.isCancel(error),
          });
          if (!failure) throw error;
          const code = failure === 'network' ? 'server_unreachable' : failure;
          throw Object.assign(new Error(code), { code });
        });
        if (response.status < 200 || response.status >= 300) {
          const code = response.data && typeof response.data === 'object' && 'error' in response.data && typeof response.data.error === 'string'
            ? response.data.error : [404, 405, 501].includes(response.status) ? 'unsupported' : 'connected_service_operation_failed';
          throw Object.assign(new Error(code), { code });
        }
        return response.data;
      },
      mutateSettings: async (mutate) => {
        const result = await updateAccountSettingsV2OnceAgainstLatest({ credentials: params.credentials,
          prepareMutation: async (raw) => {
            const next = mutate(raw);
            const keys = ['connectedServicesProfileLabelByKey', 'connectedAccountPurposeBindingsV1', 'connectedServicesDefaultAuthByAgentIdV1'] as const;
            return AccountSettingMutationV1Schema.parse({ operations: keys.filter((key) => next[key] !== undefined).map((key) => (
              next[key] === null ? { op: 'reset', key } : { op: 'set', key, value: next[key] }
            )) });
          }, ...(signal ? { signal } : {}),
        });
        if (!['applied', 'satisfied', 'unchanged'].includes(result.status)) throw Object.assign(new Error(`account_settings_${result.status}`), { code: `account_settings_${result.status}` });
      },
      resolveAgent: async (agentId) => {
        const agent = readAgentCatalogSnapshot().agentDefinitionsById.get(agentId);
        if (!agent?.pluginId) return null;
        const pluginId = agent.pluginId;
        return { agentId, title: agentId, identity: agent.identity ?? null,
          connectedAccounts: (agent.richDefinition?.definition.connectedAccounts ?? []).map((declaration) => ({
            ...declaration, service: qualifyPluginContributionReferenceV1(declaration.service, pluginId),
          })),
        };
      },
      resetQuota: async ({ machineId, serviceId, profileId, providerCreditId, sourceSnapshotFetchedAtMs }) => {
        const request = ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema.parse({ serviceId, profileId,
          idempotencyKey: buildRecoveryCreditConsumeIdempotencyKey({ serviceId, profileId, providerCreditId, sourceSnapshotFetchedAtMs }),
          ...(providerCreditId ? { providerCreditId } : {}),
        });
        return ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema.parse(await params.callMachineAction({
          machineId, ...(params.serverId ? { serverId: params.serverId } : {}),
          method: RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME, request, ...(signal ? { signal } : {}),
        }));
      },
      controlCommand: async (machineId, command) => params.callMachineAction({
        machineId, ...(params.serverId ? { serverId: params.serverId } : {}),
        method: CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
        request: ConnectedAccountControlCommandRequestSchema.parse({ v: 1, machineId, command }),
        ...(signal ? { signal } : {}),
      }),
    }, actionId, input);
    return params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, run) : run();
  };
}
