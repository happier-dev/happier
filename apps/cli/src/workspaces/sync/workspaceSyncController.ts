import { validateWorkspaceSyncRelationship } from './workspaceSyncSettings';
import { tryAcquireWorkspaceRootOwnership, type WorkspaceRootOwnershipHandle } from './workspaceSyncRootOwnership';
import type { DeleteWorkspaceSyncConflictLoserV1, ManagedWorkspaceSync, WorkspaceSyncConflictListV1, WorkspaceSyncCopyOnceV1, WorkspaceSyncRelationshipV1, WorkspaceSyncStatusV1 } from './workspaceSyncTypes';

export type WorkspaceSyncResolvedRef = Readonly<{ machineId: string; rootPath: string }>;
export interface WorkspaceSyncMutagenAdapter {
  ensure?(definition: WorkspaceSyncRelationshipV1, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  copyOnce?(input: WorkspaceSyncCopyOnceV1, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  get?(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1 | null>;
  list?(signal?: AbortSignal): Promise<readonly WorkspaceSyncStatusV1[]>;
  flush?(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  pause?(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  resume?(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  terminate?(relationshipId: string, signal?: AbortSignal): Promise<void>;
  listConflicts?(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncConflictListV1>;
  deleteConflictLoser?(request: DeleteWorkspaceSyncConflictLoserV1, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
}
export type WorkspaceSyncControllerOptions = Readonly<{ adapter: WorkspaceSyncMutagenAdapter; localMachineId?: string; resolveWorkspaceRef?: (id: string) => WorkspaceSyncResolvedRef | null | Promise<WorkspaceSyncResolvedRef | null> }>;

function unavailable(name: string): never { throw Object.assign(new Error(`Workspace sync adapter does not implement ${name}`), { code: 'workspace_sync_unavailable' }); }
function abortIfRequested(signal?: AbortSignal): void { if (signal?.aborted) throw Object.assign(new Error('Workspace sync operation cancelled'), { name: 'AbortError', code: 'cancelled' }); }

export class WorkspaceSyncController implements ManagedWorkspaceSync {
  private readonly adapter: WorkspaceSyncMutagenAdapter;
  private readonly localMachineId?: string;
  private readonly resolveRef?: WorkspaceSyncControllerOptions['resolveWorkspaceRef'];
  private readonly definitions = new Map<string, WorkspaceSyncRelationshipV1>();
  private readonly statuses = new Map<string, WorkspaceSyncStatusV1>();
  private readonly fences = new Map<string, WorkspaceRootOwnershipHandle[]>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly listeners = new Map<string, Set<(status: WorkspaceSyncStatusV1) => void>>();

  constructor(options: WorkspaceSyncControllerOptions) { this.adapter = options.adapter; this.localMachineId = options.localMachineId; this.resolveRef = options.resolveWorkspaceRef; }

  private enqueue<T>(id: string, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
    abortIfRequested(signal);
    const prior = this.queues.get(id);
    const run = (): Promise<T> => { abortIfRequested(signal); return action(); };
    const next = prior ? prior.catch(() => {}).then(run) : run();
    this.queues.set(id, next);
    void next.then(() => { if (this.queues.get(id) === next) this.queues.delete(id); }, () => { if (this.queues.get(id) === next) this.queues.delete(id); });
    return next;
  }
  private publish(status: WorkspaceSyncStatusV1): WorkspaceSyncStatusV1 { this.statuses.set(status.relationshipId, status); for (const listener of this.listeners.get(status.relationshipId) ?? []) listener(status); return status; }
  private async acquireRoots(definition: WorkspaceSyncRelationshipV1): Promise<WorkspaceRootOwnershipHandle[]> {
    if (!this.resolveRef) return [];
    const handles: WorkspaceRootOwnershipHandle[] = [];
    try {
      for (const [id, role] of [[definition.alphaWorkspaceRefId, 'alpha'], [definition.betaWorkspaceRefId, 'beta']] as const) {
        const ref = await this.resolveRef(id);
        if (!ref || (this.localMachineId && ref.machineId !== this.localMachineId)) continue;
        const result = await tryAcquireWorkspaceRootOwnership({ ownerId: definition.relationshipId, canonicalRoot: ref.rootPath, operation: 'sync' });
        if ('kind' in result) throw Object.assign(new Error('Workspace root is already in use'), { code: 'workspace_root_in_use', existing: result.existing, role });
        handles.push(result);
      }
      return handles;
    } catch (error) { await Promise.all(handles.map((handle) => handle.release())); throw error; }
  }
  async get(id: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1 | null> { abortIfRequested(signal); return this.adapter.get ? await this.adapter.get(id, signal) : this.statuses.get(id) ?? null; }
  async list(signal?: AbortSignal): Promise<readonly WorkspaceSyncStatusV1[]> { abortIfRequested(signal); return this.adapter.list ? await this.adapter.list(signal) : [...this.statuses.values()]; }
  async ensure(definition: WorkspaceSyncRelationshipV1, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> {
    const valid = validateWorkspaceSyncRelationship(definition);
    return this.enqueue(valid.relationshipId, signal, async () => {
      const previous = this.definitions.get(valid.relationshipId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(valid)) throw Object.assign(new Error('Workspace sync relationship definition conflicts with active relationship'), { code: 'relationship_definition_conflict' });
      if (!previous) this.fences.set(valid.relationshipId, await this.acquireRoots(valid));
      try {
        const status = this.adapter.ensure ? await this.adapter.ensure(valid, signal) : unavailable('ensure');
        this.definitions.set(valid.relationshipId, valid);
        return this.publish(status);
      } catch (error) { if (!previous) { await Promise.all((this.fences.get(valid.relationshipId) ?? []).map((handle) => handle.release())); this.fences.delete(valid.relationshipId); } throw error; }
    });
  }
  async copyOnce(input: WorkspaceSyncCopyOnceV1, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> { return this.enqueue(input.operationId, signal, async () => this.adapter.copyOnce ? this.publish(await this.adapter.copyOnce(input, signal)) : unavailable('copyOnce')); }
  async flush(id: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> { return this.enqueue(id, signal, async () => this.publish(this.adapter.flush ? await this.adapter.flush(id, signal) : unavailable('flush'))); }
  async pause(id: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> { return this.enqueue(id, signal, async () => this.publish(this.adapter.pause ? await this.adapter.pause(id, signal) : unavailable('pause'))); }
  async resume(id: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> { return this.enqueue(id, signal, async () => this.publish(this.adapter.resume ? await this.adapter.resume(id, signal) : unavailable('resume'))); }
  async terminate(id: string, signal?: AbortSignal): Promise<void> { return this.enqueue(id, signal, async () => { if (this.adapter.terminate) await this.adapter.terminate(id, signal); await Promise.all((this.fences.get(id) ?? []).map((handle) => handle.release())); this.fences.delete(id); this.definitions.delete(id); this.statuses.delete(id); }); }
  async listConflicts(id: string, signal?: AbortSignal): Promise<WorkspaceSyncConflictListV1> { abortIfRequested(signal); return this.adapter.listConflicts ? await this.adapter.listConflicts(id, signal) : unavailable('listConflicts'); }
  async deleteConflictLoser(request: DeleteWorkspaceSyncConflictLoserV1, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> { return this.enqueue(request.relationshipId, signal, async () => this.publish(this.adapter.deleteConflictLoser ? await this.adapter.deleteConflictLoser(request, signal) : unavailable('deleteConflictLoser'))); }
  subscribe(id: string, signal: AbortSignal): AsyncIterable<WorkspaceSyncStatusV1> {
    const self = this;
    return { async *[Symbol.asyncIterator]() { const queue: WorkspaceSyncStatusV1[] = []; let wake: (() => void) | null = null; const listener = (status: WorkspaceSyncStatusV1) => { queue.push(status); wake?.(); }; const listeners = self.listeners.get(id) ?? new Set(); listeners.add(listener); self.listeners.set(id, listeners); try { while (!signal.aborted) { if (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; }); if (queue.length) yield queue.shift()!; } } finally { listeners.delete(listener); if (listeners.size === 0) self.listeners.delete(id); } } };
  }
}

export function createWorkspaceSyncController(options: WorkspaceSyncControllerOptions): ManagedWorkspaceSync { return new WorkspaceSyncController(options); }
