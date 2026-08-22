import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import {
  type SubagentObservation,
  type SubagentsService,
  type SubagentSummary,
} from '@happier-dev/plugin-sdk/sessions/subagents';
import {
  serializeSessionSubagentCustodyDetailV1,
  type SubagentRefV1,
} from '@happier-dev/protocol';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime';
import { createHash, randomUUID } from 'node:crypto';

import type { HostSubagentStore } from './hostSubagentStore';

export type PluginSubagentHostIdentity = Readonly<{
  pluginId: string;
  contributionId: string;
  immutableGenerationId: string;
  parentSessionId: string;
}>;

type StoreState = {
  writeTail: Promise<void>;
};

type ListSnapshot = Readonly<{ queryKey: string; items: readonly SubagentSummary[]; offset: number }>;

const stateByStore = new WeakMap<object, StoreState>();
const CURSOR_PREFIX = 'plugin_subagents_v1_';
const MAX_CURSOR_SNAPSHOTS = 128;
const subagentStatuses = new Set<SubagentSummary['status']>(['starting', 'running', 'completed', 'failed', 'aborted']);

function fail(code: string, message = code): never {
  throw new PluginError({ code, message });
}

function stateFor(store: HostSubagentStore): StoreState {
  let state = stateByStore.get(store);
  if (!state) {
    state = { writeTail: Promise.resolve() };
    stateByStore.set(store, state);
  }
  return state;
}

function identityKey(identity: PluginSubagentHostIdentity): string {
  return JSON.stringify([identity.pluginId, identity.contributionId, identity.immutableGenerationId, identity.parentSessionId]);
}

function qualifiedId(identity: PluginSubagentHostIdentity, localId: string): string {
  const digest = createHash('sha256').update(JSON.stringify([
    identity.pluginId, identity.contributionId, identity.immutableGenerationId, identity.parentSessionId, localId,
  ]), 'utf8').digest('hex');
  return `plugin-subagent-v1:sha256:${digest}`;
}

function observationOperationId(input: Readonly<{
  scope: string;
  subagentId: string;
  groupId: string | null;
  status: SubagentSummary['status'];
  detail: JsonValue;
}>): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      input.scope,
      input.subagentId,
      input.groupId,
      input.status,
      serializeSessionSubagentCustodyDetailV1(input.detail),
    ]), 'utf8')
    .digest('hex');
  return `plugin-subagent-observation-v1:sha256:${digest}`;
}

function assertDataOnly(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) fail('plugin_subagent_input_invalid');
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) fail('plugin_subagent_input_invalid');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('get' in descriptor || 'set' in descriptor) fail('plugin_subagent_input_invalid');
    assertDataOnly(descriptor.value, seen);
  }
  seen.delete(value);
}

function normalizeObservation(input: unknown): SubagentObservation {
  assertDataOnly(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('plugin_subagent_input_invalid');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['observationId', 'groupId', 'status', 'detail'].includes(key))) {
    fail('plugin_subagent_input_invalid');
  }
  if (
    typeof value.observationId !== 'string' || value.observationId.trim().length === 0
    || typeof value.status !== 'string' || !subagentStatuses.has(value.status as SubagentSummary['status'])
    || (value.groupId !== undefined && typeof value.groupId !== 'string')
  ) fail('plugin_subagent_input_invalid');
  const detail = value.detail === undefined
    ? undefined
    : AgentRuntimeJsonValueV1Schema.safeParse(value.detail);
  if (detail !== undefined && !detail.success) fail('plugin_subagent_input_invalid');
  return Object.freeze({
    observationId: value.observationId,
    ...(value.groupId !== undefined ? { groupId: value.groupId as string } : {}),
    status: value.status as SubagentSummary['status'],
    ...(detail !== undefined ? { detail: detail.data } : {}),
  });
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) fail('plugin_subagent_limit_invalid');
  return Math.min(100, Math.trunc(value));
}

async function withWriteLock<T>(state: StoreState, operation: () => Promise<T>): Promise<T> {
  const previous = state.writeTail;
  let release!: () => void;
  state.writeTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function normalizeStatus(status: SubagentSummary['status']) {
  return status === 'starting' ? 'pending' as const : status;
}

type PluginServiceMetadata = Readonly<{
  pluginId: string;
  contributionId: string;
  generationId: string;
  localId: string;
  revision: string;
  updatedAtMs: number;
}>;

function readMetadata(ref: SubagentRefV1): PluginServiceMetadata | null {
  const raw = ref.agentMetadata?.pluginServiceV1;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.pluginId !== 'string'
    || typeof value.contributionId !== 'string'
    || typeof value.generationId !== 'string'
    || typeof value.localId !== 'string'
    || typeof value.revision !== 'string'
    || typeof value.updatedAtMs !== 'number'
  ) return null;
  return value as PluginServiceMetadata;
}

function projectSummary(ref: SubagentRefV1): SubagentSummary | null {
  const metadata = readMetadata(ref);
  if (!metadata) return null;
  return Object.freeze({
    id: ref.id,
    parentSessionId: ref.parentSessionId,
    ...(ref.groupRef?.groupId ? { groupId: ref.groupRef.groupId } : {}),
    status: ref.status === 'pending' ? 'starting' : ref.status,
    updatedAtMs: metadata.updatedAtMs,
  });
}

function projectOwnedSummary(ref: SubagentRefV1, identity: PluginSubagentHostIdentity): SubagentSummary | null {
  const metadata = readMetadata(ref);
  if (!metadata || identityKey(identity) !== identityKey({
    pluginId: metadata.pluginId,
    contributionId: metadata.contributionId,
    immutableGenerationId: metadata.generationId,
    parentSessionId: ref.parentSessionId,
  })) return null;
  return projectSummary(ref);
}

export function createPluginSubagentsService(params: Readonly<{
  store: HostSubagentStore;
  identity: PluginSubagentHostIdentity;
  isCurrent: () => boolean;
  durableCustody?: PluginSubagentDurableCustody;
}>): SubagentsService {
  const state = stateFor(params.store);
  const snapshots = new Map<string, ListSnapshot>();

  const current = (): boolean => {
    try { return params.isCurrent() === true; } catch { return false; }
  };
  const assertCurrent = (): void => {
    if (!current()) fail('plugin_generation_retired', 'Plugin generation is retired');
  };
  const assertParent = (parentSessionId: string | undefined): string => {
    const value = parentSessionId?.trim() || params.identity.parentSessionId;
    if (value !== params.identity.parentSessionId) fail('plugin_subagent_parent_forbidden', 'Subagent parent session is outside this invocation');
    return value;
  };
  const mirrorSummary = async (summary: PluginSubagentDurableSummary, observationId: string): Promise<SubagentSummary> => {
    const stored = await params.store.upsert({
      actor: { kind: 'plugin', pluginId: params.identity.pluginId, agentId: params.identity.contributionId },
      input: {
        id: summary.id,
        parentSessionId: summary.parentSessionId,
        origin: 'plugin',
        kind: 'custom',
        agentRef: { agentId: params.identity.contributionId },
        status: normalizeStatus(summary.status),
        ...(summary.groupId ? { groupRef: { groupId: summary.groupId, groupKind: 'custom', memberId: observationId } } : {}),
        agentMetadata: {
          pluginServiceV1: {
            pluginId: params.identity.pluginId,
            contributionId: params.identity.contributionId,
            generationId: params.identity.immutableGenerationId,
            localId: observationId,
            revision: summary.revision,
            updatedAtMs: summary.updatedAtMs,
          },
        },
        createdAt: summary.updatedAtMs,
      },
    });
    return projectSummary(stored) ?? fail('plugin_subagent_projection_unavailable');
  };
  const reconcile = async (signal?: AbortSignal): Promise<void> => {
    if (!params.durableCustody) return;
    const summaries = await params.durableCustody.list({ scope: identityKey(params.identity), signal });
    if (signal?.aborted) fail('plugin_operation_aborted');
    assertCurrent();
    await withWriteLock(state, async () => {
      for (const summary of summaries) {
        await mirrorSummary(summary, summary.id);
      }
    });
    assertCurrent();
  };
  const availability = () => current()
    ? Object.freeze({ status: 'available' as const })
    : Object.freeze({ status: 'unavailable' as const, code: 'plugin_generation_retired' });
  const observeAvailability = () => current()
    ? params.durableCustody
      ? params.durableCustody.availability()
      : Object.freeze({ status: 'unavailable' as const, code: 'plugin_subagent_durable_custody_unavailable' })
    : Object.freeze({ status: 'unavailable' as const, code: 'plugin_generation_retired' });
  const service: SubagentsService = {
    capabilities: () => Object.freeze({ list: availability(), observe: observeAvailability(), watch: availability() }),
    async list(query: NonNullable<Parameters<SubagentsService['list']>[0]> = {}) {
      assertCurrent();
      const parentSessionId = assertParent(query.parentSessionId);
      if (query.signal?.aborted) fail('plugin_operation_aborted');
      await reconcile(query.signal);
      const limit = boundedLimit(query.limit, 50);
      const groupId = query.groupId === undefined
        ? undefined
        : params.durableCustody?.normalizeGroupId(query.groupId) ?? query.groupId;
      const queryKey = JSON.stringify([parentSessionId, groupId ?? null]);
      let snapshot: ListSnapshot;
      if (query.cursor) {
        if (!query.cursor.startsWith(CURSOR_PREFIX)) fail('plugin_subagent_cursor_invalid');
        snapshot = snapshots.get(query.cursor) ?? fail('plugin_subagent_cursor_invalid');
        snapshots.delete(query.cursor);
        if (snapshot.queryKey !== queryKey) fail('plugin_subagent_cursor_invalid');
      } else {
        const refs = await params.store.list({ parentSessionId, ...(groupId ? { groupId } : {}), limit: 256 });
        if (query.signal?.aborted) fail('plugin_operation_aborted');
        assertCurrent();
        const items = refs.map((ref) => projectOwnedSummary(ref, params.identity)).filter((summary): summary is SubagentSummary => summary !== null)
          .sort((a, b) => a.id.localeCompare(b.id));
        snapshot = Object.freeze({ queryKey, items: Object.freeze(items), offset: 0 });
      }
      const items = snapshot.items.slice(snapshot.offset, snapshot.offset + limit);
      const nextOffset = snapshot.offset + items.length;
      let nextCursor: string | undefined;
      if (nextOffset < snapshot.items.length) {
        nextCursor = `${CURSOR_PREFIX}${randomUUID()}`;
        while (snapshots.size >= MAX_CURSOR_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
        snapshots.set(nextCursor, Object.freeze({ ...snapshot, offset: nextOffset }));
      }
      return Object.freeze({
        items: Object.freeze(items),
        ...(nextCursor ? { nextCursor } : {}),
      });
    },
    async get(id: string, options: NonNullable<Parameters<SubagentsService['get']>[1]> = {}) {
      assertCurrent();
      const parentSessionId = assertParent(options.parentSessionId);
      if (options.signal?.aborted) fail('plugin_operation_aborted');
      await reconcile(options.signal);
      const ref = await params.store.get({ id, parentSessionId });
      if (options.signal?.aborted) fail('plugin_operation_aborted');
      assertCurrent();
      return ref ? projectOwnedSummary(ref, params.identity) : null;
    },
    async observe(input: SubagentObservation, options: NonNullable<Parameters<SubagentsService['observe']>[1]> = {}) {
      assertCurrent();
      if (options.signal?.aborted) fail('plugin_operation_aborted');
      if (!params.durableCustody) fail('plugin_subagent_durable_custody_unavailable');
      const observation = normalizeObservation(input);
      const id = qualifiedId(params.identity, observation.observationId);
      return await withWriteLock(state, async () => {
        const scope = identityKey(params.identity);
        const normalizedGroupId = observation.groupId === undefined
          ? undefined
          : params.durableCustody!.normalizeGroupId(observation.groupId);
        const summary = await params.durableCustody!.mutate({
          scope,
          operationId: observationOperationId({
            scope,
            subagentId: id,
            groupId: normalizedGroupId ?? null,
            status: observation.status,
            detail: observation.detail ?? null,
          }),
          subagentId: id,
          groupId: observation.groupId,
          status: observation.status,
          detail: observation.detail,
          signal: options.signal,
        });
        if (options.signal?.aborted) fail('plugin_operation_aborted');
        assertCurrent();
        const mirrored = await mirrorSummary(summary, observation.observationId);
        if (options.signal?.aborted) fail('plugin_operation_aborted');
        assertCurrent();
        return mirrored;
      });
    },
    watch(query: Parameters<SubagentsService['watch']>[0], listener: Parameters<SubagentsService['watch']>[1]) {
      assertCurrent();
      const parentSessionId = assertParent(query.parentSessionId);
      const ownedIds = new Set<string>();
      const emit = (event: Parameters<typeof listener>[0]): void => {
        try {
          listener(Object.freeze(event));
        } catch {
          // Plugin listeners cannot disrupt the canonical host watcher or sibling subscribers.
        }
      };
      const subscription = params.store.watch(
        { parentSessionId, ...(query.id ? { id: query.id } : {}) },
        (event) => {
          if (!current()) return;
          if (event.kind === 'snapshot') {
            ownedIds.clear();
            for (const ref of event.subagents ?? []) {
              const item = projectOwnedSummary(ref, params.identity);
              if (item) ownedIds.add(item.id);
            }
            emit({ kind: 'snapshot' });
            return;
          }
          if (event.kind === 'removed') {
            if (event.id && ownedIds.delete(event.id)) emit({ kind: 'removed', id: event.id });
            return;
          }
          const item = event.subagent ? projectOwnedSummary(event.subagent, params.identity) : null;
          if (item) {
            ownedIds.add(item.id);
            emit({ kind: 'upserted', item });
          }
        },
      );
      void reconcile().catch(() => {
        // Watch has no error channel. Capability/list methods retain the truthful typed failure.
      });
      return Object.freeze({ dispose() { subscription.unsubscribe(); } });
    },
  };
  return Object.freeze(service);
}

export type PluginSubagentDurableCustody = Readonly<{
  availability(): Readonly<{ status: 'available' } | { status: 'unavailable'; code: string }>;
  normalizeGroupId(groupId: string): string;
  list(options: Readonly<{ scope: string; signal?: AbortSignal }>): Promise<readonly PluginSubagentDurableSummary[]>;
  mutate(input: Readonly<{
    scope: string;
    operationId: string;
    subagentId: string;
    groupId?: string;
    status: SubagentSummary['status'];
    detail?: JsonValue;
    signal?: AbortSignal;
  }>): Promise<PluginSubagentDurableSummary>;
  retire(options?: Readonly<{ signal?: AbortSignal }>): Promise<void>;
}>;

export type PluginSubagentDurableSummary = Readonly<SubagentSummary & { revision: string }>;
