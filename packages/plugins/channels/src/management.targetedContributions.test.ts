import {
  PluginError,
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
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import {
  createConversationConnectionForInvocation,
  prepareConversationConnectionForInvocation,
  setConversationConnectionEnabledForInvocation,
  transferConversationConnectionForInvocation,
} from './management.js';
import {
  createCurrentConversationConnectionFixture,
  type ConversationConnectionFixtureAuthority,
} from './testkit/currentConnectionFixture.js';

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
type MutableStateMutation = Readonly<{
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
      const current = rows.get(operation.value.id);
      const expected = operation.expectedRevision;
      const matches = expected === 'absent'
        ? current === undefined
        : current?.revision === expected;
      return matches ? [] : [{
        rowId: operation.value.id,
        revision: current?.revision ?? 0,
        deleted: false,
      }];
    });
    if (conflicts.length > 0) return { status: 'conflict' as const, conflicts };

    const results: Array<Readonly<{ rowId: string; revision: number; deleted: false }>> = [];
    for (const operation of operations) {
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
    });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
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
        supportedTransports: ['socket'],
        recommendedTransport: 'socket',
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

  it('rejects durable-push input before selection, provider execution, or persistence', async () => {
    const collection = createMutableConnectionStateCollection();
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn();
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
      providerSetupInput: { source: 'durable-push' },
      credentialRef: null,
      selectedTransport: 'durablePush',
      maximumObservationAgeMs: 60_000,
    }, context)).rejects.toMatchObject({ code: 'channels_connection_create_input_invalid' });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).not.toHaveBeenCalled();
    expect(collection.rows.size).toBe(0);
    expect(collection.batch).not.toHaveBeenCalled();
  });
});

describe('transferConversationConnectionForInvocation targeted provider selection', () => {
  it('re-runs setup/test to replace the execution origin when the selected provider configuration is unchanged', async () => {
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
    }, context)).resolves.toEqual({
      kind: 'transferPendingOldStop',
      connectionId,
      revision: 5,
      authorityEpoch: 5,
    });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(2);
    expect(collection.rows.get(connectionId)).toMatchObject({
      revision: 5,
      value: {
        payload: {
          transportOrigin: replacementExecutionOrigin,
          pendingOldTransportStop: {
            predecessorCheckpointedPollInvocation: {
              connectionRevision: 4,
              authorityEpoch: 4,
              transportOrigin: oldExecutionOrigin,
            },
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

  it('persists the exact replacement setup/selection and rejoins a lost committed transfer without replaying provider effects', async () => {
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
        throw new Error('Transfer must not stop the frozen old transport inline.');
      }
      throw new Error('Expected only the selected replacement setup/test Actions.');
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
      kind: 'rejoined',
      connectionId,
      revision: 5,
      authorityEpoch: 5,
    });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledTimes(2);
    expect(collection.batch).toHaveBeenCalledOnce();
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

describe('setConversationConnectionEnabledForInvocation targeted provider stop', () => {
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
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown) => {
      expect(action).toBe(selectedConnectionStop);
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

    await expect(setConversationConnectionEnabledForInvocation({
      connectionId,
      expectedRevision: 4,
      enabled: false,
    }, context)).resolves.toMatchObject({ kind: 'updated', revision: 5 });
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
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
    const executeAdmittedTargetedOperationWithExecutionOrigin = vi.fn(async (action: unknown, actionInput: unknown, options: unknown) => {
      expect(row).toMatchObject({
        revision: 5,
        value: { payload: { authorityEpoch: 5, enabled: false } },
      });
      expect(action).toBe(connectionStop);
      expect(actionInput).toEqual({
        v: 1,
        connectionId,
        providerConnectionKey: 'example:connection',
        providerConfigVersion: 1,
        providerConfig: { opaque: true },
        credentialRef: null,
        authorityEpoch: 5,
        reason: 'disable',
      });
      expect(options).toMatchObject({
        expectedExecutionOrigin: row.value.payload.transportOrigin,
      });
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

    await expect(setConversationConnectionEnabledForInvocation({
      connectionId,
      expectedRevision: 4,
      enabled: false,
    }, context)).resolves.toEqual({
      kind: 'updated',
      connectionId,
      revision: 5,
      authorityEpoch: 5,
    });
    expect(row.value.payload.enabled).toBe(false);
    expect(executeAdmittedTargetedOperationWithExecutionOrigin).toHaveBeenCalledOnce();
  });
});
