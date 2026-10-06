import { randomUUID } from 'node:crypto';
import { WorkspaceSyncConflictPageRequestV1Schema, WorkspaceSyncConflictV1Schema, WorkspaceSyncCopyOnceV1Schema, WorkspaceSyncPathSelectionV1Schema, WorkspaceSyncSelectionDiagnoseV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { WorkspaceSyncPathSelectionV1, WorkspaceSyncSelectionDiagnoseV1 } from '@happier-dev/protocol';

import type { WorkspaceSyncMutagenAdapter, WorkspaceSyncResolvedRef } from './workspaceSyncController';
import {
  deriveWorkspaceSyncEndpointId,
  type MutagenControlCommandV1,
  type MutagenSessionDefinition,
} from './transport/workspaceSyncBrokerProtocol';
import type {
  WorkspaceSyncConflictPageRequestV1,
  WorkspaceSyncConflictPageV1,
  WorkspaceSyncConflictV1,
  WorkspaceSyncCopyOnceV1,
  WorkspaceSyncRelationshipV1,
  WorkspaceSyncStatusV1,
} from './workspaceSyncTypes';
import { computeWorkspaceSyncPolicyDigest } from './workspaceSyncTypes';

export type WorkspaceSyncMutagenCommandTransport = (command: MutagenControlCommandV1, signal?: AbortSignal) => Promise<unknown>;
export type WorkspaceSyncMutagenAdapterOptions = Readonly<{
  send: WorkspaceSyncMutagenCommandTransport;
  resolveWorkspaceRef(id: string): WorkspaceSyncResolvedRef | null | Promise<WorkspaceSyncResolvedRef | null>;
  createRequestId?: () => string;
  nowMs?: () => number;
}>;

type GenericEndpointState = Readonly<{
  connected: boolean;
  scanned: boolean;
  scanProblemCount: number;
  transitionProblemCount: number;
}>;
type GenericEndpoint = Readonly<{ protocol: 'external'; endpointId: string; state: GenericEndpointState | null }>;
type GenericConflict = Readonly<{ root: string; alphaChanges: readonly unknown[]; betaChanges: readonly unknown[] }>;
type GenericSession = Readonly<{
  identifier: string;
  name: string;
  labels: Readonly<Record<string, string>>;
  alpha: GenericEndpoint;
  beta: GenericEndpoint;
  mode: 'one-way-safe' | 'one-way-replica' | 'two-way-safe';
  paused: boolean;
  status: string;
  successfulCycles: number;
  conflictCount: number;
  lastError?: string;
  lastErrorCode?: 'git_selection_unavailable';
}>;
type GenericSessionCandidate = Readonly<{ raw: unknown; generic: GenericSession }>;

const statuses = new Set([
  'disconnected', 'halted-on-root-emptied', 'halted-on-root-deletion', 'halted-on-root-type-change',
  'connecting-alpha', 'connecting-beta', 'watching', 'scanning', 'waiting-for-rescan', 'reconciling',
  'staging-alpha', 'staging-beta', 'transitioning', 'saving',
]);
const expectedLabels = (definition: WorkspaceSyncRelationshipV1 | WorkspaceSyncCopyOnceV1) => {
  const id = 'relationshipId' in definition ? definition.relationshipId : definition.operationId;
  return {
    'external.owner': 'happier-workspace-sync',
    'external.relationship_id': id,
    'external.endpoint_role': 'alpha|beta',
    'external.schema': 'workspace-sync-v1',
    'external.policy_digest': definition.contentPolicy.policyDigest,
    'external.alpha_workspace_ref_id': definition.alphaWorkspaceRefId,
    'external.beta_workspace_ref_id': definition.betaWorkspaceRefId,
    'external.controller_machine_id': definition.controllerMachineId,
    'external.operation_kind': 'relationshipId' in definition ? 'relationship' : 'copy_once',
    'external.policy_selection': definition.contentPolicy.selection,
  };
};
const modeByProduct = {
  keep_synced: 'one-way-safe',
  mirror_exactly: 'one-way-replica',
  keep_both_in_sync: 'two-way-safe',
} as const;

function sessionDefinition(
  definition: WorkspaceSyncRelationshipV1 | WorkspaceSyncCopyOnceV1,
): MutagenSessionDefinition {
  const operationId = 'relationshipId' in definition ? definition.relationshipId : definition.operationId;
  const { selection, extraIgnorePatterns, extraIncludePatterns } = definition.contentPolicy;
  return {
    alpha: `external://${deriveWorkspaceSyncEndpointId(operationId, 'alpha')}`,
    beta: `external://${deriveWorkspaceSyncEndpointId(operationId, 'beta')}`,
    mode: 'mode' in definition ? modeByProduct[definition.mode] : 'one-way-safe',
    contentPolicy: { selection, extraIgnorePatterns, extraIncludePatterns },
    name: operationId,
    labels: expectedLabels(definition),
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid generic Mutagen ${name}`);
  return value as Record<string, unknown>;
}
function strictFields(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Invalid generic Mutagen ${name} field: ${key}`);
  }
}
function boundedString(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > max) throw new Error(`Invalid generic Mutagen ${name}`);
  return value;
}
function boundedExactPath(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > max) {
    throw new Error(`Invalid generic Mutagen ${name}`);
  }
  return value;
}
function boundedCount(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new Error(`Invalid generic Mutagen ${name}`);
  return value;
}
function endpointState(value: unknown, name: string): GenericEndpointState | null {
  if (value === null) return null;
  const input = record(value, name);
  strictFields(input, ['connected', 'scanned', 'scanProblemCount', 'transitionProblemCount'], name);
  if (typeof input.connected !== 'boolean' || typeof input.scanned !== 'boolean') throw new Error(`Invalid generic Mutagen ${name}`);
  return {
    connected: input.connected,
    scanned: input.scanned,
    scanProblemCount: boundedCount(input.scanProblemCount, `${name}.scanProblemCount`),
    transitionProblemCount: boundedCount(input.transitionProblemCount, `${name}.transitionProblemCount`),
  };
}
function endpoint(value: unknown, name: string): GenericEndpoint {
  const input = record(value, name);
  strictFields(input, ['protocol', 'host', 'path', 'state'], name);
  if (input.protocol !== 'external' || input.path !== '') {
    throw new Error(`Invalid generic Mutagen ${name}`);
  }
  return {
    protocol: 'external', endpointId: boundedString(input.host, `${name}.host`, 256),
    state: endpointState(input.state, `${name}.state`),
  };
}
function conflict(value: unknown): GenericConflict {
  const input = record(value, 'conflict');
  if (!Array.isArray(input.alphaChanges) || !Array.isArray(input.betaChanges)
    || input.alphaChanges.length > 1_000 || input.betaChanges.length > 1_000) throw new Error('Invalid generic Mutagen conflict changes');
  return { root: boundedExactPath(input.root, 'conflict.root'), alphaChanges: input.alphaChanges, betaChanges: input.betaChanges };
}
function session(value: unknown): GenericSession {
  const input = record(value, 'session');
  strictFields(input, [
    'identifier', 'name', 'labels', 'alpha', 'beta', 'mode', 'paused', 'status',
    'successfulCycles', 'conflictCount', 'lastError', 'lastErrorCode',
  ], 'session');
  const labelsInput = record(input.labels, 'session.labels');
  if (Object.keys(labelsInput).length > 16) throw new Error('Invalid generic Mutagen session labels');
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(labelsInput)) labels[boundedString(key, 'label key', 256)] = boundedString(label, 'label value', 256);
  if (input.mode !== 'one-way-safe' && input.mode !== 'one-way-replica' && input.mode !== 'two-way-safe') throw new Error('Invalid generic Mutagen mode');
  const status = boundedString(input.status, 'status', 64);
  if (!statuses.has(status) || typeof input.paused !== 'boolean') throw new Error('Invalid generic Mutagen status');
  return {
    identifier: boundedString(input.identifier, 'identifier', 256), name: boundedString(input.name, 'name', 256), labels,
    alpha: endpoint(input.alpha, 'alpha'), beta: endpoint(input.beta, 'beta'), mode: input.mode, paused: input.paused, status,
    successfulCycles: boundedCount(input.successfulCycles, 'successfulCycles'),
    conflictCount: boundedCount(input.conflictCount, 'conflictCount'),
    ...(input.lastError === undefined ? {} : { lastError: boundedString(input.lastError, 'lastError') }),
    ...(input.lastErrorCode === undefined
      ? {}
      : input.lastErrorCode === 'git_selection_unavailable'
        ? { lastErrorCode: input.lastErrorCode }
        : (() => { throw new Error('Invalid generic Mutagen lastErrorCode'); })()),
  };
}

function recoverCopyOnceDefinition(
  generic: GenericSession,
  policy: Readonly<{ selection: 'git_worktree' | 'all_files'; patterns: readonly string[] }>,
): WorkspaceSyncCopyOnceV1 | null {
  const labels = generic.labels;
  if (labels['external.owner'] !== 'happier-workspace-sync'
    || labels['external.operation_kind'] !== 'copy_once') return null;
  const operationId = labels['external.relationship_id'];
  const selection = labels['external.policy_selection'];
  if (!operationId || generic.name !== operationId
    || labels['external.endpoint_role'] !== 'alpha|beta'
    || labels['external.schema'] !== 'workspace-sync-v1'
    || generic.mode !== 'one-way-safe'
    || (selection !== 'git_worktree' && selection !== 'all_files')
    || selection !== policy.selection
    || generic.alpha.endpointId !== deriveWorkspaceSyncEndpointId(operationId, 'alpha')
    || generic.beta.endpointId !== deriveWorkspaceSyncEndpointId(operationId, 'beta')) return null;
  const policySelection: 'git_worktree' | 'all_files' = selection;
  const policyDigest = labels['external.policy_digest'];
  const controllerMachineId = labels['external.controller_machine_id'];
  const alphaWorkspaceRefId = labels['external.alpha_workspace_ref_id'];
  const betaWorkspaceRefId = labels['external.beta_workspace_ref_id'];
  if (!policyDigest || !controllerMachineId || !alphaWorkspaceRefId || !betaWorkspaceRefId
    || alphaWorkspaceRefId === betaWorkspaceRefId) return null;
  if (policy.patterns.at(-1) !== '.git') return null;
  const body = policy.patterns.slice(0, -1);
  const candidates: WorkspaceSyncCopyOnceV1[] = [];
  for (let split = 0; split <= body.length; split += 1) {
    let extraIgnorePatterns: readonly string[];
    let extraIncludePatterns: readonly string[];
    const includePaths = body.slice(split);
    if (includePaths.some((path) => !path.startsWith('!'))) continue;
    extraIgnorePatterns = body.slice(0, split);
    extraIncludePatterns = includePaths.map((path) => path.slice(1));
    const policyInput = {
      v: 1 as const,
      selection: policySelection,
      extraIgnorePatterns,
      extraIncludePatterns,
    };
    if (computeWorkspaceSyncPolicyDigest(policyInput) !== policyDigest) continue;
    const candidate = WorkspaceSyncCopyOnceV1Schema.safeParse({
      v: 1,
      operationId,
      controllerMachineId,
      alphaWorkspaceRefId,
      betaWorkspaceRefId,
      contentPolicy: { ...policyInput, policyDigest },
    });
    if (candidate.success) candidates.push(candidate.data);
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

function definitionConflict(message: string): Error {
  return Object.assign(new Error(message), { code: 'relationship_definition_conflict' });
}

function runtimeMismatch(error: Error): Error {
  return Object.assign(new Error(error.message, { cause: error }), { code: 'relationship_runtime_mismatch' });
}

function isIndeterminate(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'indeterminate';
}

function entryFromChanges(changes: readonly unknown[]): WorkspaceSyncConflictV1['alpha'] {
  const last = changes.at(-1);
  if (!last) return { kind: 'missing' };
  const change = record(last, 'conflict change');
  const rawEntry = Object.prototype.hasOwnProperty.call(change, 'new') ? change.new : change.old;
  if (rawEntry === null || rawEntry === undefined) return { kind: 'missing' };
  const input = record(rawEntry, 'conflict entry');
  if (input.kind === 'untracked' || input.kind === 'problematic' || input.kind === 'unknown') {
    return { kind: 'unsupported', sourceKind: input.kind };
  }
  if (input.kind !== 'file' && input.kind !== 'directory' && input.kind !== 'symlink') throw new Error('Invalid generic Mutagen conflict entry kind');
  const digest = input.kind === 'file' && input.digest !== undefined ? boundedString(input.digest, 'conflict digest', 256) : undefined;
  return { kind: input.kind, ...(digest ? { digest } : {}) };
}

export class WorkspaceSyncMutagenAdapterClient implements WorkspaceSyncMutagenAdapter {
  private readonly definitions = new Map<string, WorkspaceSyncRelationshipV1 | WorkspaceSyncCopyOnceV1>();
  /** Runtime-only Mutagen identity, discovered from create/list responses and never persisted. */
  private readonly sessionIdentifiers = new Map<string, string>();
  private readonly successfulCycles = new Map<string, number>();
  private readonly lastCycleObservedAtMs = new Map<string, number>();
  private readonly createRequestId: () => string;
  private readonly nowMs: () => number;

  constructor(private readonly options: WorkspaceSyncMutagenAdapterOptions) {
    this.createRequestId = options.createRequestId ?? randomUUID;
    this.nowMs = options.nowMs ?? Date.now;
  }
  private replaceDefinitions(definitions: readonly WorkspaceSyncRelationshipV1[]): void {
    for (const [id, definition] of this.definitions) {
      if ('relationshipId' in definition) {
        this.definitions.delete(id);
        this.sessionIdentifiers.delete(id);
      }
    }
    for (const definition of definitions) this.definitions.set(definition.relationshipId, definition);
  }
  private requestId(): string { const id = this.createRequestId().trim(); if (!id) throw new Error('Workspace sync request ID is empty'); return id; }
  private async listAllSessions(signal?: AbortSignal): Promise<readonly GenericSessionCandidate[]> {
    const candidates: GenericSessionCandidate[] = [];
    let cursor: string | undefined;
    let previousIdentifier: string | undefined;
    const seenCursors = new Set<string>();
    while (true) {
      const value = record(await this.options.send({
        t: 'list',
        requestId: this.requestId(),
        ...(cursor === undefined ? {} : { cursor }),
        limit: 100,
      }, signal), 'session list page');
      strictFields(value, ['sessions', 'nextCursor'], 'session list page');
      if (!Array.isArray(value.sessions) || value.sessions.length > 100) {
        throw new Error('Invalid generic Mutagen session list page');
      }
      const page = value.sessions.map((raw) => ({ raw, generic: session(raw) }));
      for (const candidate of page) {
        if (previousIdentifier !== undefined && candidate.generic.identifier <= previousIdentifier) {
          throw new Error('Invalid generic Mutagen session list order');
        }
        previousIdentifier = candidate.generic.identifier;
      }
      candidates.push(...page);
      if (value.nextCursor === null) return candidates;
      const nextCursor = boundedString(value.nextCursor, 'session list nextCursor', 256);
      if (page.length === 0 || seenCursors.has(nextCursor)) {
        throw new Error('Invalid generic Mutagen session list continuation');
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }
  private async findClaimedSession(identity: string, signal?: AbortSignal): Promise<GenericSessionCandidate | undefined> {
    const candidates = (await this.listAllSessions(signal))
      .filter(({ generic }) => generic.name === identity
        || generic.labels['external.relationship_id'] === identity);
    if (candidates.length > 1) {
      throw definitionConflict('Multiple Mutagen sessions claim one workspace sync identity');
    }
    return candidates[0];
  }
  private async listAllPolicyPatterns(
    sessionIdentifier: string,
    signal?: AbortSignal,
  ): Promise<Readonly<{ selection: 'git_worktree' | 'all_files'; patterns: readonly string[] }>> {
    const patterns: string[] = [];
    let cursor: string | undefined;
    let selection: 'git_worktree' | 'all_files' | undefined;
    const seenCursors = new Set<string>();
    while (true) {
      const value = record(await this.options.send({
        t: 'get_policy', requestId: this.requestId(), sessionIdentifier,
        ...(cursor === undefined ? {} : { cursor }), limit: 100,
      }, signal), 'policy page');
      strictFields(value, ['selection', 'patterns', 'nextCursor'], 'policy page');
      if (value.selection !== 'git_worktree' && value.selection !== 'all_files') throw new Error('Invalid generic Mutagen policy selection');
      if (selection !== undefined && value.selection !== selection) throw new Error('Invalid generic Mutagen policy selection continuation');
      selection = value.selection;
      if (!Array.isArray(value.patterns) || value.patterns.length > 100) throw new Error('Invalid generic Mutagen policy page');
      patterns.push(...value.patterns.map((pattern) => boundedString(pattern, 'policy pattern')));
      if (value.nextCursor === null) return { selection, patterns };
      const nextCursor = boundedString(value.nextCursor, 'policy nextCursor', 256);
      if (value.patterns.length === 0 || seenCursors.has(nextCursor)) throw new Error('Invalid generic Mutagen policy cursor');
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  }
  private acceptSession(
    value: unknown,
    definition: WorkspaceSyncRelationshipV1 | WorkspaceSyncCopyOnceV1,
  ): GenericSession {
    const generic = session(value);
    const operationId = 'relationshipId' in definition ? definition.relationshipId : definition.operationId;
    const labels = expectedLabels(definition);
    if (generic.name !== operationId || Object.keys(generic.labels).length !== Object.keys(labels).length
      || Object.entries(labels).some(([key, label]) => generic.labels[key] !== label)
      || generic.alpha.endpointId !== deriveWorkspaceSyncEndpointId(operationId, 'alpha')
      || generic.beta.endpointId !== deriveWorkspaceSyncEndpointId(operationId, 'beta')) throw definitionConflict('Mutagen session identity does not match workspace sync settings');
    const expectedMode = 'mode' in definition ? modeByProduct[definition.mode] : 'one-way-safe';
    if (generic.mode !== expectedMode) throw definitionConflict('Mutagen session mode does not match workspace sync settings');
    const previousIdentifier = this.sessionIdentifiers.get(operationId);
    if (previousIdentifier !== undefined && previousIdentifier !== generic.identifier) {
      throw definitionConflict('Mutagen session identifier changed for an active workspace sync operation');
    }
    this.sessionIdentifiers.set(operationId, generic.identifier);
    return generic;
  }
  private async project(value: unknown, definition: WorkspaceSyncRelationshipV1 | WorkspaceSyncCopyOnceV1, successObservation: 'none' | 'first_cycle' | 'operation'): Promise<WorkspaceSyncStatusV1> {
    const generic = this.acceptSession(value, definition);
    const operationId = 'relationshipId' in definition ? definition.relationshipId : definition.operationId;
    const [alpha, beta] = await Promise.all([
      this.options.resolveWorkspaceRef(definition.alphaWorkspaceRefId), this.options.resolveWorkspaceRef(definition.betaWorkspaceRefId),
    ]);
    if (!alpha || !beta) throw Object.assign(new Error('Workspace sync endpoint is unavailable'), { code: 'peer_unavailable' });
    const previousCycles = this.successfulCycles.get(operationId);
    if (successObservation === 'operation'
      || (successObservation === 'first_cycle' && generic.successfulCycles > 0)
      || (previousCycles !== undefined && generic.successfulCycles > previousCycles)) this.lastCycleObservedAtMs.set(operationId, this.nowMs());
    this.successfulCycles.set(operationId, generic.successfulCycles);
    const conflictCount = generic.conflictCount;
    const endpointStates = { alpha: generic.alpha.state, beta: generic.beta.state };
    const hasEndpointProblems = [endpointStates.alpha, endpointStates.beta].some((state) => (
      state !== null && (state.scanProblemCount > 0 || state.transitionProblemCount > 0)
    ));
    const endpointUnavailable = endpointStates.alpha === null || endpointStates.beta === null
      || !endpointStates.alpha.connected || !endpointStates.beta.connected;
    const halted = generic.status.startsWith('halted-');
    const active = ['scanning', 'reconciling', 'staging-alpha', 'staging-beta', 'transitioning', 'saving'].includes(generic.status);
    const state: WorkspaceSyncStatusV1['state'] = generic.paused ? 'paused'
      : conflictCount > 0 ? 'conflicted'
        : halted || generic.lastError || hasEndpointProblems ? 'error'
          : generic.status === 'disconnected' || endpointUnavailable ? 'disconnected'
            : generic.status === 'watching' ? 'watching'
              : active && successObservation === 'operation' ? 'flushing' : 'starting';
    return {
      relationshipId: operationId, controllerMachineId: definition.controllerMachineId, state,
      alphaPath: alpha.rootPath, betaPath: beta.rootPath, mode: 'mode' in definition ? definition.mode : 'copy_once',
      endpointStates, conflictCount, lastCycleObservedAtMs: this.lastCycleObservedAtMs.get(operationId) ?? null,
      ...(generic.lastErrorCode === 'git_selection_unavailable'
        ? { errorCode: 'git_selection_unavailable' as const }
        : generic.lastError ? { errorCode: 'engine_error' as const }
          : hasEndpointProblems ? { errorCode: 'engine_problems' as const } : {}),
    };
  }
  private async reconcileRelationshipState(
    value: unknown,
    relationship: WorkspaceSyncRelationshipV1,
    signal?: AbortSignal,
  ): Promise<WorkspaceSyncStatusV1> {
    const generic = this.acceptSession(value, relationship);
    if (generic.paused === !relationship.enabled) {
      return await this.project(value, relationship, 'none');
    }
    return await this.project(await this.options.send({
      t: relationship.enabled ? 'resume' : 'pause',
      requestId: this.requestId(),
      sessionIdentifier: generic.identifier,
    }, signal), relationship, relationship.enabled ? 'first_cycle' : 'none');
  }
  private async projectMissingPausedRelationship(
    relationship: WorkspaceSyncRelationshipV1,
  ): Promise<WorkspaceSyncStatusV1> {
    const [alpha, beta] = await Promise.all([
      this.options.resolveWorkspaceRef(relationship.alphaWorkspaceRefId),
      this.options.resolveWorkspaceRef(relationship.betaWorkspaceRefId),
    ]);
    return {
      relationshipId: relationship.relationshipId,
      controllerMachineId: relationship.controllerMachineId,
      state: 'paused',
      alphaPath: alpha?.rootPath ?? relationship.alphaWorkspaceRefId,
      betaPath: beta?.rootPath ?? relationship.betaWorkspaceRefId,
      mode: relationship.mode,
      endpointStates: { alpha: null, beta: null },
      conflictCount: 0,
      lastCycleObservedAtMs: null,
    };
  }
  async discoverCopyOnceRecoveries(signal?: AbortSignal): Promise<readonly WorkspaceSyncCopyOnceV1[]> {
    const value = await this.listAllSessions(signal);
    const validById = new Map<string, Readonly<{ definition: WorkspaceSyncCopyOnceV1; sessionIdentifier: string }>>();
    const duplicates = new Set<string>();
    for (const item of value) {
      const generic = item.generic;
      if (generic.labels['external.operation_kind'] !== 'copy_once'
        || generic.labels['external.owner'] !== 'happier-workspace-sync') continue;
      const definition = recoverCopyOnceDefinition(generic, await this.listAllPolicyPatterns(generic.identifier, signal));
      if (!definition || Object.keys(generic.labels).length !== Object.keys(expectedLabels(definition)).length
        || Object.entries(expectedLabels(definition)).some(([key, label]) => generic.labels[key] !== label)) {
        await this.terminateRuntimeSession(generic.name, generic.identifier, signal);
        continue;
      }
      const previous = validById.get(definition.operationId);
      if (previous || duplicates.has(definition.operationId)) {
        await this.terminateRuntimeSession(definition.operationId, generic.identifier, signal);
        if (previous) {
          await this.terminateRuntimeSession(definition.operationId, previous.sessionIdentifier, signal);
          validById.delete(definition.operationId);
        }
        duplicates.add(definition.operationId);
        continue;
      }
      validById.set(definition.operationId, { definition, sessionIdentifier: generic.identifier });
    }
    for (const { definition, sessionIdentifier } of validById.values()) {
      this.definitions.set(definition.operationId, definition);
      this.sessionIdentifiers.set(definition.operationId, sessionIdentifier);
    }
    return [...validById.values()].map(({ definition }) => definition);
  }
  async ensure(relationship: WorkspaceSyncRelationshipV1, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> {
    this.definitions.set(relationship.relationshipId, relationship);
    try {
      const existing = await this.findClaimedSession(relationship.relationshipId, signal);
      if (existing) {
        if (!relationship.enabled) {
          await this.terminateRuntimeSession(relationship.relationshipId, existing.generic.identifier, signal);
          return await this.projectMissingPausedRelationship(relationship);
        }
        try {
          return await this.reconcileRelationshipState(existing.raw, relationship, signal);
        } catch (error) {
          if (!(error instanceof Error)
            || (error as Error & { code?: string }).code !== 'relationship_definition_conflict') {
            throw error;
          }
          await this.terminateRuntimeSession(relationship.relationshipId, existing.generic.identifier, signal);
          throw runtimeMismatch(error);
        }
      }
      if (!relationship.enabled) return await this.projectMissingPausedRelationship(relationship);
      return await this.reconcileRelationshipState(await this.options.send({
        t: 'create',
        requestId: this.requestId(),
        session: sessionDefinition(relationship),
      }, signal), relationship, signal);
    } catch (error) {
      this.definitions.delete(relationship.relationshipId);
      throw error;
    }
  }
  async rehydrate(
    definitions: readonly WorkspaceSyncRelationshipV1[],
    signal?: AbortSignal,
    holdPausedRelationshipIds: ReadonlySet<string> = new Set(),
  ): Promise<readonly WorkspaceSyncStatusV1[]> {
    this.replaceDefinitions(definitions);
    const value = await this.listAllSessions(signal);
    const results: WorkspaceSyncStatusV1[] = [];
    for (const item of value) {
      const generic = item.generic;
      const id = generic.labels['external.relationship_id'];
      const persistedClaimId = id && this.definitions.has(id)
        ? id
        : this.definitions.has(generic.name) ? generic.name : undefined;
      if (!id || generic.name !== id
        || generic.labels['external.owner'] !== 'happier-workspace-sync'
        || generic.labels['external.endpoint_role'] !== 'alpha|beta'
        || generic.labels['external.schema'] !== 'workspace-sync-v1'
        || generic.alpha.endpointId !== deriveWorkspaceSyncEndpointId(id, 'alpha')
        || generic.beta.endpointId !== deriveWorkspaceSyncEndpointId(id, 'beta')) {
        if (persistedClaimId) {
          await this.terminateRuntimeSession(persistedClaimId, generic.identifier, signal);
          continue;
        }
        throw definitionConflict('Mutagen session identity is not owned by workspace sync');
      }
      const definition = this.definitions.get(id);
      if (!definition || !('relationshipId' in definition)) {
        await this.terminateRuntimeSession(id, generic.identifier, signal);
        continue;
      }
      if (!definition.enabled) {
        await this.terminateRuntimeSession(id, generic.identifier, signal);
        continue;
      }
      if (holdPausedRelationshipIds.has(id)) {
        if (!generic.paused) {
          throw Object.assign(new Error('Recovery-held workspace sync session was not durably paused'), {
            code: 'workspace_sync_recovery_needed',
          });
        }
        results.push(await this.project(item.raw, definition, 'none'));
        continue;
      }
      try {
        results.push(await this.reconcileRelationshipState(item.raw, definition, signal));
      } catch (error) {
        if (!(error instanceof Error) || (error as Error & { code?: string }).code !== 'relationship_definition_conflict') {
          throw error;
        }
        await this.terminateRuntimeSession(id, generic.identifier, signal);
      }
    }
    return results;
  }
  async copyOnce(operation: WorkspaceSyncCopyOnceV1, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> {
    this.definitions.set(operation.operationId, operation);
    let operationError: unknown;
    let cleanupRequired = false;
    let retainForRecovery = false;
    try {
      const existing = await this.findClaimedSession(operation.operationId, signal);
      if (existing) {
        await this.project(existing.raw, operation, 'none');
        cleanupRequired = true;
        if (existing.generic.successfulCycles > 0) {
          return await this.project(existing.raw, operation, 'operation');
        }
        if (!existing.generic.paused) {
          return await this.project(await this.options.send({
            t: 'flush', requestId: this.requestId(), sessionIdentifier: existing.generic.identifier,
          }, signal), operation, 'operation');
        }
      } else {
        cleanupRequired = true;
        await this.project(await this.options.send({
          t: 'create', requestId: this.requestId(), session: sessionDefinition(operation),
        }, signal), operation, 'none');
      }
      const sessionIdentifier = this.requireSessionIdentifier(operation.operationId);
      await this.project(await this.options.send({
        t: 'resume', requestId: this.requestId(), sessionIdentifier,
      }, signal), operation, 'none');
      return await this.project(await this.options.send({
        t: 'flush', requestId: this.requestId(), sessionIdentifier,
      }, signal), operation, 'operation');
    } catch (error) {
      operationError = error;
      retainForRecovery = isIndeterminate(error);
      throw error;
    } finally {
      if (!retainForRecovery) {
        let cleanupFailure: unknown;
        try {
          if (cleanupRequired) {
            let sessionIdentifier = this.sessionIdentifiers.get(operation.operationId);
            if (!sessionIdentifier) {
              const discovered = await this.findClaimedSession(operation.operationId);
              if (discovered) {
                this.acceptSession(discovered.raw, operation);
                sessionIdentifier = discovered.generic.identifier;
              }
            }
            if (sessionIdentifier) {
              await this.options.send({ t: 'terminate', requestId: this.requestId(), sessionIdentifier });
            }
          }
        } catch (cleanupError) {
          cleanupFailure = cleanupError;
        }
        if (cleanupFailure !== undefined) {
          throw Object.assign(new Error(
            operationError === undefined
              ? 'Workspace copy completed but terminal cleanup is pending'
              : 'Workspace copy failed and terminal cleanup is pending',
            operationError === undefined ? { cause: cleanupFailure } : { cause: operationError },
          ), {
            code: 'indeterminate',
            cleanupError: cleanupFailure,
          });
        }
        this.definitions.delete(operation.operationId);
        this.sessionIdentifiers.delete(operation.operationId);
        this.successfulCycles.delete(operation.operationId);
        this.lastCycleObservedAtMs.delete(operation.operationId);
      }
    }
  }
  async get(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1 | null> {
    const definition = this.definitions.get(relationshipId);
    if (!definition) return null;
    let sessionIdentifier = this.sessionIdentifiers.get(relationshipId);
    if (!sessionIdentifier) {
      const discovered = await this.findClaimedSession(relationshipId, signal);
      if (!discovered) return null;
      this.acceptSession(discovered.raw, definition);
      sessionIdentifier = discovered.generic.identifier;
    }
    const value = await this.options.send({ t: 'get', requestId: this.requestId(), sessionIdentifier }, signal);
    return value === null ? null : await this.project(value, definition, 'none');
  }
  async list(signal?: AbortSignal): Promise<readonly WorkspaceSyncStatusV1[]> {
    const value = await this.listAllSessions(signal);
    const results: WorkspaceSyncStatusV1[] = [];
    for (const item of value) {
      const generic = item.generic;
      const id = generic.labels['external.relationship_id'];
      const definition = id ? this.definitions.get(id) : undefined;
      if (!definition || !('relationshipId' in definition)) throw definitionConflict('Mutagen session has no exact workspace sync settings owner');
      results.push(await this.project(item.raw, definition, 'none'));
    }
    return results;
  }
  private requireSessionIdentifier(relationshipId: string): string {
    const sessionIdentifier = this.sessionIdentifiers.get(relationshipId);
    if (!sessionIdentifier) {
      throw Object.assign(new Error('Workspace sync relationship runtime is not ready'), { code: 'relationship_not_ready' });
    }
    return sessionIdentifier;
  }
  async diagnoseSelection(request: WorkspaceSyncSelectionDiagnoseV1, signal?: AbortSignal): Promise<WorkspaceSyncPathSelectionV1> {
    const valid = WorkspaceSyncSelectionDiagnoseV1Schema.parse(request);
    const raw = await this.options.send({
      t: 'diagnose_selection',
      requestId: this.requestId(),
      sessionIdentifier: this.requireSessionIdentifier(valid.relationshipId),
      side: valid.side,
      path: valid.path,
    }, signal);
    return WorkspaceSyncPathSelectionV1Schema.parse(raw);
  }
  private async selected(relationshipId: string, command: 'get' | 'flush' | 'pause' | 'resume', signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> {
    const definition = this.definitions.get(relationshipId);
    if (!definition || !('relationshipId' in definition)) throw Object.assign(new Error('Workspace sync relationship is not ready'), { code: 'relationship_not_ready' });
    return await this.project(await this.options.send({
      t: command, requestId: this.requestId(), sessionIdentifier: this.requireSessionIdentifier(relationshipId),
    }, signal), definition, command === 'flush' ? 'operation' : 'none');
  }
  async flush(id: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> { return await this.selected(id, 'flush', signal); }
  async pause(id: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> { return await this.selected(id, 'pause', signal); }
  async resume(id: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> { return await this.selected(id, 'resume', signal); }
  private async terminateRuntimeSession(relationshipId: string, sessionIdentifier: string, signal?: AbortSignal): Promise<void> {
    await this.options.send({ t: 'terminate', requestId: this.requestId(), sessionIdentifier }, signal);
    this.sessionIdentifiers.delete(relationshipId);
    this.successfulCycles.delete(relationshipId);
    this.lastCycleObservedAtMs.delete(relationshipId);
  }
  async terminate(relationshipId: string, signal?: AbortSignal): Promise<void> {
    const definition = this.definitions.get(relationshipId);
    let sessionIdentifier = this.sessionIdentifiers.get(relationshipId);
    if (!sessionIdentifier && definition) {
      const discovered = await this.findClaimedSession(relationshipId, signal);
      if (discovered) {
        this.acceptSession(discovered.raw, definition);
        sessionIdentifier = discovered.generic.identifier;
      }
    }
    if (sessionIdentifier) await this.terminateRuntimeSession(relationshipId, sessionIdentifier, signal);
    this.definitions.delete(relationshipId);
  }
  async listConflicts(request: WorkspaceSyncConflictPageRequestV1, signal?: AbortSignal): Promise<WorkspaceSyncConflictPageV1> {
    const valid = WorkspaceSyncConflictPageRequestV1Schema.parse(request);
    const relationshipId = valid.relationshipId;
    const sessionIdentifier = this.requireSessionIdentifier(relationshipId);
    let raw: unknown;
    try {
      raw = await this.options.send({
        t: 'list_conflicts', requestId: this.requestId(), sessionIdentifier,
        ...(valid.cursor === undefined ? {} : { cursor: valid.cursor }),
        limit: valid.limit,
      }, signal);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'cursor_invalidated') {
        return { status: 'cursor_invalidated', relationshipId };
      }
      throw error;
    }
    const value = record(raw, 'conflict list');
    strictFields(value, ['totalCount', 'shownCount', 'truncatedCount', 'nextCursor', 'conflicts'], 'conflict list');
    if (!Array.isArray(value.conflicts) || value.conflicts.length > valid.limit) throw new Error('Invalid generic Mutagen conflict list');
    const conflicts = value.conflicts.map((item): WorkspaceSyncConflictV1 => {
      const generic = conflict(item);
      return WorkspaceSyncConflictV1Schema.parse({
        relationshipId,
        path: generic.root,
        alpha: entryFromChanges(generic.alphaChanges),
        beta: entryFromChanges(generic.betaChanges),
      });
    });
    const totalCount = boundedCount(value.totalCount, 'totalCount');
    const shownCount = boundedCount(value.shownCount, 'shownCount');
    const truncatedCount = boundedCount(value.truncatedCount, 'truncatedCount');
    if (shownCount !== conflicts.length || totalCount < shownCount || truncatedCount > totalCount - shownCount) {
      throw new Error('Invalid generic Mutagen conflict counts');
    }
    for (let index = 1; index < conflicts.length; index += 1) {
      if (Buffer.compare(
        Buffer.from(conflicts[index]!.path, 'utf8'),
        Buffer.from(conflicts[index - 1]!.path, 'utf8'),
      ) <= 0) throw new Error('Invalid generic Mutagen conflict order');
    }
    const nextCursor = value.nextCursor === null
      ? null
      : boundedString(value.nextCursor, 'conflict nextCursor', 256);
    if (nextCursor !== null && conflicts.length === 0) throw new Error('Invalid generic Mutagen conflict cursor');
    return { status: 'page', relationshipId, totalCount, nextCursor, conflicts };
  }
}

export function createWorkspaceSyncMutagenAdapter(options: WorkspaceSyncMutagenAdapterOptions): WorkspaceSyncMutagenAdapter {
  return new WorkspaceSyncMutagenAdapterClient(options);
}
