import { ENCRYPTED_DATA_KEY_V1_BYTES } from '../crypto/encryptedDataKeyEnvelopeV1.js';
import { prepareResourceRecipientKeyEnvelopesV1, runResourceRecipientKeyPreparationV1 } from '../teams/resourceRecipientKeyPreparationV1.js';
import type { PrincipalRefV1 } from '../teams/principal.js';
import type { ResourceAccessLevelV1 } from '../teams/resourceGrantAccessV1.js';
import { TodoItemV1StoredSchema, type TodoItemV1, type TodoSessionLinkJsonPortV1 } from './todoSessionLinkV1.js';
import {
  TaskResourceV1Schema, TaskResourcesListResponseV1Schema, TaskAccessGrantsListResponseV1Schema,
  TaskAccessGrantMutationResponseV1Schema, TaskAccessRecipientCensusResponseV1Schema,
  TaskRecipientKeyEnvelopeCommitResponseV1Schema, TaskResourceErrorResponseV1Schema,
  type TaskResourceV1, type TaskResourceAddressV1, type TaskAccessGrantSetRequestV1, type TaskResourceContentV1, type TaskResourceSelectionV1,
} from './taskResourceV1.js';

export class TaskResourceClientErrorV1 extends Error {
  constructor(readonly code: string, readonly outcome: 'refused' | 'failed' | 'uncertain' = 'refused') { super(code); this.name = 'TaskResourceClientError'; }
}
/** HTTP and platform crypto are the only adapters; task semantics remain in the Todo owner. */
export type TaskResourceClientOptionsV1 = Readonly<{
  accountId: string;
  requireCurrent: () => void;
  signal?: AbortSignal;
  request: (request: Readonly<{ method: 'GET' | 'PUT' | 'POST' | 'DELETE'; path: string; body?: unknown }>) => Promise<Readonly<{ status: number; body: unknown }>>;
  /** Existing raw Account-KV owner handles legacy re-sealing without re-reading this admitted row. */
  openAccountRow?: (row: Readonly<{ key: string; value: string; version: number }>) => Promise<Readonly<{ value: unknown; version: number }>>;
  crypto: Readonly<{
    randomBytes: (length: number) => Uint8Array;
    openAccount: (ciphertext: string) => Promise<Readonly<{ value: unknown; needsReseal: boolean }>>;
    sealAccount: (value: unknown) => Promise<string>;
    openKey: (envelope: string) => Promise<Uint8Array | null>;
    open: (ciphertext: string, key: Uint8Array) => Promise<unknown>;
    seal: (value: unknown, key: Uint8Array) => Promise<string>;
  }>;
}>;
export type OpenedTaskResourceV1 = Readonly<{ resource: TaskResourceV1; todo: TodoItemV1; dataKey: Uint8Array | null }>;
function fail(code: string): never { throw new TaskResourceClientErrorV1(code); }
export async function openTaskResourceContentV1(resource: TaskResourceV1,
  options: Pick<TaskResourceClientOptionsV1, 'accountId' | 'crypto' | 'requireCurrent'>): Promise<OpenedTaskResourceV1> {
  let value: unknown;
  let dataKey: Uint8Array | null = null;
  if (resource.encryptionMode === 'plain') {
    if (resource.content.t !== 'plain' || resource.encryptedDataKey !== null) fail('task_encryption_mode_mismatch');
    value = resource.content.v;
  } else {
    if (resource.content.t !== 'encrypted') fail('task_encryption_mode_mismatch');
    if ('k' in resource.content) {
      if (!resource.encryptedDataKey) fail('recipient_key_pending');
      dataKey = await options.crypto.openKey(resource.encryptedDataKey);
      if (!dataKey || dataKey.length !== ENCRYPTED_DATA_KEY_V1_BYTES) fail('resource_encryption_material_unavailable');
      value = await options.crypto.open(resource.content.c, dataKey);
    } else {
      if (resource.ownerAccountId !== options.accountId || resource.encryptedDataKey !== null) fail('task_encryption_mode_mismatch');
      value = (await options.crypto.openAccount(resource.content.c)).value;
    }
  }
  options.requireCurrent();
  const parsed = TodoItemV1StoredSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== resource.taskId) fail('task_content_invalid');
  return { resource, todo: parsed.data, dataKey };
}
export async function sealTaskResourceContentV1(current: Pick<OpenedTaskResourceV1, 'resource' | 'dataKey'>, value: TodoItemV1,
  crypto: TaskResourceClientOptionsV1['crypto']): Promise<TaskResourceContentV1> {
  if (current.resource.encryptionMode === 'plain') return { t: 'plain', v: value };
  return current.dataKey ? { t: 'encrypted', k: 'task', c: await crypto.seal(value, current.dataKey) }
    : { t: 'encrypted', c: await crypto.sealAccount(value) };
}
function pathFor(address: TaskResourceAddressV1): string {
  return `/v1/tasks/${encodeURIComponent(address.ownerAccountId)}/${encodeURIComponent(address.taskId)}`;
}
function isUnknownRoute(status: number, body: unknown): boolean {
  return status === 404 && body !== null && typeof body === 'object' && 'statusCode' in body && body.statusCode === 404
    && 'error' in body && body.error === 'Not Found' && 'message' in body && typeof body.message === 'string'
    && body.message.startsWith('Route ') && body.message.endsWith(' not found');
}

export function createTaskResourceClientV1(options: TaskResourceClientOptionsV1) {
  const request = async (method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, body?: unknown) => {
    options.requireCurrent();
    const mutating = method === 'PUT' || method === 'DELETE' || path.endsWith('/recipients/commit');
    let response: Awaited<ReturnType<TaskResourceClientOptionsV1['request']>>;
    try { response = await options.request({ method, path, ...(body === undefined ? {} : { body }) }); }
    catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'task_storage_unavailable';
      throw new TaskResourceClientErrorV1(code, mutating ? 'uncertain' : 'failed');
    }
    options.requireCurrent();
    if (isUnknownRoute(response.status, response.body)) fail('task_resource_unsupported');
    if (response.status < 200 || response.status >= 300) {
      const refusal = TaskResourceErrorResponseV1Schema.safeParse(response.body);
      if (refusal.success) fail(refusal.data.error);
      throw new TaskResourceClientErrorV1('task_storage_unavailable', mutating ? 'uncertain' : 'failed');
    }
    return response.body;
  };
  const open = async (resource: TaskResourceV1): Promise<OpenedTaskResourceV1> => {
    if (resource.encryptionMode !== 'e2ee' || resource.content.t !== 'encrypted' || 'k' in resource.content)
      return openTaskResourceContentV1(resource, options);
    if (resource.ownerAccountId !== options.accountId || resource.encryptedDataKey !== null) fail('task_encryption_mode_mismatch');
    if (!options.openAccountRow) return openTaskResourceContentV1(resource, options);
    const opened = await options.openAccountRow({ key: `todo.${resource.taskId}`, value: resource.content.c, version: resource.version });
    const parsed = TodoItemV1StoredSchema.safeParse(opened.value);
    if (!parsed.success || parsed.data.id !== resource.taskId) fail('task_content_invalid');
    return { resource: { ...resource, version: opened.version }, todo: parsed.data, dataKey: null };
  };
  const read = async (address: TaskResourceAddressV1) => {
    const resource = TaskResourceV1Schema.parse(await request('GET', pathFor(address)));
    if (resource.ownerAccountId !== address.ownerAccountId || resource.taskId !== address.taskId) fail('task_content_invalid');
    return open(resource);
  };
  const list = async (filter?: Readonly<{ ownerAccountId?: string; selection?: TaskResourceSelectionV1 }>) => {
    const selection = filter?.selection;
    const result = TaskResourcesListResponseV1Schema.parse(await request('GET', selection === undefined ? '/v1/tasks'
      : `/v1/tasks?selection=${encodeURIComponent(JSON.stringify(selection))}`));
    // Older servers can ignore unknown query fields. Never open their inventory
    // or mistake it for a selected answer.
    if (selection !== undefined && result.selectionApplied !== true) throw new TaskResourceClientErrorV1('task_selection_unsupported', 'failed');
    const resources = result.tasks.filter(task => filter?.ownerAccountId === undefined || task.ownerAccountId === filter.ownerAccountId);
    const opened = await Promise.allSettled(resources.map(open));
    // Per-row failures must not swallow the invocation's Account/currentness refusal.
    options.requireCurrent();
    const tasks: OpenedTaskResourceV1[] = [];
    const unavailableTasks = (result.unavailableTasks ?? []).filter(task => filter?.ownerAccountId === undefined || task.ownerAccountId === filter.ownerAccountId);
    opened.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') tasks.push(outcome.value);
      else {
        const resource = resources[index]!;
        unavailableTasks.push({ ownerAccountId: resource.ownerAccountId, taskId: resource.taskId,
          error: 'task_content_unavailable', reason: 'task_content_invalid' });
      }
    });
    return { tasks, unavailableTasks };
  };
  const save = async (current: OpenedTaskResourceV1, todo: TodoItemV1) => {
    const { resource, dataKey } = current;
    const content = await sealTaskResourceContentV1(current, todo, options.crypto);
    const result = TaskResourceV1Schema.parse(await request('PUT', pathFor(resource), { expectedVersion: resource.version, content }));
    if (result.ownerAccountId !== resource.ownerAccountId || result.taskId !== resource.taskId) fail('task_content_invalid');
    return { resource: result, todo, dataKey };
  };
  const grants = async (address: TaskResourceAddressV1) => TaskAccessGrantsListResponseV1Schema.parse(await request('GET', `${pathFor(address)}/grants`));
  const census = async (address: TaskResourceAddressV1, principal?: PrincipalRefV1) => {
    const result = TaskAccessRecipientCensusResponseV1Schema.parse(await request('POST', `${pathFor(address)}/recipients/census`, principal ? { principal } : {}));
    if (result.ownerAccountId !== address.ownerAccountId || result.taskId !== address.taskId) fail('task_content_invalid');
    return result;
  };
  const prepareOpened = (current: OpenedTaskResourceV1) => runResourceRecipientKeyPreparationV1({
    dataKey: current.dataKey, openedDataEncryptionKey: current.resource.encryptedDataKey,
    randomBytes: options.crypto.randomBytes, readCensus: () => census(current.resource),
    validateIdentity: () => {}, signal: options.signal,
    dataKeyChangedError: () => new TaskResourceClientErrorV1('task_data_key_changed'),
    commit: async body => TaskRecipientKeyEnvelopeCommitResponseV1Schema.parse(await request('POST', `${pathFor(current.resource)}/recipients/commit`, body)),
  });
  const share = async (address: TaskResourceAddressV1, principal: PrincipalRefV1, accessLevel: ResourceAccessLevelV1) => {
    const current = await read(address);
    const body: TaskAccessGrantSetRequestV1 = { principal, accessLevel };
    if (current.resource.encryptionMode === 'e2ee' && !current.dataKey) {
      const prospective = await census(address, principal);
      const dataKey = options.crypto.randomBytes(ENCRYPTED_DATA_KEY_V1_BYTES);
      const prepared = prepareResourceRecipientKeyEnvelopesV1({ dataKey, recipients: prospective.recipients,
        randomBytes: options.crypto.randomBytes, replaceExisting: true });
      const ownerKeyEnvelope = prepared.find(item => item.recipientAccountId === address.ownerAccountId);
      if (!ownerKeyEnvelope) fail('resource_encryption_material_unavailable');
      body.promotion = { expectedVersion: current.resource.version,
        content: { t: 'encrypted', k: 'task', c: await options.crypto.seal(current.todo, dataKey) },
        ownerKeyEnvelope, recipientKeyEnvelopes: prepared.filter(item => item.recipientAccountId !== address.ownerAccountId) };
    }
    TaskAccessGrantMutationResponseV1Schema.parse(await request('PUT', `${pathFor(address)}/grants`, body));
    try {
      // Existing resource keys need envelopes for newly admitted direct/collective recipients.
      if (current.dataKey) await prepareOpened(current);
      return await read(address);
    } catch (error) {
      throw new TaskResourceClientErrorV1(error instanceof TaskResourceClientErrorV1 ? error.code : 'task_storage_unavailable', 'uncertain');
    }
  };
  const unshare = async (address: TaskResourceAddressV1, principal: PrincipalRefV1) => {
    TaskAccessGrantMutationResponseV1Schema.parse(await request('DELETE', `${pathFor(address)}/grants`, { principal }));
    try { return await grants(address); }
    catch (error) {
      if (error instanceof TaskResourceClientErrorV1 && error.code === 'task_not_found') return { ...address, access: null, grants: [] };
      throw new TaskResourceClientErrorV1(error instanceof TaskResourceClientErrorV1 ? error.code : 'task_storage_unavailable', 'uncertain');
    }
  };
  return { read, list, save, grants, census, share, unshare, prepare: async (address: TaskResourceAddressV1) => prepareOpened(await read(address)) };
}
export type TaskResourceClientV1 = ReturnType<typeof createTaskResourceClientV1>;

/** The existing link CAS loop owns semantic merge; this adapter only routes the admitted row. */
export function createTaskResourceSessionLinkPortV1(client: TaskResourceClientV1, address: TaskResourceAddressV1,
  personal?: Readonly<{ accountId: string; port: TodoSessionLinkJsonPortV1 }>): TodoSessionLinkJsonPortV1 {
  let current: OpenedTaskResourceV1 | null = null;
  let personalStorage = false;
  return {
    read: async () => {
      try {
        current = await client.read(address);
        personalStorage = personal?.accountId === address.ownerAccountId && !current.dataKey;
        return { value: current.todo, version: current.resource.version };
      }
      catch (error) {
        if (!(error instanceof TaskResourceClientErrorV1) || error.code !== 'task_resource_unsupported' || personal?.accountId !== address.ownerAccountId) throw error;
        personalStorage = true; return personal.port.read();
      }
    },
    compareAndSet: async (value, version) => {
      if (personalStorage && personal) return personal.port.compareAndSet(value, version);
      if (!current || current.resource.version !== version) fail('task_content_invalid');
      try {
        current = await client.save(current, TodoItemV1StoredSchema.parse(value));
        return { success: true, version: current.resource.version };
      } catch (error) {
        if (!(error instanceof TaskResourceClientErrorV1) || error.code !== 'task_version_conflict') throw error;
        current = await client.read(address);
        return { success: false, value: current.todo, version: current.resource.version };
      }
    },
  };
}
