import axios from '@/api/client/credentialAxios';
import { ManagedGetOutputV1Schema, ManagedListOutputV1Schema, managedMachineActionEndpointPathV1,
  unwrapManagedMachineReadV1, type ManagedMachineReadV1, type ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineFullV1, ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedErrorV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineControllerError } from './controllerErrors';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { StoredCredentials } from '@/persistence';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createManagedPresetHydrator } from './presetHydration';
import { ManagedMachinePresetGetResultV1Schema, type ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { machinePresetActionEndpointPathV1, type MachinePresetActionInputV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';

type ManagedAccountRead = Readonly<{
  credentials?: StoredCredentials; serverHttpBaseUrl: string; signal?: AbortSignal;
  authorization?: ExternalActionExecutionAuthorizationV1; effectActionId?: string;
  homeId: string;
}>;
export type ReadManagedMachineInput = ManagedAccountRead & ManagedMachineActionInputV1<'machines.managed.get'>;

async function readManagedAccountResource(input: ManagedAccountRead, path: string, body: unknown): Promise<unknown> {
  const http = input.authorization?.requesterHttpProjection;
  const requesterHeaders = http && http.serverIdentityId === input.homeId && await http.isCurrent()
    ? await http.createRequestHeaders({ effectActionId: input.effectActionId ?? input.authorization!.binding.actionId,
      method: 'POST', path, body, ...(input.signal ? { signal: input.signal } : {}) }) : null;
  if (input.authorization && !requesterHeaders || !input.authorization && !input.credentials) throw Object.assign(new Error('Managed Machine requester authority is unavailable'), { code: 'workspace_sync_child_unavailable' });
  const response = await axios.post<unknown>(
    `${input.serverHttpBaseUrl.replace(/\/+$/, '')}${path}`, body, {
      headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...(requesterHeaders ?? { Authorization: `Bearer ${input.credentials!.token}` }) },
      validateStatus: () => true,
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  if (http && !await http.isCurrent()) throw Object.assign(new Error('Managed Machine requester authority is unavailable'), { code: 'workspace_sync_child_unavailable' });
  if (response.status < 200 || response.status >= 300) {
    const refusal = ManagedErrorV1Schema.safeParse(response.data);
    throw Object.assign(new ManagedMachineControllerError(refusal.success ? refusal.data.code : 'managed_request_failed'),
      { status: response.status });
  }
  return response.data;
}

/** Ordinary Account read: child consumers do not need controller custody or reachability. */
export async function readManagedMachineRead(input: ReadManagedMachineInput): Promise<ReturnType<typeof ManagedGetOutputV1Schema.parse>> {
  const { credentials: _credentials, serverHttpBaseUrl: _url, signal: _signal,
    authorization: _authorization, effectActionId: _effect, ...body } = input;
  return ManagedGetOutputV1Schema.parse(await readManagedAccountResource(input,
    managedMachineActionEndpointPathV1('machines.managed.get'), body));
}

/** Preset placement uses the same requester-owned Account read boundary. */
export async function readManagedMachinePreset(input: ManagedAccountRead & MachinePresetActionInputV1<'machines.presets.get'>): Promise<ManagedMachinePresetV1> {
  const result = ManagedMachinePresetGetResultV1Schema.parse(await readManagedAccountResource(input,
    machinePresetActionEndpointPathV1('machines.presets.get'), { homeId: input.homeId, id: input.id }));
  if (result.kind !== 'found') throw new ManagedMachineControllerError(result.code);
  return result.preset;
}

/** Structural consumers receive no private preset facts from the public read union. */
export async function readManagedMachine(input: ReadManagedMachineInput): Promise<ManagedMachineV1> {
  return unwrapManagedMachineReadV1(await readManagedMachineRead(input));
}

/** Private-fact consumers delegate the exact recipient projection to the captured Account-custody owner. */
export async function openManagedMachineRead(input: Readonly<{
  credentials: StoredCredentials; serverHttpBaseUrl: string; read: ManagedMachineReadV1; signal?: AbortSignal;
}>): Promise<ManagedMachineFullV1> {
  return await createManagedPresetHydrator({ credentials: input.credentials, serverUrl: input.serverHttpBaseUrl })
    .openRead(input.read, input.signal);
}

export async function readManagedMachineFull(input: ReadManagedMachineInput & Readonly<{
  credentials: StoredCredentials;
}>): Promise<ManagedMachineFullV1> {
  return await openManagedMachineRead({ credentials: input.credentials, serverHttpBaseUrl: input.serverHttpBaseUrl,
    read: await readManagedMachineRead(input), ...(input.signal ? { signal: input.signal } : {}) });
}

export type ReadManagedMachinesInput = Readonly<{
  credentials: StoredCredentials; serverHttpBaseUrl: string; homeId: string; enrolledMachineId?: string; signal?: AbortSignal;
}>;

/** Preserves each Home-selected projection for the one local consumer that needs private preset facts. */
export async function readManagedMachineReads(input: ReadManagedMachinesInput): Promise<readonly ManagedMachineReadV1[]> {
  const response = await axios.post<unknown>(`${input.serverHttpBaseUrl.replace(/\/+$/, '')}${managedMachineActionEndpointPathV1('machines.managed.list')}`,
    { homeId: input.homeId, ...(input.enrolledMachineId ? { enrolledMachineId: input.enrolledMachineId } : {}) }, { headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      Authorization: `Bearer ${input.credentials.token}` }, ...(input.signal ? { signal: input.signal } : {}) });
  return ManagedListOutputV1Schema.parse(response.data).machines;
}

/** Current controller-owned rows; this Account read confers no child Machine access. */
export async function readManagedMachines(input: ReadManagedMachinesInput): Promise<readonly ManagedMachineV1[]> {
  return (await readManagedMachineReads(input)).map(unwrapManagedMachineReadV1);
}
