import axios from 'axios';
import { ManagedGetOutputV1Schema, managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { StoredCredentials } from '@/persistence';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';

/** Ordinary Account read: child consumers do not need controller custody or reachability. */
export async function readManagedMachine(input: Readonly<{
  credentials?: StoredCredentials; serverHttpBaseUrl: string; homeId: string; managedId: string; signal?: AbortSignal;
  authorization?: ExternalActionExecutionAuthorizationV1; effectActionId?: string;
}>): Promise<ManagedMachineV1> {
  const path = managedMachineActionEndpointPathV1('machines.managed.get');
  const body = { homeId: input.homeId, managedId: input.managedId };
  const http = input.authorization?.requesterHttpProjection;
  const requesterHeaders = http && http.serverId === input.homeId && await http.isCurrent()
    ? await http.createRequestHeaders({ effectActionId: input.effectActionId ?? input.authorization!.binding.actionId,
      method: 'POST', path, body, ...(input.signal ? { signal: input.signal } : {}) }) : null;
  if (input.authorization && !requesterHeaders || !input.authorization && !input.credentials) throw Object.assign(new Error('Managed Machine requester authority is unavailable'), { code: 'workspace_sync_child_unavailable' });
  const response = await axios.post<unknown>(
    `${input.serverHttpBaseUrl.replace(/\/+$/, '')}${path}`, body, {
      headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...(requesterHeaders ?? { Authorization: `Bearer ${input.credentials!.token}` }) },
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  if (http && !await http.isCurrent()) throw Object.assign(new Error('Managed Machine requester authority is unavailable'), { code: 'workspace_sync_child_unavailable' });
  return ManagedGetOutputV1Schema.parse(response.data);
}
