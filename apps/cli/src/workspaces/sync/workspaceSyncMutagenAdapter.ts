import type { WorkspaceSyncMutagenAdapter } from './workspaceSyncController';
import type { DeleteWorkspaceSyncConflictLoserV1, WorkspaceSyncConflictListV1, WorkspaceSyncCopyOnceV1, WorkspaceSyncRelationshipV1, WorkspaceSyncStatusV1 } from './workspaceSyncTypes';

export type WorkspaceSyncMutagenCommand = Readonly<{ t: string; [key: string]: unknown }>;
export type WorkspaceSyncMutagenCommandTransport = (command: WorkspaceSyncMutagenCommand, signal?: AbortSignal) => Promise<unknown>;
function status(value: unknown): WorkspaceSyncStatusV1 { if (!value || typeof value !== 'object' || typeof (value as { relationshipId?: unknown }).relationshipId !== 'string') throw new Error('Invalid workspace sync status returned by Mutagen adapter'); return value as WorkspaceSyncStatusV1; }

export class WorkspaceSyncMutagenAdapterClient implements WorkspaceSyncMutagenAdapter {
  constructor(private readonly send: WorkspaceSyncMutagenCommandTransport) {}
  async ensure(relationship: WorkspaceSyncRelationshipV1, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> { return status(await this.send({ t: 'create', relationship, sessionName: relationship.relationshipId }, signal)); }
  async copyOnce(operation: WorkspaceSyncCopyOnceV1, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> { return status(await this.send({ t: 'copy_once', operation, sessionName: operation.operationId }, signal)); }
  async get(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1 | null> { const value = await this.send({ t: 'get', relationshipId }, signal); return value === null ? null : status(value); }
  async list(signal?: AbortSignal): Promise<readonly WorkspaceSyncStatusV1[]> { const value = await this.send({ t: 'list' }, signal); if (!Array.isArray(value)) throw new Error('Invalid workspace sync list returned by Mutagen adapter'); return value.map(status); }
  async flush(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> { return status(await this.send({ t: 'flush', relationshipId }, signal)); }
  async pause(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> { return status(await this.send({ t: 'pause', relationshipId }, signal)); }
  async resume(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> { return status(await this.send({ t: 'resume', relationshipId }, signal)); }
  async terminate(relationshipId: string, signal?: AbortSignal): Promise<void> { await this.send({ t: 'terminate', relationshipId }, signal); }
  async listConflicts(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncConflictListV1> { return await this.send({ t: 'list_conflicts', relationshipId, limit: 100 }, signal) as WorkspaceSyncConflictListV1; }
  async deleteConflictLoser(request: DeleteWorkspaceSyncConflictLoserV1, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> { return status(await this.send({ t: 'delete_conflict_loser', ...request }, signal)); }
}
export function createWorkspaceSyncMutagenAdapter(send: WorkspaceSyncMutagenCommandTransport): WorkspaceSyncMutagenAdapter { return new WorkspaceSyncMutagenAdapterClient(send); }
