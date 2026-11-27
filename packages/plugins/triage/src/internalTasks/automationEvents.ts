import { arePluginMachineMaterializationRefsEqual, computeCanonicalDomainSeparatedDigest, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  runCheckpointedPluginEventObserverV1,
  type BackgroundServiceContext,
  type PluginCheckpointedEventSourceAdapterV1,
} from '@happier-dev/plugin-sdk/background-services';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import {
  buildTaskResourceChangeEntityIdV1,
  createPluginEventAutomationSetupResultV1JsonSchema,
  readTaskBlockerAddressV1,
  readTaskIdFromAccountKvKeyV1,
  readTaskResourceChangeEntityIdV1,
  type HostEvents,
  type PluginEventObservationV1,
} from '@happier-dev/plugin-sdk/events';
import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';
import { readOwnedTaskAutomationInventory, TASK_SUBJECT_KIND, TaskSubjectIdentityV1Schema } from './automationSubject.js';
import type { TaskList } from './source.js';

const pluginId = TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1;
const closed = { policy: 'closed' } as const;
const serverId = defineProtocolString({ minLength: 1 });
const timestamp = defineProtocolNumber({ integer: true, minimum: 0 });
const setupSchema = defineProtocolObject({ v: defineProtocolLiteral(1), serverId }, closed);
const configSchema = defineProtocolObject({ v: defineProtocolLiteral(1), serverId, observingSince: timestamp }, closed);
type SourceConfig = ReturnType<typeof configSchema.parse>;
const taskCreated = 'task-created';
const taskLabeled = 'task-labeled';
const taskReady = 'task-ready';
const taskPayload = defineProtocolObject({ task: TaskSubjectIdentityV1Schema }, closed);
const facts = {
  [taskCreated]: {
    title: 'Task created',
    schema: taskPayload,
  },
  [taskLabeled]: {
    title: 'Task labels changed',
    schema: defineProtocolObject({ task: TaskSubjectIdentityV1Schema, labels: defineProtocolArray(defineProtocolString()) }, closed),
  },
  [taskReady]: {
    title: 'Task becomes Ready',
    schema: taskPayload,
  },
} as const;
type TaskEvent = keyof typeof facts;
const isTaskEvent = (id: string): id is TaskEvent => Object.hasOwn(facts, id);
const eventIds = (Object.keys(facts) as TaskEvent[]);
const sourceId = (event: TaskEvent, config: SourceConfig) =>
  `tasks:${computeCanonicalDomainSeparatedDigest('happier.triage.task-event-source.v1', [event, config.serverId, String(config.observingSince)])}`;

const taskEvent = (event: TaskEvent) => ({
  declaration: {
    kind: 'event' as const,
    title: facts[event].title,
    payloadSchema: facts[event].schema.jsonSchema,
    automation: {
      v: 1 as const,
      eligible: true as const,
      subjects: [{ kind: 'plugin' as const, subjectKindId: TASK_SUBJECT_KIND, identityField: 'task' }],
      source: {
        sourceContractVersion: 1,
        supportedObservationTransports: ['checkpointedPull' as const],
        sourceConfigSchema: configSchema.jsonSchema,
        setupActionRef: { pluginId, localId: `${event}/setup` },
      },
    },
  },
});
export const taskEvents = Object.fromEntries(eventIds.map(event => [event, taskEvent(event)]));

const setupAction = (event: TaskEvent) => ({
  title: facts[event].title,
  execution: { target: 'daemon' as const },
  scopes: ['global' as const],
  surfaces: ['plugin', 'ui', 'cli', 'agent', 'mcp'] as const,
  placementBindings: [],
  dangerLevel: 'safe' as const,
  readOnly: true,
  inputHints: { submitLabel: 'Use this source', fields: [
    { path: 'serverId', title: 'Home', widget: 'select' as const,
      inputType: { hostType: 'homeId' as const }, required: true },
  ] },
  inputSchema: setupSchema,
  resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, configSchema.jsonSchema),
  run(input: unknown, context: PluginInvocationContext) {
    const sourceConfig = configSchema.parse({ ...setupSchema.parse(input), observingSince: context.invokedAtMs });
    return { v: 1 as const, sourceInstanceId: sourceId(event, sourceConfig), sourceContractVersion: 1,
      sourceConfig, displayLabel: 'Tasks I own' };
  },
});
export const taskEventActions = Object.fromEntries(eventIds.map(event => [`${event}/setup`, setupAction(event)]));

type Checkpoint = {
  observations: PluginEventObservationV1[];
  markers: Map<string, string>;
  missing: string[];
  incomplete: boolean;
};
type SourceState = {
  accountId?: string;
  full: boolean;
  pending: Set<string>;
  settled: Map<string, string>;
  attempt?: Checkpoint;
  readiness?: ReadinessIndex;
};
type Task = TaskList['todos'][number];
type ReadinessIndex = {
  tasks: Map<string, { ready?: boolean; blockers: Set<string> }>;
  dependents: Map<string, Set<string>>;
};

function updateReadinessIndex(index: ReadinessIndex, taskId: string, item?: { task: Task; ownerAccountId: string }): boolean | undefined {
  const previous = index.tasks.get(taskId);
  const blockers = new Set(item === undefined ? [] : (item.task.blockedBy ?? []).flatMap(blocker => {
    const address = readTaskBlockerAddressV1(blocker, item.ownerAccountId);
    return address === null ? [] : [buildTaskResourceChangeEntityIdV1(address)];
  }));
  for (const blocker of previous?.blockers ?? []) {
    if (blockers.has(blocker)) continue;
    const dependents = index.dependents.get(blocker)!;
    dependents.delete(taskId);
    if (dependents.size === 0) index.dependents.delete(blocker);
  }
  if (item === undefined) index.tasks.delete(taskId);
  else {
    const ready = item.task.readiness?.ready;
    index.tasks.set(taskId, { ...(ready === undefined ? {} : { ready }), blockers });
    for (const blocker of blockers) {
      if (previous?.blockers.has(blocker)) continue;
      const dependents = index.dependents.get(blocker);
      if (dependents) dependents.add(taskId);
      else index.dependents.set(blocker, new Set([taskId]));
    }
  }
  return previous?.ready;
}

export function createTaskEventSourceAdapter(
  host: HostEvents, now: () => number = Date.now,
): PluginCheckpointedEventSourceAdapterV1<{ event: TaskEvent; config: SourceConfig }, Checkpoint> {
  const active = new Map<string, SourceState>();
  type Wake = (sourceInstanceId?: string) => Promise<void>;
  let wake: Wake | undefined;
  let account: ReturnType<HostEvents['subscribe']> | undefined;
  let reconnect: ReturnType<HostEvents['subscribe']> | undefined;

  const syncSubscriptions = () => {
    if (!wake || active.size === 0) {
      account?.dispose();
      reconnect?.dispose();
      account = reconnect = undefined;
      return;
    }
    account ??= host.subscribe({ eventId: '@happier/account/entities-invalidated', scope: { kind: 'account' } }, async event => {
      const local = new Set<string>();
      let full = false;
      for (const hint of event.payload.accountKvChanges ?? []) {
        if ('full' in hint) full = true;
        else for (const key of hint.keys) {
          const id = readTaskIdFromAccountKvKeyV1(key);
          if (id !== null) local.add(id);
        }
      }
      const addressed = event.payload.entityIds.flatMap(id => {
        const address = readTaskResourceChangeEntityIdV1(id);
        return address === null ? [] : [address];
      });
      if (!full && local.size === 0 && addressed.length === 0) return;
      const woken: Promise<void>[] = [];
      for (const [id, state] of active) {
        const qualified = addressed.filter(task => state.accountId === undefined || task.ownerAccountId === state.accountId);
        const dependents = state.readiness?.dependents;
        const dependentIds = new Set<string>();
        if (dependents !== undefined) {
          for (const task of addressed) {
            for (const dependent of dependents.get(buildTaskResourceChangeEntityIdV1(task)) ?? []) dependentIds.add(dependent);
          }
          if (state.accountId !== undefined) for (const taskId of local) {
            const key = buildTaskResourceChangeEntityIdV1({ ownerAccountId: state.accountId, taskId });
            for (const dependent of dependents.get(key) ?? []) dependentIds.add(dependent);
          }
        }
        if (!full && local.size === 0 && qualified.length === 0 && dependentIds.size === 0) continue;
        state.full ||= full;
        for (const taskId of local) state.pending.add(taskId);
        for (const { taskId } of qualified) state.pending.add(taskId);
        for (const taskId of dependentIds) state.pending.add(taskId);
        if (wake) woken.push(wake(id));
      }
      await Promise.all(woken);
    });
    reconnect ??= host.subscribe({ eventId: '@happier/automation/event-sources-invalidated', scope: { kind: 'account' } }, async event => {
      if (event.payload.reason !== 'reconnect') return;
      for (const state of active.values()) state.full = true;
      await wake?.();
    });
  };

  return {
    subscribeWake(notify) {
      wake = notify;
      syncSubscriptions();
      return { dispose() { wake = undefined; syncSubscriptions(); active.clear(); } };
    },
    decode(definition) {
      if (definition.eventRef.pluginId !== pluginId || definition.sourceContractVersion !== 1) return null;
      const event = definition.eventRef.localId;
      if (!isTaskEvent(event)) return null;
      const config = configSchema.safeParse(definition.sourceConfig);
      return config.success && definition.sourceInstanceId === sourceId(event, config.data) ? { event, config: config.data } : null;
    },
    async observe({ context, definition, source: { event, config } }) {
      const id = definition.sourceInstanceId;
      let state = active.get(id);
      if (state === undefined) {
        state = { full: true, pending: new Set(), settled: new Map(),
          ...(event === taskReady ? { readiness: { tasks: new Map(), dependents: new Map() } } : {}) };
        active.set(id, state);
        syncSubscriptions();
      }
      const resultFor = (checkpoint: Checkpoint) => ({
        observations: checkpoint.observations, checkpoint, complete: true, nextEligibleAt: null,
        ...(checkpoint.incomplete ? { status: { state: 'attention' as const, code: 'task_event_inventory_incomplete' } } : {}),
      });
      if (state.attempt) return resultFor(state.attempt);
      const { full, pending, accountId } = state;
      if (!full && !pending.size) return { observations: [], complete: true, nextEligibleAt: null };
      state.full = false;
      state.pending = new Set();
      let list: Awaited<ReturnType<typeof readOwnedTaskAutomationInventory>>;
      try {
        list = await readOwnedTaskAutomationInventory(context, full || accountId === undefined ? {} : {
          selection: { kind: 'ids', tasks: [...pending].map(taskId => ({ ownerAccountId: accountId, taskId })) },
        });
        if (list.scope.serverId !== config.serverId || (accountId !== undefined && list.scope.accountId !== accountId)) {
          throw new PluginError({ code: 'task_scope_mismatch' });
        }
      } catch (error) {
        state.full ||= full;
        for (const taskId of pending) state.pending.add(taskId);
        throw error;
      }

      state.accountId = list.scope.accountId;
      const observations: PluginEventObservationV1[] = [];
      const receivedAt = now();
      const unavailable = list.unavailableTasks;
      const present = new Set(unavailable.map(task => task.taskId));
      const markers = new Map<string, string>();
      const ownerAccountId = list.scope.accountId;
      for (const item of list.todos) {
        present.add(item.id);
        let fact: { occurredAt: number; version: number } | undefined;
        if (event === taskCreated) fact = { occurredAt: item.createdAt, version: 0 };
        else if (event === taskLabeled) fact = item.labelChange;
        else if (state.readiness !== undefined) {
          const previous = updateReadinessIndex(state.readiness, item.id, { task: item, ownerAccountId });
          if (item.readiness?.ready) {
            if (previous === false) fact = { occurredAt: receivedAt, version: item.version ?? 0 };
            else if (!full && previous === undefined && item.createdAt > config.observingSince) {
              fact = { occurredAt: item.createdAt, version: item.version ?? 0 };
            }
          }
        }
        if (!fact || fact.occurredAt <= config.observingSince) continue;
        const occurrenceId = computeCanonicalDomainSeparatedDigest('happier.triage.task-event.v1',
          [config.serverId, ownerAccountId, item.id, event, String(fact.version), String(fact.occurredAt)]);
        if (state.settled.get(item.id) === occurrenceId) continue;
        markers.set(item.id, occurrenceId);
        const task = { ownerAccountId, taskId: item.id };
        observations.push({
          eventRef: { pluginId, localId: event }, sourceInstanceId: id, sourceContractVersion: 1,
          occurrenceId, occurredAt: fact.occurredAt, observationReceivedAt: receivedAt, observedDelta: 1,
          // Equal membership needs identical evidence after adoption/reconnect.
          payload: event === taskLabeled ? { task, labels: [...new Set(item.labels)].sort() } : { task },
        });
      }
      const missing = [...(full ? new Set([...state.settled.keys(), ...(state.readiness?.tasks.keys() ?? [])]) : pending)]
        .filter(taskId => !present.has(taskId));
      if (state.readiness !== undefined) for (const taskId of missing) updateReadinessIndex(state.readiness, taskId);
      state.attempt = { observations, markers, missing, incomplete: unavailable.length > 0 };
      return resultFor(state.attempt);
    },
    async save({ definition, checkpoint }) {
      const state = active.get(definition.sourceInstanceId);
      if (!state || state.attempt !== checkpoint) return;
      for (const id of checkpoint.missing) state.settled.delete(id);
      for (const [id, occurrence] of checkpoint.markers) state.settled.set(id, occurrence);
      delete state.attempt;
      if (state.full || state.pending.size > 0) void wake?.(definition.sourceInstanceId);
    },
    async retire({ context, definitions }) {
      const materialization = context.materialization;
      const current = new Set(definitions.flatMap(definition =>
        materialization !== undefined && definition.observationTransport.kind === 'checkpointedPull'
          && arePluginMachineMaterializationRefsEqual(materialization, definition.observationTransport.watcherMaterializationRef)
          ? [definition.sourceInstanceId] : []));
      for (const id of active.keys()) if (!current.has(id)) active.delete(id);
      syncSubscriptions();
      return { complete: true };
    },
    retryAt: () => null,
  };
}

async function runTaskEvents(context: BackgroundServiceContext): Promise<void> {
  await runCheckpointedPluginEventObserverV1({ context, source: createTaskEventSourceAdapter(context.services.events.host) });
}
export const taskEventBackgroundServices = [
  { declaration: { id: 'task-events', title: 'Task Events', placement: 'daemon' as const }, runner: runTaskEvents },
];
