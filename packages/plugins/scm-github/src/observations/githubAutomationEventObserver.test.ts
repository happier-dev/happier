import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';
import { AutomationEventAdmitInputV1Schema, AutomationEventSourcesListInputV1Schema } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol';
import { PluginWebhookEndpointCheckCorrespondenceInputV1Schema, PluginWebhookEndpointCheckCorrespondenceResultV1Schema } from '@happier-dev/protocol/plugins/webhooks/endpointV1';
import { buildAutomationPluginEventOccurrenceEvidenceV1, deriveAutomationOccurrenceKeyV1, serializeAutomationOccurrenceEvidenceEqualityV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { PluginError, type JsonValue, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { HostEventEnvelope } from '@happier-dev/plugin-sdk/events';
import type {
  PluginActionInputById,
  PluginActionResultById,
} from '@happier-dev/plugin-sdk/actions';
import type {
  PluginAccountCollectionForDefinition,
  PluginCollectionRow,
} from '@happier-dev/plugin-sdk/collections';

import {
  GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION,
  GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD,
  createGithubAutomationEventCheckpointRowId as createGithubAutomationEventCheckpointRowIdOwner,
  type GithubAutomationEventCheckpointRowV1,
} from './githubAutomationEventCheckpoint.js';
import {
  createGithubAutomationEventCheckpointedPullObserver,
  normalizeGithubRepositoryEventForAutomation,
  type GithubAutomationEventCheckpointedPullObserver,
} from './githubAutomationEventObserver.js';
import { parseGithubRepositoryEventsCursor } from './githubRepositoryEventsCursor.js';
import { capturedRepositoryPullRequestEvent } from './testkit/githubRepositoryPullRequestEvent.fixture.js';
import { observeGithubDeploymentReviewsV1 } from './githubDeploymentMonitor.js';
import { activate, activateAccount } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { createStubGithubTransport } from '../triage/testkit/githubTriage.test-support.js';
import {
  GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID,
  GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID,
  parseGithubDeploymentMonitoringSourceConfig,
} from './githubProviderContracts.js';
import { resetGithubRepositoryEventHistoryGap } from '../githubAutomationEventActions.js';
import {
  GITHUB_AUTOMATION_EVENT_LOCAL_IDS,
  type GithubAutomationEventLocalIdV1,
} from '../githubAutomationEvents.js';

const GITHUB_PLUGIN_ID = 'happier.scm.forge.github';
type HttpBoundaryResponse = Awaited<ReturnType<Parameters<typeof createPluginHttpFixture>[0]['request']>>;
const EVENT_LOCAL_ID = 'automation/repository-pushed-v1';
const sourceSelectorA = '00000000-0000-4000-8000-000000000001';
const sourceSelectorB = '00000000-0000-4000-8000-000000000002';
const credentialRef = {
  service: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' },
  accountId: 'github-primary',
} as const;
const watcherMaterializationRef = {
  pluginId: GITHUB_PLUGIN_ID,
  machineId: 'machine-1',
  materializationId: 'materialization-1',
} as const;

function createGithubAutomationEventCheckpointRowId(
  input: Readonly<{
    automationId?: string;
    triggerId?: string;
    eventRef?: Readonly<{ pluginId: string; localId: string }>;
    sourceSelectorId?: string;
  }>,
): string {
  return createGithubAutomationEventCheckpointRowIdOwner({
    automationId: input.automationId ?? 'automation-a',
    triggerId: input.triggerId ?? `trigger-${input.automationId ?? 'automation-a'}`,
    eventRef: input.eventRef ?? { pluginId: GITHUB_PLUGIN_ID, localId: EVENT_LOCAL_ID },
    sourceSelectorId: input.sourceSelectorId ?? sourceSelectorA,
  });
}

type CheckpointCollection = PluginAccountCollectionForDefinition<
  typeof GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION
>;
type SourceDefinition = Extract<
  PluginActionResultById['automation.event.sources.list'],
  Readonly<{ kind: 'page' }>
>['definitions'][number];
type AutomationEventAdmitInput = PluginActionInputById['automation.event.admit'];
type AutomationEventSourceStatusReport = PluginActionInputById['automation.event.source.status.report'];
type CatalogReconciliationStatus = Extract<
  AutomationEventSourceStatusReport,
  Readonly<{ kind: 'catalogReconciliation' }>
>;

function checkpointRow(input: Readonly<{
  automationId: string;
  triggerId?: string;
  eventLocalId?: GithubAutomationEventLocalIdV1;
  sourceSelectorId: string;
  sourceInstanceId?: string;
  sourceContractVersion?: number;
}>): GithubAutomationEventCheckpointRowV1 {
  const triggerId = input.triggerId ?? `trigger-${input.automationId}`;
  const eventLocalId = input.eventLocalId ?? EVENT_LOCAL_ID;
  return {
    [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.id]: createGithubAutomationEventCheckpointRowId({
      automationId: input.automationId,
      triggerId,
      eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: eventLocalId },
      sourceSelectorId: input.sourceSelectorId,
    }),
    [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.version]: 1,
    [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.automationId]: input.automationId,
    [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.triggerId]: triggerId,
    [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventPluginId]: GITHUB_PLUGIN_ID,
    [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventLocalId]: eventLocalId,
    [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.sourceSelectorId]: input.sourceSelectorId,
    [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.payload]: {
      sourceInstanceId: input.sourceInstanceId ?? 'github:repository:77',
      sourceContractVersion: input.sourceContractVersion ?? 1,
      checkpointContractVersion: 1,
      cursor: {
        v: 1,
        observationStartsAtMs: 1_000,
        observedAtMs: 1_000,
        seenEventIds: ['old'],
        etag: 'prior-etag',
      },
      lastContiguousOccurrenceId: 'github:repository:77:event:old',
      baseline: { kind: 'currentHead', establishedAt: 1_000 },
      lastEvaluatedTriggerRevision: 1,
      continuity: { v: 1, endpointKind: 'repositoryEvents', repositoryId: '77' },
    },
  };
}

function checkpointRetirementCandidate(row: GithubAutomationEventCheckpointRowV1) {
  return {
    automationId: row[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.automationId],
    triggerId: row[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.triggerId],
    triggerRevision: row[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.payload].lastEvaluatedTriggerRevision,
    eventRef: {
      pluginId: row[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventPluginId],
      localId: row[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventLocalId],
    },
    sourceSelectorId: row[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.sourceSelectorId],
    sourceContractVersion: row[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.payload].sourceContractVersion,
  } as const;
}

function historyGapCheckpointRow(input: Readonly<{
  automationId: string;
  sourceSelectorId: string;
  eventLocalId?: GithubAutomationEventLocalIdV1;
}>): GithubAutomationEventCheckpointRowV1 {
  const row = checkpointRow(input);
  return {
    ...row,
    [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.payload]: {
      ...row.payload,
      continuity: {
        v: 1,
        endpointKind: 'repositoryEvents',
        repositoryId: '77',
        historyGap: true,
      },
    },
  };
}

function createCheckpointCollection(
  initialRows: readonly GithubAutomationEventCheckpointRowV1[],
  settings: Readonly<{
    beforeGet?: (rowId: string) => Promise<void>;
    beforePut?: (row: GithubAutomationEventCheckpointRowV1) => Promise<void>;
    forcePutConflict?: boolean;
    deleteConflictCount?: number;
    queryFailureCount?: number;
    maxRows?: number;
    pageSize?: number;
  }> = {},
): Readonly<{
  collection: CheckpointCollection;
  delete: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  rowCount(): number;
  read(rowId: string): PluginCollectionRow<GithubAutomationEventCheckpointRowV1> | null;
}> {
  const rows = new Map<string, PluginCollectionRow<GithubAutomationEventCheckpointRowV1>>();
  for (const value of initialRows) {
    rows.set(value.id, { rowId: value.id, revision: 1, value: structuredClone(value) });
  }

  const get = vi.fn(async (rowId: string) => {
    await settings.beforeGet?.(rowId);
    const row = rows.get(rowId);
    return row === undefined ? null : structuredClone(row);
  });
  const put = vi.fn(async (
    value: GithubAutomationEventCheckpointRowV1,
    options: Readonly<{ expectedRevision: number | 'absent' }>,
  ) => {
    await settings.beforePut?.(value);
    if (settings.forcePutConflict === true) {
      throw new PluginError({
        code: 'plugin_collection_conflict',
        message: 'checkpoint CAS conflict',
      });
    }
    const current = rows.get(value.id);
    const expectedMatches = options.expectedRevision === 'absent'
      ? current === undefined
      : current?.revision === options.expectedRevision;
    if (!expectedMatches) {
      throw new PluginError({
        code: 'plugin_collection_conflict',
        message: 'checkpoint CAS conflict',
      });
    }
    if (current === undefined && settings.maxRows !== undefined && rows.size >= settings.maxRows) {
      throw new PluginError({
        code: 'plugin_collection_quota_exceeded',
        message: 'checkpoint Collection row quota is exhausted',
      });
    }
    const row = {
      rowId: value.id,
      revision: (current?.revision ?? 0) + 1,
      value: structuredClone(value),
    } satisfies PluginCollectionRow<GithubAutomationEventCheckpointRowV1>;
    rows.set(value.id, row);
    return structuredClone(row);
  });

  let remainingDeleteConflicts = settings.deleteConflictCount ?? 0;
  const remove = vi.fn(async (
    rowId: string,
    options: Readonly<{ expectedRevision: number }>,
  ) => {
    if (remainingDeleteConflicts > 0) {
      remainingDeleteConflicts -= 1;
      throw new PluginError({
        code: 'plugin_collection_conflict',
        message: 'checkpoint delete CAS conflict',
      });
    }
    const current = rows.get(rowId);
    if (current === undefined || current.revision !== options.expectedRevision) {
      throw new PluginError({
        code: 'plugin_collection_conflict',
        message: 'checkpoint delete CAS conflict',
      });
    }
    rows.delete(rowId);
    return Object.freeze({ rowId, revision: current.revision + 1, deleted: true as const });
  });

  let remainingQueryFailures = settings.queryFailureCount ?? 0;
  const query = vi.fn(async (request: Readonly<{ cursor?: string; limit?: number }>) => {
    if (remainingQueryFailures > 0) {
      remainingQueryFailures -= 1;
      throw new PluginError({
        code: 'plugin_collection_unavailable',
        message: 'checkpoint Collection query failed',
      });
    }
    const ordered = [...rows.values()]
      .sort((left, right) => left.rowId.localeCompare(right.rowId));
    const available = request.cursor === undefined
      ? ordered
      : ordered.filter((row) => row.rowId > request.cursor!);
    const pageSize = Math.min(
      request.limit ?? 50,
      settings.pageSize ?? request.limit ?? 50,
    );
    const pageRows = available.slice(0, pageSize);
    const lastRowId = pageRows.at(-1)?.rowId;
    return Object.freeze({
      rows: Object.freeze(pageRows.map((row) => structuredClone(row))),
      ...(lastRowId !== undefined && available.length > pageRows.length ? { nextCursor: lastRowId } : {}),
      changeCursor: 0,
    });
  });

  // This is a narrow boundary fixture; the observer exercises only its own
  // Account Collection get/query/put/delete CAS operations.
  const collection = { get, put, query, delete: remove } as unknown as CheckpointCollection;
  return {
    collection,
    delete: remove,
    query,
    put,
    rowCount() {
      return rows.size;
    },
    read(rowId) {
      const row = rows.get(rowId);
      return row === undefined ? null : structuredClone(row);
    },
  };
}

function definition(input: Readonly<{
  automationId: string;
  sourceSelectorId: string;
  repositoryId?: string;
  triggerId?: string;
  eventLocalId?: GithubAutomationEventLocalIdV1;
  triggerRevision?: number;
}>): SourceDefinition {
  const repositoryId = input.repositoryId ?? '77';
  const repositoryName = repositoryId === '77' ? 'widgets' : `widgets-${repositoryId}`;
  return {
    automationId: input.automationId,
    triggerId: input.triggerId ?? `trigger-${input.automationId}`,
    triggerRevision: input.triggerRevision ?? 1,
    eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: input.eventLocalId ?? EVENT_LOCAL_ID },
    sourceInstanceId: `github:repository:${repositoryId}`,
    sourceSelectorId: input.sourceSelectorId,
    sourceContractVersion: 1,
    sourceConfig: {
      v: 1,
      credentialRef,
      repository: {
        v: 1,
        repositoryId,
        owner: 'acme',
        name: repositoryName,
        nameWithOwner: `acme/${repositoryName}`,
      },
    },
    observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef },
    filter: null,
    maximumObservationAgeMs: null,
  } as const satisfies SourceDefinition;
}

function catalogStatuses(
  statuses: readonly AutomationEventSourceStatusReport[],
): readonly CatalogReconciliationStatus[] {
  return statuses.filter((status): status is CatalogReconciliationStatus => status.kind === 'catalogReconciliation');
}

function durableDeploymentDefinition(automationId: string, deliveryMode: 'automatic' | 'webhook' = 'automatic'): SourceDefinition {
  const base = definition({ automationId, sourceSelectorId: sourceSelectorA, eventLocalId: 'automation/deployment-review-v1' });
  return { ...base, observationOnly: { kind: 'observationOnly' }, sourceInstanceId: 'github:repository:77:deployment-review',
    sourceConfig: { ...base.sourceConfig as Readonly<Record<string, JsonValue>>, deploymentReview: { monitoringMachineId: 'machine-1', deliveryMode } },
    observationTransport: { kind: 'durablePush', webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
      endpointMaterializationRef: watcherMaterializationRef, observationStartsAt: 1_000 } };
}

/** The host returns one transport-scoped page under its Account catalog revision. */
function sourceListResult(input: unknown, revision: string, definitions: readonly SourceDefinition[]) {
  const request = AutomationEventSourcesListInputV1Schema.parse(input);
  return request.knownRevision === revision ? { kind: 'unchanged' as const, revision,
    ...(request.checkpointRetirementCandidates === undefined ? {} : { checkpointRetirements: [] }) }
    : { kind: 'page' as const, revision, nextCursor: null,
      definitions: definitions.filter(source => source.observationTransport.kind === request.transport.kind) };
}

function sourceAttemptContext(
  observer: Pick<GithubAutomationEventCheckpointedPullObserver, 'runSourceAttempt'>,
  context: BackgroundServiceContext,
  beforeAttempt?: (input: unknown, context: PluginInvocationContext) => Promise<void>,
): BackgroundServiceContext {
  let wrapped: BackgroundServiceContext;
  wrapped = {
    ...context,
    materialization: context.materialization ?? watcherMaterializationRef,
    services: {
      ...context.services,
      http: createPluginHttpFixture({ request: context.services.http.request }),
      events: context.services.events ?? {
        plugin: {
          emit: async () => { throw new Error('Unexpected plugin event emission'); },
          subscribe: () => { throw new Error('Unexpected plugin event subscription'); },
        },
        host: { subscribe: vi.fn(() => ({ dispose() {} })) },
      },
      actions: {
        ...context.services.actions,
        execute: async (actionId: unknown, input: unknown, options?: unknown): Promise<unknown> => {
          if (
            typeof actionId === 'object'
            && actionId !== null
            && 'pluginId' in actionId
            && actionId.pluginId === GITHUB_PLUGIN_ID
            && 'localId' in actionId
            && actionId.localId === GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID
          ) {
            const actionContext = {
              plugin: context.plugin,
              contribution: {
                id: GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID,
                qualifiedId: `${GITHUB_PLUGIN_ID}/actions/${GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID}`,
              },
              surface: 'plugin' as const,
              invokedAtMs: 1_760_000_700_000,
              caller: {
                kind: 'plugin' as const,
                pluginId: GITHUB_PLUGIN_ID,
                contribution: {
                  id: GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID,
                  qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/${GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID}`,
                },
                occurrenceId: 'github-automation-observer-fixture-generation',
                sourceCustody: { kind: 'managed', immutableGenerationId: 'github-automation-observer-fixture-generation', installSource: 'npm' },
                materialization: watcherMaterializationRef,
                originSurface: 'background' as const,
              },
              signal: context.signal,
              services: wrapped.services,
            } satisfies PluginInvocationContext;
            await beforeAttempt?.(input, actionContext);
            return await observer.runSourceAttempt(
              input,
              actionContext,
            );
          }
          return await context.services.actions.execute(
            actionId as never,
            input as never,
            options as never,
          );
        },
      },
    },
  } as unknown as BackgroundServiceContext;
  return wrapped;
}

function observerBackgroundContext(input: Readonly<{
  actions: unknown;
  collection: CheckpointCollection;
  signal?: AbortSignal;
  http?: unknown;
  notifications?: unknown;
  events?: unknown;
  connectedAccounts?: unknown;
}>): BackgroundServiceContext {
  return {
    plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
    contribution: {
      id: GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID,
      qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/${GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID}`,
    },
    surface: 'background' as const,
    materialization: watcherMaterializationRef,
    signal: input.signal ?? new AbortController().signal,
    services: {
      actions: input.actions,
      events: input.events ?? { host: { subscribe: vi.fn(() => ({ dispose() {} })) } },
      connectedAccounts: input.connectedAccounts ?? {
        materialize: vi.fn(async () => ({
          kind: 'httpHeaders' as const,
          headers: { Authorization: 'Bearer exact-account-token' },
        })),
      },
      http: input.http ?? {
        request: vi.fn(async () => ({ status: 304, headers: {}, body: new Uint8Array() })),
      },
      notifications: input.notifications,
      storage: { account: { collection: vi.fn(() => input.collection) } },
    },
  } as unknown as BackgroundServiceContext;
}

type SourcesInvalidatedEnvelope = HostEventEnvelope<'@happier/automation/event-sources-invalidated'>;
type SourcesInvalidatedListener = (event: SourcesInvalidatedEnvelope) => void;
/** The authenticated Host Event the SDK observer receives; an empty payload is a definition change. */
function sourcesInvalidated(payload: SourcesInvalidatedEnvelope['payload'] = {}): SourcesInvalidatedEnvelope {
  return { eventId: '@happier/automation/event-sources-invalidated', scope: { kind: 'account' }, payload };
}

describe('GitHub Automation Event checkpointed-pull observer', () => {
  it.each([
    ['missing host', undefined, watcherMaterializationRef],
    ['other machine', { ...watcherMaterializationRef, machineId: 'machine-other' }, watcherMaterializationRef],
    ['retired materialization', { ...watcherMaterializationRef, materializationId: 'retired' }, watcherMaterializationRef],
    ['unassigned source', watcherMaterializationRef, null],
    ['current host', watcherMaterializationRef, watcherMaterializationRef],
  ] as const)('enforces %s before credentials, provider reads or checkpoint effects', async (label, materialization, assignment) => {
    const source = { ...definition({ automationId: 'assignment-gate', sourceSelectorId: sourceSelectorA }),
      observationTransport: { kind: 'checkpointedPull' as const, watcherMaterializationRef: assignment } };
    const checkpoints = createCheckpointCollection([]);
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') {
        const request = AutomationEventSourcesListInputV1Schema.parse(input);
        // Null is an unadmitted stored source, never a usable runtime assignment.
        return request.knownRevision === '7' ? { kind: 'unchanged', revision: '7' }
          : { kind: 'page', revision: '7', definitions: [source], nextCursor: null };
      }
      if (action === 'automation.event.source.status.report') return {};
      throw new Error(`Unexpected Action ${action}`);
    }) };
    const http = { request: vi.fn(async () => ({ status: 200, headers: {}, body: new TextEncoder().encode('[]') })) };
    const connectedAccounts = { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const,
      headers: { Authorization: 'Bearer exact-account-token' } })) };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    const failures: unknown[] = [];
    const context = sourceAttemptContext({ runSourceAttempt: async (input, actionContext) => {
      try { return await observer.runSourceAttempt(input, actionContext); }
      catch (error) { failures.push(error); throw error; }
    } }, observerBackgroundContext({ actions, collection: checkpoints.collection, http,
      connectedAccounts }));
    await observer.runCycle({ ...context, materialization });
    expect(failures).toEqual([]);
    const attempts = label === 'current host' ? 1 : 0;
    if (attempts === 1) expect(actions.execute.mock.calls.filter(([action]) => action === 'automation.event.source.status.report')
      .map(([, input]) => input)).toContainEqual(expect.objectContaining({ kind: 'source', state: 'baselined' }));
    expect(connectedAccounts.materialize).toHaveBeenCalledTimes(attempts);
    expect(http.request).toHaveBeenCalledTimes(attempts);
    expect(checkpoints.query).toHaveBeenCalledTimes(attempts);
    expect(checkpoints.put).toHaveBeenCalledTimes(attempts);
    expect(checkpoints.delete).not.toHaveBeenCalled();
  });

  it('rejects every unauthorized group member before checkpoint reads, secrets or provider I/O', async () => {
    const first = definition({ automationId: 'authorized-group-first', sourceSelectorId: sourceSelectorA });
    const second = definition({ automationId: 'authorized-group-second', sourceSelectorId: sourceSelectorB });
    const checkpoints = createCheckpointCollection([]);
    const connectedAccounts = { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer group-account' } })) };
    const http = { request: vi.fn(async () => ({ status: 200, headers: {}, body: new TextEncoder().encode('[]') })) };
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return sourceListResult(input, '7', [first, second]);
      if (action === 'automation.event.source.status.report') return {};
      throw new Error(`Unexpected Action ${action}`);
    }) };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    let rejected = 0;
    const context = sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection,
      http, connectedAccounts }), async (input, actionContext) => {
      if (!input || typeof input !== 'object') throw new Error('Target Action input is unavailable');
      for (const unauthorized of [
        { ...second, triggerRevision: second.triggerRevision + 1 },
        { ...second, observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: { ...watcherMaterializationRef, materializationId: 'other-host' } } },
        { ...second, sourceConfig: { ...second.sourceConfig as Readonly<Record<string, JsonValue>>,
          credentialRef: { ...credentialRef, accountId: 'different-principal' } } },
      ]) {
        await expect(observer.runSourceAttempt({ ...input, definitions: [first, unauthorized] }, actionContext)).rejects.toThrow();
        rejected++;
        expect(checkpoints.collection.get).not.toHaveBeenCalled();
        expect(checkpoints.put).not.toHaveBeenCalled();
        expect(connectedAccounts.materialize).not.toHaveBeenCalled();
        expect(http.request).not.toHaveBeenCalled();
      }
    });

    await observer.runCycle(context);

    expect(rejected).toBe(3);
    expect(connectedAccounts.materialize).toHaveBeenCalledOnce();
    expect(http.request).toHaveBeenCalledOnce();
    expect(checkpoints.rowCount()).toBe(2);
  });

  it('retains a reassigned checkpoint after the current host loses its source', async () => {
    const source = definition({ automationId: 'moved-source', sourceSelectorId: sourceSelectorA });
    const row = checkpointRow({ automationId: source.automationId, sourceSelectorId: source.sourceSelectorId });
    const checkpoints = createCheckpointCollection([row]);
    const controller = new AbortController();
    let revision = '7';
    let definitions: readonly SourceDefinition[] = [source];
    let invalidate = () => {};
    const classified: unknown[] = [];
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') {
        const request = AutomationEventSourcesListInputV1Schema.parse(input);
        if (request.checkpointRetirementCandidates) {
          classified.push(request.checkpointRetirementCandidates);
          // The server knows this exact row now belongs to the new watcher.
          return { kind: 'unchanged', revision, checkpointRetirements: [] };
        }
        return sourceListResult(input, revision, definitions);
      }
      if (action === 'automation.event.source.status.report') return {};
      throw new Error(`Unexpected Action ${action}`);
    }) };
    const events = { host: { subscribe: (_target: unknown, listener: SourcesInvalidatedListener) => {
      invalidate = () => listener(sourcesInvalidated()); return { dispose() {} };
    } } };
    const http = { request: vi.fn(async () => ({ status: 304, headers: {}, body: new Uint8Array() })) };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000,
      sleep: async (_delay, signal) => { await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), { once: true });
        if (signal.aborted) resolve();
      }); },
    });
    const context = sourceAttemptContext(observer, observerBackgroundContext({ actions, events,
      collection: checkpoints.collection, http, signal: controller.signal }));
    const running = observer.run(context);
    try {
      await vi.waitFor(() => expect(checkpoints.put).toHaveBeenCalledTimes(1));
      revision = '8'; definitions = []; invalidate();
      await vi.waitFor(() => expect(classified).toEqual([[checkpointRetirementCandidate(row)]]));
      expect(checkpoints.query).toHaveBeenCalledTimes(2);
      expect(checkpoints.delete).not.toHaveBeenCalled();
      expect(checkpoints.read(row.id)).toMatchObject({ revision: 2 });
      expect(http.request).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      await running;
    }
  });

  it('settles sibling checkpoint effects before finishing a finite Action with a failed row', async () => {
    const first = definition({ automationId: 'failed-attempt', sourceSelectorId: sourceSelectorA });
    const sibling = definition({ automationId: 'pending-attempt', sourceSelectorId: sourceSelectorB });
    let release!: () => void;
    const pendingWrite = new Promise<void>(resolve => { release = resolve; });
    const checkpoints = createCheckpointCollection([], { beforePut: async row => {
      if (row[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.automationId] === first.automationId) throw new Error('Checkpoint write unavailable');
      await pendingWrite;
    } });
    const http = { request: vi.fn(async () => ({ status: 200, headers: {}, body: new TextEncoder().encode('[]') })) };
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return sourceListResult(input, '7', [first, sibling]);
      if (action === 'automation.event.source.status.report') return {};
      throw new Error(`Unexpected Action ${action}`);
    }) };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    const context = sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection, http }));
    let settled = false;
    const cycle = observer.runCycle(context).then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(checkpoints.put).toHaveBeenCalledTimes(2));
      expect(settled).toBe(false);
    } finally {
      release();
      await cycle;
    }
    expect(checkpoints.rowCount()).toBe(1);
    expect(checkpoints.read(createGithubAutomationEventCheckpointRowId({ automationId: sibling.automationId,
      sourceSelectorId: sibling.sourceSelectorId }))).not.toBeNull();
  });

  it('keeps a long user interval asleep across the JavaScript timer range', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const base = definition({ automationId: 'long-deployment-poll', sourceSelectorId: sourceSelectorA, eventLocalId: 'automation/deployment-review-v1' });
    const source = { ...base, sourceInstanceId: 'github:repository:77:deployment-review', sourceConfig: {
      ...base.sourceConfig as Readonly<Record<string, JsonValue>>, deploymentReview: { monitoringMachineId: 'machine-1', deliveryMode: 'polling', pollingIntervalMs: 3000000000 },
    } };
    const checkpoints = createCheckpointCollection([]);
    const http = { request: vi.fn(async () => ({ status: 200, headers: { 'x-poll-interval': '3000000' },
      body: new TextEncoder().encode(JSON.stringify({ total_count: 0, workflow_runs: [] })) })) };
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return input && typeof input === 'object' && 'knownRevision' in input
        ? { kind: 'unchanged', revision: '7' } : { kind: 'page', revision: '7', definitions: [source], nextCursor: null };
      if (action === 'automation.event.source.status.report') return {};
      throw new Error(`Unexpected Action ${action}`);
    }) };
    const manifest = { contributes: { ui: { views: [{ id: 'deployment-review', container: 'appPage', target: { kind: 'app' }, renderer: 'review', title: 'Deployment review' }],
      renderers: [{ id: 'review', kind: 'reactNative', artifact: 'github-forge-native' }] } } } as const;
    const observer = createGithubAutomationEventCheckpointedPullObserver({ manifest });
    const context = sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection, http, signal: controller.signal }));
    const running = observer.run(context);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(http.request).toHaveBeenCalledTimes(1);
      const catalogReads = actions.execute.mock.calls.filter(([action]) => action === 'automation.event.sources.list').length;
      await vi.advanceTimersByTimeAsync(100);
      expect(http.request).toHaveBeenCalledTimes(1);
      expect(actions.execute.mock.calls.filter(([action]) => action === 'automation.event.sources.list')).toHaveLength(catalogReads);
      await vi.advanceTimersByTimeAsync(2_147_483_647);
      expect(http.request).toHaveBeenCalledTimes(1);
      expect(actions.execute.mock.calls.filter(([action]) => action === 'automation.event.sources.list')).toHaveLength(catalogReads);
    } finally { controller.abort(); await running; vi.useRealTimers(); }
  });
  it.each([
    { credentialKind: 'account', retireDuringRead: false },
    { credentialKind: 'native', retireDuringRead: false },
    { credentialKind: 'account', retireDuringRead: true },
  ] as const)('feeds verified deployment webhooks through activated exact-run reconciliation with $credentialKind credentials over durablePush; retiring target: $retireDuringRead', async ({ credentialKind, retireDuringRead }) => {
    const base = durableDeploymentDefinition('webhook-notices');
    const source = { ...base, sourceConfig: { ...base.sourceConfig as Readonly<Record<string, JsonValue>>,
      credentialRef: credentialKind === 'native' ? null : credentialRef } };
    let enrolled = true;
    let resolved = false;
    let denied = false;
    let targetCurrent = true;
    let invalidate = () => {};
    const checkpoints = createCheckpointCollection([]);
    const send = vi.fn(async (_request: Parameters<PluginInvocationContext['services']['notifications']['send']>[0]) => ({ deliveries: [], replayed: false }));
    const transport = createStubGithubTransport({
      binding: credentialKind === 'native' ? null : { purpose: 'github-api', account: credentialRef },
      nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: 'Bearer exact-source-token' } },
      respond: request => {
      if (request.url.endsWith('/pending_deployments')) {
        if (retireDuringRead) targetCurrent = false;
        return { status: denied ? 403 : 200, body: denied ? { message: 'Forbidden' } : resolved ? []
          : [{ environment: { id: 42, name: 'production' }, current_user_can_approve: true, wait_timer: 0, wait_timer_started_at: null, reviewers: [] }] };
      }
      if (request.url.endsWith('/runs/81')) return { status: 200, body: { id: 81, run_attempt: 2, repository: { id: 77 } } };
      throw new Error(`Unexpected GitHub read ${request.url}`);
    } });
    const testkit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount } });
    const controller = new AbortController();
    let running: Promise<void> | void = undefined;
    try {
    const handler = testkit.registration('actions', 'github/accept-webhook');
    const runBackground = testkit.registration('backgroundServices', GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID);
    const runAttempt = testkit.registration('actions', GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID);
    if (!handler || !runBackground || !runAttempt) throw new Error('GitHub monitoring registration is missing');
    const attemptDeclaration = (PLUGIN_MANIFEST.contributes.actions ?? []).find(action => action.id === GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID);
    if (!attemptDeclaration?.inputSchema) throw new Error('GitHub source attempt declaration is missing');
    const validateAttemptInput = compilePluginJsonSchema(attemptDeclaration.inputSchema);
    const actions = { execute: vi.fn(async (action: unknown, input: unknown): Promise<unknown> => {
      if (action === 'automation.event.sources.list') {
        const request = AutomationEventSourcesListInputV1Schema.parse(input);
        // Endpoint placement can change without a Definition revision. The
        // real adopted-source owner then returns new membership, not unchanged.
        if (!targetCurrent && request.transport.kind === 'durablePush') {
          return { kind: 'page', revision: '7', definitions: [], nextCursor: null };
        }
        return sourceListResult(input, enrolled ? '7' : '8', enrolled ? [source] : []);
      }
      if (action === 'plugin.webhook.endpoint.checkCorrespondence') return PluginWebhookEndpointCheckCorrespondenceResultV1Schema.parse({
        kind: 'ready', webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw', revision: 1, readiness: 'ready',
        contribution: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-events' }, targetMaterialization: watcherMaterializationRef,
        sourceInstanceId: source.sourceInstanceId });
      if (action === 'automation.event.source.status.report') return {};
      throw new Error(`Unexpected Action ${String(action)}`);
    }) };
    // Only genuine host boundaries are replaced: HTTP, Collection CAS and Action transport.
    const background = sourceAttemptContext({ runSourceAttempt: async (input, context) => {
      const result = await runAttempt(PluginJsonValueV2Schema.parse(input), context);
      if (result === undefined) throw new Error('GitHub source attempt returned no result');
      return result;
    } },
      observerBackgroundContext({ actions, collection: checkpoints.collection,
        http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
        notifications: { send }, signal: controller.signal,
        events: { host: { subscribe: (_target: unknown, listener: SourcesInvalidatedListener) => {
          invalidate = () => listener(sourcesInvalidated());
          return { dispose() {} };
        } } } }),
      async input => { expect(validateAttemptInput(input)).toBe(true); });
    const context = { ...background, surface: 'plugin', invokedAtMs: 1, caller: { kind: 'host', domain: 'ingress', originSurface: 'webhook',
      contribution: { id: 'github-events', qualifiedId: `${GITHUB_PLUGIN_ID}/github-events` } } } as PluginInvocationContext;
    const deliver = (eventType: string, action: string) => {
      const rawBody = new TextEncoder().encode(JSON.stringify({ action, repository: { id: 77, full_name: 'acme/widgets' }, workflow_run: { id: 81 } }));
      return handler({ v: 1, endpoint: { webhookContribution: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-events' }, sourceInstanceId: source.sourceInstanceId },
        delivery: { deliveryId: 'delivery-1', attempt: 1, replay: 0, receivedAtMs: 1, providerDeliveryId: 'provider-1' },
        request: { contentType: 'application/json', headers: [{ name: 'x-github-event', value: eventType }], rawBodyBytes: rawBody.length, rawBodyBase64: Buffer.from(rawBody).toString('base64') },
        verified: { verifier: 'github_hmac_sha256_v1', eventType } }, context);
    };
    running = runBackground(background);
    const delivered = await deliver('deployment_review', 'requested');
    if (retireDuringRead) {
      // Retirement during the admitted finite read applies to the next
      // observation; the current notice and cursor still settle together.
      expect(delivered).toEqual({ kind: 'settled', disposition: 'accepted' });
      expect(send).toHaveBeenCalledTimes(1);
      const rowId = createGithubAutomationEventCheckpointRowId({
        automationId: source.automationId, sourceSelectorId: source.sourceSelectorId, eventRef: source.eventRef,
      });
      const committedCheckpoint = checkpoints.read(rowId);
      expect(committedCheckpoint).not.toBeNull();
      const providerReads = transport.requests.length;
      const checkpointWrites = checkpoints.put.mock.calls.length;
      invalidate();
      await deliver('workflow_run', 'in_progress');
      expect(transport.requests).toHaveLength(providerReads);
      expect(send).toHaveBeenCalledTimes(1);
      expect(checkpoints.put).toHaveBeenCalledTimes(checkpointWrites);
      expect(checkpoints.read(rowId)).toEqual(committedCheckpoint);
      return;
    }
    expect(delivered).toEqual({ kind: 'settled', disposition: 'accepted' });
    expect(send).toHaveBeenCalledTimes(1);
    const id = send.mock.calls[0]?.[0].itemId;
    await deliver('workflow_run', 'in_progress');
    expect(send).toHaveBeenCalledTimes(1);
    expect(transport.requests.map(request => new URL(request.url).pathname)).toEqual([
      '/repos/acme/widgets/actions/runs/81', '/repos/acme/widgets/actions/runs/81/pending_deployments',
      '/repos/acme/widgets/actions/runs/81', '/repos/acme/widgets/actions/runs/81/pending_deployments',
    ]);
    denied = true;
    expect(await deliver('deployment_review', 'approved')).toMatchObject({ kind: 'retry' });
    expect(send).toHaveBeenCalledTimes(1);
    denied = false; resolved = true;
    await deliver('deployment_review', 'approved');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toMatchObject({ itemId: id, resolved: true });
    enrolled = false;
    invalidate();
    const reads = transport.requests.length;
    expect(await deliver('workflow_run', 'completed')).toEqual({ kind: 'settled', disposition: 'ignored' });
    expect(transport.requests).toHaveLength(reads);
    expect(actions.execute.mock.calls.some(([action]) => action === 'automation.event.admit')).toBe(false);
    } finally { controller.abort(); await running; await testkit.dispose(); }
  });
  it.each(['github:repository:77', 'github:repository:77:deployment-review'])(
    'wakes only the matching deployment source for authenticated ingress %s', async sourceInstanceId => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const source = durableDeploymentDefinition('targeted-deployment-wake');
    const unrelated = definition({ automationId: 'unrelated-repository-poll', sourceSelectorId: sourceSelectorB });
    const checkpoints = createCheckpointCollection([]);
    const http = { request: vi.fn(async (request: { url: string }) => ({ status: 200, headers: {},
      body: new TextEncoder().encode(JSON.stringify(request.url.endsWith('/pending_deployments') || request.url.includes('/events?')
        ? [] : { id: 81, run_attempt: 2, repository: { id: 77, full_name: 'acme/widgets' } })),
    })) };
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return sourceListResult(input, '7', [source, unrelated]);
      if (action === 'plugin.webhook.endpoint.checkCorrespondence') return {
        kind: 'ready', webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw', revision: 1, readiness: 'ready',
        contribution: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-events' }, targetMaterialization: watcherMaterializationRef,
        sourceInstanceId: source.sourceInstanceId,
      };
      if (action === 'automation.event.source.status.report') return {};
      throw new Error(`Unexpected Action ${action}`);
    }) };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ manifest: PLUGIN_MANIFEST });
    const context = sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection,
      http, signal: controller.signal }));
    const running = observer.run(context);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(http.request).toHaveBeenCalledTimes(1);
      const delivery = observer.receiveDeploymentWebhook({ repositoryId: '77', repositoryNameWithOwner: 'acme/widgets',
        runId: '81', sourceInstanceId }, controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(await delivery).toBe('accepted');
      expect(http.request.mock.calls.filter(([request]) => request.url.includes('/events?'))).toHaveLength(1);
      expect(http.request.mock.calls.filter(([request]) => request.url.endsWith('/runs/81'))).toHaveLength(1);
      expect(http.request.mock.calls.filter(([request]) => request.url.endsWith('/runs/81/pending_deployments'))).toHaveLength(1);
      const ignored = observer.receiveDeploymentWebhook({ repositoryId: '88', repositoryNameWithOwner: 'acme/other',
        runId: '81', sourceInstanceId: 'github:repository:88' }, controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(await ignored).toBe('ignored');
      expect(http.request).toHaveBeenCalledTimes(3);
    } finally { controller.abort(); await running; vi.useRealTimers(); }
  });

  it('shares mixed transport observations and preserves the native hard retry gate across early authenticated wakes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const controller = new AbortController();
    const durable = durableDeploymentDefinition('mixed-durable');
    const pull: SourceDefinition = { ...durable, automationId: 'mixed-pull', triggerId: 'trigger-mixed-pull',
      sourceSelectorId: sourceSelectorB, observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef } };
    const checkpoints = createCheckpointCollection([]);
    let routeReady = false;
    let rateLimited = false;
    const send = vi.fn(async () => ({ deliveries: [], replayed: false }));
    const http = { request: vi.fn(async (request: { url: string; headers?: Readonly<Record<string, string>> }) => {
      if (rateLimited) return { status: 429, headers: { 'retry-after': '120' }, body: new Uint8Array() };
      const census = request.url.includes('?');
      const unchanged = census && request.headers?.['If-None-Match'] === 'mixed-waiting';
      return { status: unchanged ? 304 : 200, headers: census ? { etag: 'mixed-waiting', 'x-poll-interval': '60' } : {},
        body: unchanged ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(census
          ? { total_count: 1, workflow_runs: [{ id: 81, run_attempt: 2 }] }
          : request.url.endsWith('/pending_deployments') ? [{ environment: { id: 42, name: 'production' }, current_user_can_approve: true }]
            : { id: 81, run_attempt: 2, repository: { id: 77, full_name: 'acme/widgets' } })),
      };
    }) };
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return sourceListResult(input, '7', [durable, pull]);
      if (action === 'plugin.webhook.endpoint.checkCorrespondence') return {
        kind: 'ready', webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw', revision: 1,
        readiness: routeReady ? 'ready' : 'providerConfirmationRequired',
        contribution: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-events' }, targetMaterialization: watcherMaterializationRef,
        sourceInstanceId: durable.sourceInstanceId,
      };
      if (action === 'automation.event.source.status.report') return {};
      throw new Error(`Unexpected Action ${action}`);
    }) };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ manifest: PLUGIN_MANIFEST });
    const context = sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection,
      http, notifications: { send }, signal: controller.signal }));
    const running = observer.run(context);
    const wake = () => observer.receiveDeploymentWebhook({ repositoryId: '77', repositoryNameWithOwner: 'acme/widgets',
      runId: '81', sourceInstanceId: durable.sourceInstanceId }, controller.signal);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(http.request).toHaveBeenCalledTimes(3);
      expect(send).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10_000);
      routeReady = true;
      const early = wake();
      await vi.advanceTimersByTimeAsync(0);
      expect(await early).toBe('accepted');
      expect(http.request).toHaveBeenCalledTimes(5);
      expect(send).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10_000);
      rateLimited = true;
      const limited = expect(wake()).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      await limited;
      expect(http.request).toHaveBeenCalledTimes(6);
      rateLimited = false;
      const blocked = expect(wake()).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      await blocked;
      expect(http.request).toHaveBeenCalledTimes(6);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(http.request).toHaveBeenCalledTimes(6);
      await vi.advanceTimersByTimeAsync(1);
      expect(http.request).toHaveBeenCalledTimes(7);
      expect(http.request.mock.calls.at(-1)?.[0].headers?.['If-None-Match']).toBe('mixed-waiting');
      await vi.advanceTimersByTimeAsync(59_999);
      expect(http.request).toHaveBeenCalledTimes(7);
      await vi.advanceTimersByTimeAsync(1);
      expect(http.request).toHaveBeenCalledTimes(8);
      expect(send).toHaveBeenCalledTimes(2);
    } finally { controller.abort(); await running; vi.useRealTimers(); }
  });

  it('uses the latest completed observation deadline when concurrent ingress deliveries share a finite cycle', async () => {
    const controller = new AbortController();
    const durable = durableDeploymentDefinition('concurrent-delivery-durable');
    const pull: SourceDefinition = { ...durable, automationId: 'concurrent-delivery-pull', triggerId: 'trigger-concurrent-delivery-pull',
      sourceSelectorId: sourceSelectorB, observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef } };
    const checkpoints = createCheckpointCollection([]);
    let now = 2_000;
    let delivering = false;
    const delays: number[] = [];
    const http = { request: vi.fn(async (request: { url: string }) => {
      const census = request.url.includes('?');
      const runId = census ? 81 : Number(/\/runs\/([0-9]+)/u.exec(request.url)?.[1]);
      if (delivering && request.url.endsWith('/pending_deployments')) now = runId === 81 ? 3_000 : 12_000;
      return { status: 200, headers: census ? { etag: 'concurrent-waiting', 'x-poll-interval': '60' } : {},
        body: new TextEncoder().encode(JSON.stringify(census ? { total_count: 1, workflow_runs: [{ id: 81, run_attempt: 2 }] }
          : request.url.endsWith('/pending_deployments') ? runId === 81
            ? [{ environment: { id: 42, name: 'production' }, current_user_can_approve: true }] : []
            : { id: runId, run_attempt: 2, repository: { id: 77, full_name: 'acme/widgets' } })),
      };
    }) };
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return sourceListResult(input, '7', [durable, pull]);
      if (action === 'plugin.webhook.endpoint.checkCorrespondence') return {
        kind: 'ready', webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw', revision: 1,
        readiness: delivering ? 'ready' : 'providerConfirmationRequired',
        contribution: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-events' }, targetMaterialization: watcherMaterializationRef,
        sourceInstanceId: durable.sourceInstanceId,
      };
      if (action === 'automation.event.source.status.report') return {};
      throw new Error(`Unexpected Action ${action}`);
    }) };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ manifest: PLUGIN_MANIFEST, now: () => now,
      sleep: async (delay, signal) => { delays.push(delay); await new Promise<void>(resolve => {
        signal.addEventListener('abort', () => resolve(), { once: true }); if (signal.aborted) resolve();
      }); },
    });
    const context = sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection, http,
      notifications: { send: vi.fn(async () => ({ deliveries: [], replayed: false })) }, signal: controller.signal }));
    const running = observer.run(context);
    try {
      await vi.waitFor(() => expect(delays).toEqual([60_000]));
      delivering = true;
      const receive = (runId: string) => observer.receiveDeploymentWebhook({ repositoryId: '77', repositoryNameWithOwner: 'acme/widgets',
        sourceInstanceId: durable.sourceInstanceId, runId }, controller.signal);
      expect(await Promise.all([receive('81'), receive('82')])).toEqual(['accepted', 'accepted']);
      await vi.waitFor(() => expect(delays).toHaveLength(2));
      expect(http.request).toHaveBeenCalledTimes(7);
      expect(delays[1]).toBe(60_000);
    } finally { controller.abort(); await running; }
  });

  it.each(['automatic', 'webhook'] as const)('parks %s deployment monitoring without a poll timer for a verified Home route', async deliveryMode => {
    vi.useFakeTimers();
    const source = durableDeploymentDefinition('webhook-deployments', deliveryMode);
    const checkpoints = createCheckpointCollection([]);
    const http = { request: vi.fn() };
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return sourceListResult(input, '7', [source]);
      if (action === 'plugin.webhook.endpoint.checkCorrespondence') {
        expect(PluginWebhookEndpointCheckCorrespondenceInputV1Schema.parse(input)).toEqual({
          webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
          webhookContribution: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-events' },
          targetMaterialization: watcherMaterializationRef, sourceInstanceId: source.sourceInstanceId,
          setup: { kind: 'accountEndpointV1', credential: 'serverGenerated' },
        });
        return { kind: 'ready', webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw', revision: 1, readiness: 'ready',
          contribution: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-events' }, targetMaterialization: watcherMaterializationRef,
          sourceInstanceId: source.sourceInstanceId };
      }
      if (action === 'automation.event.source.status.report') return {};
      throw new Error(`Unexpected Action ${action}`);
    }) };
    const sleep = vi.fn(async (_delay: number, signal: AbortSignal) => { if (!signal.aborted) throw new Error('Webhook monitoring scheduled a timer'); });
    const observer = createGithubAutomationEventCheckpointedPullObserver({ sleep, manifest: PLUGIN_MANIFEST });
    const context = sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection, http }));
    const controller = new AbortController();
    const running = observer.run({ ...context, signal: controller.signal });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(http.request).not.toHaveBeenCalled();
      expect(checkpoints.put).not.toHaveBeenCalled();
      expect(actions.execute.mock.calls.filter(([action]) => action === 'plugin.webhook.endpoint.checkCorrespondence')).toHaveLength(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { controller.abort(); await running; vi.useRealTimers(); }
  });

  it.each(['legacy', 'unconfirmed', 'missingBinding', 'wrongContribution', 'wrongSource', 'wrongTarget', 'revokedBinding'] as const)('moves automatic monitoring from %s correspondence to verified push and back on invalidation, then stops when paused', async initialReadiness => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const source = durableDeploymentDefinition('automatic-transition');
    let routeReady = false;
    let routeRevoked = false;
    let enrolled = true;
    let invalidate: (() => void) | undefined;
    const checkpoints = createCheckpointCollection([]);
    const http = { request: vi.fn(async (request: { url: string; headers?: Readonly<Record<string, string>> }) => ({
      status: request.headers?.['If-None-Match'] === 'waiting-empty' ? 304 : 200,
      headers: { etag: 'waiting-empty', 'x-poll-interval': '120' },
      body: new TextEncoder().encode(JSON.stringify({ total_count: 0, workflow_runs: [] })),
    })) };
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      const revision = enrolled ? '7' : '8';
      if (action === 'automation.event.sources.list') return sourceListResult(input, revision, enrolled ? [source] : []);
      if (action === 'plugin.webhook.endpoint.checkCorrespondence') return PluginWebhookEndpointCheckCorrespondenceResultV1Schema.parse(routeRevoked
        ? { kind: 'unavailable', code: 'endpoint_unavailable' }
        : { kind: 'ready', webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw', revision: 1,
          ...(initialReadiness === 'missingBinding' && !routeReady ? {} : {
            contribution: { pluginId: GITHUB_PLUGIN_ID, localId: initialReadiness === 'wrongContribution' && !routeReady ? 'other' : 'github-events' },
            targetMaterialization: initialReadiness === 'wrongTarget' && !routeReady
              ? { ...watcherMaterializationRef, materializationId: 'other' } : watcherMaterializationRef,
            sourceInstanceId: initialReadiness === 'wrongSource' && !routeReady ? 'other' : source.sourceInstanceId,
          }),
          ...(initialReadiness === 'revokedBinding' && !routeReady ? { revokedAt: 1 } : {}),
          ...(routeReady ? { readiness: 'ready' } : initialReadiness === 'legacy' ? {}
            : { readiness: initialReadiness === 'unconfirmed' ? 'providerConfirmationRequired' : 'ready' }) });
      if (action === 'automation.event.source.status.report') return {};
      throw new Error(`Unexpected Action ${action}`);
    }) };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ manifest: PLUGIN_MANIFEST });
    const context = sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection,
      http, signal: controller.signal, events: { host: { subscribe: (_target: unknown, listener: SourcesInvalidatedListener) => {
        invalidate = () => listener(sourcesInvalidated());
        return { dispose() {} };
      } } },
    }));
    const running = observer.run(context);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(http.request).toHaveBeenCalledTimes(1);
      const checkpointWrites = checkpoints.put.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120000);
      expect(http.request).toHaveBeenCalledTimes(2);
      expect(http.request.mock.calls[1]?.[0].headers?.['If-None-Match']).toBe('waiting-empty');
      if (!invalidate) throw new Error('The source invalidation subscription is missing');
      const checkpointReads = vi.mocked(checkpoints.collection.get).mock.calls.length;
      routeReady = true; invalidate();
      await vi.advanceTimersByTimeAsync(0);
      expect(http.request).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(119999);
      expect(http.request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(checkpoints.collection.get).toHaveBeenCalledTimes(checkpointReads);
      await vi.advanceTimersByTimeAsync(300000);
      expect(http.request).toHaveBeenCalledTimes(2);
      routeReady = false; routeRevoked = true; invalidate();
      await vi.advanceTimersByTimeAsync(0);
      expect(http.request).toHaveBeenCalledTimes(3);
      expect(http.request.mock.calls[2]?.[0].headers?.['If-None-Match']).toBe('waiting-empty');
      expect(http.request.mock.calls.every(([request]) => new URL(request.url).pathname.endsWith('/actions/runs'))).toBe(true);
      enrolled = false; invalidate();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(300000);
      expect(http.request).toHaveBeenCalledTimes(3);
      expect(checkpoints.put).toHaveBeenCalledTimes(checkpointWrites);
    } finally { controller.abort(); await running; vi.useRealTimers(); }
  });

  it.each([{ userInterval: 180000, floorSeconds: 120, early: 120000, remaining: 60000 },
    { userInterval: 60000, floorSeconds: 120, early: 60000, remaining: 60000 },
    { userInterval: 2 * 86400000, floorSeconds: 3 * 86400, early: 2 * 86400000, remaining: 86400000 }])(
    'uses the enrollment polling interval $userInterval with provider floor $floorSeconds and bypasses webhooks in polling mode', async ({ userInterval, floorSeconds, early, remaining }) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const base = definition({ automationId: 'polling-deployments', sourceSelectorId: sourceSelectorA, eventLocalId: 'automation/deployment-review-v1' });
    const source = { ...base, sourceInstanceId: 'github:repository:77:deployment-review', sourceConfig: {
      ...base.sourceConfig as Readonly<Record<string, JsonValue>>, deploymentReview: { monitoringMachineId: 'machine-1', deliveryMode: 'polling', pollingIntervalMs: userInterval },
    } };
    const checkpoints = createCheckpointCollection([]);
    const http = { request: vi.fn(async (request: { headers?: Readonly<Record<string, string>> }) => ({
      status: request.headers?.['If-None-Match'] ? 304 : 200, headers: { etag: 'waiting-empty', 'x-poll-interval': String(floorSeconds) },
      body: new TextEncoder().encode(JSON.stringify({ total_count: 0, workflow_runs: [] })),
    })) };
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return input && typeof input === 'object' && 'knownRevision' in input
        ? { kind: 'unchanged', revision: '7' } : { kind: 'page', revision: '7', definitions: [source], nextCursor: null };
      if (action === 'automation.event.source.status.report') return {};
      throw new Error(`Unexpected Action ${action}`);
    }) };
    let now = 2000;
    const manifest = { contributes: { ui: { views: [{ id: 'deployment-review', container: 'appPage', target: { kind: 'app' }, renderer: 'review', title: 'Deployment review' }],
      renderers: [{ id: 'review', kind: 'reactNative', artifact: 'github-forge-native' }] } } } as const;
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => now, manifest });
    const context = sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection, http,
      signal: controller.signal, notifications: { send: vi.fn() } }));
    const running = observer.run(context);
    try {
      await vi.advanceTimersByTimeAsync(0);
      now += early; await vi.advanceTimersByTimeAsync(early);
      expect(http.request).toHaveBeenCalledTimes(1);
      now += remaining; await vi.advanceTimersByTimeAsync(remaining);
      expect(http.request).toHaveBeenCalledTimes(2);
      expect(http.request.mock.calls[1]?.[0].headers?.['If-None-Match']).toBe('waiting-empty');
    } finally { controller.abort(); await running; vi.useRealTimers(); }
  });
  it('shares one deployment census across fresh and retained subscribers without inheriting their pending facts', async () => {
    const base = definition({ automationId: 'retained-deployment', sourceSelectorId: sourceSelectorA,
      eventLocalId: 'automation/deployment-review-v1' });
    const retained: SourceDefinition = { ...base, observationOnly: { kind: 'observationOnly' },
      sourceInstanceId: 'github:repository:77:deployment-review', sourceConfig: {
        ...base.sourceConfig as Readonly<Record<string, JsonValue>>, deploymentReview: { monitoringMachineId: 'machine-1', deliveryMode: 'polling' },
      } };
    const fresh = { ...retained, automationId: 'fresh-deployment', triggerId: 'trigger-fresh-deployment', sourceSelectorId: sourceSelectorB };
    const row = checkpointRow({ automationId: retained.automationId, sourceSelectorId: retained.sourceSelectorId,
      eventLocalId: 'automation/deployment-review-v1', sourceInstanceId: retained.sourceInstanceId });
    const pending = [{ repositoryId: '77', runId: '81', attempt: '2', environmentId: '42', environmentName: 'production', eligible: true }];
    const newPending = { repositoryId: '77', runId: '82', attempt: '2', environmentId: '43', environmentName: 'staging', eligible: true };
    const checkpoints = createCheckpointCollection([{ ...row, payload: { ...row.payload,
      cursor: { kind: 'deploymentReview', v: 1, pending, waitingPages: [{
        url: 'https://api.github.com/repos/acme/widgets/actions/runs?status=waiting&per_page=100',
        etag: 'retained-etag', totalCount: 1, runs: [{ runId: '81', attempt: '2' }], nextUrl: null,
      }] }, continuity: { kind: 'deploymentReview', v: 1, repositoryId: '77' },
    } }]);
    const send = vi.fn(async () => ({ deliveries: [], replayed: false }));
    const http = { request: vi.fn(async (request: { url: string; headers?: Readonly<Record<string, string>> }) => {
      const runId = request.url.includes('?') ? 82 : Number(/\/runs\/([0-9]+)/u.exec(request.url)?.[1]);
      return { status: 200,
      headers: request.url.includes('?') ? { etag: 'current-etag' } : {},
      body: new TextEncoder().encode(JSON.stringify(request.url.includes('?')
        ? { total_count: 1, workflow_runs: [{ id: runId, run_attempt: 2 }] }
        : request.url.endsWith('/pending_deployments') ? [{ environment: { id: runId === 81 ? 42 : 43,
          name: runId === 81 ? 'production' : 'staging' }, current_user_can_approve: true }]
          : { id: runId, run_attempt: 2, repository: { id: 77, full_name: 'acme/widgets' } })),
    }; }) };
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return sourceListResult(input, '7', [retained, fresh]);
      if (action === 'automation.event.source.status.report') return {};
      throw new Error(`Unexpected Action ${action}`);
    }) };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000, manifest: PLUGIN_MANIFEST });
    await observer.runCycle(sourceAttemptContext(observer, observerBackgroundContext({ actions,
      collection: checkpoints.collection, http, notifications: { send } })));

    expect(http.request.mock.calls.filter(([request]) => request.url.includes('?'))).toHaveLength(1);
    expect(http.request.mock.calls[0]?.[0].headers?.['If-None-Match']).toBeUndefined();
    expect(http.request).toHaveBeenCalledTimes(5);
    expect(send).toHaveBeenCalledTimes(2);
    expect(checkpoints.rowCount()).toBe(2);
    expect(checkpoints.read(row.id)).toMatchObject({ value: { payload: { cursor: { pending: [...pending, newPending] } } } });
    expect(checkpoints.read(createGithubAutomationEventCheckpointRowId({ automationId: fresh.automationId,
      eventRef: fresh.eventRef, sourceSelectorId: fresh.sourceSelectorId }))).toMatchObject({ value: { payload: { cursor: { pending: [newPending] } } } });
  });

  it('does not resolve a still-pending run outside the waiting list when another candidate arrives', async () => {
    const base = definition({ automationId: 'deployment-lingering', sourceSelectorId: sourceSelectorA,
      eventLocalId: 'automation/deployment-review-v1' });
    const source = parseGithubDeploymentMonitoringSourceConfig({ ...base.sourceConfig as Readonly<Record<string, JsonValue>>,
      deploymentReview: { monitoringMachineId: 'machine-1' } });
    let phase: 'waiting' | 'absent' | 'other' = 'waiting';
    const transport = createStubGithubTransport({ nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: 'Bearer synthetic' } },
      respond: request => {
        if (request.url.includes('?')) return { status: 200, headers: { etag: phase },
          body: { total_count: phase === 'absent' ? 0 : 1, workflow_runs: phase === 'absent' ? [] : [{ id: phase === 'waiting' ? 81 : 82, run_attempt: 2 }] } };
        if (request.url.endsWith('/pending_deployments')) return { status: 200, body: request.url.includes('/runs/81/')
          ? [{ environment: { id: 42, name: 'production' }, current_user_can_approve: true }] : [] };
        return { status: 200, body: { id: Number(request.url.split('/').at(-1)), run_attempt: 2, repository: { id: 77 } } };
      } });
    const first = await observeGithubDeploymentReviewsV1({ source, previous: null }, transport.context);
    phase = 'absent';
    const absent = await observeGithubDeploymentReviewsV1({ source, previous: first.cursor }, transport.context);
    expect(absent.cursor.pending).toHaveLength(1);
    phase = 'other';
    const requestCount = transport.requests.length;
    const other = await observeGithubDeploymentReviewsV1({ source, previous: absent.cursor }, transport.context);
    expect(other.cursor.pending).toEqual(absent.cursor.pending);
    expect(transport.requests.slice(requestCount).some(request => request.url.endsWith('/runs/81/pending_deployments'))).toBe(true);
  });
  it.each([{ unchangedResponse: '304', pageCount: 1, etags: true }, { unchangedResponse: 'identical200', pageCount: 1, etags: true },
    { unchangedResponse: 'identical200', pageCount: 1, etags: false },
    { unchangedResponse: '304', pageCount: 2, etags: true }] as const)('observes only the enrolled deployment Machine with zero downstream work on $unchangedResponse/$pageCount pages/etags=$etags', async ({ unchangedResponse, pageCount, etags }) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let invalidate = () => {};
    let revision = '7';
    const base = definition({ automationId: 'deployments', sourceSelectorId: sourceSelectorA,
      eventLocalId: 'automation/deployment-review-v1' });
    const source: SourceDefinition = { ...base, sourceInstanceId: 'github:repository:77:deployment-review',
      sourceConfig: { ...base.sourceConfig as Readonly<Record<string, JsonValue>>, deploymentReview: { monitoringMachineId: 'machine-1' } } };
    let currentSource: SourceDefinition = source;
    const checkpoints = createCheckpointCollection([]);
    const send = vi.fn(async (_request: Parameters<PluginInvocationContext['services']['notifications']['send']>[0]) => ({ deliveries: [], replayed: false }));
    let pendingState: 'pending' | 'denied' | 'resolved' = 'pending';
    const http = { request: vi.fn(async (request: { url: string; headers?: Readonly<Record<string, string>> }) => {
      const list = request.url.includes('?');
      const page = new URL(request.url).searchParams.get('page') === '2' ? 2 : 1;
      const runId = list ? 80 + page : Number(/\/runs\/([0-9]+)/u.exec(request.url)?.[1]);
      const listState = pageCount === 2 && page === 1 && pendingState === 'denied' ? 'pending' : pendingState;
      const etag = `waiting-${listState}-${page}`;
      const unchanged = list && request.headers?.['If-None-Match'] === etag && unchangedResponse === '304';
      return { status: unchanged ? 304 : request.url.includes('/pending_deployments') && pendingState === 'denied' ? 403 : 200,
        headers: list ? { ...(etags ? { etag } : {}), 'x-poll-interval': '120',
          ...(page < pageCount && pendingState !== 'resolved' ? { link: `<${request.url}&page=2>; rel="next"` } : {}) } : {}, body: unchanged ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(
          request.url.includes('/pending_deployments') ? pendingState === 'denied' ? { message: 'Resource not accessible by personal access token' } : pendingState === 'resolved' ? [] : [{ environment: { id: 42, name: 'production' }, current_user_can_approve: true, wait_timer: 0, wait_timer_started_at: null, reviewers: [] }]
            : list ? { total_count: pendingState === 'resolved' ? 0 : pageCount, workflow_runs: pendingState === 'resolved' ? [] : [{ id: runId, run_attempt: 2, updated_at: listState === 'pending' ? '2026-10-25T10:00:00Z' : '2026-10-25T10:01:00Z' }] }
              : { id: runId, run_attempt: 2, repository: { id: 77, full_name: 'acme/widgets' } },
        )) };
    }) };
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return sourceListResult(input, revision, [currentSource]);
      if (action === 'automation.event.source.status.report') return {};
      if (action === 'automation.event.admit') return { results: [{ kind: 'admitted', runId: 'run-github-observation', checkpointSafe: true }] };
      throw new Error(`Unexpected Action ${action}`);
    }) };
    const manifest = { id: GITHUB_PLUGIN_ID, contributes: { ui: {
      views: [{ id: 'deployment-review', container: 'appPage', target: { kind: 'app' }, renderer: 'review', title: 'Deployment review' }],
      renderers: [{ id: 'review', kind: 'reactNative', artifact: 'github-forge-native' }],
    } } } as const;
    // This is declaration metadata supplied by the host, not a mocked internal
    // renderer. Loaded composition belongs to the shared UI integration gate.
    const observer = createGithubAutomationEventCheckpointedPullObserver({ manifest });
    const context = sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection,
      http: createPluginHttpFixture({ request: http.request }), notifications: { send }, signal: controller.signal,
      events: { host: { subscribe: (_target: unknown, listener: SourcesInvalidatedListener) => { invalidate = () => listener(sourcesInvalidated()); return { dispose() {} }; } } },
    }));
    const running = observer.run(context);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(pageCount);
      const puts = checkpoints.put.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(http.request).toHaveBeenCalledTimes(3 * pageCount);
      for (let repeat = 0; repeat < 4; repeat++) await vi.advanceTimersByTimeAsync(repeat === 0 ? 60_000 : 120_000);
      expect(send).toHaveBeenCalledTimes(pageCount);
      expect(checkpoints.put).toHaveBeenCalledTimes(puts);
      expect(http.request).toHaveBeenCalledTimes(7 * pageCount);
      for (const [request] of http.request.mock.calls.slice(3 * pageCount)) {
        if (etags) expect(request.headers?.['If-None-Match']).toMatch(/^waiting-pending-[12]$/u);
        else expect(request.headers?.['If-None-Match']).toBeUndefined();
      }
      pendingState = 'denied';
      const beforeDenied = http.request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      if (pageCount === 2) expect(http.request.mock.calls.slice(beforeDenied).some(([request]) => /\/runs\/81(?:\/|$)/u.test(request.url))).toBe(false);
      expect(send).toHaveBeenCalledTimes(pageCount);
      expect(checkpoints.put).toHaveBeenCalledTimes(puts);
      pendingState = 'resolved';
      await vi.advanceTimersByTimeAsync(60_000);
      expect(send).toHaveBeenCalledTimes(2 * pageCount);
      expect(send.mock.calls[pageCount]?.[0]).toMatchObject({ resolved: true });
      currentSource = { ...source, sourceConfig: { ...source.sourceConfig as Readonly<Record<string, JsonValue>>,
        deploymentReview: { monitoringMachineId: 'machine-2' } } };
      revision = '8'; invalidate();
      const beforeForeign = http.request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(http.request).toHaveBeenCalledTimes(beforeForeign);
      expect(send).toHaveBeenCalledTimes(2 * pageCount);
    } finally { controller.abort(); await running; vi.useRealTimers(); }
  });

  it('rejoins immutable deployment occurrence evidence after notification failure and observer recreation', async () => {
    const base = definition({ automationId: 'deployments-retry', sourceSelectorId: sourceSelectorA,
      eventLocalId: 'automation/deployment-review-v1' });
    const source: SourceDefinition = { ...base, sourceInstanceId: 'github:repository:77:deployment-review',
      sourceConfig: { ...base.sourceConfig as Readonly<Record<string, JsonValue>>, deploymentReview: { monitoringMachineId: 'machine-1' } } };
    const checkpoints = createCheckpointCollection([]);
    const admitted = new Map<string, string>();
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return input && typeof input === 'object' && 'knownRevision' in input
        ? { kind: 'unchanged', revision: '7' } : { kind: 'page', revision: '7', definitions: [source], nextCursor: null };
      if (action === 'automation.event.source.status.report') return {};
      if (action !== 'automation.event.admit') throw new Error(`Unexpected Action ${action}`);
      // The host transport is a genuine boundary. Use its real evidence/key/
      // equality owners rather than accepting every synthetic retry body.
      const request = AutomationEventAdmitInputV1Schema.parse(input);
      const evidence = buildAutomationPluginEventOccurrenceEvidenceV1({ eventRef: request.eventRef,
        sourceSelectorId: source.sourceSelectorId, occurrenceId: request.occurrenceId,
        occurredAt: request.occurredAt, payload: request.payload });
      const key = deriveAutomationOccurrenceKeyV1({ triggerId: source.triggerId, evidence });
      const witness = serializeAutomationOccurrenceEvidenceEqualityV1({ accountId: 'account-a', automationId: source.automationId,
        triggerId: source.triggerId, occurrenceKey: key, evidence });
      if (admitted.has(key) && admitted.get(key) !== witness) throw new Error('Automation occurrence evidence changed');
      admitted.set(key, witness);
      return { results: [{ kind: 'admitted', runId: 'run-github-observation', checkpointSafe: true }] };
    }) };
    let now = 2000;
    const pending = [{ environment: { id: 42, name: 'production' }, current_user_can_approve: true },
      { environment: { id: 43, name: 'staging' }, current_user_can_approve: true }];
    const http = createPluginHttpFixture({ request: async request => ({ status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(
      request.url.includes('/pending_deployments') ? now === 2000 ? pending : [...pending].reverse()
        : request.url.includes('?') ? { total_count: 1, workflow_runs: [{ id: 81 }] }
          : { id: 81, run_attempt: 2, repository: { id: 77, full_name: 'acme/widgets' } },
    )) }) });
    let failSend = true;
    const send = vi.fn(async (_request: Parameters<PluginInvocationContext['services']['notifications']['send']>[0]) => {
      if (failSend) { failSend = false; throw new Error('Notification transport unavailable'); }
      return { deliveries: [], replayed: false };
    });
    const manifest = { contributes: { ui: {
      views: [{ id: 'deployment-review', container: 'appPage', target: { kind: 'app' }, renderer: 'review', title: 'Deployment review' }],
      renderers: [{ id: 'review', kind: 'reactNative', artifact: 'github-forge-native' }],
    } } } as const;
    const run = async () => {
      const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => now, manifest });
      await observer.runCycle(sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection, http, notifications: { send } })));
    };
    await run();
    expect(send).toHaveBeenCalledOnce();
    expect(admitted.size).toBe(2);
    now += 60000;
    await run();
    expect(send).toHaveBeenCalledTimes(3);
    expect(new Set(send.mock.calls.map(([request]) => request.clientRequestId)).size).toBe(2);
    expect(admitted.size).toBe(2);
    expect(checkpoints.rowCount()).toBe(1);
    const puts = checkpoints.put.mock.calls.length;
    now += 60000;
    await run();
    expect(send).toHaveBeenCalledTimes(3);
    expect(checkpoints.put).toHaveBeenCalledTimes(puts);
  });

  it.each(['completed', 'failed', 'passed'] as const)('observes PR checks %s through the admitted source checkpoint', async (kind) => {
    const sha = 'a'.repeat(40);
    const base = definition({ automationId: 'checks-a', sourceSelectorId: sourceSelectorA,
      eventLocalId: `automation/pull-request-checks-${kind}-v1` as GithubAutomationEventLocalIdV1 });
    const source: SourceDefinition = { ...base,
      sourceInstanceId: `github:repository:77:pull-request:7:head:${sha}:checks:all`,
      sourceConfig: { ...base.sourceConfig as Readonly<Record<string, JsonValue>>, checks: {
        pullRequestNumber: 7, headSha: sha, selection: 'all',
      } },
    };
    const checkpoints = createCheckpointCollection([]);
    let conclusion: string | null = null;
    let definitions: readonly SourceDefinition[] = [source];
    const admissions: AutomationEventAdmitInput[] = [];
    const http = { request: vi.fn(async (_request: { url: string }) => ({ status: 200, headers: {},
      body: new TextEncoder().encode(JSON.stringify({ data: { repository: { pullRequest: {
        headRefOid: sha, commits: { nodes: [{ commit: { oid: sha, statusCheckRollup: { contexts: {
          nodes: [{ __typename: 'CheckRun', id: 'check-1', name: 'build', status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
            conclusion, isRequired: true, detailsUrl: null, startedAt: null, completedAt: null,
            checkSuite: { createdAt: '2026-08-10T12:00:00Z' } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } }] },
      } } } })),
    })) };
    const actions = { execute: vi.fn(async (actionId: string, input: unknown) => {
      if (actionId === 'automation.event.sources.list') return sourceListResult(input, '7', definitions);
      if (actionId === 'automation.event.source.status.report') return {};
      if (actionId === 'automation.event.admit') {
        admissions.push(input as AutomationEventAdmitInput);
        return { results: [{ kind: 'admitted', runId: 'run-github-observation', checkpointSafe: true }] };
      }
      throw new Error(`unexpected Action ${actionId}`);
    }) };
    let now = 2000;
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => now });
    const context = sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection, http }));
    await observer.runCycle(sourceAttemptContext(observer, context));
    expect(checkpoints.rowCount()).toBe(1);
    expect(admissions).toHaveLength(0);
    expect(http.request).toHaveBeenCalledTimes(1);
    definitions = [source, { ...source, automationId: 'checks-new-subscriber', triggerId: 'trigger-checks-new-subscriber',
      sourceSelectorId: sourceSelectorB }];
    conclusion = kind === 'failed' ? 'FAILURE' : 'SUCCESS';
    now += 60000;
    await observer.runCycle(sourceAttemptContext(observer, context));
    expect(admissions).toHaveLength(1);
    expect(admissions[0]).toMatchObject({ eventRef: source.eventRef,
      payload: { checks: { headSha: sha, complete: true, passed: kind !== 'failed' } } });
    expect(checkpoints.rowCount()).toBe(2);
    expect(http.request).toHaveBeenCalledTimes(2);
    now += 60000;
    await observer.runCycle(sourceAttemptContext(observer, context));
    expect(admissions).toHaveLength(1);
    expect(http.request).toHaveBeenCalledTimes(3);
    expect(http.request.mock.calls.every(([request]) => (request as { url: string }).url.endsWith('/graphql'))).toBe(true);
  });
  it('admits lifecycle and existing projections through one shared checkpointed provider scan', async () => {
    const lifecycle = definition({ automationId: 'lifecycle', sourceSelectorId: sourceSelectorA, eventLocalId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestLifecycle });
    const opened = definition({ automationId: 'opened', sourceSelectorId: sourceSelectorB, eventLocalId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestOpened });
    const push = definition({ automationId: 'push', sourceSelectorId: '00000000-0000-4000-8000-000000000003' });
    const checkpoints = createCheckpointCollection([lifecycle, opened, push].map(source => checkpointRow({ automationId: source.automationId,
      sourceSelectorId: source.sourceSelectorId, eventLocalId: source.eventRef.localId as GithubAutomationEventLocalIdV1 })));
    const admissions: AutomationEventAdmitInput[] = [];
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return sourceListResult(input, '7', [lifecycle, opened, push]);
      if (action === 'automation.event.source.status.report') return {};
      if (action === 'automation.event.admit') { const request = AutomationEventAdmitInputV1Schema.parse(input); admissions.push(request);
        return { results: [{ kind: 'admitted', runId: 'pr-run', checkpointSafe: true }] }; }
      throw new Error(`Unexpected Action ${action}`);
    }) };
    const http = { request: vi.fn(async () => ({ status: 200, headers: { etag: 'current-pr' },
      body: new TextEncoder().encode(JSON.stringify([
        { id: 'old', type: 'OtherEvent', created_at: '1970-01-01T00:00:00.900Z', repo: { id: 77, name: 'acme/widgets' }, payload: {} },
        { id: 'push', type: 'PushEvent', created_at: '1970-01-01T00:00:01.050Z', repo: { id: 77, name: 'acme/widgets' },
          payload: { ref: 'refs/heads/main', before: 'b'.repeat(40), head: 'c'.repeat(40) } },
        { id: 'new', type: 'PullRequestEvent', created_at: '1970-01-01T00:00:01.100Z', repo: { id: 77, name: 'acme/widgets' },
          payload: { action: 'opened', pull_request: { id: 455, number: 33, title: 'Preview', user: { id: 99, login: 'octocat', type: 'User' },
            head: { sha: 'a'.repeat(40), ref: 'preview', repo: { id: 77, full_name: 'acme/widgets' } },
            base: { ref: 'main', repo: { id: 77, full_name: 'acme/widgets' } } } } },
      ])),
    })) };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    await observer.runCycle(sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection, http })));
    expect(admissions.map(value => value.eventRef.localId).sort()).toEqual([lifecycle.eventRef.localId, opened.eventRef.localId, push.eventRef.localId].sort());
    expect(admissions.find(value => value.eventRef.localId === lifecycle.eventRef.localId)?.payload).toMatchObject({
      pullRequest: { action: 'opened', headSha: 'a'.repeat(40) },
    });
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1, 3])('reads Preview heads only after repository Events change (%i live Previews)', async liveCount => {
    const def = definition({ automationId: 'preview-heads', sourceSelectorId: sourceSelectorA,
      eventLocalId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestLifecycle });
    const source = { ...def, deploymentPreview: { serverId: 'srv_preview', environmentId: 'preview-template' } };
    const checkpoints = createCheckpointCollection([checkpointRow({ automationId: source.automationId,
      sourceSelectorId: source.sourceSelectorId, eventLocalId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestLifecycle })]);
    const oldSha = 'a'.repeat(40);
    const headSha = 'b'.repeat(40);
    const repo = { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' };
    const reference = (id: string) => ({ contentArtifactId: id, contentHeaderVersion: 1, contentBodyVersion: 1 });
    const number = (index: number) => 40 + index;
    const id = (index: number) => String(900 + index);
    const live = Array.from({ length: liveCount }, (_, i) => i);
    const admissions: AutomationEventAdmitInput[] = [];
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return sourceListResult(input, '7', [source]);
      if (action === 'automation.event.source.status.report') return {};
      if (action === 'automation.event.admit') { admissions.push(AutomationEventAdmitInputV1Schema.parse(input));
        return { results: [{ kind: 'admitted', runId: 'preview-run', checkpointSafe: true }] }; }
      if (action === 'deployments.environments.list') {
        expect(input).toEqual({ serverId: 'srv_preview', previewTemplateEnvironmentId: 'preview-template' });
        // The extra child has no serving release. Its private content and PR must stay unread.
        return { ok: true, nextCursor: null, coverage: 'complete',
          items: [...live, liveCount].map(i => ({ id: `env-${i}`, purpose: 'preview', serverId: 'srv_preview',
            previewTemplateEnvironmentId: 'preview-template', previewPullRequestId: id(i),
            runtimeTargetLinkId: `link-${i}`, previewTargetLinkId: 'template-link', projectSourceId: 'source',
            ...reference(`env-${i}`) })),
          servingDeployments: live.map(i => ({ id: `deploy-${i}`, environmentId: `env-${i}`, targetLinkId: `link-${i}`,
            operation: 'deploy', state: 'succeeded', ...reference(`deploy-${i}`) })) };
      }
      if (action === 'deployments.receipts.get') {
        const address = input as { deploymentId: string };
        const i = Number(address.deploymentId.split('-').at(-1));
        expect(live).toContain(i);
        expect(input).toEqual({ serverId: 'srv_preview', environmentId: `env-${i}`, deploymentId: `deploy-${i}`,
          projection: 'previewHead' });
        return { ok: true, previewHead: { templateEnvironmentId: 'preview-template', repository: repo,
          pullRequestId: id(i), pullRequestNumber: number(i), deployedSha: oldSha } };
      }
      throw new Error(`Unexpected Action ${action}`);
    }) };
    let now = 2_000;
    let eventsChanged = false;
    let previewReadUnavailable = false;
    const changedEtag = 'preview-head-moved';
    const http = { request: vi.fn(async ({ url, headers }: { url: string; headers?: Record<string, string> }) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/events')) {
        if (!eventsChanged || headers?.['If-None-Match'] === changedEtag) return { status: 304, headers: {}, body: new Uint8Array() };
        return { status: 200, headers: { etag: changedEtag }, body: new TextEncoder().encode(JSON.stringify([
          { id: 'new-push', type: 'PushEvent', created_at: new Date(now).toISOString(), repo: { id: 77, name: 'acme/widgets' },
            payload: { ref: 'refs/heads/preview', before: oldSha, head: headSha } },
          { id: 'old', type: 'OtherEvent', created_at: '1970-01-01T00:00:00.900Z', repo: { id: 77, name: 'acme/widgets' }, payload: {} },
        ])) };
      }
      const i = Number(path.split('/').at(-1)) - 40;
      expect(live).toContain(i);
      if (previewReadUnavailable) return { status: 503, headers: {}, body: new Uint8Array() };
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ id: Number(id(i)),
        number: number(i), state: i === 2 ? 'closed' : 'open', author_association: 'MEMBER',
        user: { id: 99, login: 'octocat', type: 'User' },
        head: { sha: i === 1 ? oldSha : headSha, ref: 'preview', repo: { id: 77, full_name: 'acme/widgets' } },
        base: { ref: 'main', repo: { id: 77, full_name: 'acme/widgets' } } })) };
    }) };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => now });
    const context = observerBackgroundContext({ actions, collection: checkpoints.collection, http });
    const paths = () => http.request.mock.calls.map(([request]) => new URL(request.url).pathname);
    const deploymentReads = () => actions.execute.mock.calls.map(([action]) => action).filter(action => action.startsWith('deployments.'));
    const unchangedPolls = 3;
    for (let i = 0; i < unchangedPolls; i++) {
      await observer.runCycle(sourceAttemptContext(observer, context));
      now += 60_000;
    }
    expect(paths()).toEqual(Array.from({ length: unchangedPolls }, () => '/repos/acme/widgets/events'));
    expect(deploymentReads()).toEqual([]);
    expect(admissions).toHaveLength(0);

    eventsChanged = true;
    if (liveCount === 1) {
      previewReadUnavailable = true;
      await observer.runCycle(sourceAttemptContext(observer, context));
      expect(admissions).toHaveLength(0);
      previewReadUnavailable = false;
      now += 60_000;
    }
    const priorRequests = paths().length;
    const priorDeploymentReads = deploymentReads().length;
    await observer.runCycle(sourceAttemptContext(observer, context));
    expect(http.request.mock.calls[priorRequests]?.[0].headers?.['If-None-Match']).toBe('prior-etag');
    expect(paths().slice(priorRequests)).toEqual(['/repos/acme/widgets/events', ...live.map(i => `/repos/acme/widgets/pulls/${number(i)}`)]);
    expect(deploymentReads().slice(priorDeploymentReads)).toEqual(['deployments.environments.list', ...live.map(() => 'deployments.receipts.get')]);
    expect(admissions).toHaveLength(liveCount ? 1 : 0);
    if (liveCount) expect(admissions[0]?.payload).toMatchObject({ pullRequest: { action: 'synchronize', headSha } });
  });

  it.each(['own', 'fork'] as const)('admits the captured %s repository Events API PR through the checkpointed observer', async kind => {
    const source = definition({ automationId: 'lifecycle', sourceSelectorId: sourceSelectorA,
      eventLocalId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestLifecycle });
    const checkpoints = createCheckpointCollection([checkpointRow({ automationId: source.automationId,
      sourceSelectorId: source.sourceSelectorId, eventLocalId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestLifecycle })]);
    const event = structuredClone(capturedRepositoryPullRequestEvent);
    if (kind === 'fork') event.payload.pull_request.head.repo = {
      id: 78, name: 'widgets', url: 'https://api.github.com/repos/fork/widgets',
    };
    const admissions: AutomationEventAdmitInput[] = [];
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return sourceListResult(input, '7', [source]);
      if (action === 'automation.event.source.status.report') return {};
      if (action === 'automation.event.admit') { admissions.push(AutomationEventAdmitInputV1Schema.parse(input));
        return { results: [{ kind: 'admitted', runId: 'preview-run', checkpointSafe: true }] }; }
      throw new Error(`Unexpected Action ${action}`);
    }) };
    const http = { request: vi.fn(async () => ({ status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify([
      { id: 'old', type: 'OtherEvent', created_at: '1970-01-01T00:00:00.900Z', repo: event.repo, payload: {} }, event,
    ])) })) };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    await observer.runCycle(sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection, http })));
    expect(admissions).toHaveLength(1);
    expect(admissions[0]).toMatchObject({ eventRef: source.eventRef, payload: {
      repository: { repositoryId: '77', nameWithOwner: 'acme/widgets' },
      pullRequest: { id: '455', number: 33, action: 'opened', headSha: 'a'.repeat(40),
        baseRepository: { kind: 'github', repository: 'acme/widgets' },
        headRepository: { kind: 'github', repository: kind === 'fork' ? 'fork/widgets' : 'acme/widgets' },
        author: { id: '99', login: 'fixture-actor', kind: 'unsupported' } },
    } });
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it.each(['opened', 'reopened', 'closed', 'merged'] as const)('projects the available %s lifecycle fact from the checkpointed timeline', action => {
    const result = normalizeGithubRepositoryEventForAutomation({
      id: '108', type: 'PullRequestEvent', created_at: '2026-08-10T12:00:00Z', repo: { id: 77, name: 'acme/widgets' },
      payload: { action: action === 'merged' ? 'closed' : action,
        pull_request: { id: 455, number: 33, title: 'Preview', merge_commit_sha: 'c'.repeat(40), merged: action === 'merged', user: { id: 99, login: 'octocat', type: 'User' },
          head: { sha: 'a'.repeat(40), ref: 'preview', repo: { id: 77, full_name: 'acme/widgets' } },
          base: { ref: 'main', repo: { id: 77, full_name: 'acme/widgets' } } } },
    }, { v: 1, repositoryId: '77', owner: 'acme', name: 'widgets', nameWithOwner: 'acme/widgets' }, 'automation/pull-request-lifecycle-v1');
    expect(result.observation).toMatchObject({
      eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: 'automation/pull-request-lifecycle-v1' },
      payload: { pullRequest: { id: '455', number: 33, action, headSha: 'a'.repeat(40),
        baseRepository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' },
        headRepository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' },
        author: { id: '99', login: 'octocat', kind: 'human' } } },
    });
  });

  it('maps repository timeline variants to the same semantic Event refs used by webhooks', () => {
    const repository = {
      v: 1 as const,
      repositoryId: '77',
      owner: 'acme',
      name: 'widgets',
      nameWithOwner: 'acme/widgets',
    };
    const cases = [{
      localId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.push,
      raw: {
        id: '101', type: 'PushEvent', created_at: '2026-08-10T12:00:00Z',
        repo: { id: 77, name: 'acme/widgets' },
        payload: { ref: 'refs/heads/main', before: 'a'.repeat(40), head: 'b'.repeat(40) },
      },
      payload: { ref: 'refs/heads/main', before: 'a'.repeat(40), after: 'b'.repeat(40) },
    }, {
      localId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.issueOpened,
      raw: {
        id: '102', type: 'IssuesEvent', created_at: '2026-08-10T12:01:00Z',
        repo: { id: 77, name: 'acme/widgets' },
        payload: { action: 'opened', issue: { id: 201, number: 7, title: 'A new issue', labels: [{ name: 'queued' }], assignees: [] } },
      },
      payload: { issue: { id: '201', number: 7, title: 'A new issue', labels: ['queued'], assignees: [] } },
    }, {
      localId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestOpened,
      raw: {
        id: '103', type: 'PullRequestEvent', created_at: '2026-08-10T12:02:00Z',
        repo: { id: 77, name: 'acme/widgets' },
        payload: {
          action: 'opened',
          pull_request: { id: 301, number: 11, title: 'A new pull request', labels: [], assignees: [{ login: 'octocat' }] },
        },
      },
      payload: { pullRequest: { id: '301', number: 11, title: 'A new pull request', labels: [], assignees: ['octocat'] } },
    }, {
      localId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestMerged,
      raw: {
        id: '104', type: 'PullRequestEvent', created_at: '2026-08-10T12:03:00Z',
        repo: { id: 77, name: 'acme/widgets' },
        payload: {
          action: 'closed',
          pull_request: {
            id: 302, number: 12, merged: true, merge_commit_sha: 'c'.repeat(40),
            labels: [{ name: 'queued' }], assignees: [{ login: 'octocat' }],
          },
        },
      },
      payload: { pullRequest: { id: '302', number: 12, mergeCommitSha: 'c'.repeat(40), labels: ['queued'], assignees: ['octocat'] } },
    }] as const;

    for (const entry of cases) {
      expect(normalizeGithubRepositoryEventForAutomation(entry.raw, repository, entry.localId))
        .toMatchObject({
          eventId: entry.raw.id,
          observation: {
            eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: entry.localId },
            occurrenceId: `github:repository:77:event:${entry.raw.id}`,
            payload: { repository: { repositoryId: '77', nameWithOwner: 'acme/widgets' }, ...entry.payload },
          },
        });
    }
  });

  it('rejects a source attempt that did not come from the current GitHub observer materialization', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const checkpoints = createCheckpointCollection([
      checkpointRow({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA }),
    ]);
    const http = {
      request: vi.fn(async () => ({ status: 304, headers: {}, body: new Uint8Array() })),
    };
    const actions = {
      execute: vi.fn(async (actionId: string, requestInput: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          return sourceListResult(requestInput, '7', [source]);
        }
        if (actionId === 'automation.event.source.status.report') {
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: {
        id: GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID,
        qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/${GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID}`,
      },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      signal: new AbortController().signal,
      services: {
        actions,
        connectedAccounts: {
          materialize: vi.fn(async () => ({
            kind: 'httpHeaders' as const,
            headers: { Authorization: 'Bearer exact-account-token' },
          })),
        },
        http: createPluginHttpFixture({ request: http.request }),
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    const rejectedCallers: boolean[] = [];

    await observer.runCycle(sourceAttemptContext(observer, context, async (input, actionContext) => {
      for (const caller of [
        {
          kind: 'plugin',
          pluginId: 'acme.unrelated',
          contribution: {
            id: 'background-worker',
            qualifiedId: 'acme.unrelated/backgroundServices/background-worker',
          },
          occurrenceId: 'github-automation-observer-unrelated-fixture-generation',
          sourceCustody: { kind: 'managed', immutableGenerationId: 'github-automation-observer-unrelated-fixture-generation', installSource: 'npm' },
          materialization: {
            pluginId: 'acme.unrelated',
            machineId: watcherMaterializationRef.machineId,
            materializationId: watcherMaterializationRef.materializationId,
          },
          originSurface: 'background',
        } as const,
        {
          ...actionContext.caller!,
          materialization: {
            ...watcherMaterializationRef,
            materializationId: 'retired-materialization',
          },
        } as const,
      ]) {
        try {
          await observer.runSourceAttempt(input, { ...actionContext, caller });
          rejectedCallers.push(false);
        } catch {
          rejectedCallers.push(true);
        }
      }
    }));

    expect(rejectedCallers).toEqual([true, true]);
    expect(http.request).toHaveBeenCalledOnce();
  });

  it('retires the active cycle when the observer is cancelled during source dispatch', async () => {
    const definitions = [
      definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA }),
      definition({ automationId: 'automation-b', sourceSelectorId: sourceSelectorB }),
    ];
    const checkpoints = createCheckpointCollection([
      checkpointRow({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA }),
      checkpointRow({ automationId: 'automation-b', sourceSelectorId: sourceSelectorB }),
    ]);
    const controller = new AbortController();
    const http = {
      request: vi.fn(async () => ({ status: 304, headers: {}, body: new Uint8Array() })),
    };
    const actions = {
      execute: vi.fn(async (actionId: string, requestInput: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          return sourceListResult(requestInput, '7', definitions);
        }
        if (actionId === 'automation.event.source.status.report') {
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: {
        id: GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID,
        qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/${GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID}`,
      },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      signal: controller.signal,
      services: {
        actions,
        connectedAccounts: {
          materialize: vi.fn(async () => ({
            kind: 'httpHeaders' as const,
            headers: { Authorization: 'Bearer exact-account-token' },
          })),
        },
        http: createPluginHttpFixture({ request: http.request }),
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    let capturedInput: unknown;
    let capturedContext: PluginInvocationContext | undefined;
    const cycle = observer.runCycle(sourceAttemptContext(observer, context, async (input, actionContext) => {
      capturedInput ??= input;
      capturedContext ??= actionContext;
      if (!controller.signal.aborted) controller.abort(new Error('observer cycle cancelled'));
    }));

    await expect(cycle).rejects.toThrow('observer cycle cancelled');
    expect(http.request).not.toHaveBeenCalled();
    expect(capturedContext).toBeDefined();
    await expect(observer.runSourceAttempt(capturedInput, {
      ...capturedContext!,
      signal: new AbortController().signal,
    })).rejects.toThrow();
    expect(checkpoints.collection.get).not.toHaveBeenCalled();
    expect(checkpoints.put).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
  });

  it.each([true, false])('shares one provider scan across a new subscriber and a retained ETag; checkpoint safe: %s', async checkpointSafe => {
    const retained = definition({ automationId: 'retained-subscriber', sourceSelectorId: sourceSelectorA });
    const fresh = definition({ automationId: 'new-subscriber', sourceSelectorId: sourceSelectorB });
    const retainedRow = checkpointRow({ automationId: retained.automationId, sourceSelectorId: retained.sourceSelectorId });
    const checkpoints = createCheckpointCollection([retainedRow]);
    const admitted: AutomationEventAdmitInput[] = [];
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return sourceListResult(input, '7', [retained, fresh]);
      if (action === 'automation.event.source.status.report') return {};
      if (action === 'automation.event.admit') {
        admitted.push(AutomationEventAdmitInputV1Schema.parse(input));
        return { results: [checkpointSafe ? { kind: 'admitted', runId: 'retained-run', checkpointSafe: true }
          : { kind: 'blocked', reason: 'capacity', checkpointSafe: false }] };
      }
      throw new Error(`Unexpected Action ${action}`);
    }) };
    const http = { request: vi.fn(async (_request: { headers?: Readonly<Record<string, string>> }) => ({ status: 200,
      headers: { etag: 'current-etag' }, body: new TextEncoder().encode(JSON.stringify([
        { id: 'old', type: 'PushEvent', created_at: '1970-01-01T00:00:00.900Z', repo: { id: 77, name: 'acme/widgets' },
          payload: { ref: 'refs/heads/main', before: 'a'.repeat(40), head: 'b'.repeat(40) } },
        { id: 'new', type: 'PushEvent', created_at: '1970-01-01T00:00:01.100Z', repo: { id: 77, name: 'acme/widgets' },
          payload: { ref: 'refs/heads/main', before: 'b'.repeat(40), head: 'c'.repeat(40) } },
      ])),
    })) };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    const context = sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection, http }));

    await observer.runCycle(context);

    expect(http.request).toHaveBeenCalledOnce();
    expect(http.request.mock.calls[0]?.[0].headers?.['If-None-Match']).toBeUndefined();
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({ occurrenceId: 'github:repository:77:event:new',
      definitions: [expect.objectContaining({ automationId: retained.automationId })] });
    expect(checkpoints.rowCount()).toBe(2);
    expect(checkpoints.read(retainedRow.id)).toMatchObject({ value: { payload: { cursor: {
      seenEventIds: checkpointSafe ? ['old', 'new'] : ['old'],
    } } } });
    expect(checkpoints.read(createGithubAutomationEventCheckpointRowId({ automationId: fresh.automationId,
      sourceSelectorId: fresh.sourceSelectorId }))).toMatchObject({ value: { payload: { cursor: {
      seenEventIds: ['old', 'new'], observationStartsAtMs: 2_000,
    } } } });
  });

  it('coalesces one repository read while preserving independent trigger checkpoints', async () => {
    const definitions = [
      definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA }),
      definition({ automationId: 'automation-b', sourceSelectorId: sourceSelectorB }),
    ];
    const checkpoints = createCheckpointCollection([
      checkpointRow({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA }),
      checkpointRow({ automationId: 'automation-b', sourceSelectorId: sourceSelectorB }),
    ]);
    let releaseHttp: ((value: HttpBoundaryResponse) => void) | undefined;
    const httpResponse = new Promise<HttpBoundaryResponse>((resolve) => { releaseHttp = resolve; });
    const http = {
      request: vi.fn(async () => await httpResponse),
    };
    const admitted: AutomationEventAdmitInput[] = [];
    const statuses: AutomationEventSourceStatusReport[] = [];
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          const request = input as PluginActionInputById['automation.event.sources.list'];
          expect(request.transport).toEqual({ kind: 'checkpointedPull' });
          return sourceListResult(input, '7', definitions);
        }
        if (actionId === 'automation.event.admit') {
          const request = input as AutomationEventAdmitInput;
          admitted.push(request);
          return {
            results: request.definitions.map((selectedDefinition) => (
              selectedDefinition.automationId === 'automation-a' && request.occurrenceId.endsWith(':new-2')
                ? { kind: 'blocked', reason: 'capacity', checkpointSafe: false }
                : {
                  kind: 'admitted',
                  runId: `run-${selectedDefinition.automationId}-${request.occurrenceId}`,
                  checkpointSafe: true,
                }
            )),
          } satisfies PluginActionResultById['automation.event.admit'];
        }
        if (actionId === 'automation.event.source.status.report') {
          const status = input as AutomationEventSourceStatusReport;
          statuses.push(status);
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: {
        id: 'automation-repository-event-checkpointed-pull',
        qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/automation-repository-event-checkpointed-pull`,
      },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      signal: new AbortController().signal,
      // Boundary fixture supplies exactly the host services reached by the observer.
      services: {
        actions,
        connectedAccounts: {
          materialize: vi.fn(async () => ({
            kind: 'httpHeaders' as const,
            headers: { Authorization: 'Bearer exact-account-token' },
          })),
        },
        http: createPluginHttpFixture({ request: http.request }),
        storage: {
          account: {
            collection: vi.fn(() => checkpoints.collection),
          },
        },
      },
    } as unknown as BackgroundServiceContext;

    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    const cycle = observer.runCycle(sourceAttemptContext(observer, context));
    await vi.waitFor(() => expect(http.request).toHaveBeenCalledOnce());
    releaseHttp?.({
      status: 200,
      headers: { etag: 'current-etag' },
      body: new TextEncoder().encode(JSON.stringify([
        {
          id: 'old',
          type: 'PushEvent',
          created_at: '1970-01-01T00:00:00.900Z',
          repo: { id: 77, name: 'acme/widgets' },
          payload: { ref: 'refs/heads/main', before: 'a'.repeat(40), head: 'b'.repeat(40) },
        },
        {
          id: 'new-1',
          type: 'PushEvent',
          created_at: '1970-01-01T00:00:01.100Z',
          repo: { id: 77, name: 'acme/widgets' },
          payload: { ref: 'refs/heads/main', before: 'b'.repeat(40), head: 'c'.repeat(40) },
        },
        {
          id: 'new-2',
          type: 'PushEvent',
          created_at: '1970-01-01T00:00:01.200Z',
          repo: { id: 77, name: 'acme/widgets' },
          payload: { ref: 'refs/heads/release', before: 'c'.repeat(40), head: 'd'.repeat(40) },
        },
      ])),
    });
    await cycle;

    expect(admitted).toHaveLength(4);
    expect(admitted.every((request) => request.definitions.length === 1)).toBe(true);
    expect(admitted).toContainEqual(expect.objectContaining({
      eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.push },
      occurrenceId: 'github:repository:77:event:new-1',
      payload: expect.objectContaining({ ref: 'refs/heads/main', after: 'c'.repeat(40) }),
    }));
    expect(admitted).toContainEqual(expect.objectContaining({
      eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.push },
      occurrenceId: 'github:repository:77:event:new-2',
      payload: expect.objectContaining({ ref: 'refs/heads/release', after: 'd'.repeat(40) }),
    }));

    const blockedCheckpoint = checkpoints.read(createGithubAutomationEventCheckpointRowId({
      automationId: 'automation-a',
      triggerId: 'trigger-automation-a',
      eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: EVENT_LOCAL_ID },
      sourceSelectorId: sourceSelectorA,
    }));
    const admittedCheckpoint = checkpoints.read(createGithubAutomationEventCheckpointRowId({
      automationId: 'automation-b',
      triggerId: 'trigger-automation-b',
      eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: EVENT_LOCAL_ID },
      sourceSelectorId: sourceSelectorB,
    }));
    expect(blockedCheckpoint?.value.payload.cursor).toMatchObject({ seenEventIds: ['old'] });
    expect(blockedCheckpoint?.value.payload.lastContiguousOccurrenceId).toBe('github:repository:77:event:old');
    expect(admittedCheckpoint?.value.payload.cursor).toMatchObject({ seenEventIds: ['old', 'new-1', 'new-2'] });
    expect(admittedCheckpoint?.value.payload.lastContiguousOccurrenceId).toBe('github:repository:77:event:new-2');
    expect(checkpoints.rowCount()).toBe(2);
    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'catalogReconciliation', state: 'current', observedRevision: '7' }),
      expect.objectContaining({ kind: 'source', automationId: 'automation-a', state: 'backingOff', code: 'capacityBlocked' }),
      expect.objectContaining({ kind: 'source', automationId: 'automation-b', state: 'observing', code: 'none' }),
    ]));
  });

  it('coalesces provider reads while each semantic trigger admits only its matching Event', async () => {
    const push = definition({ automationId: 'automation-push', sourceSelectorId: sourceSelectorA });
    const issue = definition({
      automationId: 'automation-issue',
      sourceSelectorId: sourceSelectorB,
      eventLocalId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.issueOpened,
    });
    const issueLabeled = definition({
      automationId: 'automation-issue-labeled',
      sourceSelectorId: sourceSelectorB,
      eventLocalId: 'automation/issue-labeled-v1',
    });
    const checkpoints = createCheckpointCollection([
      checkpointRow({ automationId: push.automationId, sourceSelectorId: push.sourceSelectorId }),
      checkpointRow({
        automationId: issue.automationId,
        eventLocalId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.issueOpened,
        sourceSelectorId: issue.sourceSelectorId,
      }),
      checkpointRow({
        automationId: issueLabeled.automationId,
        eventLocalId: issueLabeled.eventRef.localId,
        sourceSelectorId: issueLabeled.sourceSelectorId,
      }),
    ]);
    const admissions: AutomationEventAdmitInput[] = [];
    const statuses: AutomationEventSourceStatusReport[] = [];
    const http = {
      request: vi.fn(async () => ({
        status: 200,
        headers: { etag: 'current-etag' },
        body: new TextEncoder().encode(JSON.stringify([
          {
            id: 'old', type: 'PushEvent', created_at: '1970-01-01T00:00:00.900Z',
            repo: { id: 77, name: 'acme/widgets' },
            payload: { ref: 'refs/heads/main', before: 'a'.repeat(40), head: 'b'.repeat(40) },
          },
          {
            id: 'push-new', type: 'PushEvent', created_at: '1970-01-01T00:00:01.100Z',
            repo: { id: 77, name: 'acme/widgets' },
            payload: { ref: 'refs/heads/main', before: 'b'.repeat(40), head: 'c'.repeat(40) },
          },
          {
            id: 'issue-new', type: 'IssuesEvent', created_at: '1970-01-01T00:00:01.200Z',
            repo: { id: 77, name: 'acme/widgets' },
            payload: { action: 'opened', issue: { id: 301, number: 11, title: 'Observed issue' } },
          },
          {
            id: 'issue-labeled', type: 'IssuesEvent', created_at: '1970-01-01T00:00:01.300Z',
            repo: { id: 77, name: 'acme/widgets' },
            payload: { action: 'labeled', label: { name: 'agent-ok' }, labels: [{ name: 'bug' }, { name: 'agent-ok' }],
              assignees: [{ login: 'octocat' }], issue: { id: 301, number: 11, title: 'Observed issue' } },
          },
        ])),
      })),
    };
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          return sourceListResult(input, '7', [push, issue, issueLabeled]);
        }
        if (actionId === 'automation.event.admit') {
          const request = input as AutomationEventAdmitInput;
          admissions.push(request);
          return {
            results: request.definitions.map((definition) => ({
              kind: 'admitted' as const,
              runId: `run-${definition.triggerId}`,
              checkpointSafe: true as const,
            })),
          } satisfies PluginActionResultById['automation.event.admit'];
        }
        if (actionId === 'automation.event.source.status.report') {
          statuses.push(input as AutomationEventSourceStatusReport);
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: { id: 'observer', qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/observer` },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      signal: new AbortController().signal,
      services: {
        actions,
        connectedAccounts: {
          materialize: vi.fn(async () => ({
            kind: 'httpHeaders' as const,
            headers: { Authorization: 'Bearer token' },
          })),
        },
        http: createPluginHttpFixture({ request: http.request }),
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;

    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(admissions).toHaveLength(3);
    expect(admissions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventRef: push.eventRef,
        definitions: [expect.objectContaining({ triggerId: push.triggerId })],
      }),
      expect.objectContaining({
        eventRef: issue.eventRef,
        definitions: [expect.objectContaining({ triggerId: issue.triggerId })],
      }),
      expect.objectContaining({
        eventRef: issueLabeled.eventRef,
        occurrenceId: 'github:repository:77:event:issue-labeled',
        definitions: [expect.objectContaining({ triggerId: issueLabeled.triggerId })],
        payload: expect.objectContaining({ label: 'agent-ok',
          issue: { id: '301', number: 11, title: 'Observed issue', labels: ['bug', 'agent-ok'], assignees: ['octocat'] } }),
      }),
    ]));
    expect(http.request).toHaveBeenCalledOnce();
    expect(checkpoints.rowCount()).toBe(3);
    expect(statuses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'source', automationId: push.automationId, observedDelta: 1,
      }),
      expect.objectContaining({
        kind: 'source', automationId: issue.automationId, observedDelta: 1,
      }),
    ]));
  });

  it('retains an adopted source snapshot across an unchanged scan and persists each completed 304 observation time', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const retained = checkpointRow({ automationId: source.automationId, sourceSelectorId: source.sourceSelectorId });
    const checkpoints = createCheckpointCollection([{ ...retained, payload: { ...retained.payload,
      continuity: { v: 1, endpointKind: 'repositoryEvents', repositoryId: '77', retiredContinuityHint: 'old' } } }]);
    const controller = new AbortController();
    let now = 2_000;
    const statuses: AutomationEventSourceStatusReport[] = [];
    const http = { request: vi.fn(async () => { now += 1_000;
      return { status: 304, headers: { 'x-poll-interval': '17' }, body: new Uint8Array() }; }) };
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return sourceListResult(input, '7', [source]);
      if (action === 'automation.event.source.status.report') { statuses.push(input as AutomationEventSourceStatusReport); return {}; }
      throw new Error(`Unexpected Action ${action}`);
    }) };
    let waits = 0;
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => now,
      sleep: async () => { if (++waits === 1) now = 20_000; else controller.abort(); } });
    await observer.run(sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection,
      http, signal: controller.signal })));
    const row = checkpoints.read(retained.id);
    expect(http.request).toHaveBeenCalledTimes(2);
    expect(checkpoints.query).toHaveBeenCalledTimes(1);
    expect(row?.value.payload.cursor).toMatchObject({ observedAtMs: 21_000, etag: 'prior-etag' });
    expect(row?.value.payload.continuity).not.toHaveProperty('retiredContinuityHint');
    expect(statuses).toContainEqual(expect.objectContaining({ kind: 'source', state: 'observing', lastObservedAt: 21_000 }));
  });

  it('does not dispatch a stale adopted catalog to source observation after currentness is lost', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const checkpoints = createCheckpointCollection([]);
    const controller = new AbortController();
    let invalidate = () => {};
    const events = { host: { subscribe: (_target: unknown, listener: SourcesInvalidatedListener) => {
      invalidate = () => listener(sourcesInvalidated()); return { dispose() {} };
    } } };
    let now = 2_000;
    let stale = false;
    const statuses: AutomationEventSourceStatusReport[] = [];
    const http = { request: vi.fn(async () => ({ status: 200, headers: { etag: 'initial' },
      body: new TextEncoder().encode('[]') })) };
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return stale ? { kind: 'cursorStale', currentRevision: '8' }
        : sourceListResult(input, '7', [source]);
      if (action === 'automation.event.source.status.report') { statuses.push(input as AutomationEventSourceStatusReport); return {}; }
      throw new Error(`Unexpected Action ${action}`);
    }) };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => now,
      sleep: async () => {
        if (!stale) { stale = true; now = 63_000; invalidate(); http.request.mockClear(); statuses.length = 0; }
        else controller.abort();
      } });
    await observer.run(sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection,
      http, events, signal: controller.signal })));
    expect(http.request).not.toHaveBeenCalled();
    expect(checkpoints.put).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual([expect.objectContaining({ kind: 'catalogReconciliation',
      observedRevision: '8', adoptedRevision: '7', state: 'reconciling' })]);
  });

  it('persists the first baseline of a fresh trigger at Protocol trigger revision zero', async () => {
    // Canonical trigger create writers mint revision 0; the observer's first
    // baseline must persist at exactly the revision the admitted definition
    // carries instead of failing every cycle until an unrelated edit bumps it.
    const source = definition({
      automationId: 'automation-a',
      sourceSelectorId: sourceSelectorA,
      triggerRevision: 0,
    });
    const rowId = createGithubAutomationEventCheckpointRowId({
      automationId: 'automation-a',
      triggerId: 'trigger-automation-a',
      eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: EVENT_LOCAL_ID },
      sourceSelectorId: sourceSelectorA,
    });
    const checkpoints = createCheckpointCollection([]);
    const statuses: AutomationEventSourceStatusReport[] = [];
    const http = {
      request: vi.fn(async () => ({
        status: 200,
        headers: { etag: 'baseline-etag' },
        body: new TextEncoder().encode(JSON.stringify([
          {
            id: 'old',
            type: 'PushEvent',
            created_at: '1970-01-01T00:00:00.900Z',
            repo: { id: 77, name: 'acme/widgets' },
            payload: { ref: 'refs/heads/main', before: 'a'.repeat(40), head: 'b'.repeat(40) },
          },
        ])),
      })),
    };
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          return sourceListResult(input, '7', [source]);
        }
        if (actionId === 'automation.event.source.status.report') {
          statuses.push(input as AutomationEventSourceStatusReport);
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: { id: 'observer', qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/observer` },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      signal: new AbortController().signal,
      services: {
        actions,
        connectedAccounts: {
          materialize: vi.fn(async () => ({
            kind: 'httpHeaders' as const,
            headers: { Authorization: 'Bearer token' },
          })),
        },
        http: createPluginHttpFixture({ request: http.request }),
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;

    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    await observer.runCycle(sourceAttemptContext(observer, context));

    const baseline = checkpoints.read(rowId);
    expect(baseline?.value.payload.baseline).toMatchObject({ kind: 'currentHead' });
    expect(baseline?.value.payload.lastEvaluatedTriggerRevision).toBe(0);
    expect(statuses).toContainEqual(expect.objectContaining({
      kind: 'source',
      automationId: 'automation-a',
      triggerRevision: 0,
      state: 'baselined',
      code: 'none',
    }));
  });

  it('persists a looping GitHub pagination gap without advancing its checkpoint cursor', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const rowId = createGithubAutomationEventCheckpointRowId({
      automationId: 'automation-a',
      triggerId: 'trigger-automation-a',
      eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: EVENT_LOCAL_ID },
      sourceSelectorId: sourceSelectorA,
    });
    const checkpoints = createCheckpointCollection([
      checkpointRow({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA }),
    ]);
    const statuses: AutomationEventSourceStatusReport[] = [];
    const repeatedPageUrl = 'https://api.github.com/repos/acme/widgets/events?per_page=100&page=2';
    let requests = 0;
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          return sourceListResult(input, '7', [source]);
        }
        if (actionId === 'automation.event.source.status.report') {
          statuses.push(input as AutomationEventSourceStatusReport);
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: { id: 'observer', qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/observer` },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      signal: new AbortController().signal,
      services: {
        actions,
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer token' } })) },
        http: {
          request: vi.fn(async () => {
            requests += 1;
            return {
              status: 200,
              headers: {
                ...(requests === 1 ? { etag: 'current-etag' } : {}),
                link: `<${repeatedPageUrl}>; rel="next"`,
              },
              body: new TextEncoder().encode(JSON.stringify([])),
            };
          }),
        },
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;

    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(requests).toBe(2);
    expect(checkpoints.read(rowId)).toMatchObject({
      revision: 2,
      value: {
        payload: {
          cursor: { etag: 'prior-etag' },
          continuity: expect.objectContaining({ historyGap: true }),
        },
      },
    });
    expect(statuses).toContainEqual(expect.objectContaining({
      kind: 'source', state: 'attention', code: 'historyGap', nextRetryAt: null,
    }));
  });

  it('persists a history gap and refuses to resume its checkpoint without a new authenticated baseline', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const rowId = createGithubAutomationEventCheckpointRowId({
      automationId: 'automation-a',
      triggerId: 'trigger-automation-a',
      eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: EVENT_LOCAL_ID },
      sourceSelectorId: sourceSelectorA,
    });
    const checkpoints = createCheckpointCollection([
      checkpointRow({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA }),
    ]);
    const statuses: AutomationEventSourceStatusReport[] = [];
    const http = { request: vi.fn(async () => ({
      status: 200,
      headers: { etag: 'no-overlap' },
      body: new TextEncoder().encode(JSON.stringify([])),
    })) };
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          return sourceListResult(input, '7', [source]);
        }
        if (actionId === 'automation.event.source.status.report') {
          statuses.push(input as AutomationEventSourceStatusReport);
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: { id: 'observer', qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/observer` },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      signal: new AbortController().signal,
      services: {
        actions,
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer token' } })) },
        http: createPluginHttpFixture({ request: http.request }),
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;

    let now = 2_000;
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => now });
    await observer.runCycle(sourceAttemptContext(observer, context));
    now = 63_000;
    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(http.request).toHaveBeenCalledOnce();
    expect(checkpoints.read(rowId)).toMatchObject({
      value: { payload: { continuity: expect.objectContaining({ historyGap: true }) } },
    });
    expect(statuses.filter((status) => status.kind === 'source')).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'attention', code: 'historyGap' }),
    ]));
  });

  it.each([
    { prior: 'persisted history gap', eventLocalId: EVENT_LOCAL_ID },
    { prior: 'missing checkpoint', eventLocalId: EVENT_LOCAL_ID },
    { prior: 'persisted history gap', eventLocalId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestOpened },
    { prior: 'missing checkpoint', eventLocalId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestOpened },
  ] as const)(
    'recovers $prior for $eventLocalId without replaying compact historical payloads', async ({ prior, eventLocalId }) => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA, eventLocalId });
    const rowId = createGithubAutomationEventCheckpointRowId({
      automationId: 'automation-a',
      triggerId: 'trigger-automation-a',
      eventRef: source.eventRef,
      sourceSelectorId: sourceSelectorA,
    });
    const checkpoints = createCheckpointCollection(prior === 'persisted history gap'
      ? [historyGapCheckpointRow({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA, eventLocalId })]
      : []);
    const priorRevision = prior === 'persisted history gap' ? 1 : 0;
    const admitted: AutomationEventAdmitInput[] = [];
    const statuses: AutomationEventSourceStatusReport[] = [];
    const baselineEventAt = Date.now() - 1_000;
    const nextEventAt = Date.now() + 60_000;
    const repositoryEvent = (id: string, createdAt: string) => ({
      id,
      type: eventLocalId === GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestOpened ? 'PullRequestEvent' : 'PushEvent',
      created_at: createdAt,
      repo: { id: 77, name: 'acme/widgets' },
      payload: eventLocalId === GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestOpened
        ? { action: 'opened', number: 1, pull_request: { id: 455, number: 1,
          // Existing compact Events lack a title. A current-head baseline must
          // retain their IDs without interpreting or emitting their payloads.
          ...(id === 'new-after-baseline' ? { title: 'New pull request' } : {}),
        } }
        : { ref: 'refs/heads/main', before: 'a'.repeat(40), head: 'b'.repeat(40) },
    });
    let requestCount = 0;
    const http = {
      request: vi.fn(async (request: Readonly<{ headers?: Readonly<Record<string, string>> }>) => {
        requestCount += 1;
        if (requestCount === 1) {
          expect(request.headers?.['If-None-Match']).toBeUndefined();
          return {
            status: 200,
            headers: { etag: 'baseline-etag' },
            body: new TextEncoder().encode(JSON.stringify([
              repositoryEvent('baseline-current', new Date(baselineEventAt).toISOString()),
            ])),
          };
        }
        expect(request.headers?.['If-None-Match']).toBe('baseline-etag');
        return {
          status: 200,
          headers: { etag: 'next-etag' },
          body: new TextEncoder().encode(JSON.stringify([
            repositoryEvent('baseline-current', new Date(baselineEventAt).toISOString()),
            repositoryEvent('new-after-baseline', new Date(nextEventAt).toISOString()),
          ])),
        };
      }),
    };
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          const request = input as PluginActionInputById['automation.event.sources.list'];
          expect(request.transport).toEqual({ kind: 'checkpointedPull' });
          if (request.knownRevision !== undefined) {
            expect(request).toEqual({
              transport: { kind: 'checkpointedPull' }, knownRevision: '7',
            });
            return { kind: 'unchanged', revision: '7' } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          return sourceListResult(input, '7', [source]);
        }
        if (actionId === 'automation.event.admit') {
          admitted.push(input as AutomationEventAdmitInput);
          return {
            results: [{ kind: 'admitted', runId: 'run-new-after-baseline', checkpointSafe: true }],
          } satisfies PluginActionResultById['automation.event.admit'];
        }
        if (actionId === 'automation.event.source.status.report') {
          statuses.push(input as AutomationEventSourceStatusReport);
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const services = {
      actions,
      connectedAccounts: {
        materialize: vi.fn(async () => ({
          kind: 'httpHeaders' as const,
          headers: { Authorization: 'Bearer exact-account-token' },
        })),
      },
      http: createPluginHttpFixture({ request: http.request }),
      storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
    };
    const actionContext = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: {
        id: 'automation/reset-repository-event-baseline-v1',
        qualifiedId: `${GITHUB_PLUGIN_ID}/actions/automation/reset-repository-event-baseline-v1`,
      },
      surface: 'plugin' as const,
      signal: new AbortController().signal,
      services,
    } as unknown as PluginInvocationContext;

    await expect(resetGithubRepositoryEventHistoryGap({
      automationId: source.automationId,
      triggerId: source.triggerId,
      triggerRevision: source.triggerRevision,
      sourceSelectorId: source.sourceSelectorId,
    }, actionContext)).resolves.toMatchObject({ kind: 'baselined' });

    expect(statuses).toContainEqual(expect.objectContaining({
      kind: 'source',
      automationId: source.automationId,
      triggerId: source.triggerId,
      triggerRevision: source.triggerRevision,
      sourceSelectorId: source.sourceSelectorId,
      state: 'baselined',
      code: 'none',
    }));

    expect(checkpoints.read(rowId)).toMatchObject({
      revision: priorRevision + 1,
      value: {
        payload: {
          cursor: { etag: 'baseline-etag', seenEventIds: ['baseline-current'] },
          lastContiguousOccurrenceId: null,
        },
      },
    });
    expect(checkpoints.read(rowId)?.value.payload.continuity).not.toHaveProperty('historyGap');

    expect(admitted).toEqual([]);

    const observerContext = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: {
        id: 'automation-repository-event-checkpointed-pull',
        qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/automation-repository-event-checkpointed-pull`,
      },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      signal: new AbortController().signal,
      services,
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => nextEventAt + 1_000 });
    await observer.runCycle(sourceAttemptContext(observer, observerContext));

    expect(http.request).toHaveBeenCalledTimes(2);
    expect(admitted).toContainEqual(expect.objectContaining({
      eventRef: source.eventRef,
      occurrenceId: 'github:repository:77:event:new-after-baseline',
    }));
    expect(admitted).toHaveLength(1);
    expect(checkpoints.read(rowId)).toMatchObject({
      revision: priorRevision + 2,
      value: {
        payload: {
          cursor: { etag: 'next-etag' },
        },
      },
    });
    expect(checkpoints.read(rowId)?.value.payload.continuity).not.toHaveProperty('historyGap');
  });

  it('finds the current source after the first source-list page before baselining a history gap', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const otherSource = definition({ automationId: 'automation-b', sourceSelectorId: sourceSelectorB });
    const rowId = createGithubAutomationEventCheckpointRowId({
      automationId: 'automation-a',
      triggerId: 'trigger-automation-a',
      eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: EVENT_LOCAL_ID },
      sourceSelectorId: sourceSelectorA,
    });
    const checkpoints = createCheckpointCollection([
      historyGapCheckpointRow({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA }),
    ]);
    let sourceListCalls = 0;
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: {
        id: 'automation/reset-repository-event-baseline-v1',
        qualifiedId: `${GITHUB_PLUGIN_ID}/actions/automation/reset-repository-event-baseline-v1`,
      },
      surface: 'plugin' as const,
      signal: new AbortController().signal,
      services: {
        actions: {
          execute: vi.fn(async (actionId: string, input: unknown) => {
            if (actionId === 'automation.event.sources.list') {
              sourceListCalls += 1;
              const request = input as PluginActionInputById['automation.event.sources.list'];
              if (sourceListCalls === 1) {
                expect(request).toEqual({ transport: { kind: 'checkpointedPull' } });
                return {
                  kind: 'page', revision: '7', definitions: [otherSource], nextCursor: 'page-2',
                } satisfies PluginActionResultById['automation.event.sources.list'];
              }
              if (sourceListCalls === 2) {
                expect(request).toEqual({
                  transport: { kind: 'checkpointedPull' }, cursor: 'page-2',
                });
                return sourceListResult(input, '7', [source]);
              }
              expect(request).toEqual({
                transport: { kind: 'checkpointedPull' }, knownRevision: '7',
              });
              return { kind: 'unchanged', revision: '7' } satisfies PluginActionResultById['automation.event.sources.list'];
            }
            if (actionId === 'automation.event.source.status.report') {
              return {} satisfies PluginActionResultById['automation.event.source.status.report'];
            }
            throw new Error(`unexpected Action ${actionId}`);
          }),
        },
        connectedAccounts: {
          materialize: vi.fn(async () => ({
            kind: 'httpHeaders' as const,
            headers: { Authorization: 'Bearer exact-account-token' },
          })),
        },
        http: createPluginHttpFixture({ request: vi.fn(async () => ({
          status: 200,
          headers: { etag: 'fresh-etag' },
          body: new TextEncoder().encode(JSON.stringify([])),
        })) }),
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as PluginInvocationContext;

    await expect(resetGithubRepositoryEventHistoryGap({
      automationId: source.automationId,
      triggerId: source.triggerId,
      triggerRevision: source.triggerRevision,
      sourceSelectorId: source.sourceSelectorId,
    }, context)).resolves.toMatchObject({ kind: 'baselined' });

    expect(sourceListCalls).toBe(5);
    expect(checkpoints.read(rowId)).toMatchObject({
      revision: 2,
      value: { payload: { cursor: { etag: 'fresh-etag' } } },
    });
    expect(checkpoints.read(rowId)?.value.payload.continuity).not.toHaveProperty('historyGap');
  });

  it('does not baseline a source that disappears when the host confirms its checkpointed-pull revision', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const rowId = createGithubAutomationEventCheckpointRowId({
      automationId: source.automationId,
      triggerId: source.triggerId,
      eventRef: source.eventRef,
      sourceSelectorId: source.sourceSelectorId,
    });
    const checkpoints = createCheckpointCollection([
      historyGapCheckpointRow({ automationId: source.automationId, sourceSelectorId: source.sourceSelectorId }),
    ]);
    const http = {
      request: vi.fn(async () => ({
        status: 200,
        headers: { etag: 'stale-baseline-etag' },
        body: new TextEncoder().encode(JSON.stringify([])),
      })),
    };
    const sourceList = vi.fn(async (input: unknown) => {
      const request = input as PluginActionInputById['automation.event.sources.list'];
      if (request.knownRevision === undefined) {
        expect(request).toEqual({ transport: { kind: 'checkpointedPull' } });
        return sourceListResult(input, '7', [source]);
      }
      expect(request).toEqual({
        transport: { kind: 'checkpointedPull' }, knownRevision: '7',
      });
      return sourceListResult(input, '8', []);
    });
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: {
        id: 'automation/reset-repository-event-baseline-v1',
        qualifiedId: `${GITHUB_PLUGIN_ID}/actions/automation/reset-repository-event-baseline-v1`,
      },
      surface: 'plugin' as const,
      signal: new AbortController().signal,
      services: {
        actions: {
          execute: vi.fn(async (actionId: string, input: unknown) => {
            if (actionId === 'automation.event.sources.list') return await sourceList(input);
            if (actionId === 'automation.event.source.status.report') {
              return {} satisfies PluginActionResultById['automation.event.source.status.report'];
            }
            throw new Error(`unexpected Action ${actionId}`);
          }),
        },
        connectedAccounts: {
          materialize: vi.fn(async () => ({
            kind: 'httpHeaders' as const,
            headers: { Authorization: 'Bearer stale-definition-token' },
          })),
        },
        http: createPluginHttpFixture({ request: http.request }),
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as PluginInvocationContext;

    await expect(resetGithubRepositoryEventHistoryGap({
      automationId: source.automationId,
      triggerId: source.triggerId,
      triggerRevision: source.triggerRevision,
      sourceSelectorId: source.sourceSelectorId,
    }, context)).resolves.toEqual({ kind: 'stale' });

    expect(sourceList).toHaveBeenCalledTimes(2);
    expect(http.request).not.toHaveBeenCalled();
    expect(checkpoints.read(rowId)).toMatchObject({
      revision: 1,
      value: { payload: { continuity: expect.objectContaining({ historyGap: true }) } },
    });
  });

  it('does not baseline after the exact source revision changes during GitHub I/O', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const rowId = createGithubAutomationEventCheckpointRowId({
      automationId: source.automationId,
      triggerId: source.triggerId,
      eventRef: source.eventRef,
      sourceSelectorId: source.sourceSelectorId,
    });
    const checkpoints = createCheckpointCollection([
      historyGapCheckpointRow({ automationId: source.automationId, sourceSelectorId: source.sourceSelectorId }),
    ]);
    let sourceListCalls = 0;
    const sourceList = vi.fn(async (input: unknown) => {
      sourceListCalls += 1;
      const request = input as PluginActionInputById['automation.event.sources.list'];
      if (sourceListCalls === 1) {
        expect(request).toEqual({ transport: { kind: 'checkpointedPull' } });
        return sourceListResult(input, '7', [source]);
      }
      expect(request).toEqual({
        transport: { kind: 'checkpointedPull' }, knownRevision: '7',
      });
      if (sourceListCalls === 2 || sourceListCalls === 3) {
        return { kind: 'unchanged', revision: '7' } satisfies PluginActionResultById['automation.event.sources.list'];
      }
      return sourceListResult(input, '8', []);
    });
    const http = {
      request: vi.fn(async () => ({
        status: 200,
        headers: { etag: 'stale-after-io-etag' },
        body: new TextEncoder().encode(JSON.stringify([])),
      })),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: {
        id: 'automation/reset-repository-event-baseline-v1',
        qualifiedId: `${GITHUB_PLUGIN_ID}/actions/automation/reset-repository-event-baseline-v1`,
      },
      surface: 'plugin' as const,
      signal: new AbortController().signal,
      services: {
        actions: {
          execute: vi.fn(async (actionId: string, input: unknown) => {
            if (actionId === 'automation.event.sources.list') return await sourceList(input);
            if (actionId === 'automation.event.source.status.report') {
              return {} satisfies PluginActionResultById['automation.event.source.status.report'];
            }
            throw new Error(`unexpected Action ${actionId}`);
          }),
        },
        connectedAccounts: {
          materialize: vi.fn(async () => ({
            kind: 'httpHeaders' as const,
            headers: { Authorization: 'Bearer stale-after-io-token' },
          })),
        },
        http: createPluginHttpFixture({ request: http.request }),
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as PluginInvocationContext;

    await expect(resetGithubRepositoryEventHistoryGap({
      automationId: source.automationId,
      triggerId: source.triggerId,
      triggerRevision: source.triggerRevision,
      sourceSelectorId: source.sourceSelectorId,
    }, context)).resolves.toEqual({ kind: 'stale' });

    expect(sourceList).toHaveBeenCalledTimes(4);
    expect(http.request).toHaveBeenCalledOnce();
    expect(checkpoints.read(rowId)).toMatchObject({
      revision: 1,
      value: { payload: { continuity: expect.objectContaining({ historyGap: true }) } },
    });
  });

  it('does not authenticate a reset source after its definition changes while loading the history-gap checkpoint', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const rowId = createGithubAutomationEventCheckpointRowId({
      automationId: source.automationId,
      triggerId: source.triggerId,
      eventRef: source.eventRef,
      sourceSelectorId: source.sourceSelectorId,
    });
    let definitionCurrent = true;
    const checkpoints = createCheckpointCollection([
      historyGapCheckpointRow({ automationId: source.automationId, sourceSelectorId: source.sourceSelectorId }),
    ], {
      beforeGet: async () => {
        definitionCurrent = false;
      },
    });
    const sourceList = vi.fn(async (input: unknown) => {
      const request = input as PluginActionInputById['automation.event.sources.list'];
      if (request.knownRevision === undefined) {
        expect(request).toEqual({ transport: { kind: 'checkpointedPull' } });
        return sourceListResult(input, '7', [source]);
      }
      expect(request).toEqual({
        transport: { kind: 'checkpointedPull' }, knownRevision: '7',
      });
      return definitionCurrent
        ? { kind: 'unchanged', revision: '7' } satisfies PluginActionResultById['automation.event.sources.list']
        : { kind: 'page', revision: '8', definitions: [], nextCursor: null } satisfies PluginActionResultById['automation.event.sources.list'];
    });
    const materialize = vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: { Authorization: 'Bearer checkpoint-race-token' },
    }));
    const http = {
      request: vi.fn(async () => ({
        status: 200,
        headers: { etag: 'checkpoint-race-etag' },
        body: new TextEncoder().encode(JSON.stringify([])),
      })),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: {
        id: 'automation/reset-repository-event-baseline-v1',
        qualifiedId: `${GITHUB_PLUGIN_ID}/actions/automation/reset-repository-event-baseline-v1`,
      },
      surface: 'plugin' as const,
      signal: new AbortController().signal,
      services: {
        actions: {
          execute: vi.fn(async (actionId: string, input: unknown) => {
            if (actionId === 'automation.event.sources.list') return await sourceList(input);
            throw new Error(`unexpected Action ${actionId}`);
          }),
        },
        connectedAccounts: { materialize },
        http: createPluginHttpFixture({ request: http.request }),
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as PluginInvocationContext;

    await expect(resetGithubRepositoryEventHistoryGap({
      automationId: source.automationId,
      triggerId: source.triggerId,
      triggerRevision: source.triggerRevision,
      sourceSelectorId: source.sourceSelectorId,
    }, context)).resolves.toEqual({ kind: 'stale' });

    expect(sourceList).toHaveBeenCalledTimes(3);
    expect(materialize).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
    expect(checkpoints.read(rowId)).toMatchObject({
      revision: 1,
      value: { payload: { continuity: expect.objectContaining({ historyGap: true }) } },
    });
  });

  it('does not authenticate or rewrite a history gap when the current source is no longer authorized', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const rowId = createGithubAutomationEventCheckpointRowId({
      automationId: 'automation-a',
      triggerId: 'trigger-automation-a',
      eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: EVENT_LOCAL_ID },
      sourceSelectorId: sourceSelectorA,
    });
    const checkpoints = createCheckpointCollection([
      historyGapCheckpointRow({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA }),
    ]);
    const http = { request: vi.fn() };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: {
        id: 'automation/reset-repository-event-baseline-v1',
        qualifiedId: `${GITHUB_PLUGIN_ID}/actions/automation/reset-repository-event-baseline-v1`,
      },
      surface: 'plugin' as const,
      signal: new AbortController().signal,
      services: {
        actions: {
          execute: vi.fn(async (actionId: string, requestInput: unknown) => {
            if (actionId !== 'automation.event.sources.list') throw new Error(`unexpected Action ${actionId}`);
            return sourceListResult(requestInput, '8', []);
          }),
        },
        connectedAccounts: { materialize: vi.fn() },
        http: createPluginHttpFixture({ request: http.request }),
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as PluginInvocationContext;

    await expect(resetGithubRepositoryEventHistoryGap({
      automationId: source.automationId,
      triggerId: source.triggerId,
      triggerRevision: source.triggerRevision,
      sourceSelectorId: source.sourceSelectorId,
    }, context)).resolves.toEqual({ kind: 'stale' });

    expect(http.request).not.toHaveBeenCalled();
    expect(checkpoints.read(rowId)).toMatchObject({
      revision: 1,
      value: { payload: { continuity: expect.objectContaining({ historyGap: true }) } },
    });
  });

  it('does not turn an ordinary current checkpoint into a new baseline', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const rowId = createGithubAutomationEventCheckpointRowId({
      automationId: 'automation-a',
      triggerId: 'trigger-automation-a',
      eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: EVENT_LOCAL_ID },
      sourceSelectorId: sourceSelectorA,
    });
    const checkpoints = createCheckpointCollection([
      checkpointRow({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA }),
    ]);
    const http = { request: vi.fn() };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: {
        id: 'automation/reset-repository-event-baseline-v1',
        qualifiedId: `${GITHUB_PLUGIN_ID}/actions/automation/reset-repository-event-baseline-v1`,
      },
      surface: 'plugin' as const,
      signal: new AbortController().signal,
      services: {
        actions: {
          execute: vi.fn(async (actionId: string, input: unknown) => {
            if (actionId !== 'automation.event.sources.list') throw new Error(`unexpected Action ${actionId}`);
            const request = input as PluginActionInputById['automation.event.sources.list'];
            if (request.knownRevision !== undefined) {
              expect(request).toEqual({
                transport: { kind: 'checkpointedPull' }, knownRevision: '7',
              });
              return { kind: 'unchanged', revision: '7' } satisfies PluginActionResultById['automation.event.sources.list'];
            }
            return sourceListResult(input, '7', [source]);
          }),
        },
        connectedAccounts: { materialize: vi.fn() },
        http: createPluginHttpFixture({ request: http.request }),
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as PluginInvocationContext;

    await expect(resetGithubRepositoryEventHistoryGap({
      automationId: source.automationId,
      triggerId: source.triggerId,
      triggerRevision: source.triggerRevision,
      sourceSelectorId: source.sourceSelectorId,
    }, context)).resolves.toEqual({ kind: 'noHistoryGap' });

    expect(http.request).not.toHaveBeenCalled();
    expect(checkpoints.read(rowId)).toMatchObject({
      revision: 1,
      value: {
        payload: {
          cursor: { etag: 'prior-etag', seenEventIds: ['old'] },
          continuity: { endpointKind: 'repositoryEvents', repositoryId: '77' },
        },
      },
    });
  });

  it('does not replace a history gap when the checkpoint CAS is stale', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const rowId = createGithubAutomationEventCheckpointRowId({
      automationId: 'automation-a',
      triggerId: 'trigger-automation-a',
      eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: EVENT_LOCAL_ID },
      sourceSelectorId: sourceSelectorA,
    });
    const checkpoints = createCheckpointCollection([
      historyGapCheckpointRow({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA }),
    ], { forcePutConflict: true });
    const http = {
      request: vi.fn(async () => ({
        status: 200,
        headers: { etag: 'fresh-etag' },
        body: new TextEncoder().encode(JSON.stringify([])),
      })),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: {
        id: 'automation/reset-repository-event-baseline-v1',
        qualifiedId: `${GITHUB_PLUGIN_ID}/actions/automation/reset-repository-event-baseline-v1`,
      },
      surface: 'plugin' as const,
      signal: new AbortController().signal,
      services: {
        actions: {
          execute: vi.fn(async (actionId: string, input: unknown) => {
            if (actionId !== 'automation.event.sources.list') throw new Error(`unexpected Action ${actionId}`);
            const request = input as PluginActionInputById['automation.event.sources.list'];
            if (request.knownRevision !== undefined) {
              expect(request).toEqual({
                transport: { kind: 'checkpointedPull' }, knownRevision: '7',
              });
              return { kind: 'unchanged', revision: '7' } satisfies PluginActionResultById['automation.event.sources.list'];
            }
            return sourceListResult(input, '7', [source]);
          }),
        },
        connectedAccounts: {
          materialize: vi.fn(async () => ({
            kind: 'httpHeaders' as const,
            headers: { Authorization: 'Bearer exact-account-token' },
          })),
        },
        http: createPluginHttpFixture({ request: http.request }),
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as PluginInvocationContext;

    await expect(resetGithubRepositoryEventHistoryGap({
      automationId: source.automationId,
      triggerId: source.triggerId,
      triggerRevision: source.triggerRevision,
      sourceSelectorId: source.sourceSelectorId,
    }, context)).resolves.toEqual({ kind: 'stale' });

    expect(http.request).toHaveBeenCalledOnce();
    expect(checkpoints.read(rowId)).toMatchObject({
      revision: 1,
      value: { payload: { continuity: expect.objectContaining({ historyGap: true }) } },
    });
  });

  it('does not replace a history gap after the explicit baseline Action is cancelled', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const rowId = createGithubAutomationEventCheckpointRowId({
      automationId: 'automation-a',
      triggerId: 'trigger-automation-a',
      eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: EVENT_LOCAL_ID },
      sourceSelectorId: sourceSelectorA,
    });
    const checkpoints = createCheckpointCollection([
      historyGapCheckpointRow({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA }),
    ]);
    const controller = new AbortController();
    const cancellation = new Error('GitHub baseline action retired');
    const http = {
      request: vi.fn(async () => {
        controller.abort(cancellation);
        return {
          status: 200,
          headers: { etag: 'fresh-etag' },
          body: new TextEncoder().encode(JSON.stringify([])),
        };
      }),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: {
        id: 'automation/reset-repository-event-baseline-v1',
        qualifiedId: `${GITHUB_PLUGIN_ID}/actions/automation/reset-repository-event-baseline-v1`,
      },
      surface: 'plugin' as const,
      signal: controller.signal,
      services: {
        actions: {
          execute: vi.fn(async (actionId: string, input: unknown) => {
            if (actionId !== 'automation.event.sources.list') throw new Error(`unexpected Action ${actionId}`);
            const request = input as PluginActionInputById['automation.event.sources.list'];
            if (request.knownRevision !== undefined) {
              expect(request).toEqual({
                transport: { kind: 'checkpointedPull' }, knownRevision: '7',
              });
              return { kind: 'unchanged', revision: '7' } satisfies PluginActionResultById['automation.event.sources.list'];
            }
            return sourceListResult(input, '7', [source]);
          }),
        },
        connectedAccounts: {
          materialize: vi.fn(async () => ({
            kind: 'httpHeaders' as const,
            headers: { Authorization: 'Bearer exact-account-token' },
          })),
        },
        http: createPluginHttpFixture({ request: http.request }),
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as PluginInvocationContext;

    await expect(resetGithubRepositoryEventHistoryGap({
      automationId: source.automationId,
      triggerId: source.triggerId,
      triggerRevision: source.triggerRevision,
      sourceSelectorId: source.sourceSelectorId,
    }, context)).rejects.toBe(cancellation);

    expect(http.request).toHaveBeenCalledOnce();
    expect(checkpoints.read(rowId)).toMatchObject({
      revision: 1,
      value: { payload: { continuity: expect.objectContaining({ historyGap: true }) } },
    });
  });

  it('adopts a complete checkpointed-pull source catalog after a cursor chain beyond the former page ceiling', async () => {
    const checkpoints = createCheckpointCollection([]);
    let sourceListCalls = 0;
    const statuses: AutomationEventSourceStatusReport[] = [];
    const nonCatalogActions: unknown[] = [];
    const pages: SourceDefinition[] = Array.from({ length: 21 }, (_, index) => ({
      ...definition({
        automationId: `automation-${index + 1}`,
        sourceSelectorId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      }),
      eventRef: { pluginId: 'other.plugin', localId: 'other-event' },
    }));
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          const request = input as PluginActionInputById['automation.event.sources.list'];
          if (request.knownRevision === '7') return { kind: 'unchanged', revision: '7' };
          sourceListCalls += 1;
          expect(request).toEqual(sourceListCalls === 1
            ? { transport: { kind: 'checkpointedPull' }, catalogRefresh: { kind: 'refresh' } }
            : { transport: { kind: 'checkpointedPull' }, cursor: `page-${sourceListCalls - 1}` });
          return {
            kind: 'page',
            revision: '7',
            definitions: [pages[sourceListCalls - 1]!],
            nextCursor: sourceListCalls === pages.length ? null : `page-${sourceListCalls}`,
          } satisfies PluginActionResultById['automation.event.sources.list'];
        }
        if (actionId === 'automation.event.source.status.report') {
          statuses.push(input as AutomationEventSourceStatusReport);
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        nonCatalogActions.push(actionId);
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: { id: 'observer', qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/observer` },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      signal: new AbortController().signal,
      // A catalog only becomes current once its checkpoint rows reconcile, so
      // this fixture supplies the Account Collection that pass reads.
      services: { actions, storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
        http: createPluginHttpFixture({ request: async () => { throw new Error('Unexpected provider request'); } }) },
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });

    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(sourceListCalls).toBe(pages.length);
    expect(nonCatalogActions).toEqual([]);
    expect(catalogStatuses(statuses)).toEqual(expect.arrayContaining([
      expect.objectContaining({ observedRevision: '7', adoptedRevision: '7', state: 'current' }),
    ]));
  });

  it('reconciles paged Account-scoped checkpoint rows only after a complete adopted source scan', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const rotated = definition({
      automationId: 'automation-b',
      sourceSelectorId: sourceSelectorB,
      repositoryId: '88',
    });
    const exactRowId = createGithubAutomationEventCheckpointRowId({
      automationId: source.automationId,
      triggerId: source.triggerId,
      eventRef: source.eventRef,
      sourceSelectorId: source.sourceSelectorId,
    });
    const rotatedRowId = createGithubAutomationEventCheckpointRowId({
      automationId: rotated.automationId,
      triggerId: rotated.triggerId,
      eventRef: rotated.eventRef,
      sourceSelectorId: rotated.sourceSelectorId,
    });
    const elsewhereRowId = createGithubAutomationEventCheckpointRowId({
      automationId: 'automation-watched-elsewhere',
      triggerId: 'trigger-automation-watched-elsewhere',
      eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: EVENT_LOCAL_ID },
      sourceSelectorId: sourceSelectorB,
    });
    const exactCheckpoint = checkpointRow({
      automationId: source.automationId,
      sourceSelectorId: source.sourceSelectorId,
    });
    const retiredCheckpoint = checkpointRow({
      automationId: rotated.automationId,
      sourceSelectorId: rotated.sourceSelectorId,
      sourceInstanceId: 'github:repository:88',
      sourceContractVersion: 2,
    });
    const elsewhereCheckpoint = checkpointRow({
      automationId: 'automation-watched-elsewhere',
      sourceSelectorId: sourceSelectorB,
      sourceInstanceId: 'github:repository:99',
    });
    const checkpoints = createCheckpointCollection([
      exactCheckpoint,
      retiredCheckpoint,
      elsewhereCheckpoint,
    ], { pageSize: 1 });
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          const request = input as PluginActionInputById['automation.event.sources.list'];
          if (request.checkpointRetirementCandidates !== undefined) {
            expect(request).toMatchObject({
              transport: { kind: 'checkpointedPull' },
              knownRevision: '7',
            });
            return {
              kind: 'unchanged',
              revision: '7',
              checkpointRetirements: request.checkpointRetirementCandidates.filter(
                (candidate) => candidate.automationId === rotated.automationId,
              ),
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          return sourceListResult(input, '7', [source, rotated]);
        }
        if (actionId === 'automation.event.source.status.report') {
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    const context = observerBackgroundContext({
      actions,
      collection: checkpoints.collection,
      http: {
        request: vi.fn(async () => ({
          status: 200,
          headers: { etag: 'paged-reconciliation' },
          body: new TextEncoder().encode(JSON.stringify([])),
        })),
      },
    });

    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(checkpoints.query).toHaveBeenCalledTimes(3);
    // The observer only applies the server's bounded retirement subset. Its
    // caller-scoped catalog never decides whether a checkpoint is retired.
    expect(checkpoints.delete).toHaveBeenCalledTimes(1);
    expect(checkpoints.delete).toHaveBeenCalledWith(rotatedRowId, expect.anything());
    expect(checkpoints.read(exactRowId)).not.toBeNull();
    expect(checkpoints.read(elsewhereRowId)).not.toBeNull();
  });

  it('deletes only the server-classified retired checkpoints through their existing Collection CAS', async () => {
    const absent = checkpointRow({
      automationId: 'automation-absent', sourceSelectorId: sourceSelectorA, sourceInstanceId: 'github:repository:71',
    });
    const softDeletedWithoutRuns = checkpointRow({
      automationId: 'automation-deleted-empty', sourceSelectorId: sourceSelectorB, sourceInstanceId: 'github:repository:72',
    });
    const selectorChanged = checkpointRow({
      automationId: 'automation-selector-changed',
      sourceSelectorId: '00000000-0000-4000-8000-000000000003',
      sourceInstanceId: 'github:repository:73',
    });
    const contractChanged = checkpointRow({
      automationId: 'automation-contract-changed',
      sourceSelectorId: '00000000-0000-4000-8000-000000000004',
      sourceInstanceId: 'github:repository:74',
    });
    const disabled = checkpointRow({
      automationId: 'automation-disabled',
      sourceSelectorId: '00000000-0000-4000-8000-000000000005',
      sourceInstanceId: 'github:repository:75',
    });
    const softDeletedWithRun = checkpointRow({
      automationId: 'automation-deleted-retained-run',
      sourceSelectorId: '00000000-0000-4000-8000-000000000006',
      sourceInstanceId: 'github:repository:76',
    });
    const checkpoints = createCheckpointCollection([
      absent,
      softDeletedWithoutRuns,
      selectorChanged,
      contractChanged,
      disabled,
      softDeletedWithRun,
    ]);
    const retired = [absent, softDeletedWithoutRuns, selectorChanged, contractChanged]
      .map(checkpointRetirementCandidate);
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          const request = input as PluginActionInputById['automation.event.sources.list'];
          if (request.checkpointRetirementCandidates === undefined) {
            expect(request.transport).toEqual({ kind: 'checkpointedPull' });
            return sourceListResult(input, '7', []);
          }
          expect(request).toEqual({
            transport: { kind: 'checkpointedPull' },
            knownRevision: '7',
            checkpointRetirementCandidates: expect.arrayContaining([
              checkpointRetirementCandidate(absent),
              checkpointRetirementCandidate(softDeletedWithoutRuns),
              checkpointRetirementCandidate(selectorChanged),
              checkpointRetirementCandidate(contractChanged),
              checkpointRetirementCandidate(disabled),
              checkpointRetirementCandidate(softDeletedWithRun),
            ]),
          });
          return {
            kind: 'unchanged', revision: '7', checkpointRetirements: retired,
          } satisfies PluginActionResultById['automation.event.sources.list'];
        }
        if (actionId === 'automation.event.source.status.report') {
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    const context = observerBackgroundContext({
      actions,
      collection: checkpoints.collection,
      http: { request: vi.fn() },
    });

    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(checkpoints.delete).toHaveBeenCalledTimes(4);
    for (const row of [absent, softDeletedWithoutRuns, selectorChanged, contractChanged]) {
      expect(checkpoints.read(row.id)).toBeNull();
    }
    expect(checkpoints.read(disabled.id)).not.toBeNull();
    expect(checkpoints.read(softDeletedWithRun.id)).not.toBeNull();
  });

  it('withholds checkpoint CAS when server retirement classification races the adopted revision', async () => {
    const row = checkpointRow({ automationId: 'automation-raced', sourceSelectorId: sourceSelectorA });
    const checkpoints = createCheckpointCollection([row]);
    const statuses: AutomationEventSourceStatusReport[] = [];
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          const request = input as PluginActionInputById['automation.event.sources.list'];
          if (request.checkpointRetirementCandidates === undefined) {
            return sourceListResult(input, '7', []);
          }
          expect(request).toMatchObject({
            transport: { kind: 'checkpointedPull' },
            knownRevision: '7',
            checkpointRetirementCandidates: [checkpointRetirementCandidate(row)],
          });
          return {
            kind: 'cursorStale', currentRevision: '8',
          } satisfies PluginActionResultById['automation.event.sources.list'];
        }
        if (actionId === 'automation.event.source.status.report') {
          statuses.push(input as AutomationEventSourceStatusReport);
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    const context = observerBackgroundContext({
      actions,
      collection: checkpoints.collection,
      http: { request: vi.fn() },
    });

    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(checkpoints.delete).not.toHaveBeenCalled();
    expect(checkpoints.read(row.id)).not.toBeNull();
    expect(catalogStatuses(statuses)).toEqual(expect.arrayContaining([
      expect.objectContaining({ observedRevision: '7', adoptedRevision: null, state: 'reconciling' }),
    ]));
  });

  it('fails closed without retiring a same-key checkpoint when only its source instance rotates', async () => {
    const source = definition({
      automationId: 'automation-a',
      sourceSelectorId: sourceSelectorA,
      repositoryId: '88',
    });
    const rowId = createGithubAutomationEventCheckpointRowId({
      automationId: source.automationId,
      triggerId: source.triggerId,
      eventRef: source.eventRef,
      sourceSelectorId: source.sourceSelectorId,
    });
    const retainedCheckpoint = checkpointRow({
      automationId: source.automationId,
      sourceSelectorId: source.sourceSelectorId,
      sourceInstanceId: 'github:repository:77',
    });
    const checkpoints = createCheckpointCollection([retainedCheckpoint]);
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          const request = input as PluginActionInputById['automation.event.sources.list'];
          if (request.checkpointRetirementCandidates !== undefined) {
            expect(request).toMatchObject({
              transport: { kind: 'checkpointedPull' },
              knownRevision: '7',
              checkpointRetirementCandidates: [checkpointRetirementCandidate(retainedCheckpoint)],
            });
            return {
              kind: 'unchanged', revision: '7', checkpointRetirements: [],
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          return sourceListResult(input, '7', [source]);
        }
        if (actionId === 'automation.event.source.status.report') {
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    const context = observerBackgroundContext({
      actions,
      collection: checkpoints.collection,
      http: {
        request: vi.fn(async () => ({
          status: 200,
          headers: { etag: 'repository-88' },
          body: new TextEncoder().encode(JSON.stringify([])),
        })),
      },
    });

    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(checkpoints.delete).not.toHaveBeenCalled();
    expect(checkpoints.read(rowId)).toMatchObject({
      value: { payload: { sourceInstanceId: 'github:repository:77', sourceContractVersion: 1 } },
    });
  });

  it('retires the predecessor checkpoint when trigger source-selector identity changes', async () => {
    const rotated = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorB });
    const predecessorRowId = createGithubAutomationEventCheckpointRowId({
      automationId: 'automation-a',
      triggerId: 'trigger-automation-a',
      eventRef: rotated.eventRef,
      sourceSelectorId: sourceSelectorA,
    });
    const predecessor = checkpointRow({
      automationId: 'automation-a',
      sourceSelectorId: sourceSelectorA,
    });
    const checkpoints = createCheckpointCollection([predecessor]);
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          const request = input as PluginActionInputById['automation.event.sources.list'];
          if (request.checkpointRetirementCandidates !== undefined) {
            expect(request.checkpointRetirementCandidates).toEqual([
              expect.objectContaining({
                automationId: 'automation-a',
                triggerId: 'trigger-automation-a',
                sourceSelectorId: sourceSelectorA,
              }),
            ]);
            return {
              kind: 'unchanged',
              revision: '7',
              checkpointRetirements: request.checkpointRetirementCandidates,
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          return sourceListResult(input, '7', [rotated]);
        }
        if (actionId === 'automation.event.source.status.report') {
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    const context = observerBackgroundContext({
      actions,
      collection: checkpoints.collection,
      http: {
        request: vi.fn(async () => ({
          status: 200,
          headers: { etag: 'selector-rotated' },
          body: new TextEncoder().encode(JSON.stringify([])),
        })),
      },
    });

    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(checkpoints.delete).toHaveBeenCalledWith(
      predecessorRowId,
      expect.objectContaining({ expectedRevision: 1 }),
    );
    expect(checkpoints.read(createGithubAutomationEventCheckpointRowId({
      automationId: rotated.automationId,
      triggerId: rotated.triggerId,
      eventRef: rotated.eventRef,
      sourceSelectorId: rotated.sourceSelectorId,
    }))).toMatchObject({
      value: {
        [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.sourceSelectorId]: sourceSelectorB,
      },
    });
    expect(checkpoints.rowCount()).toBe(1);
  });

  it('retires a retained checkpoint when its source contract is no longer compatible', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const currentRowId = createGithubAutomationEventCheckpointRowId({
      automationId: source.automationId,
      triggerId: source.triggerId,
      eventRef: source.eventRef,
      sourceSelectorId: source.sourceSelectorId,
    });
    const retiredCheckpoint = checkpointRow({
      automationId: source.automationId,
      sourceSelectorId: source.sourceSelectorId,
      sourceContractVersion: 2,
    });
    const checkpoints = createCheckpointCollection([retiredCheckpoint]);
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          const request = input as PluginActionInputById['automation.event.sources.list'];
          if (request.checkpointRetirementCandidates !== undefined) {
            expect(request).toMatchObject({
              transport: { kind: 'checkpointedPull' },
              knownRevision: '7',
              checkpointRetirementCandidates: [checkpointRetirementCandidate(retiredCheckpoint)],
            });
            return {
              kind: 'unchanged',
              revision: '7',
              checkpointRetirements: request.checkpointRetirementCandidates,
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          return sourceListResult(input, '7', [source]);
        }
        if (actionId === 'automation.event.source.status.report') {
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    const context = observerBackgroundContext({
      actions,
      collection: checkpoints.collection,
      http: {
        request: vi.fn(async () => ({
          status: 200,
          headers: { etag: 'source-contract-1' },
          body: new TextEncoder().encode(JSON.stringify([])),
        })),
      },
    });

    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(checkpoints.delete).toHaveBeenCalledTimes(1);
    expect(checkpoints.read(currentRowId)).toMatchObject({
      revision: 1,
      value: { payload: { sourceContractVersion: 1 } },
    });
  });

  it('fails closed when a checkpointed-pull source page is empty but has a continuation cursor', async () => {
    let sourceListCalls = 0;
    const statuses: AutomationEventSourceStatusReport[] = [];
    const nonCatalogActions: unknown[] = [];
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          sourceListCalls += 1;
          if (sourceListCalls > 1) throw new Error('source scan followed an empty continuation');
          return {
            kind: 'page', revision: '7', definitions: [], nextCursor: 'page-2',
          } satisfies PluginActionResultById['automation.event.sources.list'];
        }
        if (actionId === 'automation.event.source.status.report') {
          statuses.push(input as AutomationEventSourceStatusReport);
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        nonCatalogActions.push(actionId);
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    // This scenario fails closed before any checkpoint row is read, but the
    // Account Collection is still a real empty store rather than an undefined
    // binding that would only fault if the pass ever reached it.
    const checkpoints = createCheckpointCollection([]);
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: { id: 'observer', qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/observer` },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      signal: new AbortController().signal,
      // A catalog only becomes current once its checkpoint rows reconcile, so
      // this fixture supplies the Account Collection that pass reads.
      services: { actions, storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
        http: createPluginHttpFixture({ request: async () => { throw new Error('Unexpected provider request'); } }) },
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });

    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(sourceListCalls).toBe(1);
    expect(nonCatalogActions).toEqual([]);
    expect(catalogStatuses(statuses)).toEqual(expect.arrayContaining([
      expect.objectContaining({ observedRevision: '7', adoptedRevision: null, state: 'reconciling' }),
    ]));
  });

  it('retains no partial checkpointed-pull source snapshot when a cursor repeats', async () => {
    const firstSource = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const secondSource = definition({ automationId: 'automation-b', sourceSelectorId: sourceSelectorB });
    let sourceListCalls = 0;
    const statuses: AutomationEventSourceStatusReport[] = [];
    const nonCatalogActions: unknown[] = [];
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          sourceListCalls += 1;
          if (sourceListCalls === 1) {
            return {
              kind: 'page', revision: '7', definitions: [firstSource], nextCursor: 'page-2',
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          if (sourceListCalls === 2) {
            return {
              kind: 'page', revision: '7', definitions: [secondSource], nextCursor: 'page-2',
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          throw new Error('source scan followed a repeated cursor');
        }
        if (actionId === 'automation.event.source.status.report') {
          statuses.push(input as AutomationEventSourceStatusReport);
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        nonCatalogActions.push(actionId);
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    // This scenario fails closed before any checkpoint row is read, but the
    // Account Collection is still a real empty store rather than an undefined
    // binding that would only fault if the pass ever reached it.
    const checkpoints = createCheckpointCollection([]);
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: { id: 'observer', qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/observer` },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      signal: new AbortController().signal,
      // A catalog only becomes current once its checkpoint rows reconcile, so
      // this fixture supplies the Account Collection that pass reads.
      services: { actions, storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
        http: createPluginHttpFixture({ request: async () => { throw new Error('Unexpected provider request'); } }) },
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });

    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(sourceListCalls).toBe(2);
    expect(nonCatalogActions).toEqual([]);
    expect(catalogStatuses(statuses)).toEqual(expect.arrayContaining([
      expect.objectContaining({ observedRevision: '7', adoptedRevision: null, state: 'reconciling' }),
    ]));
  });

  it('never retires checkpoints from partial, unavailable, stale, revision-changing, or cancelled source reads', async () => {
    const cases = [
      'partial',
      'unavailable',
      'cursorStale',
      'revisionChanged',
      'cancelled',
    ] as const;
    for (const kind of cases) {
      const orphan = checkpointRow({
        automationId: `automation-orphan-${kind}`,
        sourceSelectorId: sourceSelectorA,
      });
      const checkpoints = createCheckpointCollection([]);
      const controller = new AbortController();
      const cancellation = new Error(`source read ${kind} cancelled`);
      const foreignSource = {
        ...definition({
          automationId: `automation-foreign-${kind}`,
          sourceSelectorId: sourceSelectorB,
        }),
        eventRef: { pluginId: 'other.plugin', localId: 'other-event' },
      } as const satisfies SourceDefinition;
      let initialScan = true;
      let failedScanCalls = 0;
      const actions = {
        execute: vi.fn(async (actionId: string, input: unknown) => {
          if (actionId === 'automation.event.source.status.report') {
            return {} satisfies PluginActionResultById['automation.event.source.status.report'];
          }
          if (actionId !== 'automation.event.sources.list') throw new Error(`unexpected Action ${actionId}`);
          const request = input as PluginActionInputById['automation.event.sources.list'];
          if (initialScan) {
            expect(request).toEqual({ transport: { kind: 'checkpointedPull' } });
            return {
              kind: 'page', revision: '7', definitions: [], nextCursor: null,
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          failedScanCalls += 1;
          if (kind === 'unavailable') throw new Error('source catalog unavailable');
          if (kind === 'cursorStale') {
            return { kind: 'cursorStale', currentRevision: '8' } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          if (kind === 'cancelled') {
            controller.abort(cancellation);
            return {
              kind: 'page', revision: '7', definitions: [], nextCursor: null,
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          if (kind === 'revisionChanged' && failedScanCalls === 2) {
            return {
              kind: 'page', revision: '9', definitions: [], nextCursor: null,
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          if (kind === 'revisionChanged') {
            return {
              kind: 'page', revision: '7', definitions: [foreignSource], nextCursor: 'page-2',
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          return {
            kind: 'page', revision: '7', definitions: [], nextCursor: 'page-2',
          } satisfies PluginActionResultById['automation.event.sources.list'];
        }),
      };
      const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
      const context = observerBackgroundContext({
        actions,
        collection: checkpoints.collection,
        signal: controller.signal,
      });

      await observer.runCycle(sourceAttemptContext(observer, context));
      await checkpoints.collection.put(orphan, { expectedRevision: 'absent' });
      checkpoints.query.mockClear();
      checkpoints.delete.mockClear();
      initialScan = false;
      if (kind === 'cancelled') {
        await expect(observer.runCycle(context)).rejects.toBe(cancellation);
      } else {
        await observer.runCycle(sourceAttemptContext(observer, context));
      }

      expect(checkpoints.query).not.toHaveBeenCalled();
      expect(checkpoints.delete).not.toHaveBeenCalled();
      expect(checkpoints.read(orphan.id)).not.toBeNull();
    }
  });

  it('retains a checkpoint the caller-scoped source catalog does not list, including after observer restart', async () => {
    // The source catalog Action answers for ONE watcher materialization and
    // only for enabled, undeleted Automations, while the checkpoint row is
    // Account-scoped. Deleting on absence silently discards another watcher's
    // continuity, a disabled Automation's resume point, and the interval a
    // moved watcher is about to resume from.
    const elsewhere = checkpointRow({
      automationId: 'automation-watched-elsewhere',
      sourceSelectorId: sourceSelectorA,
    });
    const checkpoints = createCheckpointCollection([elsewhere]);
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          const request = input as PluginActionInputById['automation.event.sources.list'];
          if (request.checkpointRetirementCandidates !== undefined) {
            expect(request).toMatchObject({
              transport: { kind: 'checkpointedPull' },
              knownRevision: '7',
              checkpointRetirementCandidates: [checkpointRetirementCandidate(elsewhere)],
            });
            return {
              kind: 'unchanged', revision: '7', checkpointRetirements: [],
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          return sourceListResult(input, '7', []);
        }
        if (actionId === 'automation.event.source.status.report') {
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    const context = observerBackgroundContext({ actions, collection: checkpoints.collection });

    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(checkpoints.delete).not.toHaveBeenCalled();
    expect(checkpoints.read(elsewhere.id)).toMatchObject({ revision: 1 });
  });

  it('treats checkpoint-delete CAS loss as harmless and retries on the next ordinary observer cycle', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA, repositoryId: '88' });
    const retained = checkpointRow({ automationId: source.automationId, sourceSelectorId: source.sourceSelectorId,
      sourceInstanceId: source.sourceInstanceId, sourceContractVersion: 2 });
    const checkpoints = createCheckpointCollection([retained], { deleteConflictCount: 1 });
    const controller = new AbortController();
    let now = 2_000;
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') {
        const request = AutomationEventSourcesListInputV1Schema.parse(input);
        if (request.checkpointRetirementCandidates) return { kind: 'unchanged', revision: '7',
          checkpointRetirements: request.checkpointRetirementCandidates };
        return sourceListResult(input, '7', [source]);
      }
      if (action === 'automation.event.source.status.report') return {};
      throw new Error(`Unexpected Action ${action}`);
    }) };
    let waits = 0;
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => now,
      sleep: async delay => {
        if (++waits === 1) {
          expect(checkpoints.read(retained.id)?.value.payload.sourceContractVersion).toBe(2);
          now += delay;
        } else controller.abort();
      } });
    await observer.run(sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection,
      signal: controller.signal })));
    expect(checkpoints.delete).toHaveBeenCalledTimes(2);
    expect(checkpoints.read(retained.id)).toBeNull();
  });

  it('withholds a current catalog until the adopted revision reconciles its checkpoint rows', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const checkpoints = createCheckpointCollection([checkpointRow({ automationId: source.automationId,
      sourceSelectorId: source.sourceSelectorId })], { queryFailureCount: 1 });
    const controller = new AbortController();
    let now = 2_000;
    const statuses: AutomationEventSourceStatusReport[] = [];
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return sourceListResult(input, '7', [source]);
      if (action === 'automation.event.source.status.report') { statuses.push(input as AutomationEventSourceStatusReport); return {}; }
      throw new Error(`Unexpected Action ${action}`);
    }) };
    let waits = 0;
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => now,
      sleep: async delay => {
        if (++waits === 1) {
          expect(catalogStatuses(statuses).every(status => status.state !== 'current')).toBe(true);
          now += delay;
        } else controller.abort();
      } });
    await observer.run(sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection,
      signal: controller.signal })));
    expect(catalogStatuses(statuses).at(-1)).toMatchObject({
      observedRevision: '7', adoptedRevision: '7', state: 'current',
    });
  });

  it('scans checkpoint rows once for an adopted revision instead of on every unchanged cycle', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const checkpoints = createCheckpointCollection([checkpointRow({ automationId: source.automationId,
      sourceSelectorId: source.sourceSelectorId })]);
    const controller = new AbortController();
    let invalidate = () => {};
    const events = { host: { subscribe: (_target: unknown, listener: SourcesInvalidatedListener) => {
      invalidate = () => listener(sourcesInvalidated()); return { dispose() {} };
    } } };
    let now = 2_000;
    let revision = '7';
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return sourceListResult(input, revision, [source]);
      if (action === 'automation.event.source.status.report') return {};
      throw new Error(`Unexpected Action ${action}`);
    }) };
    let waits = 0;
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => now,
      sleep: async delay => {
        waits += 1;
        if (waits <= 3) expect(checkpoints.query).toHaveBeenCalledTimes(1);
        if (waits === 3) { revision = '8'; invalidate(); }
        if (waits === 4) controller.abort(); else now += delay;
      } });
    await observer.run(sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection,
      events, signal: controller.signal })));
    expect(checkpoints.query).toHaveBeenCalledTimes(2);
    expect(checkpoints.put).toHaveBeenCalledTimes(4);
  });

  it('releases checkpoint Collection quota before writing the replacement baseline', async () => {
    const source = definition({
      automationId: 'automation-a',
      sourceSelectorId: sourceSelectorA,
      repositoryId: '88',
    });
    const rowId = createGithubAutomationEventCheckpointRowId({
      automationId: source.automationId,
      triggerId: source.triggerId,
      eventRef: source.eventRef,
      sourceSelectorId: source.sourceSelectorId,
    });
    const retiredCheckpoint = checkpointRow({
      automationId: source.automationId,
      sourceSelectorId: sourceSelectorB,
    });
    const retiredRowId = createGithubAutomationEventCheckpointRowId({
      automationId: retiredCheckpoint[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.automationId],
      triggerId: retiredCheckpoint[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.triggerId],
      eventRef: source.eventRef,
      sourceSelectorId: retiredCheckpoint[GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.sourceSelectorId],
    });
    const checkpoints = createCheckpointCollection([retiredCheckpoint], { maxRows: 1 });
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          const request = input as PluginActionInputById['automation.event.sources.list'];
          if (request.checkpointRetirementCandidates !== undefined) {
            expect(request).toMatchObject({
              transport: { kind: 'checkpointedPull' },
              knownRevision: '7',
              checkpointRetirementCandidates: [checkpointRetirementCandidate(retiredCheckpoint)],
            });
            return {
              kind: 'unchanged',
              revision: '7',
              checkpointRetirements: request.checkpointRetirementCandidates,
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          return sourceListResult(input, '7', [source]);
        }
        if (actionId === 'automation.event.source.status.report') {
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    const context = observerBackgroundContext({
      actions,
      collection: checkpoints.collection,
      http: {
        request: vi.fn(async () => ({
          status: 200,
          headers: { etag: 'quota-release' },
          body: new TextEncoder().encode(JSON.stringify([])),
        })),
      },
    });

    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(checkpoints.read(retiredRowId)).toBeNull();
    expect(checkpoints.read(rowId)).toMatchObject({
      revision: 1,
      value: { payload: { sourceInstanceId: 'github:repository:88' } },
    });
  });

  it('retains the last complete revision and reports reconciliation without a guessed lateness deadline', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const checkpoints = createCheckpointCollection([]);
    const controller = new AbortController();
    let invalidate = () => {};
    const events = { host: { subscribe: (_target: unknown, listener: SourcesInvalidatedListener) => {
      invalidate = () => listener(sourcesInvalidated()); return { dispose() {} };
    } } };
    let now = 1_000;
    let churn = false;
    let waits = 0;
    const statuses: AutomationEventSourceStatusReport[] = [];
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return churn ? { kind: 'cursorStale', currentRevision: '8' }
        : sourceListResult(input, '7', [source]);
      if (action === 'automation.event.source.status.report') { statuses.push(input as AutomationEventSourceStatusReport); return {}; }
      throw new Error(`Unexpected Action ${action}`);
    }) };
    const http = { request: vi.fn(async () => ({ status: 200, headers: { etag: 'initial' },
      body: new TextEncoder().encode('[]') })) };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => now,
      sleep: async () => {
        if (++waits === 1) { now = 2_000; churn = true; invalidate(); }
        else if (waits === 2) now = 62_000;
        else controller.abort();
      } });
    await observer.run(sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection,
      http, events, signal: controller.signal })));
    expect(catalogStatuses(statuses)).toEqual(expect.arrayContaining([
      expect.objectContaining({ observedRevision: '8', adoptedRevision: '7', state: 'reconciling', scanStartedAt: 2_000 }),
    ]));
    expect(catalogStatuses(statuses).map(status => status.state)).not.toContain('reconciliationLate');
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('parks an empty pull catalog and preserves invalidation during a read: %s', async (invalidateDuringRead) => {
    vi.useFakeTimers();
    const checkpoints = createCheckpointCollection([]);
    const controller = new AbortController();
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    let sources: readonly SourceDefinition[] = [];
    let invalidate = () => {};
    const dispose = vi.fn();
    const hostSubscribe = vi.fn((_target: unknown, listener: SourcesInvalidatedListener) => {
      invalidate = () => listener(sourcesInvalidated());
      return { dispose };
    });
    let sourceReadCount = 0;
    const actions = { execute: vi.fn(async (actionId: string, requestInput: unknown) => {
      if (actionId === 'automation.event.sources.list') {
        sourceReadCount += 1;
        if (invalidateDuringRead && sourceReadCount === 1) invalidate();
        return sourceListResult(requestInput, sources.length ? '8' : '7', [...sources]);
      }
      if (actionId === 'automation.event.source.status.report') return {};
      throw new Error(`unexpected Action ${actionId}`);
    }) };
    const request = vi.fn(async () => ({ status: 200, headers: { etag: 'initial', 'x-poll-interval': '17' },
      body: new TextEncoder().encode(JSON.stringify([])) }));
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: { id: 'observer', qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/observer` },
      surface: 'background', signal: controller.signal,
      services: { actions, events: { host: { subscribe: hostSubscribe } },
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const,
          headers: { Authorization: 'Bearer github-observer-test-token' } })) },
        http: { request }, storage: { account: { collection: () => checkpoints.collection } } },
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver();
    const running = observer.run(sourceAttemptContext(observer, context));
    const sourceReads = () => actions.execute.mock.calls.filter(([id]) => id === 'automation.event.sources.list').length;
    try {
      await vi.advanceTimersByTimeAsync(0);
      const initialReads = sourceReads();
      expect(initialReads).toBeGreaterThanOrEqual(invalidateDuringRead ? 2 : 1);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sourceReads()).toBe(initialReads);
      expect(request).not.toHaveBeenCalled();
      sources = [source];
      invalidate();
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(checkpoints.rowCount()).toBe(1));
      const baseline = checkpoints.read(createGithubAutomationEventCheckpointRowId({
        automationId: source.automationId, sourceSelectorId: source.sourceSelectorId,
      }));
      const cursor = parseGithubRepositoryEventsCursor(baseline?.value.payload.cursor);
      // waitFor advances fake time: measure from the retained observation, not wait completion.
      const untilPoll = cursor.observedAtMs + 17_000 - Date.now();
      expect(untilPoll).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(untilPoll - 1);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      expect(hostSubscribe).toHaveBeenCalledWith({
        eventId: '@happier/automation/event-sources-invalidated', scope: { kind: 'account' },
      }, expect.any(Function));
    } finally {
      controller.abort();
      await running;
      vi.useRealTimers();
    }
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each([17, 3 * 86_400])('keeps the provider runner alive until abort and honors the GitHub poll interval hint: %s seconds', async seconds => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const checkpoints = createCheckpointCollection([]);
    const controller = new AbortController();
    let now = 1_000;
    const waits: number[] = [];
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          return sourceListResult(input, '7', [source]);
        }
        if (actionId === 'automation.event.source.status.report') {
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: { id: 'observer', qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/observer` },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      signal: controller.signal,
      services: {
        actions,
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer token' } })) },
        http: {
          request: vi.fn(async () => ({
            status: 200,
            headers: { etag: 'initial', 'x-poll-interval': String(seconds) },
            body: new TextEncoder().encode(JSON.stringify([])),
          })),
        },
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver({
      now: () => now,
      sleep: async (delayMs) => {
        waits.push(delayMs);
        now += delayMs;
        controller.abort();
      },
    });

    await observer.run(sourceAttemptContext(observer, context));

    expect(waits).toEqual([seconds * 1_000]);
    expect(context.services.http.request).toHaveBeenCalledTimes(1);
  });

  it('retries a transient source-list failure without discarding the retained complete source set', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const checkpoints = createCheckpointCollection([]);
    const controller = new AbortController();
    let invalidate = () => {};
    const events = { host: { subscribe: (_target: unknown, listener: SourcesInvalidatedListener) => {
      invalidate = () => listener(sourcesInvalidated()); return { dispose() {} };
    } } };
    let now = 1_000;
    let sourceListCalls = 0;
    let failNextRead = false;
    const waits: number[] = [];
    const http = {
      request: vi.fn(async () => ({
        status: 200,
        headers: { etag: 'initial' },
        body: new TextEncoder().encode(JSON.stringify([])),
      })),
    };
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          sourceListCalls += 1;
          if (failNextRead) { failNextRead = false; throw new Error('temporary Automation source catalog failure'); }
          return sourceListResult(input, '7', [source]);
        }
        if (actionId === 'automation.event.source.status.report') {
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: { id: 'observer', qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/observer` },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      signal: controller.signal,
      services: {
        actions, events,
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer token' } })) },
        http: createPluginHttpFixture({ request: http.request }),
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver({
      now: () => now,
      sleep: async (delayMs) => {
        waits.push(delayMs);
        now += delayMs;
        if (waits.length === 1) { failNextRead = true; invalidate(); }
        if (waits.length === 3) controller.abort();
      },
    });

    await observer.run(sourceAttemptContext(observer, context));

    expect(waits).toEqual([60_000, 1_000, 60_000]);
    expect(sourceListCalls).toBeGreaterThanOrEqual(3);
    expect(http.request).toHaveBeenCalledTimes(2);
  });

  it('continues authorized provider work when observational catalog status is unavailable', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const checkpoints = createCheckpointCollection([]);
    const controller = new AbortController();
    let now = 1_000;
    let sourceListCalls = 0;
    let catalogStatusCalls = 0;
    const waits: number[] = [];
    const http = {
      request: vi.fn(async () => ({
        status: 200,
        headers: { etag: 'initial' },
        body: new TextEncoder().encode(JSON.stringify([])),
      })),
    };
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          sourceListCalls += 1;
          const request = input as PluginActionInputById['automation.event.sources.list'];
          if (sourceListCalls === 1) {
            expect(request).toEqual({ transport: { kind: 'checkpointedPull' }, catalogRefresh: { kind: 'refresh' } });
            return sourceListResult(input, '7', [source]);
          }
          expect(request).toEqual({ transport: { kind: 'checkpointedPull' }, knownRevision: '7' });
          return { kind: 'unchanged', revision: '7' } satisfies PluginActionResultById['automation.event.sources.list'];
        }
        if (actionId === 'automation.event.source.status.report') {
          const status = input as AutomationEventSourceStatusReport;
          if (status.kind === 'catalogReconciliation') {
            catalogStatusCalls += 1;
            if (catalogStatusCalls === 2) throw new Error('temporary Automation catalog-status failure');
          }
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: { id: 'observer', qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/observer` },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      signal: controller.signal,
      services: {
        actions,
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer token' } })) },
        http: createPluginHttpFixture({ request: http.request }),
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver({
      now: () => now,
      sleep: async (delayMs) => {
        waits.push(delayMs);
        now += delayMs;
        if (waits.length === 1) controller.abort();
      },
    });

    await observer.run(sourceAttemptContext(observer, context));

    expect(waits).toEqual([60_000]);
    expect(catalogStatusCalls).toBeGreaterThanOrEqual(2);
    expect(http.request).toHaveBeenCalledOnce();
    expect(checkpoints.rowCount()).toBe(1);
  });

  it('waits for a bounded GitHub rate-limit retry instead of restarting the source immediately', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const checkpoints = createCheckpointCollection([]);
    const controller = new AbortController();
    const waits: number[] = [];
    const statuses: AutomationEventSourceStatusReport[] = [];
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          return sourceListResult(input, '7', [source]);
        }
        if (actionId === 'automation.event.source.status.report') {
          statuses.push(input as AutomationEventSourceStatusReport);
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: { id: 'observer', qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/observer` },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      signal: controller.signal,
      services: {
        actions,
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer token' } })) },
        http: { request: vi.fn(async () => ({ status: 429, headers: { 'retry-after': '13' }, body: new Uint8Array() })) },
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver({
      now: () => 1_000,
      sleep: async (delayMs) => {
        waits.push(delayMs);
        controller.abort();
      },
    });

    await observer.run(sourceAttemptContext(observer, context));

    expect(waits).toEqual([13_000]);
    expect(statuses).toContainEqual(expect.objectContaining({
      kind: 'source', state: 'backingOff', code: 'rateLimited', nextRetryAt: 14_000,
    }));
  });

  it('uses GitHub’s minimum rate-limit wait when a 429 has no usable retry hint', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const checkpoints = createCheckpointCollection([]);
    const controller = new AbortController();
    const waits: number[] = [];
    const statuses: AutomationEventSourceStatusReport[] = [];
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          return sourceListResult(input, '7', [source]);
        }
        if (actionId === 'automation.event.source.status.report') {
          statuses.push(input as AutomationEventSourceStatusReport);
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: { id: 'observer', qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/observer` },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      signal: controller.signal,
      services: {
        actions,
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer token' } })) },
        http: { request: vi.fn(async () => ({ status: 429, headers: {}, body: new Uint8Array() })) },
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver({
      now: () => 1_000,
      reconciliationIntervalMs: 86_400_000,
      sleep: async (delayMs) => {
        waits.push(delayMs);
        controller.abort();
      },
    });

    await observer.run(sourceAttemptContext(observer, context));

    expect(waits).toEqual([60_000]);
    expect(statuses).toContainEqual(expect.objectContaining({
      kind: 'source', state: 'backingOff', code: 'rateLimited', nextRetryAt: 61_000,
    }));
  });

  it('names an ordinary GitHub 403 a missing permission rather than a revoked credential', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const checkpoints = createCheckpointCollection([]);
    const statuses: AutomationEventSourceStatusReport[] = [];
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          return sourceListResult(input, '7', [source]);
        }
        if (actionId === 'automation.event.source.status.report') {
          statuses.push(input as AutomationEventSourceStatusReport);
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: { id: 'observer', qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/observer` },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      signal: new AbortController().signal,
      services: {
        actions,
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer token' } })) },
        http: {
          request: vi.fn(async () => ({
            status: 403,
            headers: {
              'x-ratelimit-remaining': '4999',
              'x-ratelimit-reset': '61',
            },
            body: new TextEncoder().encode(JSON.stringify({ message: 'Resource not accessible by integration' })),
          })),
        },
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;

    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 1_000 });
    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(statuses).toContainEqual(expect.objectContaining({
      kind: 'source', state: 'attention', code: 'credentialMissing', nextRetryAt: null,
    }));
  });

  /**
   * One failing GitHub response, one mutable catalog: the tests below separate
   * what GitHub said about the credential from what it said about the resource,
   * and observe when the observer next asks again.
   */
  function failingSourceHarness(input: Readonly<{
    catalog: { revision: string; definitions: SourceDefinition[] };
    response: Readonly<{ status: number; headers?: Readonly<Record<string, string>> }>;
  }>) {
    const checkpoints = createCheckpointCollection([]);
    const controller = new AbortController();
    const statuses: AutomationEventSourceStatusReport[] = [];
    const http = {
      request: vi.fn(async () => ({
        status: input.response.status,
        headers: input.response.headers ?? {},
        body: new Uint8Array(),
      })),
    };
    const actions = {
      execute: vi.fn(async (actionId: string, actionInput: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          return sourceListResult(actionInput, input.catalog.revision, input.catalog.definitions);
        }
        if (actionId === 'automation.event.source.status.report') {
          statuses.push(actionInput as AutomationEventSourceStatusReport);
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: { id: 'observer', qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/observer` },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      signal: controller.signal,
      services: {
        actions,
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer token' } })) },
        http: createPluginHttpFixture({ request: http.request }),
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;
    return { checkpoints, controller, statuses, http, context };
  }

  it('re-drives a repairable GitHub 401 on the reconciliation cadence and picks up the repaired credential', async () => {
    const catalog = {
      revision: '7',
      definitions: [definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA })],
    };
    const checkpoints = createCheckpointCollection([]);
    let currentController = new AbortController();
    let clock = 1_000;
    let responseStatus = 401;
    const waits: number[] = [];
    const statuses: AutomationEventSourceStatusReport[] = [];
    const http = {
      request: vi.fn(async () => ({
        status: responseStatus,
        headers: {},
        body: new TextEncoder().encode('[]'),
      })),
    };
    const actions = {
      execute: vi.fn(async (actionId: string, actionInput: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          return sourceListResult(actionInput, catalog.revision, catalog.definitions);
        }
        if (actionId === 'automation.event.source.status.report') {
          statuses.push(actionInput as AutomationEventSourceStatusReport);
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: { id: 'observer', qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/observer` },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      get signal() {
        return currentController.signal;
      },
      services: {
        actions,
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer token' } })) },
        http: createPluginHttpFixture({ request: http.request }),
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver({
      now: () => clock,
      reconciliationIntervalMs: 120_000,
      sleep: async (delayMs) => {
        waits.push(delayMs);
        currentController.abort();
      },
    });

    await observer.run(sourceAttemptContext(observer, context));

    // GitHub rejected the credential: the owner can repair it, so the source
    // re-drives at the bounded reconciliation cadence — not the transient
    // retry delay, and not a one-day park.
    expect(statuses).toContainEqual(expect.objectContaining({
      kind: 'source', state: 'attention', code: 'credentialRevoked', nextRetryAt: null,
    }));
    expect(waits).toEqual([120_000]);

    // The repaired credential is observed again on the next due pass.
    currentController = new AbortController();
    clock = 250_000;
    responseStatus = 200;
    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(http.request).toHaveBeenCalledTimes(2);
    expect(statuses).toContainEqual(expect.objectContaining({
      kind: 'source', state: 'baselined', code: 'none',
    }));
  });

  it('names a GitHub 404 an unreachable source rather than a missing credential', async () => {
    const catalog = {
      revision: '7',
      definitions: [definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA })],
    };
    const harness = failingSourceHarness({ catalog, response: { status: 404 } });
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 1_000 });

    await observer.runCycle(sourceAttemptContext(observer, harness.context));

    // A deleted, renamed, or unreadable repository is an answer about the
    // configured source. Reporting it as a credential problem sends the owner
    // to reconnect an account that was never the cause.
    expect(harness.statuses).toContainEqual(expect.objectContaining({
      kind: 'source', state: 'attention', code: 'sourceContractIncompatible', nextRetryAt: null,
    }));
  });

  it('resumes normal observation of a parked source when its definition revision changes', async () => {
    const catalog = {
      revision: '7',
      definitions: [definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA })],
    };
    const harness = failingSourceHarness({ catalog, response: { status: 404 } });
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 1_000 });
    const attemptContext = sourceAttemptContext(observer, harness.context);

    await observer.runCycle(attemptContext);
    expect(harness.http.request).toHaveBeenCalledTimes(1);

    catalog.revision = '8';
    catalog.definitions = [
      definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA, triggerRevision: 2 }),
    ];
    await observer.runCycle(attemptContext);

    // The owner corrected the configuration: the parked source is a different
    // definition revision now, so it is observed again instead of waiting out a
    // park earned by the previous revision.
    expect(harness.http.request).toHaveBeenCalledTimes(2);
  });

  it('honors a usable long GitHub Retry-After hint without a provider wait ceiling', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const checkpoints = createCheckpointCollection([]);
    const controller = new AbortController();
    const waits: number[] = [];
    const statuses: AutomationEventSourceStatusReport[] = [];
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          return sourceListResult(input, '7', [source]);
        }
        if (actionId === 'automation.event.source.status.report') {
          statuses.push(input as AutomationEventSourceStatusReport);
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: { id: 'observer', qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/observer` },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      signal: controller.signal,
      services: {
        actions,
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer token' } })) },
        http: { request: vi.fn(async () => ({ status: 429, headers: { 'retry-after': '90000' }, body: new Uint8Array() })) },
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver({
      now: () => 1_000,
      reconciliationIntervalMs: 86_400_000,
      sleep: async (delayMs) => {
        waits.push(delayMs);
        controller.abort();
      },
    });

    await observer.run(sourceAttemptContext(observer, context));

    expect(waits).toEqual([90_000_000]);
    expect(statuses).toContainEqual(expect.objectContaining({
      kind: 'source', state: 'backingOff', code: 'rateLimited', nextRetryAt: 90_001_000,
    }));
  });


  it('retires only the removed trigger checkpoint while preserving its sibling', async () => {
    const removed = definition({ automationId: 'automation-removed', sourceSelectorId: sourceSelectorA });
    const sibling = definition({
      automationId: 'automation-sibling',
      sourceSelectorId: sourceSelectorB,
      eventLocalId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.issueOpened,
    });
    const retained = checkpointRow({
      automationId: removed.automationId,
      triggerId: removed.triggerId,
      sourceSelectorId: removed.sourceSelectorId,
    });
    const checkpoints = createCheckpointCollection([retained]);
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          const request = input as PluginActionInputById['automation.event.sources.list'];
          if (request.checkpointRetirementCandidates !== undefined) {
            expect(request.checkpointRetirementCandidates).toEqual([
              expect.objectContaining({
                automationId: removed.automationId,
                triggerId: removed.triggerId,
              }),
            ]);
            return {
              kind: 'unchanged',
              revision: '8',
              checkpointRetirements: request.checkpointRetirementCandidates,
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          return sourceListResult(input, '8', [sibling]);
        }
        if (actionId === 'automation.event.source.status.report') {
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const context = observerBackgroundContext({
      actions,
      collection: checkpoints.collection,
      http: {
        request: vi.fn(async () => ({
          status: 200,
          headers: { etag: 'sibling-baseline' },
          body: new TextEncoder().encode(JSON.stringify([])),
        })),
      },
    });
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });

    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(checkpoints.delete).toHaveBeenCalledOnce();
    expect(checkpoints.rowCount()).toBe(1);
    expect(checkpoints.read(createGithubAutomationEventCheckpointRowId({
      automationId: sibling.automationId,
      triggerId: sibling.triggerId,
      eventRef: sibling.eventRef,
      sourceSelectorId: sibling.sourceSelectorId,
    }))?.value).toMatchObject({
      [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.automationId]: sibling.automationId,
      [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.triggerId]: sibling.triggerId,
      [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.eventLocalId]: sibling.eventRef.localId,
      [GITHUB_AUTOMATION_EVENT_CHECKPOINT_FIELD.sourceSelectorId]: sibling.sourceSelectorId,
    });
  });

  it('observes each distinct repository once per eligible provider cycle', async () => {
    const definitions = ['1', '2', '3'].map((repositoryId, index) => definition({
      automationId: `automation-${repositoryId}`, repositoryId,
      sourceSelectorId: `00000000-0000-4000-8000-00000000000${index + 1}`,
    }));
    const checkpoints = createCheckpointCollection([]);
    const controller = new AbortController();
    let now = 1_000;
    const requests: string[] = [];
    const http = { request: vi.fn(async (request: Readonly<{ url: string; headers?: Readonly<Record<string, string>> }>) => {
      requests.push(new URL(request.url).pathname);
      return request.headers?.['If-None-Match'] ? { status: 304, headers: {}, body: new Uint8Array() }
        : { status: 200, headers: { etag: 'initial' }, body: new TextEncoder().encode('[]') };
    }) };
    const actions = { execute: vi.fn(async (action: string, input: unknown) => {
      if (action === 'automation.event.sources.list') return sourceListResult(input, '7', definitions);
      if (action === 'automation.event.source.status.report') return {};
      throw new Error(`Unexpected Action ${action}`);
    }) };
    let waits = 0;
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => now,
      sleep: async delay => { if (++waits === 1) now += delay; else controller.abort(); } });
    await observer.run(sourceAttemptContext(observer, observerBackgroundContext({ actions, collection: checkpoints.collection,
      http, signal: controller.signal })));
    expect(requests).toHaveLength(6);
    for (const repositoryId of ['1', '2', '3']) {
      expect(requests.filter(path => path === `/repos/acme/widgets-${repositoryId}/events`)).toHaveLength(2);
    }
    expect(checkpoints.rowCount()).toBe(3);
  });
  // The repository-Events walk reads its next page from the same RFC 8288 `Link`
  // header the rest of this source reads. RFC 8288 spells one relation several
  // equivalent ways, and a private anchored-regex parse reads NO next page from
  // most of them — which ends a walk on evidence GitHub never gave. Asserted by
  // comparison against the canonical spelling's own answer.
  it.each([
    ['canonical', (next: string) => `<${next}>; rel="next"`],
    ['unquoted rel', (next: string) => `<${next}>; rel=next`],
    ['a link parameter before rel', (next: string) => `<${next}>; type="application/json"; rel="next"`],
    ['a link parameter after rel', (next: string) => `<${next}>; rel="next"; type="application/json"`],
    ['an upper-cased rel', (next: string) => `<${next}>; rel="NEXT"`],
  ])('follows the repository Events next page whose Link header uses %s', async (_label, writeLink) => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const rowId = createGithubAutomationEventCheckpointRowId({
      automationId: 'automation-a',
      triggerId: 'trigger-automation-a',
      eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: EVENT_LOCAL_ID },
      sourceSelectorId: sourceSelectorA,
    });
    const checkpoints = createCheckpointCollection([
      checkpointRow({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA }),
    ]);
    const statuses: AutomationEventSourceStatusReport[] = [];
    const repeatedPageUrl = 'https://api.github.com/repos/acme/widgets/events?per_page=100&page=2';
    let requests = 0;
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          return sourceListResult(input, '7', [source]);
        }
        if (actionId === 'automation.event.source.status.report') {
          statuses.push(input as AutomationEventSourceStatusReport);
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: { id: 'observer', qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/observer` },
      surface: 'background' as const,
      materialization: watcherMaterializationRef,
      signal: new AbortController().signal,
      services: {
        actions,
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer token' } })) },
        http: {
          request: vi.fn(async () => {
            requests += 1;
            return {
              status: 200,
              headers: {
                ...(requests === 1 ? { etag: 'current-etag' } : {}),
                link: writeLink(repeatedPageUrl),
              },
              body: new TextEncoder().encode(JSON.stringify([])),
            };
          }),
        },
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;

    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(requests).toBe(2);
    expect(checkpoints.read(rowId)).toMatchObject({
      value: { payload: { continuity: expect.objectContaining({ historyGap: true }) } },
    });
  });
});
