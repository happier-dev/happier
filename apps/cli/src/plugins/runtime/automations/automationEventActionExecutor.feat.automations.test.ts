import { describe, expect, it, vi } from 'vitest';
import {
  AutomationEventActionHttpRequestSchemasV1,
  AutomationEventAdmitEncryptedHostEvidenceV1Schema,
  AutomationEventAdmitInputV1Schema,
  buildAutomationPluginEventOccurrenceEvidenceV1,
  deriveAutomationOccurrenceKeyV1,
  type AutomationEventSourcesListInputV1,
  type AutomationEventSourcesListResultV1,
  type AutomationEventAdmitHttpRequestV1,
  AutomationSourceSelectorIdV1Schema,
  PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
  type PluginMachineMaterializationRefV1,
  type PluginWebhookInvocationReferenceV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  createAccountScopedCryptoMaterialSnapshotV1,
  isAutomationTriggerEvidenceCiphertextV1,
  parseAutomationRunExecutionRecipeV1,
  sealAccountScopedBlobCiphertext,
  sealAutomationTriggerDefinitionStoredEnvelopeV1,
  serializeAutomationRunExecutionRecipeV1,
} from '@happier-dev/protocol';

const transportMocks = vi.hoisted(() => ({
  post: vi.fn(),
  createPublisherHeader: vi.fn(),
}));

vi.mock('axios', () => ({ default: { post: transportMocks.post } }));
vi.mock('@/plugins/installations/publisherProof', () => ({
  createDefaultPluginInstallationPublisherHeader: transportMocks.createPublisherHeader,
}));

import {
  createAutomationEventActionExecutor,
} from './automationEventActionExecutor';
import type {
  AutomationEventAdoptedDefinitionSetV1,
} from './automationEventAdoptedDefinitionSet';
import { createAutomationEventAdoptedDefinitionSetHostV1 } from './automationEventAdoptedDefinitionSetHost';
import {
  readCurrentPluginWebhookAutomationAdmissionUnresolvedV1,
  runWithPluginWebhookInvocationReferenceV1,
} from '../webhooks/pluginWebhookInvocationReference';

const credentials = {
  token: 'token_test',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
};
const readyAdmissionContinuation = {
  kind: 'ready' as const,
  accountCurrentness: { mode: 'plain' as const, version: 10, contentKeyFingerprint: null },
};
const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(
  '9d5af559-2c82-4c22-b6a0-ecabce38a631',
);
const secondSourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(
  '8a1e713b-3d8c-44ae-8599-6b0346535f3a',
);
const callerMaterialization = {
  pluginId: 'com.acme.github',
  machineId: 'machine-caller',
  materializationId: 'materialization-caller',
} as const;
const eventDeclarationRelease = {
  release: { pluginId: callerMaterialization.pluginId, version: '1.0.0' },
  archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
} as const;

type AutomationEventPublicProjectionOwner = AutomationEventAdoptedDefinitionSetV1 & Readonly<{
  listPublicProjection(params: Readonly<{
    accountId: string;
    input: AutomationEventSourcesListInputV1;
    webhookInvocationReference?: PluginWebhookInvocationReferenceV1;
    signal?: AbortSignal;
  }>): Promise<AutomationEventSourcesListResultV1 | Readonly<{ kind: 'unavailable' }>>;
}>;

type AutomationEventActionExecutorWithAdoptedSet = Parameters<
  typeof createAutomationEventActionExecutor
>[0] & Readonly<{
  resolveAdoptedDefinitionSet(
    caller: PluginMachineMaterializationRefV1,
  ): AutomationEventPublicProjectionOwner | null;
}>;

function createAvailableAdoptedDefinitionSet(
  revision: string,
): AutomationEventPublicProjectionOwner {
  return {
    refresh: async () => ({ kind: 'adopted', revision }),
    readPublicProjection: () => ({
      kind: 'available',
      revision,
      definitions: [],
    }),
    listPublicProjection: async () => ({ kind: 'unchanged', revision }),
    prepareAdmission: async () => null,
  };
}

async function* oneShotAdmissionRequests(
  requests: readonly AutomationEventAdmitHttpRequestV1[],
): AsyncIterableIterator<AutomationEventAdmitHttpRequestV1> {
  yield* requests;
}

describe('createAutomationEventActionExecutor', () => {
  it('signs and sends status reports only to the installed source-status endpoint', async () => {
    transportMocks.createPublisherHeader.mockResolvedValueOnce('publisher-proof');
    transportMocks.post.mockResolvedValueOnce({ data: {} });
    const revalidateCallerMaterialization = vi.fn(async () => true);
    const revalidateCallerImmutableGeneration = vi.fn(async () => true);
    const executor = createAutomationEventActionExecutor({
      credentials,
      revalidateCallerMaterialization,
      revalidateCallerImmutableGeneration,
      resolveAdoptedDefinitionSet: () => createAvailableAdoptedDefinitionSet('7'),
    });
    const input = {
      kind: 'catalogReconciliation' as const,
      scope: { kind: 'checkpointedPull' as const },
      observedRevision: '7',
      adoptedRevision: '7',
      state: 'current' as const,
      scanStartedAt: 1_723_247_200_000,
      nextRetryAt: null,
    };

    await expect(executor({
      actionId: 'automation.event.source.status.report',
      input,
      caller: {
        kind: 'plugin',
        pluginId: 'com.acme.github',
        materialization: callerMaterialization,
        immutableGenerationId: 'github-immutable-generation-a',
      },
    })).resolves.toEqual({});

    const body = {
      v: 1,
      caller: {
        pluginId: 'com.acme.github',
        materialization: callerMaterialization,
        immutableGenerationId: 'github-immutable-generation-a',
      },
      input,
    };
    expect(transportMocks.createPublisherHeader).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/automations/events/source-status/report',
      body,
    });
    expect(transportMocks.post).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/automations\/events\/source-status\/report$/u),
      body,
      expect.objectContaining({
        headers: expect.objectContaining({
          [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: 'publisher-proof',
        }),
      }),
    );
  });

  it('does not let the current executor transport a source status without exact caller generation', async () => {
    const execute = vi.fn(async () => ({}));
    const executor = createAutomationEventActionExecutor({
      credentials,
      transport: { execute },
      revalidateCallerMaterialization: async () => true,
      resolveAdoptedDefinitionSet: () => createAvailableAdoptedDefinitionSet('7'),
    });

    await expect(executor({
      actionId: 'automation.event.source.status.report',
      input: {
        kind: 'catalogReconciliation',
        scope: { kind: 'checkpointedPull' },
        observedRevision: '7',
        adoptedRevision: '7',
        state: 'current',
        scanStartedAt: 1_723_247_200_000,
        nextRetryAt: null,
      },
      caller: {
        kind: 'plugin',
        pluginId: 'com.acme.github',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'automation_event_caller_generation_unavailable',
      error: 'automation_event_caller_generation_unavailable',
    });

    expect(execute).not.toHaveBeenCalled();
  });

  it('revalidates and forwards the stamped caller materialization without accepting target authority', async () => {
    const execute = vi.fn(async () => ({}));
    const revalidateCallerMaterialization = vi.fn(async () => true);
    const revalidateCallerImmutableGeneration = vi.fn(async () => true);
    const executor = createAutomationEventActionExecutor({
      credentials,
      transport: { execute },
      revalidateCallerMaterialization,
      revalidateCallerImmutableGeneration,
      resolveAdoptedDefinitionSet: () => createAvailableAdoptedDefinitionSet('7'),
    });

    await expect(executor({
      actionId: 'automation.event.source.status.report',
      input: {
        kind: 'catalogReconciliation',
        scope: { kind: 'checkpointedPull' },
        observedRevision: '7',
        adoptedRevision: '7',
        state: 'current',
        scanStartedAt: 1_723_247_200_000,
        nextRetryAt: null,
      },
      caller: {
        kind: 'plugin',
        pluginId: 'com.acme.github',
        contributionLocalId: 'repository-events',
        materialization: callerMaterialization,
        immutableGenerationId: 'github-immutable-generation-a',
      },
    })).resolves.toEqual({});

    expect(revalidateCallerMaterialization).toHaveBeenCalledWith(callerMaterialization);
    expect(revalidateCallerImmutableGeneration).toHaveBeenCalledWith({
      pluginId: 'com.acme.github',
      immutableGenerationId: 'github-immutable-generation-a',
    });
    expect(execute).toHaveBeenCalledWith(
      'automation.event.source.status.report',
      {
        v: 1,
        caller: {
          pluginId: 'com.acme.github',
          contributionLocalId: 'repository-events',
          materialization: callerMaterialization,
          immutableGenerationId: 'github-immutable-generation-a',
        },
        input: {
          kind: 'catalogReconciliation',
          scope: { kind: 'checkpointedPull' },
          observedRevision: '7',
          adoptedRevision: '7',
          state: 'current',
          scanStartedAt: 1_723_247_200_000,
          nextRetryAt: null,
        },
      },
    );
  });

  it('does not transport a status report when its exact caller generation retires during preparation', async () => {
    const execute = vi.fn(async () => ({}));
    const revalidateCallerMaterialization = vi.fn(async () => true);
    const revalidateCallerImmutableGeneration = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const executor = createAutomationEventActionExecutor({
      credentials,
      transport: { execute },
      revalidateCallerMaterialization,
      revalidateCallerImmutableGeneration,
      resolveAdoptedDefinitionSet: () => createAvailableAdoptedDefinitionSet('7'),
    });

    await expect(executor({
      actionId: 'automation.event.source.status.report',
      input: {
        kind: 'catalogReconciliation',
        scope: { kind: 'checkpointedPull' },
        observedRevision: '7',
        adoptedRevision: '7',
        state: 'current',
        scanStartedAt: 1_723_247_200_000,
        nextRetryAt: null,
      },
      caller: {
        kind: 'plugin',
        pluginId: 'com.acme.github',
        contributionLocalId: 'repository-events',
        materialization: callerMaterialization,
        immutableGenerationId: 'github-immutable-generation-a',
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'automation_event_caller_generation_unavailable',
      error: 'automation_event_caller_generation_unavailable',
    });

    expect(revalidateCallerMaterialization).toHaveBeenCalledTimes(2);
    expect(revalidateCallerImmutableGeneration).toHaveBeenCalledTimes(2);
    expect(revalidateCallerImmutableGeneration).toHaveBeenNthCalledWith(1, {
      pluginId: 'com.acme.github',
      immutableGenerationId: 'github-immutable-generation-a',
    });
    expect(revalidateCallerImmutableGeneration).toHaveBeenNthCalledWith(2, {
      pluginId: 'com.acme.github',
      immutableGenerationId: 'github-immutable-generation-a',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not forward the current Webhook invocation reference into the status caller frame', async () => {
    const execute = vi.fn(async () => ({}));
    const webhookInvocationReference = {
      v: 1,
      deliveryId: 'delivery-1',
      endpoint: {
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        revision: 3,
        webhookContribution: {
          pluginId: 'com.acme.github',
          localId: 'repository-events',
        },
        handlerActionLocalId: 'receive-repository-events',
        sourceInstanceId: 'repository-1',
      },
      target: {
        materialization: {
          machineId: 'machine-1',
          materializationId: 'materialization-1',
          pluginId: 'com.acme.github',
        },
        machineInstallationId: 'installation-1',
      },
      lease: { leaseId: 'wh_lease_AAECAwQFBgcICQoLDA0ODw', revision: 5 },
    } as const;
    const executor = createAutomationEventActionExecutor({
      credentials,
      transport: { execute },
      revalidateCallerMaterialization: async () => true,
      revalidateCallerImmutableGeneration: async () => true,
    });
    const input = {
      kind: 'catalogReconciliation' as const,
      scope: {
        kind: 'durablePush' as const,
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
      },
      observedRevision: '7',
      adoptedRevision: null,
      state: 'reconciling' as const,
      scanStartedAt: 1_723_247_200_000,
      nextRetryAt: null,
    };

    const { lease, ...referenceWithoutLease } = webhookInvocationReference;
    await runWithPluginWebhookInvocationReferenceV1({
      referenceWithoutLease,
      readLease: () => lease,
      signal: new AbortController().signal,
    }, async () => {
      await expect(executor({
        actionId: 'automation.event.source.status.report',
        input,
        caller: {
          kind: 'plugin',
          pluginId: 'com.acme.github',
          contributionLocalId: 'repository-events',
          materialization: callerMaterialization,
          immutableGenerationId: 'github-immutable-generation-a',
        },
      })).resolves.toEqual({});
    });

    expect(execute).toHaveBeenCalledWith(
      'automation.event.source.status.report',
      {
        v: 1,
        caller: {
          pluginId: 'com.acme.github',
          contributionLocalId: 'repository-events',
          materialization: callerMaterialization,
          immutableGenerationId: 'github-immutable-generation-a',
        },
        input,
      },
    );
  });

  it('does not let catalog status claim current before the caller has adopted that exact revision', async () => {
    const execute = vi.fn(async () => ({}));
    const executor = createAutomationEventActionExecutor({
      credentials,
      transport: { execute },
      revalidateCallerMaterialization: async () => true,
      revalidateCallerImmutableGeneration: async () => true,
      resolveAdoptedDefinitionSet: () => createAvailableAdoptedDefinitionSet('6'),
    });

    await expect(executor({
      actionId: 'automation.event.source.status.report',
      input: {
        kind: 'catalogReconciliation',
        scope: { kind: 'checkpointedPull' },
        observedRevision: '7',
        adoptedRevision: '7',
        state: 'current',
        scanStartedAt: 1_723_247_200_000,
        nextRetryAt: null,
      },
      caller: {
        kind: 'plugin',
        pluginId: 'com.acme.github',
        materialization: callerMaterialization,
        immutableGenerationId: 'github-immutable-generation-a',
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'automation_event_adopted_definitions_unavailable',
      error: 'automation_event_adopted_definitions_unavailable',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('serves source pages only from the current adopted public projection instead of the server transport', async () => {
    const execute = vi.fn();
    const revalidateCallerMaterialization = vi.fn(async () => true);
    const listPublicProjection = vi.fn(async () => ({
      kind: 'page' as const,
      revision: '7',
      definitions: [{
        automationId: 'automation-1',
        templateVersion: 3,
        eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
        sourceInstanceId: 'repository-1',
        sourceSelectorId,
        sourceContractVersion: 1,
        sourceConfig: { repositoryId: 42 },
        observationTransport: {
          kind: 'checkpointedPull' as const,
          watcherMaterializationRef: callerMaterialization,
        },
        filter: null,
        maximumObservationAgeMs: null,
      }],
      nextCursor: null,
    }));
    const adoptedSet: AutomationEventPublicProjectionOwner = {
      refresh: async () => ({ kind: 'adopted', revision: '7' }),
      readPublicProjection: () => ({
        kind: 'available',
        revision: '7',
        definitions: [],
      }),
      listPublicProjection,
      prepareAdmission: async () => null,
    };
    const resolveAdoptedDefinitionSet = vi.fn(() => adoptedSet);
    const executorParams: AutomationEventActionExecutorWithAdoptedSet = {
      credentials,
      transport: { execute },
      revalidateCallerMaterialization,
      resolveAccountId: async () => 'account-1',
      resolveAdoptedDefinitionSet,
    };
    const executor = createAutomationEventActionExecutor(executorParams);
    const input = { transport: { kind: 'checkpointedPull' as const }, pageSize: 50 };

    await expect(executor({
      actionId: 'automation.event.sources.list',
      input,
      caller: {
        kind: 'plugin',
        pluginId: 'com.acme.github',
        materialization: callerMaterialization,
      },
    })).resolves.toMatchObject({
      kind: 'page',
      revision: '7',
      definitions: [{ automationId: 'automation-1' }],
    });
    expect(resolveAdoptedDefinitionSet).toHaveBeenCalledWith(
      callerMaterialization,
      { kind: 'checkpointedPull' },
    );
    expect(listPublicProjection).toHaveBeenCalledWith({
      accountId: 'account-1',
      input,
      signal: expect.any(AbortSignal),
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires the host-held current webhook invocation before an Event producer can list durable sources', async () => {
    const listPublicProjection = vi.fn(async () => ({
      kind: 'page' as const,
      revision: '7',
      definitions: [],
      nextCursor: null,
    }));
    const adoptedSet: AutomationEventPublicProjectionOwner = {
      refresh: async () => ({ kind: 'adopted', revision: '7' }),
      readPublicProjection: () => ({ kind: 'available', revision: '7', definitions: [] }),
      listPublicProjection,
      prepareAdmission: async () => null,
    };
    const executor = createAutomationEventActionExecutor({
      credentials,
      revalidateCallerMaterialization: async () => true,
      resolveAccountId: async () => 'account-1',
      resolveAdoptedDefinitionSet: () => adoptedSet,
    });
    const input = { transport: { kind: 'durablePush' as const }, pageSize: 50 };
    const webhookInvocationReference = {
      v: 1,
      deliveryId: 'delivery-1',
      endpoint: {
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        revision: 3,
        webhookContribution: { pluginId: 'com.acme.github', localId: 'repository-events' },
        handlerActionLocalId: 'receive-repository-events',
        sourceInstanceId: 'repository-routing-source',
      },
      target: {
        materialization: callerMaterialization,
        machineInstallationId: 'installation-caller',
      },
      lease: { leaseId: 'wh_lease_AAECAwQFBgcICQoLDA0ODw', revision: 5 },
    } as const satisfies PluginWebhookInvocationReferenceV1;

    await expect(executor({
      actionId: 'automation.event.sources.list',
      input,
      caller: {
        kind: 'plugin',
        pluginId: 'com.acme.github',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'automation_event_adopted_definitions_unavailable',
      error: 'automation_event_adopted_definitions_unavailable',
    });
    expect(listPublicProjection).not.toHaveBeenCalled();

    const { lease, ...referenceWithoutLease } = webhookInvocationReference;
    await runWithPluginWebhookInvocationReferenceV1({
      referenceWithoutLease,
      readLease: () => lease,
      signal: new AbortController().signal,
    }, async () => {
      await expect(executor({
        actionId: 'automation.event.sources.list',
        input,
        caller: {
          kind: 'plugin',
          pluginId: 'com.acme.github',
          materialization: callerMaterialization,
        },
      })).resolves.toEqual({
        kind: 'page',
        revision: '7',
        definitions: [],
        nextCursor: null,
      });
    });

    expect(listPublicProjection).toHaveBeenCalledWith({
      accountId: 'account-1',
      input,
      webhookInvocationReference,
      signal: expect.any(AbortSignal),
    });
  });

  it('passes plain admission to a custom E2 transport as one strict mode-correct request', async () => {
    const execute = vi.fn(async () => ({
      results: [{ kind: 'admitted', runId: 'run-1', checkpointSafe: true }],
      continuation: readyAdmissionContinuation,
    }));
    const adoptedSet: AutomationEventPublicProjectionOwner = {
      refresh: async () => ({ kind: 'adopted', revision: '7' }),
      readPublicProjection: () => ({ kind: 'available', revision: '7', definitions: [] }),
      listPublicProjection: async () => ({ kind: 'unchanged', revision: '7' }),
      prepareAdmission: async (params) => oneShotAdmissionRequests([{
        v: 1,
        caller: params.caller,
        input: AutomationEventAdmitInputV1Schema.parse(params.input),
        hostEvidence: {
          v: 1,
          t: 'plain',
          accountCurrentness: { mode: 'plain', version: 10, contentKeyFingerprint: null },
        },
      }]),
    };
    const executorParams: AutomationEventActionExecutorWithAdoptedSet = {
      credentials,
      transport: { execute },
      revalidateCallerMaterialization: async () => true,
      resolveAccountId: async () => 'account-1',
      resolveAdoptedDefinitionSet: () => adoptedSet,
    };
    const executor = createAutomationEventActionExecutor(executorParams);
    const input = AutomationEventAdmitInputV1Schema.parse({
      eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
      occurrenceId: 'delivery-1',
      occurredAt: 1,
      observationReceivedAt: 2,
      payload: { action: 'opened' },
      definitions: [{
        automationId: 'automation-1',
        templateVersion: 3,
        sourceSelectorId,
      }],
    });

    await expect(executor({
      actionId: 'automation.event.admit',
      input,
      caller: {
        kind: 'plugin',
        pluginId: 'com.acme.github',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({
      results: [{ kind: 'admitted', runId: 'run-1', checkpointSafe: true }],
    });
    expect(execute).toHaveBeenCalledWith('automation.event.admit', {
      v: 1,
      caller: {
        pluginId: 'com.acme.github',
        materialization: callerMaterialization,
      },
      input,
      hostEvidence: {
        v: 1,
        t: 'plain',
        accountCurrentness: {
          mode: 'plain',
          version: 10,
          contentKeyFingerprint: null,
        },
      },
    });
  });

  it('forwards stripped E2EE admission from immutable adopted definitions through the strict server boundary', async () => {
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    });
    const encryptedCurrentness = {
      mode: 'e2ee' as const,
      version: 8,
      signingKeyFingerprint: 'aemk1_signing',
      contentKeyFingerprint:
        convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
          snapshot.contentPublicKeyFingerprint,
        ),
      updatedAt: 9,
    };
    const storedDefinition = {
      automationId: 'automation-1',
      templateVersion: 3,
      eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
      sourceSelectorId,
      sourceContractVersion: 1,
      observationTransport: {
        kind: 'checkpointedPull' as const,
        watcherMaterializationRef: callerMaterialization,
      },
      storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({
        mode: 'e2ee',
        material: snapshot.material,
        randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
        binding: {
          v: 1,
          automationId: 'automation-1',
          templateVersion: 3,
          triggerKind: 'pluginEvent',
          eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
          sourceSelectorId,
        },
        definition: {
          v: 1,
          sourceInstanceId: 'private-repository-source',
          sourceConfig: { credentialHandle: 'private-source-config' },
          displayLabel: 'Private repository',
          filter: null,
          maximumObservationAgeMs: null,
        },
      }),
      executionRecipe: (() => {
        const serialized = serializeAutomationRunExecutionRecipeV1({
          v: 1,
          templateVersion: 3,
          template: {
            t: 'encrypted',
            c: sealAccountScopedBlobCiphertext({
              kind: 'automation_template_payload',
              material: snapshot.material,
              payload: { v: 1, prompt: 'private template' },
              randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 3),
            }),
          },
          triggerEvidence: null,
          target: {
            kind: 'newSession',
            spawn: {
              executionTarget: { serverId: 'server-e2ee-admission', machineId: 'machine-caller' },
              directory: '/tmp/e2ee-admission',
              agentTarget: {
                kind: 'agent',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
              },
            },
          },
        });
        if (serialized.kind !== 'available') throw new Error('fixture recipe must be valid');
        return serialized.serialized;
      })(),
      payloadSchema: {
        type: 'object',
        properties: { action: { type: 'string' } },
        required: ['action'],
        additionalProperties: false,
      },
    };
    const adoptedSet = createAutomationEventAdoptedDefinitionSetHostV1({
      credentials,
      caller: callerMaterialization,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      readStoredDefinitions: async ({ input }) => input.knownRevision === '7'
        ? { kind: 'unchanged', revision: '7', eventDeclarationRelease }
        : {
          kind: 'page',
          revision: '7',
          eventDeclarationRelease,
          definitions: [storedDefinition],
          nextCursor: null,
        },
      resolveAccountEncryptionCurrentness: async () => encryptedCurrentness,
      resolveAccountEncryptionMaterial: async () => snapshot,
    });
    await expect(adoptedSet.refresh()).resolves.toEqual({ kind: 'adopted', revision: '7' });

    const publicProjection = adoptedSet.readPublicProjection();
    expect(publicProjection).toMatchObject({ kind: 'available', revision: '7' });
    if (publicProjection.kind !== 'available') return;
    const publicDefinition = publicProjection.definitions[0]!;
    // If the plugin-visible copy aliases the admission lookup, these changes
    // make the definition fail its exact Event/current-materialization checks.
    publicDefinition.eventRef = { pluginId: 'com.acme.github', localId: 'plugin-mutated-event' };
    publicDefinition.sourceInstanceId = 'plugin-mutated-source';
    publicDefinition.sourceConfig = { credentialHandle: 'plugin-mutated-config' };

    transportMocks.createPublisherHeader.mockResolvedValueOnce('publisher-proof');
    transportMocks.post.mockResolvedValueOnce({
      data: {
        results: [{ kind: 'rejoined', runId: 'run-1', checkpointSafe: true }],
        continuation: readyAdmissionContinuation,
      },
    });
    const executor = createAutomationEventActionExecutor({
      credentials,
      revalidateCallerMaterialization: async () => true,
      resolveAccountId: async () => 'account-1',
      resolveAdoptedDefinitionSet: () => adoptedSet,
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
    });
    const input = AutomationEventAdmitInputV1Schema.parse({
      eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
      occurrenceId: 'delivery-1',
      occurredAt: 1,
      observationReceivedAt: 2,
      payload: { action: 'opened' },
      definitions: [{
        automationId: 'automation-1',
        templateVersion: 3,
        sourceSelectorId,
      }],
    });

    await expect(executor({
      actionId: 'automation.event.admit',
      input,
      caller: {
        kind: 'plugin',
        pluginId: 'com.acme.github',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({
      results: [{ kind: 'rejoined', runId: 'run-1', checkpointSafe: true }],
    });

    const postedBody = transportMocks.post.mock.calls.at(-1)?.[1];
    expect(postedBody).not.toHaveProperty('input');
    const request = AutomationEventActionHttpRequestSchemasV1['automation.event.admit'].parse(
      postedBody,
    );
    expect(JSON.stringify(request)).not.toContain('"payload"');
    expect(JSON.stringify(request)).not.toContain('"occurrenceId"');
    expect(JSON.stringify(request)).not.toContain('private-repository-source');
    expect(JSON.stringify(request)).not.toContain('private-source-config');
    expect(JSON.stringify(request)).not.toContain('private-repository-source');
    expect(JSON.stringify(request)).not.toContain('private-source-config');

    expect(request.hostEvidence).toEqual({
      v: 1,
      t: 'encrypted',
      accountCurrentness: {
        mode: 'e2ee',
        version: 8,
        contentKeyFingerprint: encryptedCurrentness.contentKeyFingerprint,
      },
      adoptedRevision: '7',
      eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
      eventDeclarationRelease,
      definitions: [{
        automationId: 'automation-1',
        templateVersion: 3,
        sourceSelectorId,
        sourceContractVersion: 1,
        observationTransport: 'checkpointedPull',
        occurrenceKey: expect.any(String),
        occurredAt: 1,
        triggerEvidenceEnvelope: { t: 'encrypted', c: expect.any(String) },
        occurrenceEvidenceEqualityTag: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        outcome: {
          kind: 'matched',
          executionRecipe: expect.any(String),
        },
      }],
    });
    if (request.hostEvidence.t !== 'encrypted') return;
    expect(Object.keys(request.hostEvidence).sort()).toEqual([
      'accountCurrentness',
      'adoptedRevision',
      'definitions',
      'eventDeclarationRelease',
      'eventRef',
      't',
      'v',
    ]);
    expect(Object.keys(request.hostEvidence.definitions[0]!).sort()).toEqual([
      'automationId',
      'observationTransport',
      'occurredAt',
      'occurrenceEvidenceEqualityTag',
      'occurrenceKey',
      'outcome',
      'sourceContractVersion',
      'sourceSelectorId',
      'templateVersion',
      'triggerEvidenceEnvelope',
    ]);
    expect(isAutomationTriggerEvidenceCiphertextV1(
      request.hostEvidence.definitions[0]!.triggerEvidenceEnvelope.c,
    )).toBe(true);
    const recipe = parseAutomationRunExecutionRecipeV1(
      request.hostEvidence.definitions[0]!.outcome.kind === 'matched'
        ? request.hostEvidence.definitions[0]!.outcome.executionRecipe
        : null,
    );
    expect(recipe.kind).toBe('available');
    if (recipe.kind !== 'available' || recipe.recipe.triggerEvidence?.t !== 'encrypted') return;
    expect(isAutomationTriggerEvidenceCiphertextV1(recipe.recipe.triggerEvidence.c)).toBe(true);
  });

  it('passes a custom E2 transport the complete E3 E2EE body without raw plugin Event input', async () => {
    const occurrenceEvidence = buildAutomationPluginEventOccurrenceEvidenceV1({
      eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
      sourceSelectorId,
      occurrenceId: 'delivery-1',
      occurredAt: 1,
      payload: { action: 'opened' },
    });
    const encryptedTriggerEvidence = sealAccountScopedBlobCiphertext({
      kind: 'automation_trigger_evidence',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      payload: { v: 1 },
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
    });
    const encryptedHostEvidence = AutomationEventAdmitEncryptedHostEvidenceV1Schema.parse({
      v: 1,
      t: 'encrypted',
      accountCurrentness: {
        mode: 'e2ee',
        version: 8,
        contentKeyFingerprint: 'aemk1_content_key',
      },
      adoptedRevision: '7',
      eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
      eventDeclarationRelease,
      definitions: [{
        automationId: 'automation-1',
        templateVersion: 3,
        sourceSelectorId,
        sourceContractVersion: 1,
        observationTransport: 'checkpointedPull',
        occurrenceKey: deriveAutomationOccurrenceKeyV1(occurrenceEvidence),
        occurredAt: 1,
        triggerEvidenceEnvelope: { t: 'encrypted', c: encryptedTriggerEvidence },
        occurrenceEvidenceEqualityTag: 'A'.repeat(43),
        outcome: { kind: 'skipped', reason: 'filtered' },
      }],
    });
    const adoptedSet: AutomationEventPublicProjectionOwner = {
      refresh: async () => ({ kind: 'adopted', revision: '7' }),
      readPublicProjection: () => ({ kind: 'available', revision: '7', definitions: [] }),
      listPublicProjection: async () => ({ kind: 'unchanged', revision: '7' }),
      prepareAdmission: async (params) => oneShotAdmissionRequests([{
        v: 1,
        caller: params.caller,
        hostEvidence: encryptedHostEvidence,
      }]),
    };
    const execute = vi.fn(async (_actionId: string, _request: unknown) => ({
      results: [{ kind: 'skipped', reason: 'filtered', checkpointSafe: true }],
      continuation: readyAdmissionContinuation,
    }));
    const executor = createAutomationEventActionExecutor({
      credentials,
      transport: { execute },
      revalidateCallerMaterialization: async () => true,
      resolveAccountId: async () => 'account-1',
      resolveAdoptedDefinitionSet: () => adoptedSet,
    });

    await expect(executor({
      actionId: 'automation.event.admit',
      input: AutomationEventAdmitInputV1Schema.parse({
        eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
        occurrenceId: 'raw-occurrence-id',
        occurredAt: 1,
        observationReceivedAt: 2,
        payload: {
          privatePayloadSentinel: 'raw Event data must not cross the E2 transport boundary',
        },
        definitions: [{
          automationId: 'automation-1',
          templateVersion: 3,
          sourceSelectorId,
        }],
      }),
      caller: {
        kind: 'plugin',
        pluginId: 'com.acme.github',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({
      results: [{ kind: 'skipped', reason: 'filtered', checkpointSafe: true }],
    });

    const body = execute.mock.calls.at(-1)?.[1];
    expect(body).toEqual({
      v: 1,
      caller: {
        pluginId: 'com.acme.github',
        materialization: callerMaterialization,
      },
      hostEvidence: encryptedHostEvidence,
    });
    expect(body).not.toHaveProperty('input');
    expect(JSON.stringify(body)).not.toContain('raw Event data must not cross the E2 transport boundary');
    expect(JSON.stringify(body)).not.toContain('raw-occurrence-id');
  });

  it('sends one frozen ordered sequence of complete encrypted calls while retaining settled outcomes and marking only an unavailable tail checkpoint-unsafe', async () => {
    const webhookInvocationReference = {
      v: 1,
      deliveryId: 'delivery-segmented-1',
      endpoint: {
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        revision: 3,
        webhookContribution: {
          pluginId: 'com.acme.github',
          localId: 'repository-events',
        },
        handlerActionLocalId: 'receive-repository-events',
        sourceInstanceId: 'repository-1',
      },
      target: {
        materialization: callerMaterialization,
        machineInstallationId: 'installation-caller',
      },
      lease: { leaseId: 'wh_lease_AAECAwQFBgcICQoLDA0ODw', revision: 5 },
    } as const;
    const input = AutomationEventAdmitInputV1Schema.parse({
      eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
      occurrenceId: 'delivery-segmented-1',
      occurredAt: 1,
      observationReceivedAt: 2,
      payload: { action: 'opened' },
      definitions: ['automation-a', 'automation-b', 'automation-c', 'automation-d'].map((automationId) => ({
        automationId,
        templateVersion: 3,
        sourceSelectorId,
      })),
    });
    const occurrenceEvidence = buildAutomationPluginEventOccurrenceEvidenceV1({
      eventRef: input.eventRef,
      sourceSelectorId,
      occurrenceId: input.occurrenceId,
      occurredAt: input.occurredAt,
      payload: input.payload,
    });
    const triggerEvidence = sealAccountScopedBlobCiphertext({
      kind: 'automation_trigger_evidence',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
      payload: { v: 1 },
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
    });
    const evidenceFor = (automationId: string, outcome: 'matched' | 'skipped') => ({
      automationId,
      templateVersion: 3,
      sourceSelectorId,
      sourceContractVersion: 1,
      observationTransport: 'durablePush' as const,
      occurrenceKey: deriveAutomationOccurrenceKeyV1(occurrenceEvidence),
      occurredAt: 1,
      triggerEvidenceEnvelope: { t: 'encrypted' as const, c: triggerEvidence },
      occurrenceEvidenceEqualityTag: 'A'.repeat(43),
      outcome: outcome === 'matched'
        ? { kind: 'matched' as const, executionRecipe: '{"v":1}' }
        : { kind: 'skipped' as const, reason: 'filtered' as const },
    });
    const hostEvidenceFor = (definitions: readonly typeof input.definitions[number][]) =>
      AutomationEventAdmitEncryptedHostEvidenceV1Schema.parse({
        v: 1,
        t: 'encrypted',
        accountCurrentness: {
          mode: 'e2ee',
          version: 8,
          contentKeyFingerprint: 'aemk1_content_key',
        },
        adoptedRevision: '7',
        eventRef: input.eventRef,
        eventDeclarationRelease,
        webhookInvocationReference,
        definitions: definitions.map((definition) =>
          evidenceFor(
            definition.automationId,
            definition.automationId === 'automation-b' ? 'skipped' : 'matched',
          ),
        ),
      });
    const preparedCalls = [
      {
        v: 1 as const,
        caller: { pluginId: 'com.acme.github', materialization: callerMaterialization },
        hostEvidence: hostEvidenceFor(input.definitions.slice(0, 2)),
      },
      {
        v: 1 as const,
        caller: { pluginId: 'com.acme.github', materialization: callerMaterialization },
        hostEvidence: hostEvidenceFor(input.definitions.slice(2)),
      },
    ] as const;
    const prepareAdmission = vi.fn<AutomationEventPublicProjectionOwner['prepareAdmission']>(
      async () => oneShotAdmissionRequests(preparedCalls),
    );
    const adoptedSet: AutomationEventPublicProjectionOwner = {
      refresh: async () => ({ kind: 'adopted', revision: '7' }),
      readPublicProjection: () => ({ kind: 'available', revision: '7', definitions: [] }),
      listPublicProjection: async () => ({ kind: 'unchanged', revision: '7' }),
      prepareAdmission,
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({
        results: [
          { kind: 'rejoined', runId: 'run-a', checkpointSafe: true },
          { kind: 'skipped', reason: 'filtered', checkpointSafe: true },
        ],
        continuation: readyAdmissionContinuation,
      })
      .mockRejectedValueOnce(new Error('transport unavailable'));
    const revalidateCallerMaterialization = vi.fn(async () => true);
    const executor = createAutomationEventActionExecutor({
      credentials,
      transport: { execute },
      revalidateCallerMaterialization,
      resolveAccountId: async () => 'account-1',
      resolveAdoptedDefinitionSet: () => adoptedSet,
    });
    const { lease, ...referenceWithoutLease } = webhookInvocationReference;

    await runWithPluginWebhookInvocationReferenceV1({
      referenceWithoutLease,
      readLease: () => lease,
      signal: new AbortController().signal,
    }, async () => {
      await expect(executor({
        actionId: 'automation.event.admit',
        input,
        caller: {
          kind: 'plugin',
          pluginId: 'com.acme.github',
          materialization: callerMaterialization,
        },
      })).resolves.toEqual({
        results: [
          { kind: 'rejoined', runId: 'run-a', checkpointSafe: true },
          { kind: 'skipped', reason: 'filtered', checkpointSafe: true },
          { kind: 'blocked', reason: 'temporarilyUnavailable', checkpointSafe: false },
          { kind: 'blocked', reason: 'temporarilyUnavailable', checkpointSafe: false },
        ],
      });
      expect(readCurrentPluginWebhookAutomationAdmissionUnresolvedV1()).toEqual({
        v: 1,
        kind: 'automationAdmissionUnresolved',
        totalCount: 2,
        entries: [
          { automationId: 'automation-c', status: { kind: 'blocked', reason: 'temporarilyUnavailable' } },
          { automationId: 'automation-d', status: { kind: 'blocked', reason: 'temporarilyUnavailable' } },
        ],
        omittedCount: 0,
      });
    });
    expect(prepareAdmission).toHaveBeenCalledTimes(1);
    expect(prepareAdmission).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'account-1',
      caller: { pluginId: 'com.acme.github', materialization: callerMaterialization },
      input,
    }));
    expect(prepareAdmission.mock.calls[0]?.[0]).not.toHaveProperty('startDefinitionIndex');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]?.[1]).toEqual(preparedCalls[0]);
    expect(execute.mock.calls[1]?.[1]).toEqual(preparedCalls[1]);
    expect(execute.mock.calls[0]?.[1]).not.toHaveProperty('input');
    expect(execute.mock.calls[1]?.[1]).not.toHaveProperty('input');
    // Initial admission and every independently committed call revalidate
    // the exact stamped caller; no later call can inherit earlier authority.
    expect(revalidateCallerMaterialization).toHaveBeenCalledTimes(3);
  });

  it('preserves settled calls and blocks only the unsent tail when the stamped caller retires between requests', async () => {
    const input = AutomationEventAdmitInputV1Schema.parse({
      eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
      occurrenceId: 'delivery-retired-between-calls',
      occurredAt: 1,
      observationReceivedAt: 2,
      payload: { action: 'opened' },
      definitions: [
        { automationId: 'automation-a', templateVersion: 3, sourceSelectorId },
        { automationId: 'automation-b', templateVersion: 3, sourceSelectorId: secondSourceSelectorId },
      ],
    });
    const hostEvidence = {
      v: 1 as const,
      t: 'plain' as const,
      accountCurrentness: { mode: 'plain' as const, version: 10, contentKeyFingerprint: null },
    };
    const adoptedSet: AutomationEventPublicProjectionOwner = {
      refresh: async () => ({ kind: 'adopted', revision: '7' }),
      readPublicProjection: () => ({ kind: 'available', revision: '7', definitions: [] }),
      listPublicProjection: async () => ({ kind: 'unchanged', revision: '7' }),
      prepareAdmission: async (params) => oneShotAdmissionRequests(
        AutomationEventAdmitInputV1Schema.parse(params.input).definitions.map((definition) => ({
          v: 1,
          caller: params.caller,
          input: { ...input, definitions: [definition] },
          hostEvidence,
        })),
      ),
    };
    const execute = vi.fn(async () => ({
      results: [{ kind: 'admitted', runId: 'run-a', checkpointSafe: true }],
      continuation: readyAdmissionContinuation,
    }));
    const revalidateCallerMaterialization = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const executor = createAutomationEventActionExecutor({
      credentials,
      transport: { execute },
      revalidateCallerMaterialization,
      resolveAccountId: async () => 'account-1',
      resolveAdoptedDefinitionSet: () => adoptedSet,
    });

    await expect(executor({
      actionId: 'automation.event.admit',
      input,
      caller: {
        kind: 'plugin',
        pluginId: 'com.acme.github',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({
      results: [
        { kind: 'admitted', runId: 'run-a', checkpointSafe: true },
        { kind: 'blocked', reason: 'temporarilyUnavailable', checkpointSafe: false },
      ],
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(revalidateCallerMaterialization).toHaveBeenCalledTimes(3);
  });

  it('preserves a settled prefix and records every remaining position when a composed admission signal aborts during the next request', async () => {
    const webhookInvocationReference = {
      v: 1,
      deliveryId: 'delivery-aborted-between-calls',
      endpoint: {
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        revision: 3,
        webhookContribution: {
          pluginId: 'com.acme.github',
          localId: 'repository-events',
        },
        handlerActionLocalId: 'receive-repository-events',
        sourceInstanceId: 'repository-1',
      },
      target: {
        materialization: callerMaterialization,
        machineInstallationId: 'installation-caller',
      },
      lease: { leaseId: 'wh_lease_AAECAwQFBgcICQoLDA0ODw', revision: 5 },
    } as const;
    const input = AutomationEventAdmitInputV1Schema.parse({
      eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
      occurrenceId: 'delivery-aborted-between-calls',
      occurredAt: 1,
      observationReceivedAt: 2,
      payload: { action: 'opened' },
      definitions: ['automation-a', 'automation-b', 'automation-c'].map((automationId) => ({
        automationId,
        templateVersion: 3,
        sourceSelectorId,
      })),
    });
    const hostEvidence = {
      v: 1 as const,
      t: 'plain' as const,
      accountCurrentness: { mode: 'plain' as const, version: 10, contentKeyFingerprint: null },
      webhookInvocationReference,
    };
    const adoptedSet: AutomationEventPublicProjectionOwner = {
      refresh: async () => ({ kind: 'adopted', revision: '7' }),
      readPublicProjection: () => ({ kind: 'available', revision: '7', definitions: [] }),
      listPublicProjection: async () => ({ kind: 'unchanged', revision: '7' }),
      prepareAdmission: async (params) => oneShotAdmissionRequests(
        input.definitions.map((definition) => ({
          v: 1,
          caller: params.caller,
          input: { ...input, definitions: [definition] },
          hostEvidence,
        })),
      ),
    };
    const callerCancellation = new AbortController();
    const cancellation = new Error('admission cancelled');
    const execute = vi.fn(async (
      _actionId: unknown,
      _request: unknown,
      transportSignal?: AbortSignal,
    ) => {
      if (execute.mock.calls.length === 1) {
        return {
          results: [{ kind: 'admitted', runId: 'run-a', checkpointSafe: true }],
          continuation: readyAdmissionContinuation,
        };
      }
      callerCancellation.abort(cancellation);
      transportSignal?.throwIfAborted();
      return {
        results: [{ kind: 'admitted', runId: 'unreachable', checkpointSafe: true }],
        continuation: readyAdmissionContinuation,
      };
    });
    const executor = createAutomationEventActionExecutor({
      credentials,
      transport: { execute },
      revalidateCallerMaterialization: async () => true,
      resolveAccountId: async () => 'account-1',
      resolveAdoptedDefinitionSet: () => adoptedSet,
    });
    const webhookCancellation = new AbortController();
    const { lease, ...referenceWithoutLease } = webhookInvocationReference;

    await runWithPluginWebhookInvocationReferenceV1({
      referenceWithoutLease,
      readLease: () => lease,
      signal: webhookCancellation.signal,
    }, async () => {
      await expect(executor({
        actionId: 'automation.event.admit',
        input,
        caller: {
          kind: 'plugin',
          pluginId: 'com.acme.github',
          materialization: callerMaterialization,
        },
        signal: callerCancellation.signal,
      })).resolves.toEqual({
        results: [
          { kind: 'admitted', runId: 'run-a', checkpointSafe: true },
          { kind: 'blocked', reason: 'temporarilyUnavailable', checkpointSafe: false },
          { kind: 'blocked', reason: 'temporarilyUnavailable', checkpointSafe: false },
        ],
      });
      expect(readCurrentPluginWebhookAutomationAdmissionUnresolvedV1()).toEqual({
        v: 1,
        kind: 'automationAdmissionUnresolved',
        totalCount: 2,
        entries: [
          { automationId: 'automation-b', status: { kind: 'blocked', reason: 'temporarilyUnavailable' } },
          { automationId: 'automation-c', status: { kind: 'blocked', reason: 'temporarilyUnavailable' } },
        ],
        omittedCount: 0,
      });
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[2]?.aborted).toBe(true);
    expect(execute.mock.calls.map(([, request]) => (
      (request as { input: { definitions: readonly { automationId: string }[] } })
        .input.definitions[0]?.automationId
    ))).toEqual(['automation-a', 'automation-b']);
    expect(readCurrentPluginWebhookAutomationAdmissionUnresolvedV1()).toBeNull();
  });

  it('composes durable-push admission evidence only from the active matching Webhook invocation', async () => {
    const execute = vi.fn(async () => ({
      results: [{ kind: 'admitted', runId: 'run-1', checkpointSafe: true }],
      continuation: readyAdmissionContinuation,
    }));
    const webhookInvocationReference = {
      v: 1,
      deliveryId: 'delivery-1',
      endpoint: {
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        revision: 3,
        webhookContribution: {
          pluginId: 'com.acme.github',
          localId: 'repository-events',
        },
        handlerActionLocalId: 'receive-repository-events',
        sourceInstanceId: 'repository-1',
      },
      target: {
        materialization: callerMaterialization,
        machineInstallationId: 'installation-caller',
      },
      lease: { leaseId: 'wh_lease_AAECAwQFBgcICQoLDA0ODw', revision: 5 },
    } as const;
    const input = AutomationEventAdmitInputV1Schema.parse({
      eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
      occurrenceId: 'delivery-1',
      occurredAt: 1,
      observationReceivedAt: 2,
      payload: { action: 'opened' },
      definitions: [{
        automationId: 'automation-1',
        templateVersion: 3,
        sourceSelectorId,
      }],
    });
    const adoptedSet: AutomationEventPublicProjectionOwner = {
      refresh: async () => ({ kind: 'adopted', revision: '7' }),
      readPublicProjection: () => ({ kind: 'available', revision: '7', definitions: [] }),
      listPublicProjection: async () => ({ kind: 'unchanged', revision: '7' }),
      prepareAdmission: async (params) => oneShotAdmissionRequests([{
        v: 1,
        caller: params.caller,
        input: AutomationEventAdmitInputV1Schema.parse(params.input),
        hostEvidence: {
          v: 1,
          t: 'plain',
          accountCurrentness: { mode: 'plain', version: 10, contentKeyFingerprint: null },
          webhookInvocationReference,
        },
      }]),
    };
    const executor = createAutomationEventActionExecutor({
      credentials,
      transport: { execute },
      revalidateCallerMaterialization: async () => true,
      resolveAccountId: async () => 'account-1',
      resolveAdoptedDefinitionSet: (_caller, transport) => (
        transport.kind === 'durablePush' ? adoptedSet : null
      ),
    });
    const { lease, ...referenceWithoutLease } = webhookInvocationReference;

    await runWithPluginWebhookInvocationReferenceV1({
      referenceWithoutLease,
      readLease: () => lease,
      signal: new AbortController().signal,
    }, async () => {
      await expect(executor({
        actionId: 'automation.event.admit',
        input,
        caller: {
          kind: 'plugin',
          pluginId: 'com.acme.github',
          materialization: callerMaterialization,
        },
      })).resolves.toEqual({
        results: [{ kind: 'admitted', runId: 'run-1', checkpointSafe: true }],
      });
    });

    expect(execute).toHaveBeenCalledWith(
      'automation.event.admit',
      {
        v: 1,
        caller: {
          pluginId: 'com.acme.github',
          materialization: callerMaterialization,
        },
        input,
        hostEvidence: expect.objectContaining({
          webhookInvocationReference,
        }),
      },
      expect.any(AbortSignal),
    );

    execute.mockClear();
    const cancelledInvocation = new AbortController();
    cancelledInvocation.abort();
    await runWithPluginWebhookInvocationReferenceV1({
      referenceWithoutLease,
      readLease: () => lease,
      signal: cancelledInvocation.signal,
    }, async () => {
      await expect(executor({
        actionId: 'automation.event.admit',
        input,
        caller: {
          kind: 'plugin',
          pluginId: 'com.acme.github',
          materialization: callerMaterialization,
        },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'automation_event_host_evidence_unavailable',
      error: 'automation_event_host_evidence_unavailable',
    });
    });
    expect(execute).not.toHaveBeenCalled();

    await expect(executor({
      actionId: 'automation.event.admit',
      input,
      caller: {
        kind: 'plugin',
        pluginId: 'com.acme.github',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'automation_event_adopted_definitions_unavailable',
      error: 'automation_event_adopted_definitions_unavailable',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('collects every canonical unresolved admission result across strict in-band failed batches', async () => {
    const execute = vi.fn();
    const webhookInvocationReference = {
      v: 1,
      deliveryId: 'delivery-1',
      endpoint: {
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        revision: 3,
        webhookContribution: {
          pluginId: 'com.acme.github',
          localId: 'repository-events',
        },
        handlerActionLocalId: 'receive-repository-events',
        sourceInstanceId: 'repository-1',
      },
      target: {
        materialization: callerMaterialization,
        machineInstallationId: 'installation-caller',
      },
      lease: { leaseId: 'wh_lease_AAECAwQFBgcICQoLDA0ODw', revision: 5 },
    } as const;
    const admitInput = (automationIds: readonly string[]) => AutomationEventAdmitInputV1Schema.parse({
      eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
      occurrenceId: 'delivery-1',
      occurredAt: 1,
      observationReceivedAt: 2,
      payload: { action: 'opened' },
      definitions: automationIds.map((automationId) => ({
        automationId,
        templateVersion: 3,
        sourceSelectorId,
      })),
    });
    const firstBatch = admitInput(['automation-b', 'automation-safe']);
    const secondBatch = admitInput(['automation-a']);
    const adoptedSet: AutomationEventPublicProjectionOwner = {
      refresh: async () => ({ kind: 'adopted', revision: '7' }),
      readPublicProjection: () => ({ kind: 'available', revision: '7', definitions: [] }),
      listPublicProjection: async () => ({ kind: 'unchanged', revision: '7' }),
      prepareAdmission: async (params) => oneShotAdmissionRequests([{
        v: 1,
        caller: params.caller,
        input: AutomationEventAdmitInputV1Schema.parse(params.input),
        hostEvidence: {
          v: 1,
          t: 'plain',
          accountCurrentness: { mode: 'plain', version: 10, contentKeyFingerprint: null },
          webhookInvocationReference,
        },
      }]),
    };
    const executor = createAutomationEventActionExecutor({
      credentials,
      transport: { execute },
      revalidateCallerMaterialization: async () => true,
      resolveAccountId: async () => 'account-1',
      resolveAdoptedDefinitionSet: () => adoptedSet,
    });
    const executeAdmission = async (input: typeof firstBatch) => await executor({
      actionId: 'automation.event.admit',
      input,
      caller: {
        kind: 'plugin',
        pluginId: 'com.acme.github',
        materialization: callerMaterialization,
      },
    });
    const { lease, ...referenceWithoutLease } = webhookInvocationReference;

    execute
      .mockResolvedValueOnce({
        results: [
          { kind: 'blocked', reason: 'capacity', checkpointSafe: false },
          { kind: 'admitted', runId: 'run-safe', checkpointSafe: true },
        ],
        continuation: readyAdmissionContinuation,
      })
      .mockResolvedValueOnce({
        results: [{
          kind: 'refreshDefinition',
          reason: 'observationTargetChanged',
          checkpointSafe: false,
        }],
        continuation: readyAdmissionContinuation,
      });

    await runWithPluginWebhookInvocationReferenceV1({
      referenceWithoutLease,
      readLease: () => lease,
      signal: new AbortController().signal,
    }, async () => {
      await expect(executeAdmission(firstBatch)).resolves.toEqual({
        results: [
          { kind: 'blocked', reason: 'capacity', checkpointSafe: false },
          { kind: 'admitted', runId: 'run-safe', checkpointSafe: true },
        ],
      });
      await expect(executeAdmission(secondBatch)).resolves.toEqual({
        results: [{
          kind: 'refreshDefinition',
          reason: 'observationTargetChanged',
          checkpointSafe: false,
        }],
      });
      expect(readCurrentPluginWebhookAutomationAdmissionUnresolvedV1()).toEqual({
        v: 1,
        kind: 'automationAdmissionUnresolved',
        totalCount: 2,
        entries: [
          {
            automationId: 'automation-a',
            status: { kind: 'refreshDefinition', reason: 'observationTargetChanged' },
          },
          {
            automationId: 'automation-b',
            status: { kind: 'blocked', reason: 'capacity' },
          },
        ],
        omittedCount: 0,
      });
    });
    expect(readCurrentPluginWebhookAutomationAdmissionUnresolvedV1()).toBeNull();

    execute.mockReset();
    execute
      .mockResolvedValueOnce({
        results: [
          { kind: 'blocked', reason: 'capacity', checkpointSafe: false },
          { kind: 'admitted', runId: 'run-safe', checkpointSafe: true },
        ],
        continuation: readyAdmissionContinuation,
      })
      .mockRejectedValueOnce(new Error('admission unavailable'));

    await runWithPluginWebhookInvocationReferenceV1({
      referenceWithoutLease,
      readLease: () => lease,
      signal: new AbortController().signal,
    }, async () => {
      await expect(executeAdmission(firstBatch)).resolves.toEqual({
        results: [
          { kind: 'blocked', reason: 'capacity', checkpointSafe: false },
          { kind: 'admitted', runId: 'run-safe', checkpointSafe: true },
        ],
      });
      await expect(executeAdmission(secondBatch)).resolves.toEqual({
        results: [{
          kind: 'blocked',
          reason: 'temporarilyUnavailable',
          checkpointSafe: false,
        }],
      });
      expect(readCurrentPluginWebhookAutomationAdmissionUnresolvedV1()).toEqual({
        v: 1,
        kind: 'automationAdmissionUnresolved',
        totalCount: 2,
        entries: [
          {
            automationId: 'automation-a',
            status: { kind: 'blocked', reason: 'temporarilyUnavailable' },
          },
          {
            automationId: 'automation-b',
            status: { kind: 'blocked', reason: 'capacity' },
          },
        ],
        omittedCount: 0,
      });
    });
  });

  it('fails closed before transport when the stamped caller materialization is absent or stale', async () => {
    const execute = vi.fn();
    const executor = createAutomationEventActionExecutor({
      credentials,
      transport: { execute },
      revalidateCallerMaterialization: async () => false,
      revalidateCallerImmutableGeneration: async () => true,
    });

    await expect(executor({
      actionId: 'automation.event.source.status.report',
      input: {
        kind: 'catalogReconciliation',
        scope: { kind: 'checkpointedPull' },
        observedRevision: '7',
        adoptedRevision: '7',
        state: 'current',
        scanStartedAt: 1_723_247_200_000,
        nextRetryAt: null,
      },
      caller: {
        kind: 'plugin',
        pluginId: 'com.acme.github',
        materialization: callerMaterialization,
        immutableGenerationId: 'github-immutable-generation-a',
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'automation_event_caller_materialization_unavailable',
      error: 'automation_event_caller_materialization_unavailable',
    });
    expect(execute).not.toHaveBeenCalled();

    await expect(executor({
      actionId: 'automation.event.source.status.report',
      input: {
        kind: 'catalogReconciliation',
        scope: { kind: 'checkpointedPull' },
        observedRevision: '7',
        adoptedRevision: '7',
        state: 'current',
        scanStartedAt: 1_723_247_200_000,
        nextRetryAt: null,
      },
      caller: { kind: 'plugin', pluginId: 'com.acme.github' },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'automation_event_caller_materialization_unavailable',
    });
  });

  it('fails closed before transport when the resolved runtime has no currentness owner', async () => {
    const execute = vi.fn();
    const executor = createAutomationEventActionExecutor({
      credentials,
      transport: { execute },
    });

    await expect(executor({
      actionId: 'automation.event.source.status.report',
      input: {
        kind: 'catalogReconciliation',
        scope: { kind: 'checkpointedPull' },
        observedRevision: '7',
        adoptedRevision: '7',
        state: 'current',
        scanStartedAt: 1_723_247_200_000,
        nextRetryAt: null,
      },
      caller: {
        kind: 'plugin',
        pluginId: 'com.acme.github',
        materialization: callerMaterialization,
      },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'automation_event_caller_materialization_unavailable',
      error: 'automation_event_caller_materialization_unavailable',
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
