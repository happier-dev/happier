import {
  PluginError,
  type JsonValue,
  type PluginInvocationContext,
  type TargetedContributionPointRef,
  type TargetedContributionSnapshot,
  type TargetedContributionsService,
} from '@happier-dev/plugin-sdk';
import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import type { PluginTargetedContributionSelectionV1 } from '@happier-dev/plugin-sdk/contributions';
import { describe, expect, it, vi } from 'vitest';

import {
  CHANNEL_STATE_FIELD,
  CHANNEL_STATE_FIXED_ROW_ID,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import {
  createConversationConnectionForInvocation,
  prepareConversationConnectionForInvocation,
  retestConversationConnectionForInvocation,
  setConversationBindingEnabledForInvocation,
  updateConversationConnectionForInvocation,
  transferConversationConnectionForInvocation,
} from './management.js';
import {
  createCurrentConversationConnectionFixture,
  type ConversationConnectionFixtureAuthority,
} from './testkit/currentConnectionFixture.js';
import { assertChannelsTestCollectionQueryLimit } from './testkit/collectionQueryBound.js';

const providerSelection = {
  target: {
    pluginId: 'happier.channels',
    immutableGenerationId: 'channels-generation-a',
  },
  point: {
    pointId: 'providers',
    protocol: { id: 'happier.channels/providers', version: 1 },
  },
  contributor: {
    pluginId: 'example.channels.provider',
    contributionId: 'example-socket',
    immutableGenerationId: 'provider-generation-a',
  },
} as const satisfies PluginTargetedContributionSelectionV1;

const replacementProviderSelection = {
  ...providerSelection,
  contributor: {
    pluginId: providerSelection.contributor.pluginId,
    contributionId: 'example-socket-replacement',
    immutableGenerationId: 'provider-generation-b',
  },
} as const satisfies PluginTargetedContributionSelectionV1;

function admittedProviderOperation(input: Readonly<{
  contributor?: Readonly<{
    pluginId: string;
    contributionId: string;
    immutableGenerationId: string;
  }>;
  role: string;
}>) {
  const contributor = input.contributor ?? providerSelection.contributor;
  return Object.freeze({
    identity: Object.freeze({
      target: Object.freeze({ pluginId: providerSelection.target.pluginId }),
      point: Object.freeze({
        pointId: providerSelection.point.pointId,
        protocol: Object.freeze({ ...providerSelection.point.protocol }),
      }),
      contributor: Object.freeze({ ...contributor }),
      role: input.role,
    }),
  });
}

const setupAction = admittedProviderOperation({ role: 'setup' });
const connectionTestAction = admittedProviderOperation({ role: 'connectionTest' });
const messageDeliverAction = admittedProviderOperation({ role: 'messageDeliver' });
const connectionStopAction = admittedProviderOperation({ role: 'connectionStop' });
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
            generation: current.targetImmutableGenerationId
              ?? providerSelection.target.immutableGenerationId,
            contributions: (current.contributions ?? [current]).map((contribution) => ({
              contributor: {
                pluginId: contribution.contributorPluginId ?? providerSelection.contributor.pluginId,
                contributionId: contribution.contributorId ?? providerSelection.contributor.contributionId,
                immutableGenerationId: contribution.contributorImmutableGenerationId,
              },
              protocol: providerSelection.point.protocol,
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
      ...(input.stateCollection === undefined ? {} : {
        storage: {
          account: { collection: () => input.stateCollection },
        },
      }),
    },
  } as unknown as PluginInvocationContext;
}

type MutableStateValue = Readonly<Record<string, unknown>> & Readonly<{ id: string }>;
type MutableStateRow = Readonly<{
  rowId: string;
  revision: number;
  value: MutableStateValue;
}>;
type MutableStateMutation =
  | Readonly<{ kind: 'assert'; rowId: string; expectedRevision: number }>
  | Readonly<{
    kind: 'put';
    value: MutableStateValue;
    expectedRevision: number | 'absent';
  }>;

/** The Account Collection is the one external boundary for this owner test. */
function createMutableConnectionStateCollection() {
  const rows = new Map<string, MutableStateRow>();
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
    async query(request: Readonly<{ index: string; prefix?: readonly unknown[]; limit?: number }>) {
      assertChannelsTestCollectionQueryLimit(request.limit);
      if (request.index !== CHANNEL_STATE_INDEX_ID.byKind) {
        throw new Error(`Unexpected owner query index: ${request.index}`);
      }
      const kind = request.prefix?.[0];
      return {
        rows: [...rows.values()].filter((row) => (
          (row.value as Readonly<Record<string, unknown>>)[CHANNEL_STATE_FIELD.recordKind] === kind
        )),
        changeCursor: 1,
        nextCursor: undefined,
      };
    },
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
    serverIdentityId: 'srv-example',
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
    serverIdentityId: 'srv-example',
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
        contributorPluginId: input.contributorPluginId,
        operations: {
          setup: setupAction,
          connectionTest: connectionTestAction,
          messageDeliver: messageDeliverAction,
          connectionStop: connectionStopAction,
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
  it('resolves the selected admitted contributor and binds its exact selected account to the setup handle', async () => {
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
          outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
          setupGuidance: {
            externalUrl: 'https://provider.example.test/install',
            requiredPermissionsLabel: 'Read messages, Send messages',
          },
        },
        executionOrigin: {
          serverIdentityId: 'srv-example',
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
      }),
    });

    await expect(prepareConversationConnectionForInvocation({
      providerSelection,
      providerSetupInput: { source: 'test' },
      credentialRef: selectedCredentialRef,
    }, context)).resolves.toMatchObject({
      kind: 'ready',
      supportedTransports: ['socket'],
      recommendedTransport: 'socket',
      setupGuidance: {
        externalUrl: 'https://provider.example.test/install',
        requiredPermissionsLabel: 'Read messages, Send messages',
      },
    });
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
        serverIdentityId: 'srv-example',
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
        serverIdentityId: 'srv-example',
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
          serverIdentityId: 'srv-example',
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
        serverIdentityId: 'srv-example',
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
      }),
    });

    await expect(prepareConversationConnectionForInvocation({
      providerSelection,
      providerSetupInput: { source: 'invalid-transport-facts' },
      credentialRef: null,
    }, context)).rejects.toMatchObject({ code: 'channels_connection_setup_result_invalid' });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
  });

  it('rejects a contributor replaced after the caller selected its prior immutable generation', async () => {
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: 'provider-generation-b',
      }),
    });

    await expect(prepareConversationConnectionForInvocation({
      providerSelection,
      providerSetupInput: { source: 'test' },
      credentialRef: null,
    }, context)).rejects.toBeInstanceOf(Error);
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
  });

  it('rejects a target replacement before executing the formerly selected setup handle', async () => {
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
        targetImmutableGenerationId: 'channels-generation-b',
      }),
    });

    await expect(prepareConversationConnectionForInvocation({
      providerSelection,
      providerSetupInput: { source: 'test' },
      credentialRef: null,
    }, context)).rejects.toMatchObject({ code: 'channels_provider_contribution_unavailable' });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
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

describe('createConversationConnectionForInvocation targeted provider selection', () => {
  it('reruns the exact setup and test handles, then rejoins after a committed Account write loses its response', async () => {
    const collection = createMutableConnectionStateCollection();
    seedConnectionIdentityKey(collection);
    const controller = new AbortController();
    const executionOrigin = {
      serverIdentityId: 'srv-example',
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
            outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
            immutableGenerationId: providerSelection.contributor.immutableGenerationId,
          },
          providerSetupInput: { source: 'create' },
          credentialRef: selectedCredentialRef,
          transport: { kind: 'socket' },
          providerConnectionKey: 'example:connection',
          providerConfig: { opaque: true },
        },
      },
    });
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
      serverIdentityId: 'srv-example',
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
      serverIdentityId: 'srv-example',
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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

  it('rejects mismatched setup and test execution origins before persistence', async () => {
    const collection = createMutableConnectionStateCollection();
    seedConnectionIdentityKey(collection);
    const setupExecutionOrigin = {
      serverIdentityId: 'srv-example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-example',
        materializationId: 'materialization-a',
      },
    };
    const testExecutionOrigin = {
      ...setupExecutionOrigin,
      materializationRef: {
        ...setupExecutionOrigin.materializationRef,
        materializationId: 'materialization-b',
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
      executionOrigin: action === setupAction ? setupExecutionOrigin : testExecutionOrigin,
    }));
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
    }, context)).rejects.toMatchObject({ code: 'channels_connection_execution_origin_mismatch' });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(2);
    expect(collection.rows.size).toBe(1);
    expect(collection.batch).not.toHaveBeenCalled();
  });

  it.each([
    ['socket', 'connectionStop'],
    ['checkpointedPull', 'observationsPoll'],
  ] as const)('rejects %s creation before provider execution when its required %s role is absent', async (
    selectedTransport,
    requiredOperation,
  ) => {
    const collection = createMutableConnectionStateCollection();
    seedConnectionIdentityKey(collection);
    const executionOrigin = {
      serverIdentityId: 'srv-example',
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
        operations: { setup: setupAction, connectionTest: connectionTestAction, messageDeliver: messageDeliverAction },
      }),
      stateCollection: collection,
    });

    await expect(createConversationConnectionForInvocation({
      providerSelection,
      providerSetupInput: { source: 'create' },
      credentialRef: null,
      selectedTransport,
      maximumObservationAgeMs: 60_000,
    }, context)).rejects.toMatchObject({
      code: 'channels_connection_transport_role_unavailable',
      details: { selectedTransport, requiredOperation },
    });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
    expect(collection.rows.size).toBe(1);
    expect(collection.batch).not.toHaveBeenCalled();
  });

  it('does not persist a setup/test result once the selected contributor is retired before the persistence reread', async () => {
    const collection = createMutableConnectionStateCollection();
    seedConnectionIdentityKey(collection);
    const executionOrigin = {
      serverIdentityId: 'srv-example',
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
        snapshots: [
          {
            contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
    }, context)).rejects.toMatchObject({ code: 'channels_provider_contribution_unavailable' });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(2);
    expect(collection.rows.size).toBe(1);
    expect(collection.batch).not.toHaveBeenCalled();
  });

});

describe('transferConversationConnectionForInvocation targeted provider selection', () => {
  it('conflicts a narrow transfer when a concurrent enable changes the binding demand after its scan', async () => {
    const connectionId = 'connection-transfer-concurrent-enable';
    const executionOrigin = {
      serverIdentityId: 'srv-example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-old',
        materializationId: 'materialization-old',
      },
    } as const;
    const replacementExecutionOrigin = {
      serverIdentityId: 'srv-example',
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
        immutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
      if (!enabled && request.index === CHANNEL_STATE_INDEX_ID.byKind
        && request.prefix?.[0] === CHANNEL_STATE_RECORD_KIND.binding) {
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
      serverIdentityId: 'srv-example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-old',
        materializationId: 'materialization-old',
      },
    } as const;
    const replacementExecutionOrigin = {
      serverIdentityId: 'srv-example',
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
        immutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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

  it('re-runs setup/test, then stops the frozen old socket transport through its exact retired origin', async () => {
    const connectionId = 'connection-transfer-same-config-new-origin';
    const oldExecutionOrigin = {
      serverIdentityId: 'srv-example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-old',
        materializationId: 'materialization-old',
      },
    } as const;
    const replacementExecutionOrigin = {
      serverIdentityId: 'srv-example',
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
        immutableGenerationId: providerSelection.contributor.immutableGenerationId,
      },
      providerSetupInput: { source: 'same' },
      credentialRef: null,
      transportOrigin: oldExecutionOrigin,
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
            outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
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
        return { result: { kind: 'stopped' }, executionOrigin: oldExecutionOrigin };
      }
      throw new Error('Expected only the selected setup/test/stop Actions.');
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
      providerSelection,
      providerSetupInput: { source: 'same' },
      credentialRef: null,
      selectedTransport: 'socket',
    }, context)).resolves.toEqual({
      kind: 'transferred',
      connectionId,
      revision: 6,
      authorityEpoch: 5,
    });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(3);
    expect(stopInvocations).toEqual([{
      operationInput: {
        v: 1,
        connectionId,
        providerConnectionKey: 'example:connection',
        providerConfigVersion: 1,
        providerConfig: { source: 'same' },
        credentialRef: null,
        authorityEpoch: 5,
        reason: 'transfer',
      },
      options: expect.objectContaining({ expectedExecutionOrigin: oldExecutionOrigin }),
    }]);
    expect(collection.rows.get(connectionId)).toMatchObject({
      revision: 6,
      value: {
        payload: {
          transportOrigin: replacementExecutionOrigin,
          authorityEpoch: 5,
          pendingOldTransportStop: null,
        },
      },
    });
  });

  it('keeps a socket transfer disclosed as pending custody when the frozen old stop is not proven', async () => {
    const connectionId = 'connection-transfer-unproven-old-stop';
    const oldExecutionOrigin = {
      serverIdentityId: 'srv-example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-old',
        materializationId: 'materialization-old',
      },
    } as const;
    const replacementExecutionOrigin = {
      serverIdentityId: 'srv-example',
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
        immutableGenerationId: providerSelection.contributor.immutableGenerationId,
      },
      providerSetupInput: { source: 'same' },
      credentialRef: null,
      transportOrigin: oldExecutionOrigin,
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
        connectionId,
        authority,
        transport: { kind: 'socket' },
        overlapSafety: 'safe',
        replayContinuity: 'none',
        outboundTextLimit: { maximum: 4_000, unit: 'unicodeCodePoints' },
      }),
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
        return { result: { kind: 'pending' }, executionOrigin: oldExecutionOrigin };
      }
      throw new Error('Expected only the selected setup/test/stop Actions.');
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
      providerSelection,
      providerSetupInput: { source: 'same' },
      credentialRef: null,
      selectedTransport: 'socket',
    }, context)).resolves.toEqual({
      kind: 'transferPendingOldStop',
      connectionId,
      revision: 5,
      authorityEpoch: 5,
    });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(3);
    expect(collection.rows.get(connectionId)).toMatchObject({
      revision: 5,
      value: {
        payload: {
          pendingOldTransportStop: {
            transportOrigin: oldExecutionOrigin,
            providerContributionSelection: authority.providerContributionSelection,
            stopRequest: {
              connectionId,
              authorityEpoch: 5,
              reason: 'transfer',
            },
          },
        },
      },
    });
  });

  it('rejoins a lost committed transfer by replaying only the idempotent frozen old stop', async () => {
    const connectionId = 'connection-transfer-targeted';
    const oldExecutionOrigin = {
      serverIdentityId: 'srv-example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-old',
        materializationId: 'materialization-old',
      },
    } as const;
    const replacementExecutionOrigin = {
      serverIdentityId: 'srv-example',
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
    const oldConnectionStopAction = admittedProviderOperation({ role: 'connectionStop' });
    const collection = createMutableConnectionStateCollection();
    const oldAuthority = {
      providerPluginId: providerSelection.contributor.pluginId,
      providerContributionSelection: {
        contributionId: providerSelection.contributor.contributionId,
        immutableGenerationId: providerSelection.contributor.immutableGenerationId,
      },
      providerSetupInput: { source: 'old' },
      credentialRef: null,
      transportOrigin: oldExecutionOrigin,
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
      if (action === oldConnectionStopAction) {
        return { result: { kind: 'notRunning' }, executionOrigin: oldExecutionOrigin };
      }
      throw new Error('Expected only the selected replacement setup/test/stop Actions.');
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: replacementProviderSelection.contributor.immutableGenerationId,
        contributions: [
          {
            contributorId: providerSelection.contributor.contributionId,
            contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
            operations: {
              setup: setupAction,
              connectionTest: connectionTestAction,
              messageDeliver: messageDeliverAction,
              connectionStop: oldConnectionStopAction,
            },
          },
          {
            contributorId: replacementProviderSelection.contributor.contributionId,
            contributorImmutableGenerationId: replacementProviderSelection.contributor.immutableGenerationId,
            operations: {
              setup: replacementSetupAction,
              connectionTest: replacementConnectionTestAction,
              messageDeliver: admittedProviderOperation({
                contributor: replacementProviderSelection.contributor,
                role: 'messageDeliver',
              }),
              connectionStop: admittedProviderOperation({
                contributor: replacementProviderSelection.contributor,
                role: 'connectionStop',
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
            immutableGenerationId: replacementProviderSelection.contributor.immutableGenerationId,
          },
          providerSetupInput: { source: 'replacement' },
          transportOrigin: replacementExecutionOrigin,
          transport: { kind: 'socket' },
          overlapSafety: 'providerExclusive',
          replayContinuity: 'none',
          providerConnectionKey: 'example:connection',
          providerConfig: { source: 'replacement' },
          authorityEpoch: 5,
          pendingOldTransportStop: {
            predecessorCheckpointedPollInvocation: {
              connectionRevision: 4,
              authorityEpoch: 4,
              transportOrigin: oldExecutionOrigin,
            },
            transportOrigin: oldExecutionOrigin,
            providerContributionSelection: {
              contributionId: providerSelection.contributor.contributionId,
              immutableGenerationId: providerSelection.contributor.immutableGenerationId,
            },
            stopRequest: {
              v: 1,
              connectionId,
              providerConnectionKey: 'example:connection',
              providerConfigVersion: 1,
              providerConfig: { source: 'old' },
              credentialRef: null,
              authorityEpoch: 5,
              reason: 'transfer',
            },
            overlapSafety: 'safe',
            acceptedPossibleLoss: false,
          },
          historyGap: { reason: 'providerHistoryUnavailable' },
        },
      },
    });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(2);

    await expect(transferConversationConnectionForInvocation(transferInput, context)).resolves.toEqual({
      kind: 'transferred',
      connectionId,
      revision: 6,
      authorityEpoch: 5,
    });
    // Setup and test are never replayed; only the exact frozen old stop runs.
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(3);
    expect(collection.batch).toHaveBeenCalledTimes(2);
    expect(collection.rows.get(connectionId)).toMatchObject({
      revision: 6,
      value: { payload: { authorityEpoch: 5, pendingOldTransportStop: null } },
    });
  });

  it('rejects an exact-revision equal-origin rejoin when Account authority changes during provider setup/test', async () => {
    const connectionId = 'connection-transfer-equal-origin-stale-after-test';
    const executionOrigin = {
      serverIdentityId: 'srv-example',
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
        immutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
          value: connectionValue,
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
      providerSelection,
      providerSetupInput: { source: 'same' },
      credentialRef: null,
      selectedTransport: 'socket',
    }, context)).rejects.toMatchObject({ code: 'channels_connection_transfer_conflict' });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(2);
    expect(collection.batch).not.toHaveBeenCalled();
  });

  it('rejects a changed-origin transfer before a stale CAS when Account policy changes during provider setup/test', async () => {
    const connectionId = 'connection-transfer-changed-origin-stale-after-test';
    const oldExecutionOrigin = {
      serverIdentityId: 'srv-example',
      materializationRef: {
        pluginId: providerSelection.contributor.pluginId,
        machineId: 'machine-current',
        materializationId: 'materialization-current',
      },
    } as const;
    const replacementExecutionOrigin = {
      serverIdentityId: 'srv-example',
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
        immutableGenerationId: providerSelection.contributor.immutableGenerationId,
      },
      providerSetupInput: { source: 'old' },
      credentialRef: null,
      transportOrigin: oldExecutionOrigin,
      providerConnectionKey: 'example:connection',
      providerConfig: { source: 'old' },
      routingIdentityKey: 'r'.repeat(43),
      integrationPrincipal: { id: 'example-bot' },
      authorityEpoch: 4,
    } as const satisfies ConversationConnectionFixtureAuthority;
    const connectionValue = createCurrentConversationConnectionFixture({
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
          transportOrigin: oldExecutionOrigin,
        },
      },
    });
  });
});

describe('updateConversationConnectionForInvocation targeted provider stop', () => {
  it('uses the exact persisted contribution when one provider plugin contributes multiple channels providers', async () => {
    const connectionId = 'connection-disable-selected-contribution';
    const selectedConnectionStop = admittedProviderOperation({ role: 'connectionStop' });
    const otherConnectionStop = admittedProviderOperation({
      contributor: {
        pluginId: providerSelection.contributor.pluginId,
        contributionId: 'other-socket',
        immutableGenerationId: 'provider-generation-other',
      },
      role: 'connectionStop',
    });
    const persistedAuthority = {
      providerPluginId: providerSelection.contributor.pluginId,
      providerContributionSelection: {
        contributionId: providerSelection.contributor.contributionId,
        immutableGenerationId: providerSelection.contributor.immutableGenerationId,
      },
      providerSetupInput: { source: 'persisted' },
      credentialRef: null,
      transportOrigin: {
        serverIdentityId: 'server-example',
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
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (_action: unknown) => {
      return {
        result: { kind: 'stopped' },
        executionOrigin: row.value.payload.transportOrigin,
      };
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
        contributions: [
          {
            contributorId: 'other-socket',
            contributorImmutableGenerationId: 'provider-generation-other',
            operations: { connectionStop: otherConnectionStop },
          },
          {
            contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
            operations: { connectionStop: selectedConnectionStop },
          },
        ],
      }),
      stateCollection,
    });

    await expect(updateConversationConnectionForInvocation({
      connectionId,
      expectedRevision: 4,
      enabled: false,
      maximumObservationAgeMs: 60_000,
    }, context)).resolves.toMatchObject({ kind: 'updated', revision: 5 });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
    expect(executeAdmittedTargetedOperationWithExecutionOrigin.mock.calls[0]?.[0])
      .toBe(selectedConnectionStop);
  });

  it('stops the socket transport when the ordinary connection policy Action is the one that disables it', async () => {
    const connectionId = 'connection-policy-disable-targeted';
    const connectionStop = admittedProviderOperation({ role: 'connectionStop' });
    const persistedAuthority = {
      providerPluginId: providerSelection.contributor.pluginId,
      providerContributionSelection: {
        contributionId: providerSelection.contributor.contributionId,
        immutableGenerationId: providerSelection.contributor.immutableGenerationId,
      },
      providerSetupInput: { source: 'persisted' },
      credentialRef: null,
      transportOrigin: {
        serverIdentityId: 'server-example',
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
    expect(executeAdmittedTargetedOperationWithExecutionOrigin.mock.calls[0]?.[0])
      .toBe(connectionStop);
    expect(executeAdmittedTargetedOperationWithExecutionOrigin.mock.calls[0]?.[1])
      .toMatchObject({ connectionId, authorityEpoch: 5, reason: 'disable' });
  });

  it('persists an online disable before best-effort stopping through the exact current contribution', async () => {
    const connectionId = 'connection-disable-targeted';
    const connectionStop = admittedProviderOperation({ role: 'connectionStop' });
    const persistedAuthority = {
      providerPluginId: providerSelection.contributor.pluginId,
      providerContributionSelection: {
        contributionId: providerSelection.contributor.contributionId,
        immutableGenerationId: providerSelection.contributor.immutableGenerationId,
      },
      providerSetupInput: { source: 'persisted' },
      credentialRef: null,
      transportOrigin: {
        serverIdentityId: 'server-example',
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
    // assertion inside this mock can never fail the test. Record the row the
    // stop observed and assert both it and the recorded call afterwards.
    const rowsObservedAtStop: (typeof row)[] = [];
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (
      _action: unknown,
      _actionInput: unknown,
      _options: unknown,
    ) => {
      rowsObservedAtStop.push(row);
      return {
        result: { kind: 'stopped' },
        executionOrigin: row.value.payload.transportOrigin,
      };
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
    expect(rowsObservedAtStop[0]).toMatchObject({
      revision: 5,
      value: { payload: { authorityEpoch: 5, enabled: false } },
    });
    const [stopAction, stopInput, stopOptions]
      = executeAdmittedTargetedOperationWithExecutionOrigin.mock.calls[0] ?? [];
    expect(stopAction).toBe(connectionStop);
    expect(stopInput).toEqual({
      v: 1,
      connectionId,
      providerConnectionKey: 'example:connection',
      providerConfigVersion: 1,
      providerConfig: { opaque: true },
      credentialRef: null,
      authorityEpoch: 5,
      reason: 'disable',
    });
    expect(stopOptions).toMatchObject({
      expectedExecutionOrigin: row.value.payload.transportOrigin,
    });
  });
});

describe('retestConversationConnectionForInvocation', () => {
  const retestPersistedAuthority = {
    providerPluginId: providerSelection.contributor.pluginId,
    providerContributionSelection: {
      contributionId: providerSelection.contributor.contributionId,
      immutableGenerationId: providerSelection.contributor.immutableGenerationId,
    },
    providerSetupInput: { source: 'persisted' },
    credentialRef: selectedCredentialRef,
    transportOrigin: {
      serverIdentityId: 'server-example',
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
    const batches: unknown[][] = [];
    const stateCollection = {
      async get() { return row; },
      async query(request: Readonly<{ index: string; prefix?: readonly unknown[]; limit?: number }>) {
        assertChannelsTestCollectionQueryLimit(request.limit);
        if (
          request.index !== CHANNEL_STATE_INDEX_ID.byKind
          || request.prefix?.[0] !== CHANNEL_STATE_RECORD_KIND.binding
        ) {
          throw new Error(`Unexpected retest query: ${JSON.stringify(request)}`);
        }
        return { rows: bindingRows, changeCursor: 7, nextCursor: undefined };
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

  it('re-probes the saved connection through the persisted provider test and clears its retained readiness attention', async () => {
    const fixture = retestFixture();
    const connectionTest = admittedProviderOperation({ role: 'connectionTest' });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (
      action: unknown,
      actionInput: unknown,
      options: unknown,
    ) => {
      expect(action).toBe(connectionTest);
      // Exactly the retained connection facts. A retest that re-ran setup, or
      // rebuilt the request from caller input, would be a second connection
      // writer rather than a re-observation of the saved one.
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
        expectedExecutionOrigin: retestPersistedAuthority.transportOrigin,
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
  ])('refuses to publish a $name verdict after the tested connection revision changes', async ({ result }) => {
    const fixture = retestFixture();
    let readCount = 0;
    const stateCollection = {
      ...fixture.stateCollection,
      async get() {
        readCount += 1;
        const current = fixture.readRow();
        return readCount === 1 ? current : { ...current, revision: current.revision + 1 };
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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

  it('refuses to publish a provider verdict after the tested contribution generation changes', async () => {
    const fixture = retestFixture();
    const connectionTest = admittedProviderOperation({ role: 'connectionTest' });
    const context = invocationContext({
      actions: {
        executeAdmittedTargetedOperationWithExecutionOrigin: vi.fn(async () => ({
          result: {
            kind: 'notReady',
            reason: 'credentialInvalid',
            diagnostic: 'The saved bot token was rejected.',
          },
          executionOrigin: retestPersistedAuthority.transportOrigin,
        })),
      } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
        operations: { setup: setupAction, connectionTest },
        snapshots: [
          {
            contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
            operations: { setup: setupAction, connectionTest },
          },
          {
            contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
            targetImmutableGenerationId: 'channels-target-generation-replaced',
            operations: { setup: setupAction, connectionTest },
          },
        ],
      }),
      stateCollection: fixture.stateCollection,
    });

    await expect(retestConversationConnectionForInvocation({
      connectionId: fixture.connectionId,
      expectedRevision: 4,
      authorityEpoch: 4,
    }, context)).rejects.toMatchObject({
      code: 'channels_connection_retest_conflict',
      retryable: true,
    });
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
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => ({
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => ({
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
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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

  it('refuses a probe whose credential now resolves to a different immutable integration principal', async () => {
    const fixture = retestFixture();
    const connectionTest = admittedProviderOperation({ role: 'connectionTest' });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => ({
      // The saved provider connection key still matches, but the credential
      // behind it now answers for a different immutable integration principal.
      result: {
        kind: 'ready',
        integrationPrincipal: { id: 'someone-elses-bot' },
        providerConnectionKey: 'example:connection',
      },
      executionOrigin: retestPersistedAuthority.transportOrigin,
    }));
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
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

  it('refuses to touch the provider at all once the caller no longer holds current connection authority', async () => {
    const fixture = retestFixture();
    const connectionTest = admittedProviderOperation({ role: 'connectionTest' });
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async () => {
      throw new Error('The provider must not be probed under retired authority.');
    });
    const context = invocationContext({
      actions: { executeAdmittedTargetedOperationWithExecutionOrigin } as unknown as ActionsService,
      targetedContributions: targetedContributionsFixture({
        contributorImmutableGenerationId: providerSelection.contributor.immutableGenerationId,
        operations: { setup: setupAction, connectionTest },
      }),
      stateCollection: fixture.stateCollection,
    });

    await expect(retestConversationConnectionForInvocation({
      connectionId: fixture.connectionId,
      expectedRevision: 4,
      authorityEpoch: 3,
    }, context)).rejects.toMatchObject({
      code: 'channels_connection_retest_conflict',
      retryable: true,
    });
    await expect(retestConversationConnectionForInvocation({
      connectionId: fixture.connectionId,
      expectedRevision: 3,
      authorityEpoch: 4,
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
