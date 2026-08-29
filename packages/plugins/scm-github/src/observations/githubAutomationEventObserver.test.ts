import { describe, expect, it, vi } from 'vitest';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
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
import {
  GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID,
  GITHUB_AUTOMATION_REPOSITORY_SOURCE_ATTEMPT_ACTION_ID,
} from './githubProviderContracts.js';
import { resetGithubRepositoryEventHistoryGap } from '../githubAutomationEventActions.js';
import {
  GITHUB_AUTOMATION_EVENT_LOCAL_IDS,
  type GithubAutomationEventLocalIdV1,
} from '../githubAutomationEvents.js';

const GITHUB_PLUGIN_ID = 'happier.scm.forge.github';
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

async function waitForCall(callCount: () => number): Promise<void> {
  for (let attempt = 0; attempt < 20 && callCount() === 0; attempt += 1) {
    await Promise.resolve();
  }
}

function catalogStatuses(
  statuses: readonly AutomationEventSourceStatusReport[],
): readonly CatalogReconciliationStatus[] {
  return statuses.filter((status): status is CatalogReconciliationStatus => status.kind === 'catalogReconciliation');
}

function sourceAttemptContext(
  observer: GithubAutomationEventCheckpointedPullObserver,
  context: BackgroundServiceContext,
  beforeAttempt?: (input: unknown, context: PluginInvocationContext) => Promise<void>,
): BackgroundServiceContext {
  let wrapped: BackgroundServiceContext;
  wrapped = {
    ...context,
    services: {
      ...context.services,
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
}>): BackgroundServiceContext {
  return {
    plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
    contribution: {
      id: GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID,
      qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/${GITHUB_AUTOMATION_REPOSITORY_EVENT_BACKGROUND_SERVICE_ID}`,
    },
    surface: 'background' as const,
    signal: input.signal ?? new AbortController().signal,
    services: {
      actions: input.actions,
      connectedAccounts: {
        materialize: vi.fn(async () => ({
          kind: 'httpHeaders' as const,
          headers: { Authorization: 'Bearer exact-account-token' },
        })),
      },
      http: input.http ?? {
        request: vi.fn(async () => ({ status: 304, headers: {}, body: new Uint8Array() })),
      },
      storage: { account: { collection: vi.fn(() => input.collection) } },
    },
  } as unknown as BackgroundServiceContext;
}

describe('GitHub Automation Event checkpointed-pull observer', () => {
  it('maps all four repository timeline variants to the same semantic Event refs used by webhooks', () => {
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
        payload: { action: 'opened', issue: { id: 201, number: 7, title: 'A new issue' } },
      },
      payload: { issue: { id: '201', number: 7, title: 'A new issue' } },
    }, {
      localId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestOpened,
      raw: {
        id: '103', type: 'PullRequestEvent', created_at: '2026-08-10T12:02:00Z',
        repo: { id: 77, name: 'acme/widgets' },
        payload: {
          action: 'opened',
          pull_request: { id: 301, number: 11, title: 'A new pull request' },
        },
      },
      payload: { pullRequest: { id: '301', number: 11, title: 'A new pull request' } },
    }, {
      localId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.pullRequestMerged,
      raw: {
        id: '104', type: 'PullRequestEvent', created_at: '2026-08-10T12:03:00Z',
        repo: { id: 77, name: 'acme/widgets' },
        payload: {
          action: 'closed',
          pull_request: {
            id: 302, number: 12, merged: true, merge_commit_sha: 'c'.repeat(40),
          },
        },
      },
      payload: { pullRequest: { id: '302', number: 12, mergeCommitSha: 'c'.repeat(40) } },
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
      execute: vi.fn(async (actionId: string) => {
        if (actionId === 'automation.event.sources.list') {
          return {
            kind: 'page', revision: '7', definitions: [source], nextCursor: null,
          } satisfies PluginActionResultById['automation.event.sources.list'];
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
      signal: new AbortController().signal,
      services: {
        actions,
        connectedAccounts: {
          materialize: vi.fn(async () => ({
            kind: 'httpHeaders' as const,
            headers: { Authorization: 'Bearer exact-account-token' },
          })),
        },
        http,
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

  it('retires the cycle coalescer when the observer is cancelled during source dispatch', async () => {
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
      execute: vi.fn(async (actionId: string) => {
        if (actionId === 'automation.event.sources.list') {
          return {
            kind: 'page', revision: '7', definitions, nextCursor: null,
          } satisfies PluginActionResultById['automation.event.sources.list'];
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
      signal: controller.signal,
      services: {
        actions,
        connectedAccounts: {
          materialize: vi.fn(async () => ({
            kind: 'httpHeaders' as const,
            headers: { Authorization: 'Bearer exact-account-token' },
          })),
        },
        http,
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
    })).rejects.toThrow('not part of the current observer cycle');
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
    let releaseHttp: ((value: unknown) => void) | undefined;
    const httpResponse = new Promise<unknown>((resolve) => { releaseHttp = resolve; });
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
          return {
            kind: 'page', revision: '7', definitions, nextCursor: null,
          } satisfies PluginActionResultById['automation.event.sources.list'];
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
        http,
        storage: {
          account: {
            collection: vi.fn(() => checkpoints.collection),
          },
        },
      },
    } as unknown as BackgroundServiceContext;

    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    const cycle = observer.runCycle(sourceAttemptContext(observer, context));
    await waitForCall(() => http.request.mock.calls.length);
    expect(http.request).toHaveBeenCalledOnce();
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
    expect(blockedCheckpoint?.value.payload.cursor).toMatchObject({ seenEventIds: ['old', 'new-1'] });
    expect(blockedCheckpoint?.value.payload.lastContiguousOccurrenceId).toBe('github:repository:77:event:new-1');
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
    const checkpoints = createCheckpointCollection([
      checkpointRow({ automationId: push.automationId, sourceSelectorId: push.sourceSelectorId }),
      checkpointRow({
        automationId: issue.automationId,
        eventLocalId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.issueOpened,
        sourceSelectorId: issue.sourceSelectorId,
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
        ])),
      })),
    };
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          return {
            kind: 'page', revision: '7', definitions: [push, issue], nextCursor: null,
          } satisfies PluginActionResultById['automation.event.sources.list'];
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
      signal: new AbortController().signal,
      services: {
        actions,
        connectedAccounts: {
          materialize: vi.fn(async () => ({
            kind: 'httpHeaders' as const,
            headers: { Authorization: 'Bearer token' },
          })),
        },
        http,
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;

    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(admissions).toHaveLength(2);
    expect(admissions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventRef: push.eventRef,
        definitions: [expect.objectContaining({ triggerId: push.triggerId })],
      }),
      expect.objectContaining({
        eventRef: issue.eventRef,
        definitions: [expect.objectContaining({ triggerId: issue.triggerId })],
      }),
    ]));
    expect(http.request).toHaveBeenCalledOnce();
    expect(checkpoints.rowCount()).toBe(2);
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
    const checkpoints = createCheckpointCollection([
      checkpointRow({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA }),
    ]);
    let now = 2_000;
    let sourceListCalls = 0;
    const statuses: AutomationEventSourceStatusReport[] = [];
    const http = {
      request: vi.fn(async () => {
        now += 1_000;
        return { status: 304, headers: { 'x-poll-interval': '17' }, body: new Uint8Array() };
      }),
    };
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          const request = input as PluginActionInputById['automation.event.sources.list'];
          sourceListCalls += 1;
          if (sourceListCalls === 1) {
            expect(request).toEqual({ transport: { kind: 'checkpointedPull' } });
            return {
              kind: 'page', revision: '7', definitions: [source], nextCursor: null,
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          expect(request).toEqual({ transport: { kind: 'checkpointedPull' }, knownRevision: '7' });
          return { kind: 'unchanged', revision: '7' } satisfies PluginActionResultById['automation.event.sources.list'];
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
      signal: new AbortController().signal,
      services: {
        actions,
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer token' } })) },
        http,
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;

    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => now });
    await observer.runCycle(sourceAttemptContext(observer, context));
    now = 20_000;
    await observer.runCycle(sourceAttemptContext(observer, context));

    const row = checkpoints.read(createGithubAutomationEventCheckpointRowId({
      automationId: 'automation-a',
      triggerId: 'trigger-automation-a',
      eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: EVENT_LOCAL_ID },
      sourceSelectorId: sourceSelectorA,
    }));
    expect(http.request).toHaveBeenCalledTimes(2);
    expect(row?.value.payload.cursor).toMatchObject({ observedAtMs: 21_000, etag: 'prior-etag' });
    expect(statuses).toContainEqual(expect.objectContaining({
      kind: 'source', state: 'observing', lastObservedAt: 21_000,
    }));
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
          return {
            kind: 'page', revision: '7', definitions: [source], nextCursor: null,
          } satisfies PluginActionResultById['automation.event.sources.list'];
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
      signal: new AbortController().signal,
      services: {
        actions,
        connectedAccounts: {
          materialize: vi.fn(async () => ({
            kind: 'httpHeaders' as const,
            headers: { Authorization: 'Bearer token' },
          })),
        },
        http,
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
          return {
            kind: 'page', revision: '7', definitions: [source], nextCursor: null,
          } satisfies PluginActionResultById['automation.event.sources.list'];
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
          return {
            kind: 'page', revision: '7', definitions: [source], nextCursor: null,
          } satisfies PluginActionResultById['automation.event.sources.list'];
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
      signal: new AbortController().signal,
      services: {
        actions,
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer token' } })) },
        http,
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

  it('replaces a persisted history gap only through an authenticated baseline before the next conditional poll', async () => {
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
    const admitted: AutomationEventAdmitInput[] = [];
    const statuses: AutomationEventSourceStatusReport[] = [];
    const baselineEventAt = Date.now() - 1_000;
    const nextEventAt = Date.now() + 60_000;
    const repositoryEvent = (id: string, createdAt: string) => ({
      id,
      type: 'PushEvent',
      created_at: createdAt,
      repo: { id: 77, name: 'acme/widgets' },
      payload: { ref: 'refs/heads/main', before: 'a'.repeat(40), head: 'b'.repeat(40) },
    });
    let requestCount = 0;
    const http = {
      request: vi.fn(async (request: Readonly<{ headers: Readonly<Record<string, string>> }>) => {
        requestCount += 1;
        if (requestCount === 1) {
          expect(request.headers['If-None-Match']).toBeUndefined();
          return {
            status: 200,
            headers: { etag: 'baseline-etag' },
            body: new TextEncoder().encode(JSON.stringify([
              repositoryEvent('baseline-current', new Date(baselineEventAt).toISOString()),
            ])),
          };
        }
        expect(request.headers['If-None-Match']).toBe('baseline-etag');
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
          return {
            kind: 'page', revision: '7', definitions: [source], nextCursor: null,
          } satisfies PluginActionResultById['automation.event.sources.list'];
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
      http,
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
      revision: 2,
      value: {
        payload: {
          cursor: { etag: 'baseline-etag', seenEventIds: ['baseline-current'] },
          lastContiguousOccurrenceId: null,
        },
      },
    });
    expect(checkpoints.read(rowId)?.value.payload.continuity).not.toHaveProperty('historyGap');

    const observerContext = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: {
        id: 'automation-repository-event-checkpointed-pull',
        qualifiedId: `${GITHUB_PLUGIN_ID}/backgroundServices/automation-repository-event-checkpointed-pull`,
      },
      surface: 'background' as const,
      signal: new AbortController().signal,
      services,
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => nextEventAt + 1_000 });
    await observer.runCycle(sourceAttemptContext(observer, observerContext));

    expect(http.request).toHaveBeenCalledTimes(2);
    expect(admitted).toContainEqual(expect.objectContaining({
      occurrenceId: 'github:repository:77:event:new-after-baseline',
    }));
    expect(checkpoints.read(rowId)).toMatchObject({
      revision: 3,
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
                return {
                  kind: 'page', revision: '7', definitions: [source], nextCursor: null,
                } satisfies PluginActionResultById['automation.event.sources.list'];
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
        http: {
          request: vi.fn(async () => ({
            status: 200,
            headers: { etag: 'fresh-etag' },
            body: new TextEncoder().encode(JSON.stringify([])),
          })),
        },
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
        return {
          kind: 'page', revision: '7', definitions: [source], nextCursor: null,
        } satisfies PluginActionResultById['automation.event.sources.list'];
      }
      expect(request).toEqual({
        transport: { kind: 'checkpointedPull' }, knownRevision: '7',
      });
      return {
        kind: 'page', revision: '8', definitions: [], nextCursor: null,
      } satisfies PluginActionResultById['automation.event.sources.list'];
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
        http,
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
        return {
          kind: 'page', revision: '7', definitions: [source], nextCursor: null,
        } satisfies PluginActionResultById['automation.event.sources.list'];
      }
      expect(request).toEqual({
        transport: { kind: 'checkpointedPull' }, knownRevision: '7',
      });
      if (sourceListCalls === 2 || sourceListCalls === 3) {
        return { kind: 'unchanged', revision: '7' } satisfies PluginActionResultById['automation.event.sources.list'];
      }
      return {
        kind: 'page', revision: '8', definitions: [], nextCursor: null,
      } satisfies PluginActionResultById['automation.event.sources.list'];
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
        http,
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
        return {
          kind: 'page', revision: '7', definitions: [source], nextCursor: null,
        } satisfies PluginActionResultById['automation.event.sources.list'];
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
        http,
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
          execute: vi.fn(async (actionId: string) => {
            if (actionId !== 'automation.event.sources.list') throw new Error(`unexpected Action ${actionId}`);
            return {
              kind: 'page', revision: '8', definitions: [], nextCursor: null,
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }),
        },
        connectedAccounts: { materialize: vi.fn() },
        http,
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
            return {
              kind: 'page', revision: '7', definitions: [source], nextCursor: null,
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }),
        },
        connectedAccounts: { materialize: vi.fn() },
        http,
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
            return {
              kind: 'page', revision: '7', definitions: [source], nextCursor: null,
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }),
        },
        connectedAccounts: {
          materialize: vi.fn(async () => ({
            kind: 'httpHeaders' as const,
            headers: { Authorization: 'Bearer exact-account-token' },
          })),
        },
        http,
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
            return {
              kind: 'page', revision: '7', definitions: [source], nextCursor: null,
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }),
        },
        connectedAccounts: {
          materialize: vi.fn(async () => ({
            kind: 'httpHeaders' as const,
            headers: { Authorization: 'Bearer exact-account-token' },
          })),
        },
        http,
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
          sourceListCalls += 1;
          const request = input as PluginActionInputById['automation.event.sources.list'];
          expect(request).toEqual(sourceListCalls === 1
            ? { transport: { kind: 'checkpointedPull' } }
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
      signal: new AbortController().signal,
      // A catalog only becomes current once its checkpoint rows reconcile, so
      // this fixture supplies the Account Collection that pass reads.
      services: { actions, storage: { account: { collection: vi.fn(() => checkpoints.collection) } } },
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });

    await observer.runCycle(context);

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
          return {
            kind: 'page', revision: '7', definitions: [source, rotated], nextCursor: null,
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
            expect(request).toEqual({ transport: { kind: 'checkpointedPull' } });
            return {
              kind: 'page', revision: '7', definitions: [], nextCursor: null,
            } satisfies PluginActionResultById['automation.event.sources.list'];
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
            return {
              kind: 'page', revision: '7', definitions: [], nextCursor: null,
            } satisfies PluginActionResultById['automation.event.sources.list'];
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
          return {
            kind: 'page', revision: '7', definitions: [source], nextCursor: null,
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
          return {
            kind: 'page', revision: '7', definitions: [rotated], nextCursor: null,
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
          return {
            kind: 'page', revision: '7', definitions: [source], nextCursor: null,
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
      signal: new AbortController().signal,
      // A catalog only becomes current once its checkpoint rows reconcile, so
      // this fixture supplies the Account Collection that pass reads.
      services: { actions, storage: { account: { collection: vi.fn(() => checkpoints.collection) } } },
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });

    await observer.runCycle(context);

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
      signal: new AbortController().signal,
      // A catalog only becomes current once its checkpoint rows reconcile, so
      // this fixture supplies the Account Collection that pass reads.
      services: { actions, storage: { account: { collection: vi.fn(() => checkpoints.collection) } } },
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });

    await observer.runCycle(context);

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

      await observer.runCycle(context);
      await checkpoints.collection.put(orphan, { expectedRevision: 'absent' });
      checkpoints.query.mockClear();
      checkpoints.delete.mockClear();
      initialScan = false;
      if (kind === 'cancelled') {
        await expect(observer.runCycle(context)).rejects.toBe(cancellation);
      } else {
        await observer.runCycle(context);
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
          return {
            kind: 'page', revision: '7', definitions: [], nextCursor: null,
          } satisfies PluginActionResultById['automation.event.sources.list'];
        }
        if (actionId === 'automation.event.source.status.report') {
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    const context = observerBackgroundContext({ actions, collection: checkpoints.collection });

    await observer.runCycle(context);

    expect(checkpoints.delete).not.toHaveBeenCalled();
    expect(checkpoints.read(elsewhere.id)).toMatchObject({ revision: 1 });
  });

  it('treats checkpoint-delete CAS loss as harmless and retries on the next ordinary observer cycle', async () => {
    const source = definition({
      automationId: 'automation-a',
      sourceSelectorId: sourceSelectorA,
      repositoryId: '88',
    });
    const retiredRowId = createGithubAutomationEventCheckpointRowId({
      automationId: source.automationId,
      triggerId: source.triggerId,
      eventRef: source.eventRef,
      sourceSelectorId: source.sourceSelectorId,
    });
    const checkpoints = createCheckpointCollection([
      checkpointRow({
        automationId: source.automationId,
        sourceSelectorId: source.sourceSelectorId,
        sourceInstanceId: source.sourceInstanceId,
        sourceContractVersion: 2,
      }),
    ], { deleteConflictCount: 1 });
    let sourceListCalls = 0;
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          const request = input as PluginActionInputById['automation.event.sources.list'];
          if (request.checkpointRetirementCandidates !== undefined) {
            expect(request).toMatchObject({
              transport: { kind: 'checkpointedPull' },
              knownRevision: '7',
              checkpointRetirementCandidates: [expect.objectContaining({
                automationId: source.automationId,
                sourceSelectorId: source.sourceSelectorId,
                sourceContractVersion: 2,
              })],
            });
            return {
              kind: 'unchanged',
              revision: '7',
              checkpointRetirements: request.checkpointRetirementCandidates,
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          sourceListCalls += 1;
          if (sourceListCalls === 1) {
            expect(request).toEqual({ transport: { kind: 'checkpointedPull' } });
            return {
              kind: 'page', revision: '7', definitions: [source], nextCursor: null,
            } satisfies PluginActionResultById['automation.event.sources.list'];
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
    };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    const context = observerBackgroundContext({
      actions,
      collection: checkpoints.collection,
      http: {
        request: vi.fn(async () => ({
          status: 200,
          headers: { etag: 'cas-retry' },
          body: new TextEncoder().encode(JSON.stringify([])),
        })),
      },
    });

    await expect(observer.runCycle(sourceAttemptContext(observer, context))).resolves.toBeUndefined();
    expect(checkpoints.read(retiredRowId)).toMatchObject({
      value: { payload: { sourceContractVersion: 2 } },
    });
    await expect(observer.runCycle(sourceAttemptContext(observer, context))).resolves.toBeUndefined();

    // The retry retires the incompatible row; the replacement baseline is
    // written by the next observation that is due for this source.
    expect(checkpoints.delete).toHaveBeenCalledTimes(2);
    expect(checkpoints.read(retiredRowId)).toBeNull();
  });

  it('withholds a current catalog until the adopted revision reconciles its checkpoint rows', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const checkpoints = createCheckpointCollection([
      checkpointRow({ automationId: source.automationId, sourceSelectorId: source.sourceSelectorId }),
    ], { queryFailureCount: 1 });
    const statuses: AutomationEventSourceStatusReport[] = [];
    let sourceListCalls = 0;
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          sourceListCalls += 1;
          return sourceListCalls === 1
            ? { kind: 'page', revision: '7', definitions: [source], nextCursor: null } satisfies PluginActionResultById['automation.event.sources.list']
            : { kind: 'unchanged', revision: '7' } satisfies PluginActionResultById['automation.event.sources.list'];
        }
        if (actionId === 'automation.event.source.status.report') {
          statuses.push(input as AutomationEventSourceStatusReport);
          return {} satisfies PluginActionResultById['automation.event.source.status.report'];
        }
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => 2_000 });
    const context = observerBackgroundContext({ actions, collection: checkpoints.collection });

    await expect(observer.runCycle(sourceAttemptContext(observer, context))).resolves.toBeUndefined();

    // The checkpoint query failed, so this revision is not reconciled and the
    // product must not claim its pull catalog is current.
    expect(catalogStatuses(statuses).map((status) => status.state)).toEqual(['reconciling']);

    await expect(observer.runCycle(sourceAttemptContext(observer, context))).resolves.toBeUndefined();

    expect(catalogStatuses(statuses).at(-1)).toMatchObject({
      observedRevision: '7',
      adoptedRevision: '7',
      state: 'current',
    });
  });

  it('scans checkpoint rows once for an adopted revision instead of on every unchanged cycle', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const checkpoints = createCheckpointCollection([
      checkpointRow({ automationId: source.automationId, sourceSelectorId: source.sourceSelectorId }),
    ]);
    let sourceListCalls = 0;
    const actions = {
      execute: vi.fn(async (actionId: string) => {
        if (actionId === 'automation.event.sources.list') {
          sourceListCalls += 1;
          if (sourceListCalls === 1) {
            return { kind: 'page', revision: '7', definitions: [source], nextCursor: null } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          if (sourceListCalls <= 3) {
            return { kind: 'unchanged', revision: '7' } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          return { kind: 'page', revision: '8', definitions: [source], nextCursor: null } satisfies PluginActionResultById['automation.event.sources.list'];
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
    const afterAdoption = checkpoints.query.mock.calls.length;
    expect(afterAdoption).toBeGreaterThan(0);

    await observer.runCycle(sourceAttemptContext(observer, context));
    await observer.runCycle(sourceAttemptContext(observer, context));
    expect(checkpoints.query.mock.calls.length).toBe(afterAdoption);

    await observer.runCycle(sourceAttemptContext(observer, context));
    expect(checkpoints.query.mock.calls.length).toBeGreaterThan(afterAdoption);
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
          return {
            kind: 'page', revision: '7', definitions: [source], nextCursor: null,
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

  it('retains the last complete revision and preserves a truthful reconciling/late scan start across cursor churn', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const checkpoints = createCheckpointCollection([]);
    let now = 1_000;
    let sourceListCalls = 0;
    const statuses: AutomationEventSourceStatusReport[] = [];
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          sourceListCalls += 1;
          if (sourceListCalls === 1) {
            return {
              kind: 'page', revision: '7', definitions: [source], nextCursor: null,
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          const request = input as PluginActionInputById['automation.event.sources.list'];
          expect(request.knownRevision).toBe('7');
          return { kind: 'cursorStale', currentRevision: '8' } satisfies PluginActionResultById['automation.event.sources.list'];
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
      signal: new AbortController().signal,
      services: {
        actions,
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer token' } })) },
        http: {
          request: vi.fn(async () => ({
            status: 200,
            headers: { etag: 'initial' },
            body: new TextEncoder().encode(JSON.stringify([])),
          })),
        },
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;

    const observer = createGithubAutomationEventCheckpointedPullObserver({
      now: () => now,
      reconciliationLateAfterMs: 60_000,
    });
    await observer.runCycle(sourceAttemptContext(observer, context));
    now = 2_000;
    await observer.runCycle(sourceAttemptContext(observer, context));
    now = 62_001;
    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(catalogStatuses(statuses)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        observedRevision: '8', adoptedRevision: '7', state: 'reconciling', scanStartedAt: 2_000,
      }),
      expect.objectContaining({
        observedRevision: '8', adoptedRevision: '7', state: 'reconciliationLate', scanStartedAt: 2_000,
      }),
    ]));
  });

  it('keeps the provider runner alive until abort and waits for the GitHub poll interval hint', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const checkpoints = createCheckpointCollection([]);
    const controller = new AbortController();
    let now = 1_000;
    const waits: number[] = [];
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          return {
            kind: 'page', revision: '7', definitions: [source], nextCursor: null,
          } satisfies PluginActionResultById['automation.event.sources.list'];
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
      signal: controller.signal,
      services: {
        actions,
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer token' } })) },
        http: {
          request: vi.fn(async () => ({
            status: 200,
            headers: { etag: 'initial', 'x-poll-interval': '17' },
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

    expect(waits).toEqual([17_000]);
  });

  it('retries a transient source-list failure without discarding the retained complete source set', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const checkpoints = createCheckpointCollection([]);
    const controller = new AbortController();
    let now = 1_000;
    let sourceListCalls = 0;
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
            expect(request).toEqual({ transport: { kind: 'checkpointedPull' } });
            return {
              kind: 'page', revision: '7', definitions: [source], nextCursor: null,
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          expect(request).toEqual({ transport: { kind: 'checkpointedPull' }, knownRevision: '7' });
          if (sourceListCalls === 2) throw new Error('temporary Automation source catalog failure');
          return { kind: 'unchanged', revision: '7' } satisfies PluginActionResultById['automation.event.sources.list'];
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
      signal: controller.signal,
      services: {
        actions,
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer token' } })) },
        http,
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver({
      now: () => now,
      sleep: async (delayMs) => {
        waits.push(delayMs);
        now += delayMs;
        if (waits.length === 3) controller.abort();
      },
    });

    await observer.run(sourceAttemptContext(observer, context));

    expect(waits).toEqual([60_000, 1_000, 60_000]);
    expect(sourceListCalls).toBe(3);
    expect(http.request).toHaveBeenCalledTimes(2);
  });

  it('retries a transient catalog-status failure after retaining a complete source set', async () => {
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
            expect(request).toEqual({ transport: { kind: 'checkpointedPull' } });
            return {
              kind: 'page', revision: '7', definitions: [source], nextCursor: null,
            } satisfies PluginActionResultById['automation.event.sources.list'];
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
      signal: controller.signal,
      services: {
        actions,
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer token' } })) },
        http,
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver({
      now: () => now,
      sleep: async (delayMs) => {
        waits.push(delayMs);
        now += delayMs;
        if (waits.length === 2) controller.abort();
      },
    });

    await observer.run(sourceAttemptContext(observer, context));

    expect(waits).toEqual([1_000, 60_000]);
    expect(sourceListCalls).toBe(2);
    expect(catalogStatusCalls).toBe(3);
    expect(http.request).toHaveBeenCalledOnce();
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
          return {
            kind: 'page', revision: '7', definitions: [source], nextCursor: null,
          } satisfies PluginActionResultById['automation.event.sources.list'];
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
          return {
            kind: 'page', revision: '7', definitions: [source], nextCursor: null,
          } satisfies PluginActionResultById['automation.event.sources.list'];
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

  it('keeps an ordinary positive-remaining GitHub 403 with reset metadata as credential attention', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const checkpoints = createCheckpointCollection([]);
    const statuses: AutomationEventSourceStatusReport[] = [];
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          return {
            kind: 'page', revision: '7', definitions: [source], nextCursor: null,
          } satisfies PluginActionResultById['automation.event.sources.list'];
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
      kind: 'source', state: 'attention', code: 'credentialRevoked', nextRetryAt: null,
    }));
  });

  it('caps a usable long GitHub Retry-After hint at the provider wait ceiling', async () => {
    const source = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const checkpoints = createCheckpointCollection([]);
    const controller = new AbortController();
    const waits: number[] = [];
    const statuses: AutomationEventSourceStatusReport[] = [];
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          return {
            kind: 'page', revision: '7', definitions: [source], nextCursor: null,
          } satisfies PluginActionResultById['automation.event.sources.list'];
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

    expect(waits).toEqual([86_400_000]);
    expect(statuses).toContainEqual(expect.objectContaining({
      kind: 'source', state: 'backingOff', code: 'rateLimited', nextRetryAt: 86_401_000,
    }));
  });

  it('persists independent semantic-trigger checkpoints while coalescing repository reads', async () => {
    const firstSource = definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA });
    const secondSource = definition({
      automationId: 'automation-b',
      sourceSelectorId: sourceSelectorB,
      eventLocalId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.issueOpened,
    });
    const checkpoints = createCheckpointCollection([]);
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
          return {
            kind: 'page', revision: '7', definitions: [firstSource, secondSource], nextCursor: null,
          } satisfies PluginActionResultById['automation.event.sources.list'];
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
      signal: new AbortController().signal,
      services: {
        actions,
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer token' } })) },
        http,
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;

    const observer = createGithubAutomationEventCheckpointedPullObserver({
      now: () => 2_000,
      maxConcurrentSources: 1,
    });
    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(http.request).toHaveBeenCalledOnce();
    expect(checkpoints.rowCount()).toBe(2);
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
          return {
            kind: 'page', revision: '8', definitions: [sibling], nextCursor: null,
          } satisfies PluginActionResultById['automation.event.sources.list'];
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

  it('bounds concurrent source calls and fairly rotates the source that starts each subsequent cycle', async () => {
    const definitions = [
      definition({ automationId: 'automation-a', sourceSelectorId: sourceSelectorA, repositoryId: '1' }),
      definition({ automationId: 'automation-b', sourceSelectorId: sourceSelectorB, repositoryId: '2' }),
      definition({ automationId: 'automation-c', sourceSelectorId: '00000000-0000-4000-8000-000000000003', repositoryId: '3' }),
    ];
    const checkpoints = createCheckpointCollection([]);
    let now = 1_000;
    let sourceListCalls = 0;
    let activeHttp = 0;
    let peakHttp = 0;
    const repositoryOrder: string[] = [];
    const http = {
      request: vi.fn(async (request: Readonly<{ url: string; headers?: Readonly<Record<string, string>> }>) => {
        activeHttp += 1;
        peakHttp = Math.max(peakHttp, activeHttp);
        repositoryOrder.push(new URL(request.url).pathname.split('/')[3]!);
        await Promise.resolve();
        activeHttp -= 1;
        return request.headers?.['If-None-Match'] === undefined
          ? { status: 200, headers: { etag: 'initial' }, body: new TextEncoder().encode(JSON.stringify([])) }
          : { status: 304, headers: {}, body: new Uint8Array() };
      }),
    };
    const actions = {
      execute: vi.fn(async (actionId: string, input: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          sourceListCalls += 1;
          if (sourceListCalls === 1) {
            return {
              kind: 'page', revision: '7', definitions, nextCursor: null,
            } satisfies PluginActionResultById['automation.event.sources.list'];
          }
          expect((input as PluginActionInputById['automation.event.sources.list']).knownRevision).toBe('7');
          return { kind: 'unchanged', revision: '7' } satisfies PluginActionResultById['automation.event.sources.list'];
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
      signal: new AbortController().signal,
      services: {
        actions,
        connectedAccounts: { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer token' } })) },
        http,
        storage: { account: { collection: vi.fn(() => checkpoints.collection) } },
      },
    } as unknown as BackgroundServiceContext;
    const observer = createGithubAutomationEventCheckpointedPullObserver({ now: () => now, maxConcurrentSources: 1 });

    await observer.runCycle(sourceAttemptContext(observer, context));
    now = 61_000;
    await observer.runCycle(sourceAttemptContext(observer, context));

    expect(peakHttp).toBe(1);
    expect(repositoryOrder).toEqual([
      'widgets-1', 'widgets-2', 'widgets-3',
      'widgets-2', 'widgets-3', 'widgets-1',
    ]);
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
          return {
            kind: 'page', revision: '7', definitions: [source], nextCursor: null,
          } satisfies PluginActionResultById['automation.event.sources.list'];
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
