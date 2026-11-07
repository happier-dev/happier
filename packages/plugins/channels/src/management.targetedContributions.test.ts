import {
  PluginError,
  type JsonValue,
  type PluginInvocationContext,
  type TargetedContributionSnapshot,
  type TargetedContributionsService,
} from '@happier-dev/plugin-sdk';
import type { TargetedContributionPointRef } from '@happier-dev/plugin-sdk/contributions';
import type { ActionsService, PluginMachineExecutionOriginV1 } from '@happier-dev/plugin-sdk/actions';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { PluginTargetedContributionSelectionV1 } from '@happier-dev/plugin-sdk/contributions';
import { ConversationEndpointResolveInputV1Schema, ConversationProviderSetupResultV1Schema } from '@happier-dev/channels-protocol/v1';
import { describe, expect, it, vi } from 'vitest';
import { getConversationConnectionTransportOrigin, getConversationConnectionExecutionRouting } from './connectionLifecycle.js';

import {
  CHANNEL_STATE_FIELD,
  CHANNEL_STATE_FIXED_ROW_ID,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import { convergeConversationConnectionWebhookEndpointTarget } from './connectionWebhookEndpoint.js';
import { createIngressSupervisor } from './checkpointedPollSupervisor.js';
import {
  createConversationConnectionForInvocation,
  manageSessionPullRequestBindingForInvocation,
  deleteConversationConnectionForInvocation,
  prepareConversationConnectionForInvocation,
  recordConversationCheckpointedPollHistoryGapForInvocation,
  retestConversationConnectionForInvocation,
  retryConversationConnectionPollForInvocation,
  setConversationBindingEnabledForInvocation,
  updateConversationConnectionForInvocation,
  transferConversationConnectionForInvocation,
} from './management.js';
import {
  createCurrentConversationConnectionFixture,
  type ConversationConnectionFixtureAuthority,
} from './testkit/currentConnectionFixture.js';
import { MemoryCollection } from './testkit/memoryCollection.js';
import { GITHUB_CHANNEL_PULL_REQUESTS } from '../../scm-github/src/githubChannelContribution.js';

const providerSelection = {
  target: {
    pluginId: 'happier.channels',
    sourceCustody: { kind: 'development', registeredRootId: 'channels-root-a' },
  },
  point: {
    pointId: 'providers',
    protocol: { id: 'happier.channels/providers', version: 1 },
  },
  contributor: {
    pluginId: 'example.channels.provider',
    contributionId: 'example-socket',
    sourceCustody: { kind: 'managed', immutableGenerationId: 'provider-generation-a', installSource: 'npm' },
  },
} as const satisfies PluginTargetedContributionSelectionV1;

const replacementProviderSelection = {
  ...providerSelection,
  contributor: {
    pluginId: providerSelection.contributor.pluginId,
    contributionId: 'example-socket-replacement',
    sourceCustody: { kind: 'managed', immutableGenerationId: 'provider-generation-b', installSource: 'npm' },
  },
} as const satisfies PluginTargetedContributionSelectionV1;

function admittedProviderOperation(input: Readonly<{
  contributor?: Readonly<{
    pluginId: string;
    contributionId: string;
    sourceCustody: PluginTargetedContributionSelectionV1['contributor']['sourceCustody'];
  }>;
  role: string;
}>) {
  const contributor = input.contributor ?? providerSelection.contributor;
  const occurrenceId = contributor.sourceCustody.kind === 'managed'
    ? contributor.sourceCustody.immutableGenerationId
    : contributor.contributionId;
  return Object.freeze({
    identity: Object.freeze({
      target: Object.freeze({ pluginId: providerSelection.target.pluginId }),
      point: Object.freeze({
        pointId: providerSelection.point.pointId,
        protocol: Object.freeze({ ...providerSelection.point.protocol }),
      }),
      contributor: Object.freeze({
        pluginId: contributor.pluginId,
        contributionId: contributor.contributionId,
        occurrenceId,
      }),
      role: input.role,
    }),
  });
}

const setupAction = admittedProviderOperation({ role: 'setup' });
const connectionTestAction = admittedProviderOperation({ role: 'connectionTest' });
const messageDeliverAction = admittedProviderOperation({ role: 'messageDeliver' });
const connectionStopAction = admittedProviderOperation({ role: 'connectionStop' });
const observationsPollAction = admittedProviderOperation({ role: 'observationsPoll' });
const selectedCredentialRef = {
  service: {
    pluginId: providerSelection.contributor.pluginId,
    localId: 'example-connected-account',
  },
  accountId: 'account-example',
} as const;

type TargetedProviderFixtureSnapshot = Readonly<{
  contributorId?: string;
  contributorImmutableGenerationId: string;
  contributorPluginId?: string;
  operations?: unknown;
  targetImmutableGenerationId?: string;
  targetSourceCustody?: PluginTargetedContributionSelectionV1['target']['sourceCustody'];
  contributions?: readonly TargetedProviderFixtureSnapshot[];
}>;

function targetedContributionsFixture(input: TargetedProviderFixtureSnapshot & Readonly<{
  snapshots?: readonly TargetedProviderFixtureSnapshot[];
}>): TargetedContributionsService {
  let readCount = 0;
  const snapshots = input.snapshots ?? [input];
  return Object.freeze({
    observeForSelf<TContribution>(
      _point: TargetedContributionPointRef<TContribution>,
      _options: Readonly<{ onInvalidated: () => void }>,
    ) {
      return Object.freeze({
        dispose() {},
        async readCurrent(): Promise<TargetedContributionSnapshot<TContribution>> {
          const current = snapshots[Math.min(readCount, snapshots.length - 1)];
          readCount += 1;
          if (current === undefined) throw new Error('Expected a targeted-provider snapshot.');
          // This is the host admission boundary fixture. The real snapshot carries
          // the contributor generation with the exact role Action handle.
          return {
            occurrenceId: current.targetImmutableGenerationId ?? 'channels-occurrence-a',
            sourceCustody: current.targetSourceCustody ?? providerSelection.target.sourceCustody,
            contributions: (current.contributions ?? [current]).map((contribution) => ({
              contributor: {
                pluginId: contribution.contributorPluginId ?? providerSelection.contributor.pluginId,
                contributionId: contribution.contributorId ?? providerSelection.contributor.contributionId,
                occurrenceId: contribution.contributorImmutableGenerationId,
                sourceCustody: { kind: 'managed', immutableGenerationId: contribution.contributorImmutableGenerationId, installSource: 'npm' },
              },
              protocol: providerSelection.point.protocol,
              descriptor: { v: 1, displayName: 'Provider fixture', pullRequests: GITHUB_CHANNEL_PULL_REQUESTS },
              operations: contribution.operations ?? {
                setup: setupAction,
                connectionTest: connectionTestAction,
                messageDeliver: messageDeliverAction,
              },
            })) as unknown as readonly TContribution[],
          };
        },
      });
    },
  });
}

function invocationContext(input: Readonly<{
  actions: ActionsService;
  targetedContributions: TargetedContributionsService;
  stateCollection?: unknown;
  signal?: AbortSignal;
}>): PluginInvocationContext {
  // Prepare reaches only these two host-owned boundaries; the narrow cast keeps
  // the test on the public management owner without mocking internal logic.
  return {
    invokedAtMs: 1_700_000_000_000,
    signal: input.signal ?? new AbortController().signal,
    services: {
      actions: input.actions,
      targetedContributions: input.targetedContributions,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      ...(input.stateCollection === undefined ? {} : {
        storage: {
          account: { collection: () => input.stateCollection },
        },
      }),
    },
  } as unknown as PluginInvocationContext;
}

type MutableStateValue = Readonly<Record<string, unknown>> & Readonly<{ id: string }>;
type MutableStateMutation =
  | Readonly<{ kind: 'assert'; rowId: string; expectedRevision: number }>
  | Readonly<{
    kind: 'put';
    value: MutableStateValue;
    expectedRevision: number | 'absent';
  }>;

/** The Account Collection is the one external boundary for this owner test. */
function createMutableConnectionStateCollection() {
  const queryCollection = new MemoryCollection<MutableStateValue>();
  const rows = queryCollection.rows;
  let loseNextUpdatedBatchResponse = false;
  const batch = vi.fn(async (operations: readonly MutableStateMutation[]) => {
    const conflicts = operations.flatMap((operation) => {
      const rowId = operation.kind === 'put' ? operation.value.id : operation.rowId;
      const current = rows.get(rowId);
      const expected = operation.expectedRevision;
      const matches = expected === 'absent'
        ? current === undefined
        : current?.revision === expected;
      return matches ? [] : [{
        rowId,
        revision: current?.revision ?? 0,
        deleted: false,
      }];
    });
    if (conflicts.length > 0) return { status: 'conflict' as const, conflicts };

    const results: Array<Readonly<{ rowId: string; revision: number; deleted: false }>> = [];
    for (const operation of operations) {
      if (operation.kind !== 'put') continue;
      const current = rows.get(operation.value.id);
      const revision = (current?.revision ?? 0) + 1;
      rows.set(operation.value.id, { rowId: operation.value.id, revision, value: operation.value });
      results.push({ rowId: operation.value.id, revision, deleted: false });
    }
    if (loseNextUpdatedBatchResponse) {
      loseNextUpdatedBatchResponse = false;
      throw new Error('simulated response loss after Account write commit');
    }
    return { status: 'updated' as const, results };
  });
  return {
    rows,
    get: async (rowId: string) => rows.get(rowId) ?? null,
    async put(value: MutableStateValue, input: Readonly<{ expectedRevision: number | 'absent' }>) {
      const current = rows.get(value.id);
      const matches = input.expectedRevision === 'absent'
        ? current === undefined
        : current?.revision === input.expectedRevision;
      if (!matches) throw new Error('collection conflict');
      const row = { rowId: value.id, revision: (current?.revision ?? 0) + 1, value };
      rows.set(value.id, row);
      return row;
    },
    query: queryCollection.query.bind(queryCollection),
    batch,
    loseNextUpdatedBatchResponse() {
      loseNextUpdatedBatchResponse = true;
    },
  };
}

function seedConnectionIdentityKey(collection: ReturnType<typeof createMutableConnectionStateCollection>): void {
  const rowId = CHANNEL_STATE_FIXED_ROW_ID.connectionIdentityKey;
  collection.rows.set(rowId, {
    rowId,
    revision: 1,
    value: {
      [CHANNEL_STATE_FIELD.id]: rowId,
      [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.connectionIdentityKey,
      [CHANNEL_STATE_FIELD.version]: 1,
      payload: { connectionIdentityKey: 'A'.repeat(43) },
    },
  });
}

function collectionQuotaError(): PluginError {
  return new PluginError({
    code: 'collection_quota_incompatible',
    message: 'Collection mutation exceeds the current Account quota.',
    details: { dimension: 'maxAccountBytes', effectiveMaximum: 1 },
  });
}

function readyConnectionCreateActionExecutor() {
  const executionOrigin = {
    serverIdentityId: 'srv_example',
    materializationRef: {
      pluginId: providerSelection.contributor.pluginId,
      machineId: 'machine-example',
      materializationId: 'materialization-example',
    },
  } as const;
  return vi.fn(async (action: unknown) => {
    if (action === setupAction) {
      return {
        result: {
          v: 1,
          credentialRef: null,
          providerConnectionKey: 'example:connection',
          providerConfigVersion: 1,
          providerConfig: { opaque: true },
          integrationPrincipal: { id: 'example-bot' },
          supportedTransports: ['socket'],
          recommendedTransport: 'socket',
          overlapSafety: 'safe',
          replayContinuity: 'none',
          outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
          setupGuidance: {
            externalUrl: 'https://provider.example.test/install',
            requiredPermissionsLabel: 'Read messages, Send messages',
          },
        },
        executionOrigin,
      };
    }
    if (action === connectionTestAction) {
      return {
        result: {
          kind: 'ready',
          integrationPrincipal: { id: 'example-bot' },
          providerConnectionKey: 'example:connection',
        },
        executionOrigin,
      };
    }
    throw new Error('Expected only the selected setup and connection-test Actions.');
  });
}

function readyConnectionCreateContext(input: Readonly<{ stateCollection: unknown }>): Readonly<{
  context: PluginInvocationContext;
  executeAdmittedTargetedOperationWithExecutionOrigin: ReturnType<typeof readyConnectionCreateActionExecutor>;
}> {
  const executeAdmittedTargetedOperationWithExecutionOrigin = readyConnectionCreateActionExecutor();
  return {
    context: invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: {
          setup: setupAction,
          connectionTest: connectionTestAction,
          messageDeliver: messageDeliverAction,
          connectionStop: connectionStopAction,
        },
      }),
      stateCollection: input.stateCollection,
    }),
    executeAdmittedTargetedOperationWithExecutionOrigin,
  };
}

const connectionCreateInput = {
  providerSelection,
  providerSetupInput: { source: 'create' },
  credentialRef: null,
  selectedTransport: 'socket',
  maximumObservationAgeMs: 60_000,
} as const;

describe('connection Create acknowledgement recovery', () => {
  it('adopts the exact committed reservation after an unknown Collection acknowledgement without a second write', async () => {
    const collection = createMutableConnectionStateCollection();
    seedConnectionIdentityKey(collection);
    const originalBatch = collection.batch.getMockImplementation()!;
    collection.batch.mockImplementationOnce(async operations => {
      await originalBatch(operations);
      throw new PluginError({ code: 'plugin_collection_outcome_unknown', message: 'Lost acknowledgement' });
    });
    const { context } = readyConnectionCreateContext({ stateCollection: collection });
    const outcome = await createConversationConnectionForInvocation(connectionCreateInput, context);
    expect(outcome).toMatchObject({ kind: 'rejoined' });
    expect(collection.batch).toHaveBeenCalledTimes(1);
    expect([...collection.rows.values()].filter(row => row.value['record-kind'] === 'connection')).toHaveLength(1);
  });

  it('preserves uncertainty after an uncommitted acknowledgement and safely rejoins through the same Create Action', async () => {
    const collection = createMutableConnectionStateCollection();
    seedConnectionIdentityKey(collection);
    collection.batch.mockRejectedValueOnce(new PluginError({ code: 'plugin_collection_outcome_unknown', message: 'Lost acknowledgement' }));
    const { context } = readyConnectionCreateContext({ stateCollection: collection });
    await expect(createConversationConnectionForInvocation(connectionCreateInput, context)).rejects.toMatchObject({
      code: 'plugin_collection_outcome_unknown', retryable: true,
      details: { recommendedRecovery: { action: { pluginId: 'happier.channels', localId: 'connection/create-v1' } } },
    });
    const created = await createConversationConnectionForInvocation(connectionCreateInput, context);
    expect(created.kind).toBe('created');
    const rejoined = await createConversationConnectionForInvocation(connectionCreateInput, context);
    expect(rejoined).toMatchObject({ ...created, kind: 'rejoined' });
    expect([...collection.rows.values()].filter(row => row.value['record-kind'] === 'connection')).toHaveLength(1);
  });

  it('does not offer a safe retry when the canonical outcome cannot be read', async () => {
    const collection = createMutableConnectionStateCollection();
    seedConnectionIdentityKey(collection);
    collection.batch.mockImplementationOnce(async () => {
      vi.spyOn(collection, 'get').mockRejectedValueOnce(new Error('Account state unavailable'));
      throw new PluginError({ code: 'plugin_collection_outcome_unknown', message: 'Lost acknowledgement' });
    });
    const { context } = readyConnectionCreateContext({ stateCollection: collection });
    await expect(createConversationConnectionForInvocation(connectionCreateInput, context)).rejects.toMatchObject({
      code: 'plugin_collection_outcome_unknown', retryable: false,
      details: { recommendedRecovery: { unavailableReason: 'accountStateUnavailable' } },
    });
    expect(collection.batch).toHaveBeenCalledTimes(1);
  });

  it('adopts an original Create that commits after the unknown-outcome reread', async () => {
    const collection = createMutableConnectionStateCollection();
    seedConnectionIdentityKey(collection);
    const commit = collection.batch.getMockImplementation()!;
    let issued: readonly MutableStateMutation[] = [];
    collection.batch.mockImplementationOnce(async operations => {
      issued = operations;
      throw new PluginError({ code: 'plugin_collection_outcome_unknown', message: 'Lost acknowledgement' });
    });
    const { context } = readyConnectionCreateContext({ stateCollection: collection });
    await expect(createConversationConnectionForInvocation(connectionCreateInput, context)).rejects.toMatchObject({
      code: 'plugin_collection_outcome_unknown', retryable: true,
    });
    await commit(issued);
    expect(await createConversationConnectionForInvocation(connectionCreateInput, context)).toMatchObject({ kind: 'rejoined' });
    expect(collection.batch).toHaveBeenCalledTimes(1);
    expect([...collection.rows.values()].filter(row => row.value['record-kind'] === 'connection')).toHaveLength(1);
  });
});

describe('native SCM session PR binding owner', () => {
  it('refuses another person’s Session at the canonical reader before status, credentials or writes', async () => {
    const collection = createMutableConnectionStateCollection();
    const execute = vi.fn(async () => ({ projection: 'externalShareableV1', sessionId: 'another-persons-session' }));
    const providerEffect = vi.fn();
    const context = invocationContext({ stateCollection: collection,
      actions: { execute, executeAdmittedTargetedOperationWithExecutionOrigin: providerEffect } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({ contributorImmutableGenerationId: 'provider-generation-a' }),
    });
    const request = { kind: 'attach', sessionId: 'session-1', pullRequest: { repository: 'acme/widgets', number: 12 } };
    await expect(manageSessionPullRequestBindingForInvocation(request, context))
      .rejects.toMatchObject({ code: 'channels_pr_link_session_not_verified' });
    const denied = new PluginError({ code: 'session_access_denied', message: 'Session reader denied access' });
    execute.mockRejectedValueOnce(denied);
    await expect(manageSessionPullRequestBindingForInvocation(request, context)).rejects.toBe(denied);
    expect(execute.mock.calls).toEqual([
      ['session.transcript.get', { sessionId: 'session-1', projection: 'externalShareableV1', limit: 1 }, { signal: context.signal }],
      ['session.transcript.get', { sessionId: 'session-1', projection: 'externalShareableV1', limit: 1 }, { signal: context.signal }],
    ]);
    expect(providerEffect).not.toHaveBeenCalled();
    expect(collection.rows.size).toBe(0);
  });

  it.each([
    { label: 'no accepted checkout', status: { session: { id: 'session-1' } } },
    { label: 'repository without an admitted checkout', status: { session: { id: 'session-1' }, acceptedWorkspace: {
      repository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' },
    } } },
    { label: 'another Session', status: { session: { id: 'session-2' }, acceptedWorkspace: {
      checkout: { serverId: 'srv_example', workspaceId: 'workspace-1', machineId: 'machine-example', rootPath: '/repo' },
      repository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' },
    } } },
    { label: 'another repository', status: { session: { id: 'session-1' }, acceptedWorkspace: {
      checkout: { serverId: 'srv_example', workspaceId: 'workspace-1', machineId: 'machine-example', rootPath: '/repo' },
      repository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/other' },
    } } },
  ])('refuses URL and structured attach with $label before provider effects or binding writes', async ({ status }) => {
    const collection = createMutableConnectionStateCollection();
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();
    const execute = vi.fn(async (actionId: string) => {
      if (actionId === 'session.transcript.get') return { projection: 'externalShareableV1', sessionId: 'session-1' };
      if (actionId === 'session.status.get') return status;
      throw new Error(`Unexpected Action ${actionId}`);
    });
    const context = invocationContext({ stateCollection: collection,
      actions: { execute, executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({ contributorImmutableGenerationId: 'provider-generation-a' }),
    });
    const targets: readonly Readonly<Record<string, JsonValue>>[] = [{ pullRequestUrl: 'https://github.com/acme/widgets/pull/12' },
      { pullRequest: { repository: 'acme/widgets', number: 12 } }];
    for (const target of targets) {
      await expect(manageSessionPullRequestBindingForInvocation({ kind: 'attach', sessionId: 'session-1', ...target }, context))
        .rejects.toMatchObject({ code: 'channels_pr_link_checkout_not_verified' });
    }
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
    expect(collection.rows.size).toBe(0);
    expect(execute).toHaveBeenCalledWith('session.status.get', {
      sessionId: 'session-1', includeAcceptedWorkspace: true,
    }, expect.objectContaining({ signal: context.signal }));
  });

  it.each(['https://github.com/acme/widgets/issues/12', 'https://example.test/acme/widgets/pull/12'])('refuses a URL that cannot identify a supported PR: %s', async (pullRequestUrl) => {
    const execute = vi.fn();
    const context = invocationContext({ actions: { execute } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({ contributorImmutableGenerationId: 'provider-generation-a' }),
    });
    await expect(manageSessionPullRequestBindingForInvocation({ kind: 'attach', sessionId: 'session-1', pullRequestUrl }, context))
      .rejects.toMatchObject({ code: 'channels_pr_link_url_invalid' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('attaches without an existing connection and rejoins both link and scoped binding after response loss', async () => {
    const collection = createMutableConnectionStateCollection();
    seedConnectionIdentityKey(collection);
    const contributor = { ...providerSelection.contributor, pluginId: 'happier.scm.forge.github', contributionId: 'github-channels' };
    const roles = ['setup', 'connectionTest', 'observationsPoll', 'endpointResolve', 'principalResolve'] as const;
    const operations = Object.fromEntries(roles.map((role) => [role, admittedProviderOperation({ contributor, role })]));
    const credentialRef = { service: { pluginId: contributor.pluginId, localId: 'github' }, accountId: 'native-account' };
    const origin = { serverIdentityId: 'srv_example', materializationRef: { pluginId: contributor.pluginId, machineId: 'machine-example', materializationId: 'materialization-example' } };
    const setup = { v: 1, credentialRef, providerConnectionKey: 'github:repository:77', providerConfigVersion: 1, providerConfig: { repository: 'acme/widgets' }, integrationPrincipal: { id: '99', label: 'native-user' }, supportedTransports: ['checkpointedPull'], recommendedTransport: 'checkpointedPull', overlapSafety: 'safe', replayContinuity: 'checkpointed', outboundTextLimit: { maximum: 65_536, unit: 'unicodeCodePoints' }, sharedEndpointInputModes: ['allAllowedMessages'] };
    const actions = {
      execute: async (actionId: string, input: JsonValue) => {
        if (actionId === 'automation.conversation.target.verify') return { kind: 'verified' };
        if (actionId === 'session.transcript.get') return { ok: true, projection: 'externalShareableV1', sessionId: 'session-1', items: [], scannedThroughSeq: 0, hasMore: false };
        if (actionId === 'session.status.get') return { session: { id: 'session-1' }, acceptedWorkspace: {
          checkout: { serverId: 'srv_example', workspaceId: 'workspace-1', machineId: 'machine-example', rootPath: '/repo' },
          repository: { kind: 'github', deployment: 'https://github.com/', repository: 'Acme/Widgets' },
        } };
        throw new Error(`Unexpected action ${actionId}: ${JSON.stringify(input)}`);
      },
      executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(async (action: unknown, input: unknown) => {
        const number = action === operations.endpointResolve && ConversationEndpointResolveInputV1Schema.parse(input).query.endsWith('/13') ? 13 : 12;
        const result = action === operations.setup ? setup
          : action === operations.connectionTest ? { kind: 'ready', integrationPrincipal: setup.integrationPrincipal, providerConnectionKey: setup.providerConnectionKey }
          : action === operations.endpointResolve ? { kind: 'resolved', candidates: [{ kind: 'githubPullRequest', audience: 'shared', id: `github:repository:77:issue:300:number:${number}`, parentId: '77', pullRequest: { repository: 'acme/widgets', number } }] }
          : action === operations.principalResolve ? { kind: 'resolved', candidates: [{ id: '99', label: 'native-user', kind: 'human' }] }
          : undefined;
        if (result === undefined) throw new Error('Unexpected provider effect');
        return { result, executionOrigin: origin };
      }),
    };
    const providerReads: string[] = [];
    const targeted = targetedContributionsFixture({ contributorPluginId: contributor.pluginId, contributorId: contributor.contributionId, contributorImmutableGenerationId: 'provider-generation-a', operations });
    const context = invocationContext({ stateCollection: collection, actions: actions as unknown as ActionsService,
      targetedContributions: { ...targeted, observeForSelf(point, options) {
        providerReads.push(point.id);
        return targeted.observeForSelf(point, options);
      } },
    });
    const link = { kind: 'attach', sessionId: 'session-1', pullRequest: { repository: 'acme/widgets', number: 12 } };
    actions.executeAdmittedTargetedOperationWithExecutionOrigin.mockImplementationOnce(async () => ({
      result: { ...setup, credentialRef: { ...credentialRef, accountId: 'another-account' } }, executionOrigin: origin,
    }));
    await expect(manageSessionPullRequestBindingForInvocation({ ...link, credentialRef }, context))
      .rejects.toMatchObject({ code: 'channels_pr_link_credential_mismatch' });
    expect([...collection.rows.values()].filter(row => row.value['record-kind'] === 'connection')).toHaveLength(0);
    await expect(manageSessionPullRequestBindingForInvocation({ ...link, pullRequest: { ...link.pullRequest, number: 14 } }, context))
      .rejects.toMatchObject({ code: 'channels_pr_link_endpoint_identity_mismatch' });
    actions.executeAdmittedTargetedOperationWithExecutionOrigin.mockClear();
    const connectionReads = vi.spyOn(collection, 'get');
    providerReads.length = 0;
    const expectOneAdmission = () => {
      const calls = actions.executeAdmittedTargetedOperationWithExecutionOrigin.mock.calls;
      expect(Object.fromEntries(['setup', 'connectionTest', 'endpointResolve', 'principalResolve'].map(role =>
        [role, calls.filter(([action]) => action === operations[role]).length]))).toEqual({
        setup: 1, connectionTest: 1, endpointResolve: 1, principalResolve: 1,
      });
      actions.executeAdmittedTargetedOperationWithExecutionOrigin.mockClear();
    };
    const first = await manageSessionPullRequestBindingForInvocation({ kind: 'attach', sessionId: 'session-1',
      pullRequestUrl: 'https://github.com/Acme/widgets/pull/12' }, context);
    expectOneAdmission();
    if (first.kind !== 'attached') throw new Error('Expected the retained PR link.');
    const linkedBinding = collection.rows.get(first.bindingId);
    expect(linkedBinding?.value.payload).toMatchObject({ enabled: false, target: { kind: 'session', sessionId: 'session-1' } });
    const linkConnection = collection.rows.get(String(linkedBinding?.value[CHANNEL_STATE_FIELD.connectionId]));
    expect(linkConnection?.value.payload).toMatchObject({ enabled: true, transport: { kind: 'checkpointedPull' } });
    // The prior identity-mismatch request already created this connection.
    // Rejoin reads it once; the binding writer reads once for its final CAS.
    expect(connectionReads.mock.calls.filter(([id]) => id === linkConnection?.rowId)).toHaveLength(2);
    // PR selection carries its admitted contribution into setup; no second
    // selection read is needed. Connection test retains its own role lookup.
    expect(providerReads.filter(point => point === 'providers')).toHaveLength(2);
    connectionReads.mockClear();
    providerReads.length = 0;
    await expect(manageSessionPullRequestBindingForInvocation(link, context)).resolves.toEqual(first);
    expectOneAdmission();
    expect(connectionReads.mock.calls.filter(([id]) => id === linkConnection?.rowId)).toHaveLength(2);
    expect(providerReads.filter(point => point === 'providers')).toHaveLength(2);
    const scoped = { ...link, target: { automationId: 'automation-1', triggerId: 'trigger-1', triggerRevision: 0, triggerKind: 'ciFailed' } };
    collection.loseNextUpdatedBatchResponse();
    await expect(manageSessionPullRequestBindingForInvocation(scoped, context)).rejects.toThrow('simulated response loss after Account write commit');
    expectOneAdmission();
    const second = await manageSessionPullRequestBindingForInvocation(scoped, context);
    expectOneAdmission();
    await expect(manageSessionPullRequestBindingForInvocation(scoped, context)).resolves.toEqual(second);
    expectOneAdmission();
    await expect(manageSessionPullRequestBindingForInvocation({ ...scoped, target: { ...scoped.target, triggerRevision: 1 } }, context)).resolves.toEqual(second);
    expectOneAdmission();
    const active = [...collection.rows.values()].filter((row) => row.value['record-kind'] === 'binding' && typeof row.value.payload === 'object' && row.value.payload !== null && !Array.isArray(row.value.payload) && Reflect.get(row.value.payload, 'enabled') === true);
    expect(active).toHaveLength(1);
    expect(active[0]?.value.payload).toMatchObject({ target: { scopedTrigger: { triggerRevision: 1 } } });
    expect([...collection.rows.values()].filter((row) => row.value['record-kind'] === 'binding')).toHaveLength(2);
    await expect(manageSessionPullRequestBindingForInvocation({ kind: 'list', sessionId: 'session-1' }, context)).resolves.toEqual({ kind: 'links', sessionId: 'session-1', pullRequestLinks: [{ provider: 'github', repository: 'acme/widgets', number: 12, url: 'https://github.com/acme/widgets/pull/12' }] });
    await manageSessionPullRequestBindingForInvocation({ ...scoped, pullRequest: { repository: 'acme/widgets', number: 13 }, target: { ...scoped.target, triggerRevision: 2 } }, context);
    const observers = [...collection.rows.values()].filter((row) => row.value['record-kind'] === 'binding' && typeof row.value.payload === 'object' && row.value.payload !== null && !Array.isArray(row.value.payload) && Reflect.get(row.value.payload, 'enabled') === true);
    expect(observers).toHaveLength(1);
    expect(observers[0]?.value.payload).toMatchObject({ target: { scopedTrigger: { pullRequest: { number: 13 } } } });
    const links = await manageSessionPullRequestBindingForInvocation({ kind: 'list', sessionId: 'session-1' }, context);
    if (links.kind !== 'links') throw new Error('Expected the retained Session PR links.');
    expect(links).toEqual({ kind: 'links', sessionId: 'session-1', pullRequestLinks: expect.arrayContaining([
      { provider: 'github', repository: 'acme/widgets', number: 12, url: 'https://github.com/acme/widgets/pull/12' },
      { provider: 'github', repository: 'acme/widgets', number: 13, url: 'https://github.com/acme/widgets/pull/13' },
    ]) });
    expect(links.pullRequestLinks).toHaveLength(2);
  });
});

const DURABLE_PUSH_WEBHOOK_ENDPOINT_ID = 'wh_ep_AAECAwQFBgcICQoLDA0ODw';

/**
 * The durable-push create journey exercises the same public management owner
 * with a setup that declares the generic webhook contribution. The captured
 * connection-test input proves the preallocated final identity reached the
 * provider effect before any endpoint or row existed.
 */
function durablePushCreateActionExecutor(input: Readonly<{
  contributorPluginId?: string;
}>): Readonly<{
  executeAdmittedTargetedOperationWithExecutionOrigin: ReturnType<typeof vi.fn>;
  connectionTestInputs: unknown[];
}> {
  const connectionTestInputs: unknown[] = [];
  const contributorPluginId = input.contributorPluginId ?? providerSelection.contributor.pluginId;
  const executionOrigin = {
    serverIdentityId: 'srv_example',
    materializationRef: {
      pluginId: contributorPluginId,
      machineId: 'machine-example',
      materializationId: 'materialization-example',
    },
  } as const;
  const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown, actionInput: unknown) => {
    if (action === setupAction) {
      return {
        result: {
          v: 1,
          credentialRef: null,
          providerConnectionKey: 'example:connection',
          providerConfigVersion: 1,
          providerConfig: { opaque: true },
          integrationPrincipal: { id: 'example-bot' },
          supportedTransports: ['checkpointedPull', 'socket', 'durablePush'],
          recommendedTransport: 'durablePush',
          overlapSafety: 'safe',
          replayContinuity: 'none',
          outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
          webhookContributionRef: { pluginId: contributorPluginId, localId: 'webhook' },
        },
        executionOrigin,
      };
    }
    if (action === connectionTestAction) {
      connectionTestInputs.push(actionInput);
      return {
        result: {
          kind: 'ready',
          integrationPrincipal: { id: 'example-bot' },
          providerConnectionKey: 'example:connection',
        },
        executionOrigin,
      };
    }
    throw new Error('Expected only the selected setup and connection-test Actions.');
  });
  return { executeAdmittedTargetedOperationWithExecutionOrigin, connectionTestInputs };
}

function correspondenceReadyExecutor(input: Readonly<{
  observed?: unknown[];
  result?: unknown;
}> = {}): ReturnType<typeof vi.fn> {
  return vi.fn(async (_actionId: string, actionInput: unknown) => {
    input.observed?.push(actionInput);
    return input.result ?? {
      kind: 'ready',
      webhookEndpointId: (actionInput as Readonly<{ webhookEndpointId: string }>).webhookEndpointId,
      revision: 4,
    };
  });
}

function durablePushCreateContext(input: Readonly<{
  stateCollection: unknown;
  contributorPluginId?: string;
  correspondence?: ReturnType<typeof correspondenceReadyExecutor>;
  signal?: AbortSignal;
}>): Readonly<{
  context: PluginInvocationContext;
  executeAdmittedTargetedOperationWithExecutionOrigin: ReturnType<typeof vi.fn>;
  connectionTestInputs: unknown[];
  correspondenceInputs: unknown[];
}> {
  const correspondenceInputs: unknown[] = [];
  const executor = durablePushCreateActionExecutor({ contributorPluginId: input.contributorPluginId });
  const correspondence = input.correspondence ?? correspondenceReadyExecutor({ observed: correspondenceInputs });
  return {
    context: invocationContext({
      actions: {
        executeAdmittedTargetedOperationWithExecutionOrigin: executor.executeAdmittedTargetedOperationWithExecutionOrigin,
        execute: correspondence,
      } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        contributorPluginId: input.contributorPluginId,
        operations: {
          setup: setupAction,
          connectionTest: connectionTestAction,
          messageDeliver: messageDeliverAction,
          connectionStop: connectionStopAction,
          observationsPoll: observationsPollAction,
        },
      }),
      stateCollection: input.stateCollection,
      signal: input.signal,
    }),
    executeAdmittedTargetedOperationWithExecutionOrigin: executor.executeAdmittedTargetedOperationWithExecutionOrigin,
    connectionTestInputs: executor.connectionTestInputs,
    correspondenceInputs,
  };
}

function durablePushCreateInput(input: Readonly<{
  selectedTransport?: 'checkpointedPull' | 'socket' | 'durablePush';
  providerSelection?: Record<string, JsonValue>;
  endpointContinuation?: Readonly<{
    connectionId: string;
    webhookEndpointId: string;
  }>;
}> = {}): JsonValue {
  return {
    ...connectionCreateInput,
    selectedTransport: input.selectedTransport ?? 'durablePush',
    ...(input.providerSelection === undefined ? {} : { providerSelection: input.providerSelection }),
    ...(input.endpointContinuation === undefined ? {} : { endpointContinuation: input.endpointContinuation }),
  };
}

describe('prepareConversationConnectionForInvocation targeted provider selection', () => {
  it.each([true, false])('resolves the selected admitted contributor and binds its exact selected account to the setup handle (native limit: %s)', async (hasNativeLimit) => {
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown, actionInput: unknown, options: unknown) => {
      expect(action).toBe(setupAction);
      expect(actionInput).toEqual({ source: 'test' });
      expect(options).toMatchObject({ expectedSelectedConnectedAccountRef: selectedCredentialRef });
      return {
        result: {
          v: 1,
          credentialRef: selectedCredentialRef,
          providerConnectionKey: 'example:connection',
          providerConfigVersion: 1,
          providerConfig: { opaque: true },
          integrationPrincipal: { id: 'example-bot' },
          supportedTransports: ['socket'],
          recommendedTransport: 'socket',
          overlapSafety: 'safe',
          replayContinuity: 'none',
          ...(hasNativeLimit ? { outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' } } : {}),
          recommendedMaximumObservationAgeMs: 30 * 86_400_000,
          setupGuidance: {
            externalUrl: 'https://provider.example.test/install',
            requiredPermissionsLabel: 'Read messages, Send messages',
          },
        },
        executionOrigin: {
          serverIdentityId: 'srv_example',
          materializationRef: {
            pluginId: providerSelection.contributor.pluginId,
            machineId: 'machine-example',
            materializationId: 'materialization-example',
          },
        },
      };
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
      }),
    });

    const prepared = await prepareConversationConnectionForInvocation({
      providerSelection,
      providerSetupInput: { source: 'test' },
      credentialRef: selectedCredentialRef,
    }, context);
    expect(prepared).toMatchObject({
      kind: 'ready',
      supportedTransports: ['socket'],
      recommendedTransport: 'socket',
      recommendedMaximumObservationAgeMs: 30 * 86_400_000,
      setupGuidance: {
        externalUrl: 'https://provider.example.test/install',
        requiredPermissionsLabel: 'Read messages, Send messages',
      },
    });
    if (hasNativeLimit) expect(prepared).toHaveProperty('outboundTextLimit', { maximum: 4_000, unit: 'unicodeCodePoints' });
    else expect(prepared).not.toHaveProperty('outboundTextLimit');
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
  });

  it('projects a durable-push-capable provider onto the transports connection creation can currently select', async () => {
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => ({
      result: {
        v: 1,
        credentialRef: selectedCredentialRef,
        providerConnectionKey: 'example:connection',
        providerConfigVersion: 1,
        providerConfig: { opaque: true },
        integrationPrincipal: { id: 'example-bot' },
        supportedTransports: ['durablePush', 'socket'],
        recommendedTransport: 'durablePush',
        overlapSafety: 'safe',
        replayContinuity: 'none',
        outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
        webhookContributionRef: { pluginId: providerSelection.contributor.pluginId, localId: 'webhook' },
      },
      executionOrigin: {
        serverIdentityId: 'srv_example',
        materializationRef: {
          pluginId: providerSelection.contributor.pluginId,
          machineId: 'machine-example',
          materializationId: 'materialization-example',
        },
      },
    }));
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
      }),
    });

    await expect(prepareConversationConnectionForInvocation({
      providerSelection,
      providerSetupInput: { source: 'durable-push-capable' },
      credentialRef: selectedCredentialRef,
    }, context)).resolves.toMatchObject({
      kind: 'ready',
      supportedTransports: ['durablePush', 'socket'],
      recommendedTransport: 'durablePush',
    });
  });

  it('admits preparation when a provider only supports durable push', async () => {
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => ({
      result: {
        v: 1,
        credentialRef: selectedCredentialRef,
        providerConnectionKey: 'example:connection',
        providerConfigVersion: 1,
        providerConfig: { opaque: true },
        integrationPrincipal: { id: 'example-bot' },
        supportedTransports: ['durablePush'],
        recommendedTransport: 'durablePush',
        overlapSafety: 'safe',
        replayContinuity: 'none',
        outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
        webhookContributionRef: { pluginId: providerSelection.contributor.pluginId, localId: 'webhook' },
      },
      executionOrigin: {
        serverIdentityId: 'srv_example',
        materializationRef: {
          pluginId: providerSelection.contributor.pluginId,
          machineId: 'machine-example',
          materializationId: 'materialization-example',
        },
      },
    }));
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
      }),
    });

    await expect(prepareConversationConnectionForInvocation({
      providerSelection,
      providerSetupInput: { source: 'durable-push-only' },
      credentialRef: selectedCredentialRef,
    }, context)).resolves.toMatchObject({
      kind: 'ready',
      supportedTransports: ['durablePush'],
      recommendedTransport: 'durablePush',
    });
  });

  it('returns provider-neutral remediation without creating or testing a connection', async () => {
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown, actionInput: unknown, options: unknown) => {
      expect(action).toBe(setupAction);
      expect(actionInput).toEqual({ source: 'requires-remediation' });
      expect(options).toMatchObject({ expectedSelectedConnectedAccountRef: selectedCredentialRef });
      return {
        result: { kind: 'requiresRemediation' },
        executionOrigin: {
          serverIdentityId: 'srv_example',
          materializationRef: {
            pluginId: providerSelection.contributor.pluginId,
            machineId: 'machine-example',
            materializationId: 'materialization-example',
          },
        },
      };
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
      }),
    });

    await expect(prepareConversationConnectionForInvocation({
      providerSelection,
      providerSetupInput: { source: 'requires-remediation' },
      credentialRef: selectedCredentialRef,
    }, context)).resolves.toEqual({ kind: 'requiresRemediation' });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'a recommended transport outside the supported set',
      { supportedTransports: ['socket'], recommendedTransport: 'checkpointedPull' },
    ],
    [
      'durable push with destructive overlap',
      {
        supportedTransports: ['durablePush'],
        recommendedTransport: 'durablePush',
        overlapSafety: 'destructive',
        webhookContributionRef: { pluginId: providerSelection.contributor.pluginId, localId: 'webhook' },
      },
    ],
    [
      'durable push with replay continuity',
      {
        supportedTransports: ['durablePush'],
        recommendedTransport: 'durablePush',
        replayContinuity: 'checkpointed',
        webhookContributionRef: { pluginId: providerSelection.contributor.pluginId, localId: 'webhook' },
      },
    ],
    [
      'durable push without its webhook contribution',
      { supportedTransports: ['durablePush'], recommendedTransport: 'durablePush' },
    ],
    [
      'a webhook contribution without durable push',
      {
        supportedTransports: ['socket'],
        recommendedTransport: 'socket',
        webhookContributionRef: { pluginId: providerSelection.contributor.pluginId, localId: 'webhook' },
      },
    ],
  ] as const)('rejects %s through setup admission before prepare projects any transport facts', async (_name, overrides) => {
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => ({
      result: {
        v: 1,
        credentialRef: null,
        providerConnectionKey: 'example:connection',
        providerConfigVersion: 1,
        providerConfig: { opaque: true },
        integrationPrincipal: { id: 'example-bot' },
        overlapSafety: 'safe',
        replayContinuity: 'none',
        outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
        ...overrides,
      },
      executionOrigin: {
        serverIdentityId: 'srv_example',
        materializationRef: {
          pluginId: providerSelection.contributor.pluginId,
          machineId: 'machine-example',
          materializationId: 'materialization-example',
        },
      },
    }));
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
      }),
    });

    await expect(prepareConversationConnectionForInvocation({
      providerSelection,
      providerSetupInput: { source: 'invalid-transport-facts' },
      credentialRef: null,
    }, context)).rejects.toMatchObject({ code: 'channels_connection_setup_result_invalid' });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
  });

  it.each(['contributor', 'target'] as const)('re-resolves setup after the selected %s is replaced', async replaced => {
    const replacementSetup = admittedProviderOperation({ role: 'setup', contributor: {
      ...providerSelection.contributor,
      sourceCustody: { kind: 'managed', immutableGenerationId: 'provider-generation-b', installSource: 'npm' },
    } });
    const setup = readyConnectionCreateActionExecutor();
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (operation: unknown) => {
      expect(operation).toBe(replacementSetup);
      return setup(setupAction);
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: replaced === 'contributor' ? 'provider-generation-b' : providerSelection.contributor.sourceCustody.immutableGenerationId,
        ...(replaced === 'target' ? { targetSourceCustody: { kind: 'development' as const, registeredRootId: 'channels-root-b' } } : {}),
        operations: { setup: replacementSetup, connectionTest: connectionTestAction, messageDeliver: messageDeliverAction },
      }),
    });

    await expect(prepareConversationConnectionForInvocation({
      providerSelection,
      providerSetupInput: { source: 'test' },
      credentialRef: null,
    }, context)).resolves.toMatchObject({ kind: 'ready', supportedTransports: ['socket'] });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
  });

  it('does not fall back to another admitted contributor when the selected contributor is absent', async () => {
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorPluginId: 'another.channels.provider',
        contributorId: 'another-socket',
        contributorImmutableGenerationId: 'another-generation',
      }),
    });

    await expect(prepareConversationConnectionForInvocation({
      providerSelection,
      providerSetupInput: { source: 'test' },
      credentialRef: null,
    }, context)).rejects.toBeInstanceOf(Error);
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
  });
});

describe('checkpointed poll source custody', () => {
  const authority = {
    providerPluginId: providerSelection.contributor.pluginId,
    providerContributionSelection: { contributionId: providerSelection.contributor.contributionId },
    providerSetupInput: {},
    credentialRef: null,
    transportOrigin: {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-example',
        materializationId: 'materialization-example',
      },
    },
    providerConnectionKey: 'example:connection',
    providerConfig: {},
    routingIdentityKey: 'r'.repeat(43),
    integrationPrincipal: { id: 'example-bot' },
    authorityEpoch: 4,
  } as const satisfies ConversationConnectionFixtureAuthority;

  it('accepts current-route source custody for history-gap settlement and refuses another Machine', async () => {
    const connectionId = 'connection-source-poll';
    const collection = createMutableConnectionStateCollection();
    collection.rows.set(connectionId, {
      rowId: connectionId,
      revision: 4,
      value: createCurrentConversationConnectionFixture({
        configurationRevision: 4,
        connectionId,
        authority,
        transport: { kind: 'checkpointedPull' },
        replayContinuity: 'checkpointed',
      }),
    });
    const input = {
      connectionId,
      expectedRevision: 4,
      authorityEpoch: authority.authorityEpoch,
      executionOrigin: {
        serverIdentityId: authority.transportOrigin.serverIdentityId,
        sourceRef: {
          pluginId: authority.providerPluginId,
          machineId: authority.transportOrigin.materializationRef.machineId,
          sourceCustody: providerSelection.contributor.sourceCustody,
        },
      },
    };
    const context = invocationContext({ stateCollection: collection,
      actions: { async executeAdmittedTargetedOperationWithExecutionOrigin() {
        throw new Error('Settlement does not invoke another provider operation.');
      } } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({ contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId }),
    });
      await expect(recordConversationCheckpointedPollHistoryGapForInvocation({ ...input,
        executionOrigin: { ...input.executionOrigin, sourceRef: { ...input.executionOrigin.sourceRef, machineId: 'another-machine' } },
        fact: { reason: 'providerHistoryUnavailable' },
      }, context)).resolves.toBe('staleAuthority');
      expect(collection.batch).not.toHaveBeenCalled();
      await expect(recordConversationCheckpointedPollHistoryGapForInvocation({
        ...input,
        fact: { reason: 'providerHistoryUnavailable' },
      }, context)).resolves.toBe('recorded');
      expect(collection.batch).toHaveBeenCalled();
  });
});

describe('deleteConversationConnectionForInvocation transport ownership', () => {
  it('detaches a durable-push Channels connection without invoking provider stop or webhook revoke', async () => {
    const connectionId = 'connection-durable-push-delete';
    const collection = createMutableConnectionStateCollection();
    const authority = {
      providerPluginId: providerSelection.contributor.pluginId,
      providerContributionSelection: {
        contributionId: providerSelection.contributor.contributionId,
      },
      providerSetupInput: { source: 'saved' },
      credentialRef: null,
      transportOrigin: {
        serverIdentityId: 'srv_example',
        materializationRef: {
          pluginId: providerSelection.contributor.pluginId,
          machineId: 'machine-example',
          materializationId: 'materialization-example',
        },
      },
      providerConnectionKey: 'example:connection',
      providerConfig: { opaque: true },
      routingIdentityKey: 'r'.repeat(43),
      integrationPrincipal: { id: 'example-bot' },
      authorityEpoch: 4,
    } as const satisfies ConversationConnectionFixtureAuthority;
    collection.rows.set(connectionId, {
      rowId: connectionId,
      revision: 4,
      value: createCurrentConversationConnectionFixture({
        configurationRevision: 4,
        connectionId,
        authority,
        transport: {
          kind: 'durablePush',
          webhookContributionRef: { pluginId: providerSelection.contributor.pluginId, localId: 'webhook' },
          webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID,
          webhookSourceInstanceId: `channels.connection.${connectionId}`,
        },
        overlapSafety: 'safe',
        replayContinuity: 'none',
        outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
      }),
    });
    const { context, executeAdmittedTargetedOperationWithExecutionOrigin } = readyConnectionCreateContext({
      stateCollection: collection,
    });

    await expect(deleteConversationConnectionForInvocation({
      connectionId,
      expectedRevision: 4,
    }, context)).resolves.toEqual({
      kind: 'deleteFinalizing',
      connectionId,
      revision: 5,
      authorityEpoch: 5,
      acceptedPossibleLoss: false,
    });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
    expect(collection.rows.get(connectionId)).toMatchObject({
      revision: 5,
      value: {
        payload: {
          transport: {
            kind: 'durablePush',
            webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID,
          },
          deletionState: 'finalizingDelete',
          pendingOldTransportStop: null,
        },
      },
    });
  });
});

describe('createConversationConnectionForInvocation targeted provider selection', () => {
  it.each(['materialized', 'source'] as const)('reruns exact setup/test and rejoins response loss with %s custody', async (originKind) => {
    const hasNativeLimit = originKind === 'materialized';
    const collection = createMutableConnectionStateCollection();
    seedConnectionIdentityKey(collection);
    const controller = new AbortController();
    const executionOrigin: PluginMachineExecutionOriginV1 = originKind === 'source' ? {
      serverIdentityId: 'srv_example',
      sourceRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-example',
        sourceCustody: { kind: 'development', registeredRootId: '/runtime/source-a/provider' },
      },
    } : {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-example',
        materializationId: 'materialization-example',
      },
    };
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (
      action: unknown,
      actionInput: unknown,
      options: unknown,
    ) => {
      if (action === setupAction) {
        expect(actionInput).toEqual({ source: 'create' });
        expect(options).toMatchObject({
          signal: controller.signal,
          expectedSelectedConnectedAccountRef: selectedCredentialRef,
        });
        return {
          result: {
            v: 1,
            credentialRef: selectedCredentialRef,
            providerConnectionKey: 'example:connection',
            providerConfigVersion: 1,
            providerConfig: { opaque: true },
            integrationPrincipal: { id: 'example-bot' },
            supportedTransports: ['socket'],
            recommendedTransport: 'socket',
            overlapSafety: 'safe',
            replayContinuity: 'none',
            ...(hasNativeLimit ? { outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' } } : {}),
          },
          executionOrigin,
        };
      }
      expect(action).toBe(connectionTestAction);
      expect(options).toMatchObject({ signal: controller.signal });
      expect(actionInput).toMatchObject({
        v: 1,
        providerConnectionKey: 'example:connection',
        providerConfigVersion: 1,
        providerConfig: { opaque: true },
        credentialRef: selectedCredentialRef,
        selectedTransport: 'socket',
      });
      return {
        result: {
          kind: 'ready',
          integrationPrincipal: { id: 'example-bot' },
          providerConnectionKey: 'example:connection',
        },
        executionOrigin,
      };
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: {
          setup: setupAction,
          connectionTest: connectionTestAction,
          messageDeliver: messageDeliverAction,
          connectionStop: connectionStopAction,
        },
      }),
      stateCollection: collection,
      signal: controller.signal,
    });

    collection.loseNextUpdatedBatchResponse();
    await expect(createConversationConnectionForInvocation({
      providerSelection,
      providerSetupInput: { source: 'create' },
      credentialRef: selectedCredentialRef,
      selectedTransport: 'socket',
      maximumObservationAgeMs: 60_000,
    }, context)).rejects.toThrow('simulated response loss after Account write commit');

    const rejoined = await createConversationConnectionForInvocation({
      providerSelection,
      providerSetupInput: { source: 'create' },
      credentialRef: selectedCredentialRef,
      selectedTransport: 'socket',
      maximumObservationAgeMs: 60_000,
    }, context);
    expect(rejoined).toMatchObject({ kind: 'rejoined' });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(4);
    expect(collection.batch).toHaveBeenCalledOnce();
    const connections = [...collection.rows.values()].filter((row) => (
      row.value[CHANNEL_STATE_FIELD.recordKind] === CHANNEL_STATE_RECORD_KIND.connection
    ));
    expect(connections).toHaveLength(1);
    const connection = connections[0];
    if (connection === undefined) throw new Error('Expected the committed connection row.');
    expect(rejoined).toEqual({ kind: 'rejoined', connectionId: connection.rowId });
    expect(connection).toMatchObject({
      value: {
        payload: {
          providerPluginId: providerSelection.contributor.pluginId,
          providerContributionSelection: {
            contributionId: providerSelection.contributor.contributionId,
          },
          providerSetupInput: { source: 'create' },
          credentialRef: selectedCredentialRef,
          transport: { kind: 'socket' },
          providerConnectionKey: 'example:connection',
          providerConfig: { opaque: true },
          historyGap: { reason: 'providerHistoryUnavailable', reportedAt: expect.any(Number) },
        },
      },
    });
    if (hasNativeLimit) expect(connection.value.payload).toHaveProperty('outboundTextLimit', { maximum: 4_000, unit: 'unicodeCodePoints' });
    else expect(connection.value.payload).not.toHaveProperty('outboundTextLimit');
  });

  it('preserves a quota refusal from the identity-key singleton without a connection, reservation, or later effect', async () => {
    const quotaError = collectionQuotaError();
    const collection = {
      ...createMutableConnectionStateCollection(),
      put: vi.fn(async () => {
        throw quotaError;
      }),
    };
    const { context, executeAdmittedTargetedOperationWithExecutionOrigin } = readyConnectionCreateContext({
      stateCollection: collection,
    });

    await expect(createConversationConnectionForInvocation(connectionCreateInput, context)).rejects.toMatchObject({
      code: 'collection_quota_incompatible',
      details: { dimension: 'maxAccountBytes', effectiveMaximum: 1 },
    } satisfies Partial<PluginError>);
    expect(collection.put).toHaveBeenCalledOnce();
    expect(collection.batch).not.toHaveBeenCalled();
    expect(collection.rows.size).toBe(0);
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(2);
  });

  it('keeps a non-quota identity-key failure mapped to its existing Channels error', async () => {
    const collection = {
      ...createMutableConnectionStateCollection(),
      put: vi.fn(async () => {
        throw new Error('identity-key storage is unavailable');
      }),
    };
    const { context } = readyConnectionCreateContext({ stateCollection: collection });

    await expect(createConversationConnectionForInvocation(connectionCreateInput, context)).rejects.toMatchObject({
      code: 'channels_connection_identity_key_unavailable',
      retryable: true,
    } satisfies Partial<PluginError>);
    expect(collection.batch).not.toHaveBeenCalled();
    expect(collection.rows.size).toBe(0);
  });

  it('preserves a quota refusal from the connection-reservation batch without connection, reservation, or later effect', async () => {
    const collection = createMutableConnectionStateCollection();
    seedConnectionIdentityKey(collection);
    const quotaError = collectionQuotaError();
    collection.batch.mockRejectedValueOnce(quotaError);
    const { context, executeAdmittedTargetedOperationWithExecutionOrigin } = readyConnectionCreateContext({
      stateCollection: collection,
    });

    await expect(createConversationConnectionForInvocation(connectionCreateInput, context)).rejects.toMatchObject({
      code: 'collection_quota_incompatible',
      details: { dimension: 'maxAccountBytes', effectiveMaximum: 1 },
    } satisfies Partial<PluginError>);
    expect(collection.batch).toHaveBeenCalledOnce();
    expect([...collection.rows.values()]).toEqual([expect.objectContaining({
      rowId: CHANNEL_STATE_FIXED_ROW_ID.connectionIdentityKey,
      value: expect.objectContaining({
        [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.connectionIdentityKey,
      }),
    })]);
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(2);
  });

  it('does not invoke connection test when cancellation settles between setup and test', async () => {
    const collection = createMutableConnectionStateCollection();
    seedConnectionIdentityKey(collection);
    const controller = new AbortController();
    const executionOrigin = {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-example',
        materializationId: 'materialization-example',
      },
    };
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn((
      action: unknown,
      _actionInput: unknown,
      options: unknown,
    ) => {
      if (action === setupAction) {
        expect(options).toMatchObject({
          signal: controller.signal,
          expectedSelectedConnectedAccountRef: selectedCredentialRef,
        });
        let settleSetup: ((value: unknown) => void) | undefined;
        const setupExecution = new Promise<unknown>((resolve) => {
          settleSetup = resolve;
        });
        setTimeout(() => {
          // `runProviderSetup` registered its await continuation before this
          // timer. Registering this reaction now lets setup finish its own
          // cancellation checks, then aborts before the outer test effect.
          void setupExecution.then(() => controller.abort());
          settleSetup?.({
            result: {
              v: 1,
              credentialRef: selectedCredentialRef,
              providerConnectionKey: 'example:connection',
              providerConfigVersion: 1,
              providerConfig: { opaque: true },
              integrationPrincipal: { id: 'example-bot' },
              supportedTransports: ['socket'],
              recommendedTransport: 'socket',
              overlapSafety: 'safe',
              replayContinuity: 'none',
              outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
            },
            executionOrigin,
          });
        }, 0);
        return setupExecution;
      }
      expect(action).toBe(connectionTestAction);
      expect(options).toMatchObject({ signal: controller.signal });
      return {
        result: {
          kind: 'ready',
          integrationPrincipal: { id: 'example-bot' },
          providerConnectionKey: 'example:connection',
        },
        executionOrigin,
      };
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: {
          setup: setupAction,
          connectionTest: connectionTestAction,
          messageDeliver: messageDeliverAction,
          connectionStop: connectionStopAction,
        },
      }),
      stateCollection: collection,
      signal: controller.signal,
    });

    await expect(createConversationConnectionForInvocation({
      providerSelection,
      providerSetupInput: { source: 'cancel-after-setup' },
      credentialRef: selectedCredentialRef,
      selectedTransport: 'socket',
      maximumObservationAgeMs: 60_000,
    }, context)).rejects.toMatchObject({ code: 'channels_connection_create_cancelled' });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
    expect(collection.batch).not.toHaveBeenCalled();
  });

  it('rejects a setup credential echo that differs from the outer selected account before test or persistence', async () => {
    const collection = createMutableConnectionStateCollection();
    seedConnectionIdentityKey(collection);
    const executionOrigin = {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-example',
        materializationId: 'materialization-example',
      },
    };
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown) => {
      expect(action).toBe(setupAction);
      return {
        result: {
          v: 1,
          credentialRef: { ...selectedCredentialRef, accountId: 'another-account' },
          providerConnectionKey: 'example:connection',
          providerConfigVersion: 1,
          providerConfig: { opaque: true },
          integrationPrincipal: { id: 'example-bot' },
          supportedTransports: ['socket'],
          recommendedTransport: 'socket',
          overlapSafety: 'safe',
          replayContinuity: 'none',
          outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
        },
        executionOrigin,
      };
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: {
          setup: setupAction,
          connectionTest: connectionTestAction,
          messageDeliver: messageDeliverAction,
          connectionStop: connectionStopAction,
        },
      }),
      stateCollection: collection,
    });

    await expect(createConversationConnectionForInvocation({
      providerSelection,
      providerSetupInput: { source: 'create' },
      credentialRef: selectedCredentialRef,
      selectedTransport: 'socket',
      maximumObservationAgeMs: 60_000,
    }, context)).rejects.toMatchObject({ code: 'channels_connection_credential_mismatch' });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
    expect(collection.rows.size).toBe(1);
    expect(collection.batch).not.toHaveBeenCalled();
  });

  it.each(['setup', 'connectionTest'] as const)('accepts same-route source/materialized replacement from %s during setup', async (sourceOperation) => {
    const collection = createMutableConnectionStateCollection();
    seedConnectionIdentityKey(collection);
    const materializedOrigin = {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-example',
        materializationId: 'materialization-example',
      },
    };
    const sourceOrigin = {
      serverIdentityId: 'srv_example',
      sourceRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-example',
        sourceCustody: providerSelection.contributor.sourceCustody,
      },
    };
    const replacementContributor = {
      ...providerSelection.contributor,
      sourceCustody: { kind: 'managed', immutableGenerationId: 'provider-generation-b', installSource: 'npm' },
    } as const;
    const replacementOperations = {
      setup: admittedProviderOperation({ contributor: replacementContributor, role: 'setup' }),
      connectionTest: admittedProviderOperation({ contributor: replacementContributor, role: 'connectionTest' }),
      messageDeliver: admittedProviderOperation({ contributor: replacementContributor, role: 'messageDeliver' }),
      connectionStop: admittedProviderOperation({ contributor: replacementContributor, role: 'connectionStop' }),
    };
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown) => ({
      result: Reflect.get(action as object, 'identity').role === 'setup'
        ? {
          v: 1,
          credentialRef: null,
          providerConnectionKey: 'example:connection',
          providerConfigVersion: 1,
          providerConfig: { opaque: true },
          integrationPrincipal: { id: 'example-bot' },
          supportedTransports: ['socket'],
          recommendedTransport: 'socket',
          overlapSafety: 'safe',
          replayContinuity: 'none',
          outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
        }
        : {
          kind: 'ready',
          integrationPrincipal: { id: 'example-bot' },
          providerConnectionKey: 'example:connection',
        },
      executionOrigin: (Reflect.get(action as object, 'identity').role === 'setup') === (sourceOperation === 'setup')
        ? sourceOrigin
        : materializedOrigin,
    }));
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: {
          setup: setupAction,
          connectionTest: connectionTestAction,
          messageDeliver: messageDeliverAction,
          connectionStop: connectionStopAction,
        },
        snapshots: [
          { contributorImmutableGenerationId: 'provider-generation-a', operations: { setup: setupAction, connectionTest: connectionTestAction, messageDeliver: messageDeliverAction, connectionStop: connectionStopAction } },
          { contributorImmutableGenerationId: 'provider-generation-b', operations: replacementOperations },
        ],
      }),
      stateCollection: collection,
    });

    await expect(createConversationConnectionForInvocation({
      providerSelection,
      providerSetupInput: { source: 'create' },
      credentialRef: null,
      selectedTransport: 'socket',
      maximumObservationAgeMs: 60_000,
    }, context)).resolves.toMatchObject({ kind: 'created' });
    expect(collection.rows.size).toBe(3);
    if (sourceOperation === 'setup') {
      expect(executeAdmittedTargetedOperationWithExecutionOrigin.mock.calls.map(([action]) => action))
        .toEqual([setupAction, replacementOperations.connectionTest]);
      await expect(prepareConversationConnectionForInvocation({
        providerSelection,
        providerSetupInput: { source: 'prepare' },
        credentialRef: null,
      }, context)).resolves.toMatchObject({ kind: 'ready', supportedTransports: ['socket'] });
    }
  });

  it('lets the host refuse a test on another Machine after one setup and test admission', async () => {
    const collection = createMutableConnectionStateCollection();
    seedConnectionIdentityKey(collection);
    const setupExecutionOrigin = {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-example',
        materializationId: 'materialization-a',
      },
    };
    const hostRoutingDenial = new PluginError({ code: 'plugin_action_execution_origin_mismatch', message: 'Host routing admission refused' });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown, _input: unknown, options?: Readonly<{ expectedExecutionRouting?: unknown }>) => {
      if (action !== setupAction) {
        expect(options?.expectedExecutionRouting).toEqual(getConversationConnectionExecutionRouting(
          getConversationConnectionTransportOrigin(setupExecutionOrigin), providerSelection.contributor.pluginId,
        ));
        // Routing refusal belongs to the genuine host execution boundary.
        throw hostRoutingDenial;
      }
      return {
        result: {
          v: 1,
          credentialRef: null,
          providerConnectionKey: 'example:connection',
          providerConfigVersion: 1,
          providerConfig: { opaque: true },
          integrationPrincipal: { id: 'example-bot' },
          supportedTransports: ['socket'],
          recommendedTransport: 'socket',
          overlapSafety: 'safe',
          replayContinuity: 'none',
          outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
        },
        executionOrigin: setupExecutionOrigin,
      };
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: {
          setup: setupAction,
          connectionTest: connectionTestAction,
          messageDeliver: messageDeliverAction,
          connectionStop: connectionStopAction,
        },
      }),
      stateCollection: collection,
    });

    await expect(createConversationConnectionForInvocation({
      providerSelection,
      providerSetupInput: { source: 'create' },
      credentialRef: null,
      selectedTransport: 'socket',
      maximumObservationAgeMs: 60_000,
    }, context)).rejects.toBe(hostRoutingDenial);
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(2);
    expect(collection.rows.size).toBe(1);
    expect(collection.batch).not.toHaveBeenCalled();
  });

  it.each([
    ['socket', null],
    ['checkpointedPull', 'observationsPoll'],
  ] as const)('requires only the selected transport receive role (%s)', async (
    selectedTransport,
    requiredOperation,
  ) => {
    const collection = createMutableConnectionStateCollection();
    seedConnectionIdentityKey(collection);
    const executionOrigin = {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-example',
        materializationId: 'materialization-example',
      },
    };
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown) => ({
      result: action === setupAction
        ? {
          v: 1,
          credentialRef: null,
          providerConnectionKey: 'example:connection',
          providerConfigVersion: 1,
          providerConfig: { opaque: true },
          integrationPrincipal: { id: 'example-bot' },
          supportedTransports: [selectedTransport],
          recommendedTransport: selectedTransport,
          overlapSafety: 'safe',
          replayContinuity: 'none',
          outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
        }
        : {
          kind: 'ready',
          integrationPrincipal: { id: 'example-bot' },
          providerConnectionKey: 'example:connection',
        },
      executionOrigin,
    }));
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: { setup: setupAction, connectionTest: connectionTestAction, messageDeliver: messageDeliverAction },
      }),
      stateCollection: collection,
    });

    const creating = createConversationConnectionForInvocation({
      providerSelection,
      providerSetupInput: { source: 'create' },
      credentialRef: null,
      selectedTransport,
      maximumObservationAgeMs: 60_000,
    }, context);
    if (selectedTransport === 'socket') {
      await expect(creating).resolves.toMatchObject({ kind: 'created' });
      expect([...collection.rows.values()].find(row => row.value['record-kind'] === 'connection')?.value.payload)
        .toMatchObject({ enabled: true, pendingOldTransportStop: null });
      return;
    }
    await expect(creating).rejects.toMatchObject({
      code: 'channels_connection_transport_role_unavailable',
      details: { selectedTransport, requiredOperation },
    });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
    expect(collection.rows.size).toBe(1);
    expect(collection.batch).not.toHaveBeenCalled();
  });

  it('persists a proved setup/test result across same-ID contributor replacement before the persistence reread', async () => {
    const collection = createMutableConnectionStateCollection();
    seedConnectionIdentityKey(collection);
    const executionOrigin = {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-example',
        materializationId: 'materialization-example',
      },
    };
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown) => ({
      result: action === setupAction
        ? {
          v: 1,
          credentialRef: null,
          providerConnectionKey: 'example:connection',
          providerConfigVersion: 1,
          providerConfig: { opaque: true },
          integrationPrincipal: { id: 'example-bot' },
          supportedTransports: ['socket'],
          recommendedTransport: 'socket',
          overlapSafety: 'safe',
          replayContinuity: 'none',
          outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
        }
        : {
          kind: 'ready',
          integrationPrincipal: { id: 'example-bot' },
          providerConnectionKey: 'example:connection',
        },
      executionOrigin,
    }));
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        snapshots: [
          {
            contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
            operations: {
              setup: setupAction,
              connectionTest: connectionTestAction,
              messageDeliver: messageDeliverAction,
              connectionStop: connectionStopAction,
            },
          },
          {
            contributorImmutableGenerationId: 'provider-generation-b',
            operations: {
              setup: setupAction,
              connectionTest: connectionTestAction,
              messageDeliver: messageDeliverAction,
              connectionStop: connectionStopAction,
            },
          },
        ],
      }),
      stateCollection: collection,
    });

    await expect(createConversationConnectionForInvocation({
      providerSelection,
      providerSetupInput: { source: 'create' },
      credentialRef: null,
      selectedTransport: 'socket',
      maximumObservationAgeMs: 60_000,
    }, context)).resolves.toMatchObject({ kind: 'created' });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(2);
    expect(collection.batch).toHaveBeenCalledOnce();
  });

});

describe('transferConversationConnectionForInvocation targeted provider selection', () => {
  it('conflicts a narrow transfer when a concurrent enable changes the binding demand after its scan', async () => {
    const connectionId = 'connection-transfer-concurrent-enable';
    const executionOrigin = {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-old',
        materializationId: 'materialization-old',
      },
    } as const;
    const replacementExecutionOrigin = {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-replacement',
        materializationId: 'materialization-replacement',
      },
    } as const;
    const collection = createMutableConnectionStateCollection();
    const authority = {
      providerPluginId: providerSelection.contributor.pluginId,
      providerContributionSelection: {
        contributionId: providerSelection.contributor.contributionId,
      },
      providerSetupInput: { source: 'same' },
      credentialRef: null,
      transportOrigin: executionOrigin,
      providerConnectionKey: 'example:connection',
      providerConfig: { source: 'same' },
      routingIdentityKey: 'r'.repeat(43),
      integrationPrincipal: { id: 'example-bot' },
      authorityEpoch: 4,
    } as const satisfies ConversationConnectionFixtureAuthority;
    collection.rows.set(connectionId, {
      rowId: connectionId,
      revision: 4,
      value: createCurrentConversationConnectionFixture({
        configurationRevision: 4,
        connectionId,
        authority,
        transport: { kind: 'socket' },
        overlapSafety: 'safe',
        replayContinuity: 'none',
        outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
        sharedEndpointInputModes: ['directMentionsOnly', 'addressedMessages', 'allAllowedMessages'],
      }),
    });
    const bindingId = 'binding-concurrent-enable';
    collection.rows.set(bindingId, {
      rowId: bindingId,
      revision: 1,
      value: {
        [CHANNEL_STATE_FIELD.id]: bindingId,
        [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.binding,
        [CHANNEL_STATE_FIELD.connectionId]: connectionId,
        [CHANNEL_STATE_FIELD.bindingId]: bindingId,
        v: 1,
        'created-at': 1,
        'updated-at': 1,
        payload: {
          endpoint: { kind: 'shared', audience: 'shared', id: 'room-1' },
          target: {
            kind: 'session',
            sessionId: 'session-1',
            policy: {
              deliveryMode: 'repliesOnly',
              permissionCeiling: 'read-only',
              approvals: { kind: 'off' },
              newSession: { kind: 'off' },
            },
          },
          allowedPrincipalIds: ['person-1'],
          allowBotSenders: false,
          inputMode: 'allAllowedMessages',
          inboundDebounceMs: 750,
          linkPreviewPolicy: 'suppress',
          senderFeedback: 'off',
          authorityEpoch: 1,
          enabled: false,
          deletionState: 'none',
        },
      },
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown) => {
      if (action === setupAction) {
        return {
          result: {
            v: 1,
            credentialRef: null,
            providerConnectionKey: 'example:connection',
            providerConfigVersion: 1,
            providerConfig: { source: 'same' },
            integrationPrincipal: { id: 'example-bot' },
            supportedTransports: ['socket'],
            recommendedTransport: 'socket',
            overlapSafety: 'safe',
            replayContinuity: 'none',
            outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
            sharedEndpointInputModes: ['directMentionsOnly', 'addressedMessages'],
          },
          executionOrigin: replacementExecutionOrigin,
        };
      }
      if (action === connectionTestAction) {
        return {
          result: {
            kind: 'ready',
            integrationPrincipal: { id: 'example-bot' },
            providerConnectionKey: 'example:connection',
            sharedEndpointInputModes: ['directMentionsOnly', 'addressedMessages'],
          },
          executionOrigin: replacementExecutionOrigin,
        };
      }
      throw new Error('The transfer must lose before stopping the incumbent transport.');
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: {
          setup: setupAction,
          connectionTest: connectionTestAction,
          messageDeliver: messageDeliverAction,
          connectionStop: connectionStopAction,
        },
      }),
      stateCollection: collection,
    });
    const queryBeforeConcurrentEnable = collection.query.bind(collection);
    let enabled = false;
    collection.query = async (request) => {
      const scanned = await queryBeforeConcurrentEnable(request);
      if (!enabled && request.index === CHANNEL_STATE_INDEX_ID.byConnectionKindV1
        && request.prefix?.[0] === connectionId && request.prefix[1] === CHANNEL_STATE_RECORD_KIND.binding) {
        enabled = true;
        await setConversationBindingEnabledForInvocation({
          bindingId,
          expectedRevision: 1,
          enabled: true,
        }, context);
      }
      return scanned;
    };

    await expect(transferConversationConnectionForInvocation({
      connectionId,
      expectedRevision: 4,
      expectedAuthorityEpoch: 4,
      providerSelection,
      providerSetupInput: { source: 'same' },
      credentialRef: null,
      selectedTransport: 'socket',
    }, context)).rejects.toMatchObject({
      code: 'channels_connection_transfer_conflict',
    });
    expect(collection.rows.get(bindingId)?.value.payload).toMatchObject({ enabled: true });
    expect(collection.rows.get(connectionId)?.revision).toBe(5);
  });

  it('refuses a transfer whose replacement credential can no longer deliver an enabled shared binding', async () => {
    // Same bot, narrower credential: the replacement authenticates the same
    // immutable identity but its platform now withholds ordinary shared
    // messages. Committing this transfer would leave the saved
    // `allAllowedMessages` binding apparently intact and permanently silent.
    const connectionId = 'connection-transfer-narrowed-capability';
    const executionOrigin = {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-old',
        materializationId: 'materialization-old',
      },
    } as const;
    const replacementExecutionOrigin = {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-replacement',
        materializationId: 'materialization-replacement',
      },
    } as const;
    const collection = createMutableConnectionStateCollection();
    const authority = {
      providerPluginId: providerSelection.contributor.pluginId,
      providerContributionSelection: {
        contributionId: providerSelection.contributor.contributionId,
      },
      providerSetupInput: { source: 'same' },
      credentialRef: null,
      transportOrigin: executionOrigin,
      providerConnectionKey: 'example:connection',
      providerConfig: { source: 'same' },
      routingIdentityKey: 'r'.repeat(43),
      integrationPrincipal: { id: 'example-bot' },
      authorityEpoch: 4,
    } as const satisfies ConversationConnectionFixtureAuthority;
    collection.rows.set(connectionId, {
      rowId: connectionId,
      revision: 4,
      value: createCurrentConversationConnectionFixture({
        configurationRevision: 4,
        connectionId,
        authority,
        transport: { kind: 'socket' },
        overlapSafety: 'safe',
        replayContinuity: 'none',
        outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
        sharedEndpointInputModes: ['directMentionsOnly', 'addressedMessages', 'allAllowedMessages'],
      }),
    });
    const bindingId = 'binding-shared-all';
    collection.rows.set(bindingId, {
      rowId: bindingId,
      revision: 1,
      value: {
        [CHANNEL_STATE_FIELD.id]: bindingId,
        [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.binding,
        [CHANNEL_STATE_FIELD.connectionId]: connectionId,
        [CHANNEL_STATE_FIELD.bindingId]: bindingId,
        v: 1,
        payload: {
          enabled: true,
          endpoint: { audience: 'shared' },
          inputMode: 'allAllowedMessages',
        },
      },
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown) => {
      if (action === setupAction) {
        return {
          result: {
            v: 1,
            credentialRef: null,
            providerConnectionKey: 'example:connection',
            providerConfigVersion: 1,
            providerConfig: { source: 'same' },
            integrationPrincipal: { id: 'example-bot' },
            supportedTransports: ['socket'],
            recommendedTransport: 'socket',
            overlapSafety: 'safe',
            replayContinuity: 'none',
            outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
            sharedEndpointInputModes: ['directMentionsOnly', 'addressedMessages'],
          },
          executionOrigin: replacementExecutionOrigin,
        };
      }
      if (action === connectionTestAction) {
        return {
          result: {
            kind: 'ready',
            integrationPrincipal: { id: 'example-bot' },
            providerConnectionKey: 'example:connection',
            sharedEndpointInputModes: ['directMentionsOnly', 'addressedMessages'],
          },
          executionOrigin: replacementExecutionOrigin,
        };
      }
      throw new Error('A refused transfer must never reach the old-transport stop.');
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: {
          setup: setupAction,
          connectionTest: connectionTestAction,
          messageDeliver: messageDeliverAction,
          connectionStop: connectionStopAction,
        },
      }),
      stateCollection: collection,
    });

    await expect(transferConversationConnectionForInvocation({
      connectionId,
      expectedRevision: 4,
      expectedAuthorityEpoch: 4,
      providerSelection,
      providerSetupInput: { source: 'same' },
      credentialRef: null,
      selectedTransport: 'socket',
    }, context)).resolves.toMatchObject({
      kind: 'notReady',
      reason: 'permissionMissing',
    });
    // Nothing was committed: the incumbent authority and its wider retained
    // capability are untouched.
    expect(collection.rows.get(connectionId)).toMatchObject({
      revision: 4,
      value: {
        payload: {
          authorityEpoch: 4,
          sharedEndpointInputModes: ['directMentionsOnly', 'addressedMessages', 'allAllowedMessages'],
        },
      },
    });
  });

  it.each(['materialized', 'source'] as const)('moves a %s provider to another Machine without predecessor stop custody', async (originKind) => {
    const hasNativeLimit = originKind === 'materialized';
    const connectionId = 'connection-transfer-same-config-new-origin';
    const oldExecutionOrigin: PluginMachineExecutionOriginV1 = originKind === 'source' ? {
      serverIdentityId: 'srv_example',
      sourceRef: { pluginId: providerSelection.contributor.pluginId, machineId: 'machine-old',
        sourceCustody: { kind: 'development', registeredRootId: '/runtime/source-old/provider' } },
    } : {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-old',
        materializationId: 'materialization-old',
      },
    };
    const replacementExecutionOrigin: PluginMachineExecutionOriginV1 = originKind === 'source' ? {
      serverIdentityId: 'srv_example',
      sourceRef: { pluginId: providerSelection.contributor.pluginId, machineId: 'machine-replacement',
        sourceCustody: { kind: 'development', registeredRootId: '/runtime/source-reloaded/provider' } },
    } : {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-replacement',
        materializationId: 'materialization-replacement',
      },
    };
    const collection = createMutableConnectionStateCollection();
    const authority = {
      providerPluginId: providerSelection.contributor.pluginId,
      providerContributionSelection: {
        contributionId: providerSelection.contributor.contributionId,
      },
      providerSetupInput: { source: 'same' },
      credentialRef: null,
      transportOrigin: getConversationConnectionTransportOrigin(oldExecutionOrigin),
      providerConnectionKey: 'example:connection',
      providerConfig: { source: 'same' },
      routingIdentityKey: 'r'.repeat(43),
      integrationPrincipal: { id: 'example-bot' },
      authorityEpoch: 4,
    } as const satisfies ConversationConnectionFixtureAuthority;
    collection.rows.set(connectionId, {
      rowId: connectionId,
      revision: 4,
      value: createCurrentConversationConnectionFixture({
        configurationRevision: 4,
        connectionId,
        authority,
        transport: { kind: 'socket' },
        overlapSafety: 'safe',
        replayContinuity: 'none',
        outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
      }),
    });
    const stopInvocations: unknown[] = [];
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (
      action: unknown,
      operationInput: unknown,
      options?: unknown,
    ) => {
      if (action === setupAction) {
        return {
          result: {
            v: 1,
            credentialRef: null,
            providerConnectionKey: 'example:connection',
            providerConfigVersion: 1,
            providerConfig: { source: 'same' },
            integrationPrincipal: { id: 'example-bot' },
            supportedTransports: ['socket'],
            recommendedTransport: 'socket',
            overlapSafety: 'safe',
            replayContinuity: 'none',
            ...(hasNativeLimit ? { outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' } } : {}),
          },
          executionOrigin: replacementExecutionOrigin,
        };
      }
      if (action === connectionTestAction) {
        return {
          result: {
            kind: 'ready',
            integrationPrincipal: { id: 'example-bot' },
            providerConnectionKey: 'example:connection',
          },
          executionOrigin: replacementExecutionOrigin,
        };
      }
      if (action === connectionStopAction) {
        stopInvocations.push({ operationInput, options });
        return { result: { kind: 'pending' }, executionOrigin: oldExecutionOrigin };
      }
      throw new Error('Expected only the selected setup/test/stop Actions.');
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: {
          setup: setupAction,
          connectionTest: connectionTestAction,
          messageDeliver: messageDeliverAction,
          connectionStop: connectionStopAction,
        },
      }),
      stateCollection: collection,
    });

    await expect(transferConversationConnectionForInvocation({
      connectionId,
      expectedRevision: 4,
      expectedAuthorityEpoch: 4,
      providerSelection,
      providerSetupInput: { source: 'same' },
      credentialRef: null,
      selectedTransport: 'socket',
    }, context)).resolves.toEqual({
      kind: 'transferred',
      connectionId,
      revision: 5,
      authorityEpoch: 5,
    });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(2);
    const transferredPayload = collection.rows.get(connectionId)?.value.payload;
    if (hasNativeLimit) expect(transferredPayload).toHaveProperty('outboundTextLimit', { maximum: 4_000, unit: 'unicodeCodePoints' });
    else expect(transferredPayload).not.toHaveProperty('outboundTextLimit');
    expect(stopInvocations).toEqual([]);
    expect(collection.rows.get(connectionId)).toMatchObject({
      revision: 5,
      value: {
        payload: {
          transportOrigin: getConversationConnectionTransportOrigin(replacementExecutionOrigin),
          authorityEpoch: 5,
          pendingOldTransportStop: null,
        },
      },
    });
  });


  it('rejoins a lost committed socket transfer from desired placement with the predecessor unavailable', async () => {
    const connectionId = 'connection-transfer-targeted';
    const oldExecutionOrigin = {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-old',
        materializationId: 'materialization-old',
      },
    } as const;
    const replacementExecutionOrigin = {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: replacementProviderSelection.contributor.pluginId,
        machineId: 'machine-replacement',
        materializationId: 'materialization-replacement',
      },
    } as const;
    const replacementSetupAction = admittedProviderOperation({
      contributor: replacementProviderSelection.contributor,
      role: 'setup',
    });
    const replacementConnectionTestAction = admittedProviderOperation({
      contributor: replacementProviderSelection.contributor,
      role: 'connectionTest',
    });
    const collection = createMutableConnectionStateCollection();
    const oldAuthority = {
      providerPluginId: providerSelection.contributor.pluginId,
      providerContributionSelection: {
        contributionId: providerSelection.contributor.contributionId,
      },
      providerSetupInput: { source: 'old' },
      credentialRef: null,
      transportOrigin: getConversationConnectionTransportOrigin(oldExecutionOrigin),
      providerConnectionKey: 'example:connection',
      providerConfig: { source: 'old' },
      routingIdentityKey: 'r'.repeat(43),
      integrationPrincipal: { id: 'example-bot' },
      authorityEpoch: 4,
    } as const satisfies ConversationConnectionFixtureAuthority;
    collection.rows.set(connectionId, {
      rowId: connectionId,
      revision: 4,
      value: createCurrentConversationConnectionFixture({
        configurationRevision: 4,
        connectionId,
        authority: oldAuthority,
        transport: { kind: 'socket' },
        overlapSafety: 'safe',
        replayContinuity: 'none',
        outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
      }),
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown, actionInput: unknown) => {
      if (action === replacementSetupAction) {
        expect(actionInput).toEqual({ source: 'replacement' });
        return {
          result: {
            v: 1,
            credentialRef: null,
            providerConnectionKey: 'example:connection',
            providerConfigVersion: 1,
            providerConfig: { source: 'replacement' },
            integrationPrincipal: { id: 'example-bot' },
            supportedTransports: ['socket'],
            recommendedTransport: 'socket',
            overlapSafety: 'providerExclusive',
            replayContinuity: 'none',
            outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
          },
          executionOrigin: replacementExecutionOrigin,
        };
      }
      if (action === replacementConnectionTestAction) {
        expect(actionInput).toMatchObject({
          v: 1,
          connectionId,
          providerConnectionKey: 'example:connection',
          providerConfigVersion: 1,
          providerConfig: { source: 'replacement' },
          credentialRef: null,
          selectedTransport: 'socket',
        });
        return {
          result: {
            kind: 'ready',
            integrationPrincipal: { id: 'example-bot' },
            providerConnectionKey: 'example:connection',
          },
          executionOrigin: replacementExecutionOrigin,
        };
      }
      throw new Error('Expected only the selected replacement setup/test Actions.');
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: replacementProviderSelection.contributor.sourceCustody.immutableGenerationId,
        contributions: [
          {
            contributorId: replacementProviderSelection.contributor.contributionId,
            contributorImmutableGenerationId: replacementProviderSelection.contributor.sourceCustody.immutableGenerationId,
            operations: {
              setup: replacementSetupAction,
              connectionTest: replacementConnectionTestAction,
              messageDeliver: admittedProviderOperation({
                contributor: replacementProviderSelection.contributor,
                role: 'messageDeliver',
              }),
            },
          },
        ],
      }),
      stateCollection: collection,
    });
    const transferInput = {
      connectionId,
      expectedRevision: 4,
      expectedAuthorityEpoch: 4,
      providerSelection: replacementProviderSelection,
      providerSetupInput: { source: 'replacement' },
      credentialRef: null,
      selectedTransport: 'socket',
    } as const;

    collection.loseNextUpdatedBatchResponse();
    await expect(transferConversationConnectionForInvocation(transferInput, context))
      .rejects.toThrow('simulated response loss after Account write commit');
    expect(collection.rows.get(connectionId)).toMatchObject({
      revision: 5,
      value: {
        payload: {
          providerPluginId: replacementProviderSelection.contributor.pluginId,
          providerContributionSelection: {
            contributionId: replacementProviderSelection.contributor.contributionId,
          },
          providerSetupInput: { source: 'replacement' },
          transportOrigin: getConversationConnectionTransportOrigin(replacementExecutionOrigin),
          transport: { kind: 'socket' },
          overlapSafety: 'providerExclusive',
          replayContinuity: 'none',
          providerConnectionKey: 'example:connection',
          providerConfig: { source: 'replacement' },
          authorityEpoch: 5,
          pendingOldTransportStop: null,
          historyGap: { reason: 'providerHistoryUnavailable' },
        },
      },
    });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(2);

    await expect(transferConversationConnectionForInvocation(transferInput, context)).resolves.toEqual({
      kind: 'transferred',
      connectionId,
      revision: 5,
      authorityEpoch: 5,
    });
    // The current replacement is prepared again; desired-state equality
    // rejoins without a second write or reaching the offline predecessor.
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(4);
    expect(collection.batch).toHaveBeenCalledTimes(1);
    expect(collection.rows.get(connectionId)).toMatchObject({
      revision: 5,
      value: { payload: { authorityEpoch: 5, pendingOldTransportStop: null } },
    });
  });

  it('rejoins equal-origin desired placement without overwriting a concurrent Account policy change', async () => {
    const connectionId = 'connection-transfer-equal-origin-stale-after-test';
    const executionOrigin = {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-current',
        materializationId: 'materialization-current',
      },
    } as const;
    const collection = createMutableConnectionStateCollection();
    const authority = {
      providerPluginId: providerSelection.contributor.pluginId,
      providerContributionSelection: {
        contributionId: providerSelection.contributor.contributionId,
      },
      providerSetupInput: { source: 'same' },
      credentialRef: null,
      transportOrigin: executionOrigin,
      providerConnectionKey: 'example:connection',
      providerConfig: { source: 'same' },
      routingIdentityKey: 'r'.repeat(43),
      integrationPrincipal: { id: 'example-bot' },
      authorityEpoch: 4,
    } as const satisfies ConversationConnectionFixtureAuthority;
    const connectionValue = createCurrentConversationConnectionFixture({
      configurationRevision: 4,
      connectionId,
      authority,
      transport: { kind: 'socket' },
      overlapSafety: 'safe',
      replayContinuity: 'none',
      outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
    });
    collection.rows.set(connectionId, {
      rowId: connectionId,
      revision: 4,
      value: connectionValue,
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown) => {
      if (action === setupAction) {
        return {
          result: {
            v: 1,
            credentialRef: null,
            providerConnectionKey: 'example:connection',
            providerConfigVersion: 1,
            providerConfig: { source: 'same' },
            integrationPrincipal: { id: 'example-bot' },
            supportedTransports: ['socket'],
            recommendedTransport: 'socket',
            overlapSafety: 'safe',
            replayContinuity: 'none',
            outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
          },
          executionOrigin,
        };
      }
      if (action === connectionTestAction) {
        collection.rows.set(connectionId, {
          rowId: connectionId,
          revision: 5,
          value: {
            ...connectionValue,
            payload: { ...connectionValue.payload, configurationRevision: 5, maximumObservationAgeMs: 120_000 },
          },
        });
        return {
          result: {
            kind: 'ready',
            integrationPrincipal: { id: 'example-bot' },
            providerConnectionKey: 'example:connection',
          },
          executionOrigin,
        };
      }
      throw new Error('Expected only the selected setup/test Actions.');
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: {
          setup: setupAction,
          connectionTest: connectionTestAction,
          messageDeliver: messageDeliverAction,
          connectionStop: connectionStopAction,
        },
      }),
      stateCollection: collection,
    });

    await expect(transferConversationConnectionForInvocation({
      connectionId,
      expectedRevision: 4,
      expectedAuthorityEpoch: 4,
      providerSelection,
      providerSetupInput: { source: 'same' },
      credentialRef: null,
      selectedTransport: 'socket',
    }, context)).resolves.toMatchObject({ kind: 'rejoined', connectionId, revision: 5, authorityEpoch: 4 });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(2);
    expect(collection.batch).not.toHaveBeenCalled();
    expect(collection.rows.get(connectionId)?.value.payload).toMatchObject({
      configurationRevision: 5, maximumObservationAgeMs: 120_000, authorityEpoch: 4,
    });
  });

  it('rejects a changed-origin transfer before a stale CAS when Account policy changes during provider setup/test', async () => {
    const connectionId = 'connection-transfer-changed-origin-stale-after-test';
    const oldExecutionOrigin = {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-current',
        materializationId: 'materialization-current',
      },
    } as const;
    const replacementExecutionOrigin = {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-replacement',
        materializationId: 'materialization-replacement',
      },
    } as const;
    const collection = createMutableConnectionStateCollection();
    const authority = {
      providerPluginId: providerSelection.contributor.pluginId,
      providerContributionSelection: {
        contributionId: providerSelection.contributor.contributionId,
      },
      providerSetupInput: { source: 'old' },
      credentialRef: null,
      transportOrigin: getConversationConnectionTransportOrigin(oldExecutionOrigin),
      providerConnectionKey: 'example:connection',
      providerConfig: { source: 'old' },
      routingIdentityKey: 'r'.repeat(43),
      integrationPrincipal: { id: 'example-bot' },
      authorityEpoch: 4,
    } as const satisfies ConversationConnectionFixtureAuthority;
    const connectionValue = createCurrentConversationConnectionFixture({
      configurationRevision: 4,
      connectionId,
      authority,
      transport: { kind: 'socket' },
      overlapSafety: 'safe',
      replayContinuity: 'none',
      outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
    });
    collection.rows.set(connectionId, {
      rowId: connectionId,
      revision: 4,
      value: connectionValue,
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown) => {
      if (action === setupAction) {
        return {
          result: {
            v: 1,
            credentialRef: null,
            providerConnectionKey: 'example:connection',
            providerConfigVersion: 1,
            providerConfig: { source: 'replacement' },
            integrationPrincipal: { id: 'example-bot' },
            supportedTransports: ['socket'],
            recommendedTransport: 'socket',
            overlapSafety: 'safe',
            replayContinuity: 'none',
            outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
          },
          executionOrigin: replacementExecutionOrigin,
        };
      }
      if (action === connectionTestAction) {
        collection.rows.set(connectionId, {
          rowId: connectionId,
          revision: 5,
          value: {
            ...connectionValue,
            payload: {
              ...connectionValue.payload,
              configurationRevision: 5,
              enabled: false,
              authorityEpoch: 5,
              maximumObservationAgeMs: 120_000,
            },
          },
        });
        return {
          result: {
            kind: 'ready',
            integrationPrincipal: { id: 'example-bot' },
            providerConnectionKey: 'example:connection',
          },
          executionOrigin: replacementExecutionOrigin,
        };
      }
      throw new Error('Expected only the selected setup/test Actions.');
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: {
          setup: setupAction,
          connectionTest: connectionTestAction,
          messageDeliver: messageDeliverAction,
          connectionStop: connectionStopAction,
        },
      }),
      stateCollection: collection,
    });

    await expect(transferConversationConnectionForInvocation({
      connectionId,
      expectedRevision: 4,
      expectedAuthorityEpoch: 4,
      providerSelection,
      providerSetupInput: { source: 'replacement' },
      credentialRef: null,
      selectedTransport: 'socket',
    }, context)).rejects.toMatchObject({ code: 'channels_connection_transfer_conflict' });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(2);
    expect(collection.batch).not.toHaveBeenCalled();
    expect(collection.rows.get(connectionId)).toMatchObject({
      revision: 5,
      value: {
        payload: {
          enabled: false,
          authorityEpoch: 5,
          maximumObservationAgeMs: 120_000,
          transportOrigin: getConversationConnectionTransportOrigin(oldExecutionOrigin),
        },
      },
    });

  });

  it('converts checkpointed pull to durable push only after generic endpoint correspondence', async () => {
    const connectionId = 'connection-transfer-pull-to-push';
    const oldExecutionOrigin = {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-old',
        materializationId: 'materialization-old',
      },
    } as const;
    const collection = createMutableConnectionStateCollection();
    collection.rows.set(connectionId, {
      rowId: connectionId,
      revision: 4,
      value: createCurrentConversationConnectionFixture({
        configurationRevision: 4,
        connectionId,
        authority: {
          providerPluginId: providerSelection.contributor.pluginId,
          providerContributionSelection: {
            contributionId: providerSelection.contributor.contributionId,
          },
          providerSetupInput: { source: 'same' },
          credentialRef: null,
          transportOrigin: getConversationConnectionTransportOrigin(oldExecutionOrigin),
          providerConnectionKey: 'example:connection',
          providerConfig: { opaque: true },
          routingIdentityKey: 'r'.repeat(43),
          integrationPrincipal: { id: 'example-bot' },
          authorityEpoch: 4,
        },
        transport: { kind: 'checkpointedPull' },
        overlapSafety: 'safe',
        replayContinuity: 'checkpointed',
        outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
      }),
    });
    const first = durablePushCreateContext({ stateCollection: collection });
    const transferInput = {
      connectionId,
      expectedRevision: 4,
      expectedAuthorityEpoch: 4,
      providerSelection,
      providerSetupInput: { source: 'same' },
      credentialRef: null,
      selectedTransport: 'durablePush',
    } as const;

    const endpointRequired = await transferConversationConnectionForInvocation(transferInput, first.context);
    expect(endpointRequired).toMatchObject({
      kind: 'endpointRequired',
      connectionId,
      sourceInstanceId: `channels.connection.${connectionId}`,
    });
    expect(collection.rows.get(connectionId)?.revision).toBe(4);
    expect(first.correspondenceInputs).toHaveLength(0);

    const correspondenceInputs: unknown[] = [];
    const endpointActions = vi.fn(async (actionId: string, actionInput: unknown) => {
      if (actionId === 'plugin.webhook.endpoint.checkCorrespondence') {
        correspondenceInputs.push(actionInput);
        return { kind: 'ready', webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID, revision: 4 };
      }
      expect(actionId).toBe('plugin.webhook.endpoint.convergeTarget');
      expect(actionInput).toMatchObject({ targetIntentEpoch: 5,
        desiredTargetRouting: { serverIdentityId: 'srv_example', machineId: 'machine-example' } });
      return { kind: 'converged', webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID,
        revision: 5, targetIntentEpoch: 5, targetMaterialization: {
          pluginId: providerSelection.contributor.pluginId,
          machineId: 'machine-example', materializationId: 'materialization-example',
        } };
    });
    const second = durablePushCreateContext({ stateCollection: collection, correspondence: endpointActions });
    const transferred = await transferConversationConnectionForInvocation({
      ...transferInput,
      endpointContinuation: {
        connectionId,
        webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID,
      },
    }, second.context);

    expect(transferred).toMatchObject({
      kind: 'transferred',
      connectionId,
      authorityEpoch: 5,
    });
    expect(correspondenceInputs).toHaveLength(1);
    expect(collection.rows.get(connectionId)).toMatchObject({
      revision: 5,
      value: {
        payload: {
          transport: {
            kind: 'durablePush',
            webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID,
            webhookSourceInstanceId: `channels.connection.${connectionId}`,
          },
          authorityEpoch: 5,
          pendingOldTransportStop: null,
          historyGap: { reason: 'providerHistoryUnavailable' },
        },
      },
    });

    await expect(transferConversationConnectionForInvocation({
      ...transferInput,
      endpointContinuation: {
        connectionId,
        webhookEndpointId: 'wh_ep_AQIDBAUGBwgJCgsMDQ4PEA',
      },
    }, second.context)).rejects.toMatchObject({
      code: 'channels_connection_transfer_conflict',
    });
  });


  it('converts durable push to checkpointed pull without a provider stop or webhook mutation', async () => {
    const connectionId = 'connection-transfer-push-to-pull';
    const oldExecutionOrigin = {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-old',
        materializationId: 'materialization-old',
      },
    } as const;
    const collection = createMutableConnectionStateCollection();
    collection.rows.set(connectionId, {
      rowId: connectionId,
      revision: 4,
      value: createCurrentConversationConnectionFixture({
        configurationRevision: 4,
        connectionId,
        authority: {
          providerPluginId: providerSelection.contributor.pluginId,
          providerContributionSelection: {
            contributionId: providerSelection.contributor.contributionId,
          },
          providerSetupInput: { source: 'same' },
          credentialRef: null,
          transportOrigin: getConversationConnectionTransportOrigin(oldExecutionOrigin),
          providerConnectionKey: 'example:connection',
          providerConfig: { opaque: true },
          routingIdentityKey: 'r'.repeat(43),
          integrationPrincipal: { id: 'example-bot' },
          authorityEpoch: 4,
        },
        transport: {
          kind: 'durablePush',
          webhookContributionRef: {
            pluginId: providerSelection.contributor.pluginId,
            localId: 'webhook',
          },
          webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID,
          webhookSourceInstanceId: `channels.connection.${connectionId}`,
        },
        overlapSafety: 'safe',
        replayContinuity: 'none',
        outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
      }),
    });
    const selected = durablePushCreateContext({ stateCollection: collection });

    const transferInput = {
      connectionId,
      expectedRevision: 4,
      expectedAuthorityEpoch: 4,
      providerSelection,
      providerSetupInput: { source: 'same' },
      credentialRef: null,
      selectedTransport: 'checkpointedPull',
    } as const;
    collection.loseNextUpdatedBatchResponse();
    await expect(transferConversationConnectionForInvocation(transferInput, selected.context))
      .rejects.toThrow('simulated response loss after Account write commit');
    await expect(transferConversationConnectionForInvocation(transferInput, selected.context)).resolves.toEqual({
      kind: 'transferred',
      connectionId,
      revision: 5,
      authorityEpoch: 5,
    });

    // Detachment settles in one revision and keeps no frozen custody, so the
    // response-loss rejoin resolves this request's placement through the same
    // selected setup/test seam — one pair per attempt — before agreeing the
    // retained state is the one it committed. No endpoint Action replays.
    expect(selected.executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(4);
    expect(selected.correspondenceInputs).toHaveLength(0);
    expect(collection.rows.get(connectionId)).toMatchObject({
      revision: 5,
      value: {
        payload: {
          transport: { kind: 'checkpointedPull' },
          authorityEpoch: 5,
          pendingOldTransportStop: null,
          historyGap: { reason: 'providerHistoryUnavailable' },
        },
      },
    });
  });
});

describe('updateConversationConnectionForInvocation desired lifecycle', () => {

it('disables with one generation advance and no provider stop effect', async () => {
    const connectionId = 'connection-policy-disable-targeted';
    const connectionStop = admittedProviderOperation({ role: 'connectionStop' });
    const persistedAuthority = {
      providerPluginId: providerSelection.contributor.pluginId,
      providerContributionSelection: {
        contributionId: providerSelection.contributor.contributionId,
      },
      providerSetupInput: { source: 'persisted' },
      credentialRef: null,
      transportOrigin: {
        serverIdentityId: 'srv_example',
        materializationRef: {
          pluginId: providerSelection.contributor.pluginId,
          machineId: 'machine-example',
          materializationId: 'materialization-example',
        },
      },
      providerConnectionKey: 'example:connection',
      providerConfig: { opaque: true },
      routingIdentityKey: 'r'.repeat(43),
      integrationPrincipal: { id: 'example-bot' },
      authorityEpoch: 4,
    } as const satisfies ConversationConnectionFixtureAuthority;
    let row = {
      rowId: connectionId,
      revision: 4,
      value: createCurrentConversationConnectionFixture({
        configurationRevision: 4,
        connectionId,
        authority: persistedAuthority,
        transport: { kind: 'socket' },
        overlapSafety: 'safe',
        replayContinuity: 'none',
        outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
      }),
    };
    const stateCollection = {
      async get() { return row; },
      async batch(operations: readonly Readonly<{
        kind: string;
        value?: typeof row.value;
        expectedRevision?: number | 'absent';
      }>[]) {
        const mutation = operations[0];
        if (mutation?.kind !== 'put' || mutation.expectedRevision !== row.revision || mutation.value === undefined) {
          return { status: 'conflict' as const, conflicts: [] };
        }
        row = { rowId: connectionId, revision: row.revision + 1, value: mutation.value };
        return {
          status: 'updated' as const,
          results: [{ rowId: connectionId, revision: row.revision, deleted: false }],
        };
      },
    };
    // The disable owner swallows a rejected best-effort stop by design, so an
    // assertion inside this mock can never fail the test.
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (
      _action: unknown,
      _actionInput: unknown,
    ) => {
      return {
        result: { kind: 'stopped' },
        executionOrigin: row.value.payload.transportOrigin,
      };
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: {
          setup: setupAction,
          connectionTest: connectionTestAction,
          messageDeliver: messageDeliverAction,
          connectionStop,
        },
      }),
      stateCollection,
    });

    await expect(updateConversationConnectionForInvocation({
      connectionId,
      expectedRevision: 4,
      enabled: false,
      maximumObservationAgeMs: 60_000,
    }, context)).resolves.toEqual({
      kind: 'updated',
      connectionId,
      revision: 5,
      authorityEpoch: 5,
    });
    expect(row.value.payload.enabled).toBe(false);
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
  });

});

describe('retestConversationConnectionForInvocation', () => {
  const retestPersistedAuthority = {
    providerPluginId: providerSelection.contributor.pluginId,
    providerContributionSelection: {
      contributionId: providerSelection.contributor.contributionId,
    },
    providerSetupInput: { source: 'persisted' },
    credentialRef: selectedCredentialRef,
    transportOrigin: {
      serverIdentityId: 'srv_example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-example',
        materializationId: 'materialization-example',
      },
    },
    providerConnectionKey: 'example:connection',
    providerConfig: { opaque: true },
    routingIdentityKey: 'r'.repeat(43),
    integrationPrincipal: { id: 'example-bot' },
    authorityEpoch: 4,
  } as const satisfies ConversationConnectionFixtureAuthority;

  function retestSetupExecution() {
    return {
      executionOrigin: retestPersistedAuthority.transportOrigin,
      result: ConversationProviderSetupResultV1Schema.parse({
        v: 1, credentialRef: selectedCredentialRef,
        providerConnectionKey: 'example:connection', providerConfigVersion: 1,
        providerConfig: { opaque: true }, integrationPrincipal: { id: 'example-bot' },
        supportedTransports: ['socket'], recommendedTransport: 'socket',
        overlapSafety: 'safe', replayContinuity: 'none',
        outboundTextLimit: { maximum: 65_536, unit: 'unicodeCodePoints' },
        recommendedMaximumObservationAgeMs: 30 * 86_400_000,
      }),
    };
  }

  it('refreshes native delivery capability and provider freshness on an old retained connection without replacing user policy', async () => {
    const collection = createMutableConnectionStateCollection();
    const connectionId = 'legacy-native-limit';
    const initial = createCurrentConversationConnectionFixture({
      configurationRevision: 4,
      connectionId, authority: retestPersistedAuthority,
      transport: { kind: 'socket' }, maximumObservationAgeMs: 60_000,
      providerReadiness: null,
    });
    const { outboundTextLimit: _obsoleteLimit, ...legacyPayload } = initial.payload;
    collection.rows.set(connectionId, {
      rowId: connectionId, revision: 4, value: { ...initial, payload: legacyPayload },
    });
    const context = invocationContext({
      stateCollection: collection,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: { setup: setupAction, connectionTest: connectionTestAction },
      }),
      actions: {
        async executeAdmittedTargetedOperationWithExecutionOrigin(operation: unknown) {
          if (operation === setupAction) return retestSetupExecution();
          return {
            executionOrigin: retestPersistedAuthority.transportOrigin,
            result: {
              kind: 'ready', providerConnectionKey: 'example:connection',
              integrationPrincipal: { id: 'example-bot' },
            },
          };
        },
      } as unknown as ActionsService,
    });
    await expect(retestConversationConnectionForInvocation({
      connectionId, expectedRevision: 4, authorityEpoch: 4,
    }, context)).resolves.toMatchObject({ kind: 'ready' });
    expect(collection.rows.get(connectionId)?.value.payload).toMatchObject({
      outboundTextLimit: { maximum: 65_536, unit: 'unicodeCodePoints' },
      recommendedMaximumObservationAgeMs: 30 * 86_400_000,
      maximumObservationAgeMs: 60_000, authorityEpoch: 4,
      providerConfig: { opaque: true },
    });
    await expect(retestConversationConnectionForInvocation({
      connectionId, expectedRevision: 5, authorityEpoch: 4,
    }, context)).resolves.toMatchObject({ kind: 'ready', revision: 5 });
    expect(collection.rows.get(connectionId)?.revision).toBe(5);
  });

  it('removes superseded optional capabilities when the current provider declares no native limit or freshness recommendation', async () => {
    const collection = createMutableConnectionStateCollection();
    const connectionId = 'formerly-bounded';
    const initial = createCurrentConversationConnectionFixture({ connectionId, authority: retestPersistedAuthority,
      providerReadiness: null, transport: { kind: 'socket' } });
    collection.rows.set(connectionId, { rowId: connectionId, revision: 1,
      value: { ...initial, payload: { ...initial.payload, recommendedMaximumObservationAgeMs: 86_400_000 } } });
    const setup = retestSetupExecution();
    const { outboundTextLimit: _oldLimit, recommendedMaximumObservationAgeMs: _oldRecommendation, ...unbounded } = setup.result;
    const context = invocationContext({ stateCollection: collection,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: { setup: setupAction, connectionTest: connectionTestAction },
      }),
      actions: { async executeAdmittedTargetedOperationWithExecutionOrigin(operation: unknown) {
        return { executionOrigin: setup.executionOrigin, result: operation === setupAction ? unbounded : {
          kind: 'ready', providerConnectionKey: unbounded.providerConnectionKey, integrationPrincipal: unbounded.integrationPrincipal,
        } };
      } } as unknown as ActionsService,
    });
    await expect(retestConversationConnectionForInvocation({ connectionId, expectedRevision: 1, authorityEpoch: 4 }, context))
      .resolves.toMatchObject({ kind: 'ready', revision: 2 });
    const payload = collection.rows.get(connectionId)?.value.payload;
    expect(payload).not.toHaveProperty('outboundTextLimit');
    expect(payload).not.toHaveProperty('recommendedMaximumObservationAgeMs');
    expect(payload).toMatchObject({ maximumObservationAgeMs: initial.payload.maximumObservationAgeMs, authorityEpoch: 4 });
  });

  /** One attention-carrying saved connection plus the Account boundary it lives in. */
  function retestFixture(input?: Readonly<{
    providerReadiness?: unknown;
    bindings?: readonly Readonly<{
      bindingId: string;
      connectionId?: string;
      enabled: boolean;
      audience: 'direct' | 'shared';
      inputMode: 'directMentionsOnly' | 'addressedMessages' | 'allAllowedMessages';
    }>[];
  }>) {
    const connectionId = 'connection-retest';
    let row = {
      rowId: connectionId,
      revision: 4,
      value: createCurrentConversationConnectionFixture({
        configurationRevision: 4,
        connectionId,
        authority: retestPersistedAuthority,
        transport: { kind: 'socket' },
        overlapSafety: 'safe',
        replayContinuity: 'none',
        outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
        providerReadiness: (input?.providerReadiness ?? {
          code: 'providerConfigurationInvalid',
          diagnostic: 'The saved bot token was rejected.',
        }) as never,
      }),
    };
    const bindingRows = (input?.bindings ?? []).map((binding) => ({
      rowId: binding.bindingId,
      revision: 1,
      value: {
        [CHANNEL_STATE_FIELD.id]: binding.bindingId,
        [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.binding,
        [CHANNEL_STATE_FIELD.connectionId]: binding.connectionId ?? connectionId,
        [CHANNEL_STATE_FIELD.bindingId]: binding.bindingId,
        v: 1,
        payload: {
          enabled: binding.enabled,
          endpoint: { audience: binding.audience },
          inputMode: binding.inputMode,
        },
      },
    }));
    const queryCollection = new MemoryCollection();
    const batches: unknown[][] = [];
    const stateCollection = {
      async get() { return row; },
      async query(request: Parameters<MemoryCollection['query']>[0]) {
        if (
          (request.index !== CHANNEL_STATE_INDEX_ID.byConnectionBindingV2
            && request.index !== CHANNEL_STATE_INDEX_ID.byConnectionKindV1)
          || request.prefix?.[0] !== connectionId
        ) {
          throw new Error(`Unexpected retest query: ${JSON.stringify(request)}`);
        }
        queryCollection.rows.set(row.rowId, row);
        for (const binding of bindingRows) queryCollection.rows.set(binding.rowId, binding);
        return queryCollection.query(request);
      },
      async batch(operations: readonly Readonly<{
        kind: string;
        value?: typeof row.value;
        expectedRevision?: number | 'absent';
      }>[]) {
        batches.push([...operations]);
        const mutation = operations[0];
        if (mutation?.kind !== 'put' || mutation.expectedRevision !== row.revision || mutation.value === undefined) {
          return { status: 'conflict' as const, conflicts: [] };
        }
        row = { rowId: connectionId, revision: row.revision + 1, value: mutation.value };
        return {
          status: 'updated' as const,
          results: [{ rowId: connectionId, revision: row.revision, deleted: false }],
        };
      },
    };
    return {
      connectionId,
      batches,
      stateCollection,
      readRow: () => row,
    };
  }

  it('re-probes the current saved connection without a stale list version and clears its retained readiness attention', async () => {
    const fixture = retestFixture();
    const connectionTest = admittedProviderOperation({ role: 'connectionTest' });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (
      action: unknown,
      actionInput: unknown,
      options: unknown,
    ) => {
      if (action === setupAction) {
        expect(actionInput).toEqual(retestPersistedAuthority.providerSetupInput);
        expect(options).toMatchObject({ expectedExecutionRouting: getConversationConnectionExecutionRouting(getConversationConnectionTransportOrigin(retestPersistedAuthority.transportOrigin), providerSelection.contributor.pluginId),
          expectedSelectedConnectedAccountRef: selectedCredentialRef });
        return retestSetupExecution();
      }
      expect(action).toBe(connectionTest);
      // The probe and setup refresh both consume saved facts, never caller
      // replacements for connection identity or configuration.
      expect(actionInput).toEqual({
        v: 1,
        connectionId: fixture.connectionId,
        providerConnectionKey: 'example:connection',
        providerConfigVersion: 1,
        providerConfig: { opaque: true },
        credentialRef: selectedCredentialRef,
        selectedTransport: 'socket',
      });
      expect(options).toMatchObject({
        expectedExecutionRouting: getConversationConnectionExecutionRouting(getConversationConnectionTransportOrigin(retestPersistedAuthority.transportOrigin), providerSelection.contributor.pluginId),
      });
      return {
        result: {
          kind: 'ready',
          integrationPrincipal: { id: 'example-bot' },
          providerConnectionKey: 'example:connection',
        },
        executionOrigin: retestPersistedAuthority.transportOrigin,
      };
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: { setup: setupAction, connectionTest },
      }),
      stateCollection: fixture.stateCollection,
    });

    await expect(retestConversationConnectionForInvocation({
      connectionId: fixture.connectionId,
    }, context)).resolves.toEqual({
      kind: 'ready',
      connectionId: fixture.connectionId,
      revision: 5,
      authorityEpoch: 4,
    });
    // The one canonical readiness field is settled; the retest owns no second
    // health record of its own.
    expect(fixture.readRow().value.payload.providerReadiness).toBeNull();
  });

  it('reports a still-failing probe without writing any Account state or superseding the retained attention', async () => {
    const fixture = retestFixture();
    const connectionTest = admittedProviderOperation({ role: 'connectionTest' });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => ({
      result: {
        kind: 'notReady',
        reason: 'credentialInvalid',
        retryAfterMs: 30_000,
        diagnostic: 'The saved bot token was rejected.',
      },
      executionOrigin: retestPersistedAuthority.transportOrigin,
    }));
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: { setup: setupAction, connectionTest },
      }),
      stateCollection: fixture.stateCollection,
    });

    await expect(retestConversationConnectionForInvocation({
      connectionId: fixture.connectionId,
      expectedRevision: 4,
      authorityEpoch: 4,
    }, context)).resolves.toEqual({
      kind: 'notReady',
      reason: 'credentialInvalid',
      retryAfterMs: 30_000,
      diagnostic: 'The saved bot token was rejected.',
    });
    expect(fixture.batches).toHaveLength(0);
    expect(fixture.readRow().revision).toBe(4);
    expect(fixture.readRow().value.payload.providerReadiness).toEqual({
      code: 'providerConfigurationInvalid',
      diagnostic: 'The saved bot token was rejected.',
    });
  });

  it.each([
    {
      name: 'ready',
      result: {
        kind: 'ready' as const,
        integrationPrincipal: { id: 'example-bot' },
        providerConnectionKey: 'example:connection',
      },
    },
    {
      name: 'not-ready',
      result: {
        kind: 'notReady' as const,
        reason: 'credentialInvalid' as const,
        diagnostic: 'The saved bot token was rejected.',
      },
    },
  ])('refuses to publish a $name verdict after the tested connection generation changes', async ({ result }) => {
    const fixture = retestFixture();
    let readCount = 0;
    const stateCollection = {
      ...fixture.stateCollection,
      async get() {
        readCount += 1;
        const current = fixture.readRow();
        return readCount === 1 ? current : {
          ...current,
          revision: current.revision + 1,
          value: { ...current.value, payload: {
            ...current.value.payload,
            authorityEpoch: current.value.payload.authorityEpoch + 1,
          } },
        };
      },
    };
    const connectionTest = admittedProviderOperation({ role: 'connectionTest' });
    const context = invocationContext({
      actions: {
        executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(async () => ({
          result,
          executionOrigin: retestPersistedAuthority.transportOrigin,
        })),
      } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: { setup: setupAction, connectionTest },
      }),
      stateCollection,
    });

    await expect(retestConversationConnectionForInvocation({
      connectionId: fixture.connectionId,
      expectedRevision: 4,
      authorityEpoch: 4,
    }, context)).rejects.toMatchObject({
      code: 'channels_connection_retest_conflict',
      retryable: true,
    });
    expect(readCount).toBe(2);
    expect(fixture.batches).toHaveLength(0);
  });

  it('retains a native readiness observation across same-ID contribution replacement', async () => {
    const fixture = retestFixture();
    const connectionTest = admittedProviderOperation({ role: 'connectionTest' });
    const replacementConnectionTest = admittedProviderOperation({
      role: 'connectionTest',
      contributor: { ...providerSelection.contributor, sourceCustody: { kind: 'managed', immutableGenerationId: 'provider-generation-b', installSource: 'npm' } },
    });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (operation: unknown) => ({
      result: operation === connectionTest
        ? { kind: 'notReady', reason: 'credentialInvalid' }
        : { kind: 'notReady', reason: 'network' },
      executionOrigin: retestPersistedAuthority.transportOrigin,
    }));
    const context = invocationContext({
      actions: {
        executeAdmittedTargetedOperationWithExecutionOrigin,
      } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: { setup: setupAction, connectionTest },
        snapshots: [
          {
            contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
            operations: { setup: setupAction, connectionTest },
          },
          {
            contributorImmutableGenerationId: 'provider-generation-b',
            targetImmutableGenerationId: 'channels-target-generation-replaced',
            operations: { setup: setupAction, connectionTest: replacementConnectionTest },
          },
        ],
      }),
      stateCollection: fixture.stateCollection,
    });

    await expect(retestConversationConnectionForInvocation({
      connectionId: fixture.connectionId,
      expectedRevision: 4,
      authorityEpoch: 4,
    }, context)).resolves.toMatchObject({ kind: 'notReady', reason: 'credentialInvalid' });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin.mock.calls.map(([operation]) => operation))
      .toEqual([connectionTest]);
    expect(fixture.batches).toHaveLength(0);
  });

  it('fails readiness truthfully when the current provider capability can no longer deliver an enabled shared binding', async () => {
    // A Telegram bot whose BotFather group privacy was re-enabled after setup
    // still answers `getMe` for the same bot: identity is unchanged, the probe
    // is "ready", and the saved `allAllowedMessages` binding is nonetheless
    // impossible to observe. Reporting ready here is total silent message loss.
    const fixture = retestFixture({
      bindings: [
        { bindingId: 'binding-shared-all', enabled: true, audience: 'shared', inputMode: 'allAllowedMessages' },
      ],
    });
    const connectionTest = admittedProviderOperation({ role: 'connectionTest' });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown) => action === setupAction ? retestSetupExecution() : ({
      result: {
        kind: 'ready',
        integrationPrincipal: { id: 'example-bot' },
        providerConnectionKey: 'example:connection',
        sharedEndpointInputModes: ['directMentionsOnly', 'addressedMessages'],
      },
      executionOrigin: retestPersistedAuthority.transportOrigin,
    }));
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: { setup: setupAction, connectionTest },
      }),
      stateCollection: fixture.stateCollection,
    });

    await expect(retestConversationConnectionForInvocation({
      connectionId: fixture.connectionId,
      expectedRevision: 4,
      authorityEpoch: 4,
    }, context)).resolves.toMatchObject({
      kind: 'notReady',
      reason: 'permissionMissing',
    });
    // The one canonical readiness field now names the narrowing instead of
    // being cleared by a probe that only proved identity.
    expect(fixture.readRow().value.payload.providerReadiness).toMatchObject({
      code: 'providerPermissionMissing',
    });
  });

  it('clears readiness when the current provider capability still covers every enabled binding', async () => {
    const fixture = retestFixture({
      bindings: [
        { bindingId: 'binding-shared-mentions', enabled: true, audience: 'shared', inputMode: 'directMentionsOnly' },
        // A disabled binding promises nothing today, and a direct endpoint is
        // outside the shared-endpoint capability entirely.
        { bindingId: 'binding-shared-off', enabled: false, audience: 'shared', inputMode: 'allAllowedMessages' },
        { bindingId: 'binding-direct', enabled: true, audience: 'direct', inputMode: 'allAllowedMessages' },
        // Another connection's binding is not this connection's promise.
        {
          bindingId: 'binding-other-connection',
          connectionId: 'connection-other',
          enabled: true,
          audience: 'shared',
          inputMode: 'allAllowedMessages',
        },
      ],
    });
    const connectionTest = admittedProviderOperation({ role: 'connectionTest' });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown) => action === setupAction ? retestSetupExecution() : ({
      result: {
        kind: 'ready',
        integrationPrincipal: { id: 'example-bot' },
        providerConnectionKey: 'example:connection',
        sharedEndpointInputModes: ['directMentionsOnly', 'addressedMessages'],
      },
      executionOrigin: retestPersistedAuthority.transportOrigin,
    }));
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: { setup: setupAction, connectionTest },
      }),
      stateCollection: fixture.stateCollection,
    });

    await expect(retestConversationConnectionForInvocation({
      connectionId: fixture.connectionId,
      expectedRevision: 4,
      authorityEpoch: 4,
    }, context)).resolves.toEqual({
      kind: 'ready',
      connectionId: fixture.connectionId,
      revision: 5,
      authorityEpoch: 4,
    });
    expect(fixture.readRow().value.payload.providerReadiness).toBeNull();
  });

  it.each(['connectionTest', 'setup'])('refuses a %s whose credential now resolves to a different immutable integration principal', async (mismatchedRole) => {
    const fixture = retestFixture();
    const connectionTest = admittedProviderOperation({ role: 'connectionTest' });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown) => {
      if (action === setupAction) {
        const setup = retestSetupExecution();
        return { ...setup, result: { ...setup.result,
          integrationPrincipal: { id: 'someone-elses-bot' } } };
      }
      return {
        // The saved key still matches, but this credential's immutable
        // principal may have changed in either authenticated observation.
        result: {
          kind: 'ready',
          integrationPrincipal: { id: mismatchedRole === 'connectionTest' ? 'someone-elses-bot' : 'example-bot' },
          providerConnectionKey: 'example:connection',
        },
        executionOrigin: retestPersistedAuthority.transportOrigin,
      };
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: { setup: setupAction, connectionTest },
      }),
      stateCollection: fixture.stateCollection,
    });

    await expect(retestConversationConnectionForInvocation({
      connectionId: fixture.connectionId,
      expectedRevision: 4,
      authorityEpoch: 4,
    }, context)).rejects.toMatchObject({
      code: 'channels_connection_test_identity_mismatch',
    });
    // Zero writes: the retained readiness attention still names the failure.
    expect(fixture.batches).toHaveLength(0);
    expect(fixture.readRow().revision).toBe(4);
    expect(fixture.readRow().value.payload.providerReadiness).toEqual({
      code: 'providerConfigurationInvalid',
      diagnostic: 'The saved bot token was rejected.',
    });
  });

  it('refuses to touch the provider when the current saved connection is disabled', async () => {
    const fixture = retestFixture();
    const connectionTest = admittedProviderOperation({ role: 'connectionTest' });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => {
      throw new Error('The provider must not be probed under retired authority.');
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: { setup: setupAction, connectionTest },
      }),
      stateCollection: {
        ...fixture.stateCollection,
        async get() {
          const current = fixture.readRow();
          return { ...current, value: { ...current.value, payload: { ...current.value.payload, enabled: false } } };
        },
      },
    });

    await expect(retestConversationConnectionForInvocation({
      connectionId: fixture.connectionId,
    }, context)).rejects.toMatchObject({
      code: 'channels_connection_retest_conflict',
      retryable: true,
    });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
    expect(fixture.batches).toHaveLength(0);
  });
});

describe('durablePush connection create endpoint continuation', () => {
  it('returns the preallocated final identity and exact core-minted ensure facts, persisting nothing', async () => {
    const collection = createMutableConnectionStateCollection();
    const { context, connectionTestInputs, correspondenceInputs } = durablePushCreateContext({
      stateCollection: collection,
    });

    const result = await createConversationConnectionForInvocation(
      durablePushCreateInput(),
      context,
    );

    expect(result).toMatchObject({ kind: 'endpointRequired' });
    if (result.kind !== 'endpointRequired') return;
    const sourceInstanceId = `channels.connection.${result.connectionId}`;
    expect(result).toEqual({
      kind: 'endpointRequired',
      connectionId: expect.any(String),
      webhookContribution: {
        pluginId: providerSelection.contributor.pluginId,
        localId: 'webhook',
      },
      targetMaterialization: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-example',
        materializationId: 'materialization-example',
      },
      sourceInstanceId,
      webhookEndpointSetup: { kind: 'accountEndpointV1', credential: 'serverGenerated' },
      webhookEndpointIdempotencyKey: expect.stringMatching(/^[A-Za-z0-9._:-]{16,128}$/u),
    });
    // The generic ensure key is the one stable attempt identity; Channels
    // publishes no parallel setup-attempt token.
    // The preallocated final identity reached the provider connection test
    // before any endpoint or row existed.
    expect(connectionTestInputs).toHaveLength(1);
    expect(connectionTestInputs[0]).toMatchObject({ connectionId: result.connectionId });
    // The first call is observation-plus-identity only: no correspondence
    // proof, no Account row, and no identity-key singleton yet.
    expect(correspondenceInputs).toHaveLength(0);
    expect(collection.rows.size).toBe(0);
  });

  it('rejoins an existing exact connection before the endpoint journey starts', async () => {
    const collection = createMutableConnectionStateCollection();
    const first = durablePushCreateContext({ stateCollection: collection });
    const incumbent = await createConversationConnectionForInvocation(
      durablePushCreateInput({ selectedTransport: 'socket' }),
      first.context,
    );
    if (incumbent.kind !== 'created') throw new Error('Expected the incumbent socket connection.');

    const second = durablePushCreateContext({ stateCollection: collection });
    await expect(createConversationConnectionForInvocation(
      durablePushCreateInput(),
      second.context,
    )).resolves.toEqual({ kind: 'rejoined', connectionId: incumbent.connectionId });
    expect(second.correspondenceInputs).toHaveLength(0);
  });

  it('continues with the returned identity, proves host correspondence, and persists the exact endpoint facts', async () => {
    const collection = createMutableConnectionStateCollection();
    const first = durablePushCreateContext({ stateCollection: collection });
    const endpointRequired = await createConversationConnectionForInvocation(
      durablePushCreateInput(),
      first.context,
    );
    if (endpointRequired.kind !== 'endpointRequired') {
      throw new Error('Expected the endpointRequired arm.');
    }
    const continuation = {
      connectionId: endpointRequired.connectionId,
      webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID,
    };

    const second = durablePushCreateContext({ stateCollection: collection });
    const created = await createConversationConnectionForInvocation(
      durablePushCreateInput({ endpointContinuation: continuation }),
      second.context,
    );

    expect(created).toEqual({ kind: 'created', connectionId: endpointRequired.connectionId });
    // Correspondence is host-derived with the exact four facts; the core
    // derives them, the continuation only relayed the endpoint identity.
    expect(second.correspondenceInputs).toEqual([{
      webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID,
      webhookContribution: {
        pluginId: providerSelection.contributor.pluginId,
        localId: 'webhook',
      },
      targetMaterialization: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-example',
        materializationId: 'materialization-example',
      },
      sourceInstanceId: `channels.connection.${endpointRequired.connectionId}`,
      setup: { kind: 'accountEndpointV1', credential: 'serverGenerated' },
    }]);
    // The persisted row is the preallocated identity with the exact durable
    // endpoint facts, and the connection test reused the same identity.
    expect(second.connectionTestInputs[0]).toMatchObject({
      connectionId: endpointRequired.connectionId,
    });
    const row = collection.rows.get(endpointRequired.connectionId);
    expect(row?.value).toMatchObject({
      'record-kind': CHANNEL_STATE_RECORD_KIND.connection,
      payload: {
        transport: {
          kind: 'durablePush',
          webhookContributionRef: {
            pluginId: providerSelection.contributor.pluginId,
            localId: 'webhook',
          },
          webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID,
          webhookSourceInstanceId: `channels.connection.${endpointRequired.connectionId}`,
        },
        overlapSafety: 'safe',
        replayContinuity: 'none',
      },
    });
    // One reservation guards the same immutable provider identity.
    const reservation = [...collection.rows.values()].find((candidate) => (
      candidate.value[CHANNEL_STATE_FIELD.recordKind] === CHANNEL_STATE_RECORD_KIND.connectionReservation
    ));
    expect(reservation).toBeDefined();
  });

  it('rejoins the exact committed connection and endpoint when a continuation response is lost', async () => {
    const collection = createMutableConnectionStateCollection();
    const first = durablePushCreateContext({ stateCollection: collection });
    const endpointRequired = await createConversationConnectionForInvocation(
      durablePushCreateInput(),
      first.context,
    );
    if (endpointRequired.kind !== 'endpointRequired') {
      throw new Error('Expected the endpointRequired arm.');
    }
    const continuation = {
      connectionId: endpointRequired.connectionId,
      webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID,
    };
    const second = durablePushCreateContext({ stateCollection: collection });
    await expect(createConversationConnectionForInvocation(
      durablePushCreateInput({ endpointContinuation: continuation }),
      second.context,
    )).resolves.toEqual({ kind: 'created', connectionId: endpointRequired.connectionId });

    // The retried continuation runs setup/test and host-derived current
    // correspondence again before it rejoins without an endpoint effect.
    const retry = durablePushCreateContext({ stateCollection: collection });
    await expect(createConversationConnectionForInvocation(
      durablePushCreateInput({ endpointContinuation: continuation }),
      retry.context,
    )).resolves.toEqual({ kind: 'rejoined', connectionId: endpointRequired.connectionId });
    expect(retry.correspondenceInputs).toHaveLength(1);
  });

  it('fails closed when correspondence is not a current ready result', async () => {
    const collection = createMutableConnectionStateCollection();
    const first = durablePushCreateContext({ stateCollection: collection });
    const endpointRequired = await createConversationConnectionForInvocation(
      durablePushCreateInput(),
      first.context,
    );
    if (endpointRequired.kind !== 'endpointRequired') {
      throw new Error('Expected the endpointRequired arm.');
    }
    const second = durablePushCreateContext({
      stateCollection: collection,
      correspondence: correspondenceReadyExecutor({
        result: { kind: 'unavailable', code: 'endpoint_not_found' },
      }),
    });
    await expect(createConversationConnectionForInvocation(
      durablePushCreateInput({
        endpointContinuation: {
          connectionId: endpointRequired.connectionId,
          webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID,
        },
      }),
      second.context,
    )).rejects.toMatchObject({
      code: 'channels_connection_endpoint_correspondence_mismatch',
    });
    expect([...collection.rows.values()]).toHaveLength(0);
  });

  it('fails closed when a mismatched continuation names another attempt endpoint', async () => {
    const collection = createMutableConnectionStateCollection();
    // Two live attempts each hold their own preallocated identity and ensure
    // key before either commits — the exact reachable overlap a retried or
    // interleaved setup journey can produce.
    const first = durablePushCreateContext({ stateCollection: collection });
    const firstAttempt = await createConversationConnectionForInvocation(
      durablePushCreateInput(),
      first.context,
    );
    if (firstAttempt.kind !== 'endpointRequired') throw new Error('Expected the first arm.');
    const second = durablePushCreateContext({ stateCollection: collection });
    const secondAttempt = await createConversationConnectionForInvocation(
      durablePushCreateInput(),
      second.context,
    );
    if (secondAttempt.kind !== 'endpointRequired') throw new Error('Expected the second arm.');
    expect(secondAttempt.connectionId).not.toBe(firstAttempt.connectionId);
    expect(secondAttempt.webhookEndpointIdempotencyKey)
      .not.toBe(firstAttempt.webhookEndpointIdempotencyKey);

    // The first attempt commits its connection with its own endpoint.
    const commit = durablePushCreateContext({ stateCollection: collection });
    await createConversationConnectionForInvocation(
      durablePushCreateInput({
        endpointContinuation: {
          connectionId: firstAttempt.connectionId,
          webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID,
        },
      }),
      commit.context,
    );

    // The interleaved second attempt's continuation names the retained
    // connection's identity space with its own endpoint: current host-derived
    // correspondence runs first, then incumbent identity mismatch fails
    // closed without any write.
    const interleaved = durablePushCreateContext({ stateCollection: collection });
    await expect(createConversationConnectionForInvocation(
      durablePushCreateInput({
        endpointContinuation: {
          connectionId: secondAttempt.connectionId,
          webhookEndpointId: 'wh_ep_AQIDBAUGBwgJCgsMDQ4PEA',
        },
      }),
      interleaved.context,
    )).rejects.toMatchObject({
      code: 'channels_connection_create_endpoint_mismatch',
    });
    expect(interleaved.correspondenceInputs).toHaveLength(1);
  });

  it('revalidates an incumbent endpoint that wins after the continuation pre-check', async () => {
    const collection = createMutableConnectionStateCollection();
    const first = durablePushCreateContext({ stateCollection: collection });
    const firstAttempt = await createConversationConnectionForInvocation(
      durablePushCreateInput(),
      first.context,
    );
    if (firstAttempt.kind !== 'endpointRequired') throw new Error('Expected the first arm.');
    const second = durablePushCreateContext({ stateCollection: collection });
    const secondAttempt = await createConversationConnectionForInvocation(
      durablePushCreateInput(),
      second.context,
    );
    if (secondAttempt.kind !== 'endpointRequired') throw new Error('Expected the second arm.');

    const batchImplementation = collection.batch.getMockImplementation();
    if (batchImplementation === undefined) throw new Error('Expected the mutable collection batch owner.');
    let releaseFirstBatch: (() => void) | undefined;
    const firstBatchReleased = new Promise<void>((resolve) => {
      releaseFirstBatch = resolve;
    });
    let reportFirstBatchBlocked: (() => void) | undefined;
    const firstBatchBlocked = new Promise<void>((resolve) => {
      reportFirstBatchBlocked = resolve;
    });
    let holdFirstConnectionBatch = true;
    collection.batch.mockImplementation(async (operations) => {
      const isConnectionBatch = operations.some((operation) => (
        operation.kind === 'put'
        && operation.value[CHANNEL_STATE_FIELD.recordKind] === CHANNEL_STATE_RECORD_KIND.connection
      ));
      if (holdFirstConnectionBatch && isConnectionBatch) {
        holdFirstConnectionBatch = false;
        reportFirstBatchBlocked?.();
        await firstBatchReleased;
      }
      return await batchImplementation(operations);
    });

    // The first continuation passes currentness/setup/test/correspondence and
    // observes no incumbent, then pauses immediately before its atomic
    // reservation-plus-connection batch.
    const firstContinuation = durablePushCreateContext({ stateCollection: collection });
    const firstOutcome = createConversationConnectionForInvocation(
      durablePushCreateInput({
        endpointContinuation: {
          connectionId: firstAttempt.connectionId,
          webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID,
        },
      }),
      firstContinuation.context,
    );
    await firstBatchBlocked;

    // A second exact attempt wins the incumbent reservation with a different
    // endpoint while the first caller is between its pre-check and batch.
    const racedEndpointId = 'wh_ep_AQIDBAUGBwgJCgsMDQ4PEA';
    const secondContinuation = durablePushCreateContext({ stateCollection: collection });
    await expect(createConversationConnectionForInvocation(
      durablePushCreateInput({
        endpointContinuation: {
          connectionId: secondAttempt.connectionId,
          webhookEndpointId: racedEndpointId,
        },
      }),
      secondContinuation.context,
    )).resolves.toEqual({ kind: 'created', connectionId: secondAttempt.connectionId });

    releaseFirstBatch?.();
    await expect(firstOutcome).rejects.toMatchObject({
      code: 'channels_connection_create_endpoint_mismatch',
    });
    expect(firstContinuation.correspondenceInputs).toHaveLength(1);
    expect(secondContinuation.correspondenceInputs).toHaveLength(1);
    expect(collection.rows.get(secondAttempt.connectionId)).toMatchObject({
      value: {
        payload: {
          transport: {
            kind: 'durablePush',
            webhookEndpointId: racedEndpointId,
            webhookSourceInstanceId: `channels.connection.${secondAttempt.connectionId}`,
          },
        },
      },
    });
  });

  it('cancellation leaves no partial connection row or endpoint proof', async () => {
    const collection = createMutableConnectionStateCollection();
    const controller = new AbortController();
    controller.abort();
    const { context } = durablePushCreateContext({
      stateCollection: collection,
      signal: controller.signal,
    });
    await expect(createConversationConnectionForInvocation(
      durablePushCreateInput({
        endpointContinuation: {
          connectionId: 'connection-cancelled',
          webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID,
        },
      }),
      context,
    )).rejects.toMatchObject({ code: 'channels_connection_create_cancelled' });
    expect([...collection.rows.values()]).toHaveLength(0);
  });

  it('keeps ordinary transports free of the endpoint journey and rejects a continuation without durable push', async () => {
    const collection = createMutableConnectionStateCollection();
    const socket = durablePushCreateContext({ stateCollection: collection });
    const created = await createConversationConnectionForInvocation(
      durablePushCreateInput({ selectedTransport: 'socket' }),
      socket.context,
    );
    expect(created).toMatchObject({ kind: 'created' });
    expect(socket.correspondenceInputs).toHaveLength(0);
    const row = collection.rows.get((created as Readonly<{ connectionId: string }>).connectionId);
    expect(row?.value).toMatchObject({
      payload: { transport: { kind: 'socket' } },
    });

    const invalid = durablePushCreateContext({ stateCollection: createMutableConnectionStateCollection() });
    await expect(createConversationConnectionForInvocation({
      ...connectionCreateInput,
      endpointContinuation: {
        connectionId: 'connection-1',
        webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID,
      },
    }, invalid.context)).rejects.toMatchObject({
      code: 'channels_connection_create_endpoint_continuation_invalid',
    });
  });

  it('gives external contributor identities the identical endpoint journey', async () => {
    const externalPluginId = 'external.channels.provider';
    const externalContributor = {
      ...providerSelection.contributor,
      pluginId: externalPluginId,
    } as const;
    const externalProviderSelection = {
      ...providerSelection,
      contributor: externalContributor,
    } as const satisfies PluginTargetedContributionSelectionV1;
    const collection = createMutableConnectionStateCollection();
    const first = durablePushCreateContext({
      stateCollection: collection,
      contributorPluginId: externalPluginId,
    });
    const endpointRequired = await createConversationConnectionForInvocation(
      durablePushCreateInput({ providerSelection: externalProviderSelection }),
      first.context,
    );
    if (endpointRequired.kind !== 'endpointRequired') {
      throw new Error('Expected the endpointRequired arm.');
    }
    expect(endpointRequired.webhookContribution.pluginId).toBe(externalPluginId);
    expect(endpointRequired.targetMaterialization.pluginId).toBe(externalPluginId);
    expect(endpointRequired.sourceInstanceId).toBe(
      `channels.connection.${endpointRequired.connectionId}`,
    );
    const second = durablePushCreateContext({
      stateCollection: collection,
      contributorPluginId: externalPluginId,
    });
    await expect(createConversationConnectionForInvocation(
      durablePushCreateInput({
        providerSelection: externalProviderSelection,
        endpointContinuation: {
          connectionId: endpointRequired.connectionId,
          webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID,
        },
      }),
      second.context,
    )).resolves.toEqual({ kind: 'created', connectionId: endpointRequired.connectionId });
    expect(second.correspondenceInputs[0]).toMatchObject({
      webhookContribution: { pluginId: externalPluginId },
      targetMaterialization: { pluginId: externalPluginId },
    });
  });
});

/**
 * Transfer recovery consumes the connection's desired placement and generation.
 * The generic webhook owner resolves the current installation on that Machine;
 * no second persisted endpoint target or old-worker stop is needed.
 */
describe('transferConversationConnectionForInvocation desired target recovery', () => {
  const OLD_ORIGIN = {
    serverIdentityId: 'srv_example',
    materializationRef: {
      pluginId: providerSelection.contributor.pluginId,
      machineId: 'machine-old',
      materializationId: 'materialization-old',
    },
  } as const;
  const REPLACEMENT_MATERIALIZATION = {
    pluginId: providerSelection.contributor.pluginId,
    machineId: 'machine-example',
    materializationId: 'materialization-example',
  } as const;

  function transferAuthority(): ConversationConnectionFixtureAuthority {
    return {
      providerPluginId: providerSelection.contributor.pluginId,
      providerContributionSelection: {
        contributionId: providerSelection.contributor.contributionId,
      },
      providerSetupInput: { source: 'same' },
      credentialRef: null,
      transportOrigin: OLD_ORIGIN,
      providerConnectionKey: 'example:connection',
      providerConfig: { opaque: true },
      routingIdentityKey: 'r'.repeat(43),
      integrationPrincipal: { id: 'example-bot' },
      authorityEpoch: 4,
    };
  }

  /**
   * The generic webhook endpoint boundary.
   *
   * It models the canonical owner's convergence contract rather than a
   * pass-through stub, because that contract is exactly what the transfer
   * journey depends on: intent epochs order competing transfers, an equal
   * epoch already at its desired target rejoins without a second write, and a
   * lower epoch is refused so a late retry can never drag delivery back. The
   * endpoint keeps its own revision so a test can prove whether it really
   * moved, and the transfer owner never observes or supplies that revision.
   */
  function webhookEndpointBoundary(input: Readonly<{
    connectionId: string;
    collection: ReturnType<typeof createMutableConnectionStateCollection>;
  }>) {
    const currentTargets = new Map<string, Readonly<Record<string, string>>>([
      [REPLACEMENT_MATERIALIZATION.machineId, REPLACEMENT_MATERIALIZATION],
      ['machine-next', { ...REPLACEMENT_MATERIALIZATION, machineId: 'machine-next', materializationId: 'materialization-next' }],
    ]);
    const state = {
      target: { ...OLD_ORIGIN.materializationRef } as Readonly<Record<string, string>>,
      targetIntentEpoch: null as number | null,
      revision: 4,
      failNextConverge: false,
      unavailableNextConverge: false,
      requireApproval: false,
      beforeConvergeResult: undefined as (() => Promise<void>) | undefined,
      /** Retained row revision observed at each endpoint call, in order. */
      observedRevisions: [] as Array<number | undefined>,
      convergeInputs: [] as unknown[],
    };
    const execute = vi.fn(async (actionId: string, actionInput: unknown) => {
      state.observedRevisions.push(input.collection.rows.get(input.connectionId)?.revision);
      if (actionId === 'plugin.webhook.endpoint.convergeTarget') {
        const beforeResult = state.beforeConvergeResult;
        state.beforeConvergeResult = undefined;
        await beforeResult?.();
        if (state.requireApproval) return {
          kind: 'approval_request_created', artifactId: 'webhook-target-approval',
          actionId: 'plugin.webhook.endpoint.convergeTarget',
        };
        if (state.failNextConverge) {
          state.failNextConverge = false;
          throw new Error('endpoint owner unavailable');
        }
        if (state.unavailableNextConverge) {
          state.unavailableNextConverge = false;
          return { kind: 'unavailable', code: 'endpoint_unavailable' };
        }
        state.convergeInputs.push(actionInput);
        const request = actionInput as Readonly<{
          desiredTargetMaterialization?: Readonly<Record<string, string>>;
          desiredTargetRouting?: Readonly<{ serverIdentityId: string; machineId: string }>;
          targetIntentEpoch: number;
        }>;
        if (state.targetIntentEpoch !== null && state.targetIntentEpoch > request.targetIntentEpoch) {
          return {
            kind: 'superseded',
            webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID,
            currentTargetIntentEpoch: state.targetIntentEpoch,
          };
        }
        // The external webhook owner resolves the current installation for a
        // routing target; Channels never fabricates or persists that identity.
        const desiredTarget = request.desiredTargetMaterialization
          ?? currentTargets.get(request.desiredTargetRouting?.machineId ?? '');
        if (desiredTarget === undefined) return { kind: 'unavailable', code: 'endpoint_unavailable' };
        const atDesiredTarget = JSON.stringify(state.target) === JSON.stringify(desiredTarget);
        if (!(state.targetIntentEpoch === request.targetIntentEpoch && atDesiredTarget)) {
          state.target = { ...desiredTarget };
          state.targetIntentEpoch = request.targetIntentEpoch;
          state.revision += 1;
        }
        return {
          kind: 'converged',
          webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID,
          revision: state.revision,
          targetMaterialization: { ...state.target },
          targetIntentEpoch: request.targetIntentEpoch,
        };
      }
      throw new Error(`Unexpected generic Action: ${actionId}`);
    });
    return { state, execute };
  }

  /**
   * One selected provider whose setup/test return the replacement origin and
   * whose stop Action is observable. Nothing here decides transport policy;
   * the transfer owner does.
   */
  function transferProviderExecutor(input: Readonly<{
    supportedTransports: readonly string[];
    recommendedTransport: string;
    replayContinuity: 'checkpointed' | 'sessionBound' | 'none';
    stopInputs: unknown[];
    stopOrigins: unknown[];
    /** The origin this replacement setup/test proves; defaults to the first one. */
    replacementMaterialization?: Readonly<{
      pluginId: string;
      machineId: string;
      materializationId: string;
    }>;
  }>) {
    const replacementMaterialization = input.replacementMaterialization ?? REPLACEMENT_MATERIALIZATION;
    return vi.fn(async (action: unknown, actionInput: unknown, options?: unknown) => {
      if (action === setupAction) {
        return {
          result: {
            v: 1,
            credentialRef: null,
            providerConnectionKey: 'example:connection',
            providerConfigVersion: 1,
            providerConfig: { opaque: true },
            integrationPrincipal: { id: 'example-bot' },
            supportedTransports: [...input.supportedTransports],
            recommendedTransport: input.recommendedTransport,
            overlapSafety: 'safe',
            replayContinuity: input.replayContinuity,
            outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
            // A webhook contribution may only be declared by a setup that
            // actually offers durable push.
            ...(input.supportedTransports.includes('durablePush')
              ? {
                webhookContributionRef: {
                  pluginId: providerSelection.contributor.pluginId,
                  localId: 'webhook',
                },
              }
              : {}),
          },
          executionOrigin: {
            serverIdentityId: 'srv_example',
            materializationRef: replacementMaterialization,
          },
        };
      }
      if (action === connectionTestAction) {
        return {
          result: {
            kind: 'ready',
            integrationPrincipal: { id: 'example-bot' },
            providerConnectionKey: 'example:connection',
          },
          executionOrigin: {
            serverIdentityId: 'srv_example',
            materializationRef: replacementMaterialization,
          },
        };
      }
      if (action === connectionStopAction) {
        input.stopInputs.push(actionInput);
        input.stopOrigins.push((options as Readonly<{ expectedExecutionRouting?: unknown }> | undefined)
          ?.expectedExecutionRouting);
        return {
          result: { kind: 'stopped' },
          executionOrigin: OLD_ORIGIN,
        };
      }
      throw new Error('Expected only the selected setup, test, and stop Actions.');
    });
  }

  function transferContext(input: Readonly<{
    stateCollection: unknown;
    provider: ReturnType<typeof transferProviderExecutor>;
    execute?: ReturnType<typeof vi.fn>;
    signal?: AbortSignal;
  }>): PluginInvocationContext {
    return invocationContext({
      actions: {
        executeAdmittedTargetedOperationWithExecutionOrigin: input.provider,
        ...(input.execute === undefined ? {} : { execute: input.execute }),
      } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.sourceCustody.immutableGenerationId,
        operations: {
          setup: setupAction,
          connectionTest: connectionTestAction,
          messageDeliver: messageDeliverAction,
          connectionStop: connectionStopAction,
          observationsPoll: observationsPollAction,
        },
      }),
      stateCollection: input.stateCollection,
      signal: input.signal,
    });
  }

  function pushTransferFixture(connectionId: string) {
    const collection = createMutableConnectionStateCollection();
    collection.rows.set(connectionId, { rowId: connectionId, revision: 4,
      value: createCurrentConversationConnectionFixture({ configurationRevision: 4, connectionId,
        authority: transferAuthority(), transport: { kind: 'durablePush',
          webhookContributionRef: { pluginId: providerSelection.contributor.pluginId, localId: 'webhook' },
          webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID,
          webhookSourceInstanceId: `channels.connection.${connectionId}` },
        overlapSafety: 'safe', replayContinuity: 'none',
        outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' } }),
    });
    const stopInputs: unknown[] = [];
    const provider = transferProviderExecutor({ supportedTransports: ['checkpointedPull', 'socket', 'durablePush'],
      recommendedTransport: 'durablePush', replayContinuity: 'none', stopInputs, stopOrigins: [] });
    const endpoint = webhookEndpointBoundary({ connectionId, collection });
    const context = transferContext({ stateCollection: collection, provider, execute: endpoint.execute });
    const input = { connectionId, expectedRevision: 4, expectedAuthorityEpoch: 4, providerSelection,
      providerSetupInput: { source: 'same' }, credentialRef: null, selectedTransport: 'durablePush' } as const;
    return { collection, provider, endpoint, context, input, stopInputs };
  }

  it('commits a durable-push desired target without retaining endpoint-retarget custody', async () => {
    const fixture = pushTransferFixture('connection-transfer-desired-target');
    fixture.endpoint.state.unavailableNextConverge = true;
    await expect(transferConversationConnectionForInvocation(fixture.input, fixture.context)).resolves.toMatchObject({
      kind: 'transferred', connectionId: fixture.input.connectionId, authorityEpoch: 5,
    });
    expect(fixture.endpoint.state.observedRevisions).toEqual([5]);
    expect(fixture.endpoint.state.target).toEqual(OLD_ORIGIN.materializationRef);
    expect(fixture.collection.rows.get(fixture.input.connectionId)).toMatchObject({ revision: 6,
      value: { payload: { authorityEpoch: 5, pendingOldTransportStop: null,
        pollFailure: { phase: 'retryDue', evidence: { kind: 'action', code: 'endpoint_unavailable' } },
        transportOrigin: { machineId: REPLACEMENT_MATERIALIZATION.machineId },
        transport: { kind: 'durablePush', webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID } } },
    });
    expect(fixture.stopInputs).toEqual([]);
    await expect(retryConversationConnectionPollForInvocation({
      connectionId: fixture.input.connectionId, expectedRevision: 5, authorityEpoch: 5,
    }, fixture.context)).resolves.toMatchObject({ kind: 'retryScheduled', authorityEpoch: 5 });
    expect(fixture.collection.rows.get(fixture.input.connectionId)?.value).toMatchObject({
      payload: { pollFailure: null, authorityEpoch: 5,
        transportOrigin: { machineId: REPLACEMENT_MATERIALIZATION.machineId } },
    });
  });

  it('recovers the desired durable-push target after a crash through the real supervisor and stays quiet on unrelated writes', async () => {
    const fixture = pushTransferFixture('connection-transfer-supervisor-crash');
    fixture.collection.loseNextUpdatedBatchResponse();
    await expect(transferConversationConnectionForInvocation(fixture.input, fixture.context)).rejects.toThrow('simulated response loss');
    expect(fixture.endpoint.execute).not.toHaveBeenCalled();
    fixture.endpoint.state.unavailableNextConverge = true;
    vi.useFakeTimers();
    const generation = new AbortController();
    const watchers: Array<{ kind?: string; notify(): void }> = [];
    const collection = { ...fixture.collection, watch: (request: Readonly<{ prefix?: readonly string[] }>, notify: () => void) => {
      watchers.push({ kind: request.prefix?.[0], notify }); return { dispose() {} };
    } };
    const supervisor = createIngressSupervisor();
    const running = supervisor.run({ ...fixture.context, signal: generation.signal,
      services: { ...fixture.context.services, storage: { account: { collection: () => collection } },
        logger: { info: vi.fn(), warn: vi.fn() }, events: { plugin: { emit: async () => ({ subscriberCount: 0 }) } } },
    } as unknown as BackgroundServiceContext);
    const publish = (kind: string) => { for (const watcher of watchers) if (watcher.kind === undefined || watcher.kind === kind) watcher.notify(); };
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.endpoint.state.target).toEqual(OLD_ORIGIN.materializationRef);
      expect(fixture.collection.rows.get(fixture.input.connectionId)?.value).toMatchObject({
        payload: { pollFailure: { phase: 'retryDue', evidence: { code: 'endpoint_unavailable' } } },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fixture.endpoint.state.target).toEqual(REPLACEMENT_MATERIALIZATION);
      expect(fixture.endpoint.state.revision).toBe(5);
      const settledConvergeCalls = fixture.endpoint.state.convergeInputs.length;
      expect(fixture.collection.rows.get(fixture.input.connectionId)?.value).toMatchObject({ payload: { pollFailure: null } });
      for (let index = 0; index < 10; index += 1) {
        publish('checkpoint'); publish('pairing-request'); publish('binding'); publish('connection');
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(fixture.endpoint.state.convergeInputs).toHaveLength(settledConvergeCalls);
      const row = fixture.collection.rows.get(fixture.input.connectionId)!;
      const payload = row.value.payload as Readonly<Record<string, unknown>>;
      fixture.collection.rows.set(row.rowId, { ...row, revision: row.revision + 1,
        value: { ...row.value, payload: { ...payload, authorityEpoch: 6,
          transportOrigin: { serverIdentityId: 'srv_example', machineId: 'machine-next' } } } });
      publish('connection');
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.endpoint.state.target).toEqual({ ...REPLACEMENT_MATERIALIZATION,
        machineId: 'machine-next', materializationId: 'materialization-next' });
      expect(fixture.endpoint.state.convergeInputs).toHaveLength(settledConvergeCalls + 1);
      expect(fixture.collection.rows.get(row.rowId)?.revision).toBe(row.revision + 1);
      const connectionWrites = fixture.collection.batch.mock.calls.length;
      const endpointRevision = fixture.endpoint.state.revision;
      publish('connection');
      await vi.advanceTimersByTimeAsync(0);
      expect(fixture.collection.batch.mock.calls.length).toBe(connectionWrites);
      expect(fixture.endpoint.state.revision).toBe(endpointRevision);
    } finally {
      generation.abort(); await running; await supervisor.dispose(); vi.useRealTimers();
    }
  });

  it('rejoins a response-lost transfer by its current desired facts without another connection write', async () => {
    const fixture = pushTransferFixture('connection-transfer-idempotent-desire');
    fixture.collection.loseNextUpdatedBatchResponse();
    await expect(transferConversationConnectionForInvocation(fixture.input, fixture.context)).rejects.toThrow('simulated response loss');
    await expect(transferConversationConnectionForInvocation(fixture.input, fixture.context)).resolves.toMatchObject({
      kind: 'transferred', revision: 5, authorityEpoch: 5,
    });
    expect(fixture.collection.rows.get(fixture.input.connectionId)?.revision).toBe(5);
    expect(fixture.endpoint.state.target).toEqual(REPLACEMENT_MATERIALIZATION);
    expect(fixture.stopInputs).toEqual([]);
  });

  it('shows a policy-deferred endpoint move as blocked and never creates automatic duplicate approvals', async () => {
    const fixture = pushTransferFixture('connection-transfer-approval-deferred');
    fixture.endpoint.state.requireApproval = true;
    let concurrentEditApplied = false;
    fixture.endpoint.state.beforeConvergeResult = async () => {
      const edited = await updateConversationConnectionForInvocation({
        connectionId: fixture.input.connectionId, expectedRevision: 5,
        enabled: true, maximumObservationAgeMs: 120_000,
      }, fixture.context);
      concurrentEditApplied = edited.kind === 'updated';
    };
    await expect(transferConversationConnectionForInvocation(fixture.input, fixture.context)).resolves.toMatchObject({
      kind: 'transferred', authorityEpoch: 5,
    });
    expect(concurrentEditApplied).toBe(true);
    vi.useFakeTimers();
    const generation = new AbortController();
    const collection = { ...fixture.collection, watch: () => ({ dispose() {} }) };
    const supervisor = createIngressSupervisor();
    const running = supervisor.run({ ...fixture.context, signal: generation.signal,
      services: { ...fixture.context.services, storage: { account: { collection: () => collection } },
        logger: { info: vi.fn(), warn: vi.fn() }, events: { plugin: { emit: async () => ({ subscriberCount: 0 }) } } },
    } as unknown as BackgroundServiceContext);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fixture.endpoint.execute).toHaveBeenCalledTimes(1);
      expect(fixture.collection.rows.get(fixture.input.connectionId)?.value).toMatchObject({
        payload: { pollFailure: { phase: 'blocked', evidence: {
          kind: 'action', code: 'channels_connection_transfer_endpoint_unavailable',
        } } },
      });
      expect(fixture.endpoint.state.target).toEqual(OLD_ORIGIN.materializationRef);
    } finally {
      generation.abort(); await running; await supervisor.dispose(); vi.useRealTimers();
    }
  });

  it('allows a later transfer while a previous desired endpoint move is unavailable and refuses a late older move', async () => {
    const fixture = pushTransferFixture('connection-transfer-newer-desire');
    fixture.endpoint.state.failNextConverge = true;
    await expect(transferConversationConnectionForInvocation(fixture.input, fixture.context)).resolves.toMatchObject({ kind: 'transferred', authorityEpoch: 5 });
    const nextMaterialization = { ...REPLACEMENT_MATERIALIZATION, machineId: 'machine-next', materializationId: 'materialization-next' };
    const nextProvider = transferProviderExecutor({ supportedTransports: ['durablePush'], recommendedTransport: 'durablePush',
      replayContinuity: 'none', stopInputs: fixture.stopInputs, stopOrigins: [], replacementMaterialization: nextMaterialization });
    await expect(transferConversationConnectionForInvocation({ ...fixture.input, expectedRevision: 5, expectedAuthorityEpoch: 5,
      providerSetupInput: { source: 'next' } }, transferContext({ stateCollection: fixture.collection,
        provider: nextProvider, execute: fixture.endpoint.execute }))).resolves.toMatchObject({ kind: 'transferred', authorityEpoch: 6 });
    await expect(convergeConversationConnectionWebhookEndpointTarget({ context: fixture.context, transferAuthorityEpoch: 5,
      webhookEndpointId: DURABLE_PUSH_WEBHOOK_ENDPOINT_ID,
      webhookContribution: { pluginId: providerSelection.contributor.pluginId, localId: 'webhook' },
      sourceInstanceId: `channels.connection.${fixture.input.connectionId}`, nextTargetMaterialization: REPLACEMENT_MATERIALIZATION,
    })).rejects.toMatchObject({ code: 'channels_connection_transfer_endpoint_superseded' });
    expect(fixture.endpoint.state.target).toEqual(nextMaterialization);
    expect(fixture.collection.rows.get(fixture.input.connectionId)).toMatchObject({ revision: 7,
      value: { payload: { authorityEpoch: 6, pendingOldTransportStop: null, pollFailure: null } },
    });
  });
});
