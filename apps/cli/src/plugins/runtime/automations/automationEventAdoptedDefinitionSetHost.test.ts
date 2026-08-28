import { describe, expect, it, vi } from 'vitest';
import {
  AutomationEventStoredDefinitionsReadResultV1Schema,
  AutomationSourceSelectorIdV1Schema,
  AutomationTriggerIdSchema,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  createAccountScopedCryptoMaterialSnapshotV1,
  sealAutomationTriggerDefinitionStoredEnvelopeV1,
  type AccountEncryptionCurrentnessResponse,
  type AutomationEventStoredDefinitionProjectionV1,
  type AutomationEventDeclarationReleaseV1,
  type AutomationEventStoredDefinitionsReadResultV1,
  type AutomationEventAdmitHttpRequestV1,
  type PluginMachineMaterializationRefV1,
  type PluginWebhookInvocationReferenceV1,
  MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_CALL,
  MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES,
  readAutomationEventAdmitHttpRequestCanonicalUtf8ByteLengthV1,
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
  createAutomationEventAdoptedDefinitionSetHostV1,
  createAutomationEventStoredDefinitionsHttpTransportV1,
} from './automationEventAdoptedDefinitionSetHost';

const credentials = {
  token: 'token_test',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
};
const caller = {
  pluginId: 'com.acme.github',
  machineId: 'machine-current',
  materializationId: 'materialization-current',
} as const satisfies PluginMachineMaterializationRefV1;
const immutableGenerationId = 'github-generation-current';
const actionCaller = {
  pluginId: caller.pluginId,
  immutableGenerationId,
  materialization: caller,
} as const;
const triggerId = AutomationTriggerIdSchema.parse('trigger-repository-event');
const triggerRevision = 4;
const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(
  '9d5af559-2c82-4c22-b6a0-ecabce38a631',
);
const secondSourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(
  '8a1e713b-3d8c-44ae-8599-6b0346535f3a',
);
const eventDeclarationRelease = {
  release: { pluginId: caller.pluginId, version: '1.0.0' },
  archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
} as const satisfies AutomationEventDeclarationReleaseV1;
const durableScopeCurrent = 'a'.repeat(43);
const durableScopeMoved = 'b'.repeat(43);
const durableWebhookInvocationReference = {
  v: 1,
  deliveryId: 'delivery-1',
  endpoint: {
    webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
    revision: 3,
    webhookContribution: { pluginId: caller.pluginId, localId: 'repository-events' },
    handlerActionLocalId: 'receive-repository-events',
    sourceInstanceId: 'endpoint-routing-source',
  },
  target: {
    materialization: caller,
    machineInstallationId: 'installation-current',
  },
  lease: { leaseId: 'wh_lease_AAECAwQFBgcICQoLDA0ODw', revision: 5 },
} as const satisfies PluginWebhookInvocationReferenceV1;

function storedDefinition(options: Readonly<{
  automationId?: string;
  triggerId?: typeof triggerId;
  triggerRevision?: number;
  sourceSelectorId?: typeof sourceSelectorId;
}> = {}): AutomationEventStoredDefinitionProjectionV1 {
  const automationId = options.automationId ?? 'automation-1';
  const selectedTriggerId = options.triggerId ?? triggerId;
  const selectedTriggerRevision = options.triggerRevision ?? triggerRevision;
  const selectedSourceSelectorId = options.sourceSelectorId ?? sourceSelectorId;
  return {
    automationId,
    triggerId: selectedTriggerId,
    triggerRevision: selectedTriggerRevision,
    eventRef: { pluginId: caller.pluginId, localId: 'repository-event' },
    sourceSelectorId: selectedSourceSelectorId,
    sourceContractVersion: 1,
    observationTransport: {
      kind: 'checkpointedPull' as const,
      watcherMaterializationRef: caller,
    },
    payloadSchema: { type: 'object' },
    storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({
      mode: 'plain',
      binding: {
        v: 1,
        automationId,
        triggerId: selectedTriggerId,
        triggerRevision: selectedTriggerRevision,
        triggerKind: 'pluginEvent',
        eventRef: { pluginId: caller.pluginId, localId: 'repository-event' },
        sourceSelectorId: selectedSourceSelectorId,
      },
      definition: {
        v: 1,
        sourceInstanceId: 'repository-1',
        sourceConfig: { repositoryId: 42 },
        displayLabel: 'Repository 42',
        filter: null,
        maximumObservationAgeMs: null,
      },
    }),
  };
}

function durablePushStoredDefinition(options: Readonly<{
  automationId?: string;
  sourceSelectorId?: typeof sourceSelectorId;
}> = {}): AutomationEventStoredDefinitionProjectionV1 {
  const automationId = options.automationId ?? 'automation-1';
  const selectedSourceSelectorId = options.sourceSelectorId ?? sourceSelectorId;
  return {
    ...storedDefinition(),
    automationId,
    sourceSelectorId: selectedSourceSelectorId,
    observationTransport: {
      kind: 'durablePush',
      webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
      endpointMaterializationRef: caller,
      observationStartsAt: 1,
    },
    storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({
      mode: 'plain',
      binding: {
        v: 1,
        automationId,
        triggerId,
        triggerRevision,
        triggerKind: 'pluginEvent',
        eventRef: { pluginId: caller.pluginId, localId: 'repository-event' },
        sourceSelectorId: selectedSourceSelectorId,
      },
      definition: {
        v: 1,
        sourceInstanceId: 'repository-private-source',
        webhookRoutingSourceInstanceId: 'endpoint-routing-source',
        sourceConfig: { repositoryId: 42 },
        displayLabel: 'Repository 42',
        filter: null,
        maximumObservationAgeMs: null,
      },
    }),
  };
}

const plainCurrentness = async (): Promise<AccountEncryptionCurrentnessResponse> => ({
  mode: 'plain',
  version: 7,
  signingKeyFingerprint: 'aemk1_signing',
  contentKeyFingerprint: null,
  updatedAt: 8,
});

async function collectPreparedAdmissionRequests(
  sequence: AsyncIterableIterator<AutomationEventAdmitHttpRequestV1> | null,
): Promise<AutomationEventAdmitHttpRequestV1[]> {
  if (sequence === null) throw new Error('Expected a prepared Event admission sequence');
  const requests: AutomationEventAdmitHttpRequestV1[] = [];
  for await (const request of sequence) requests.push(request);
  return requests;
}

describe('Automation Event adopted-definition host factory', () => {
  it('uses the incumbent private Event route and rejects malformed response bytes at the HTTP boundary', async () => {
    const immutableGenerationId = 'github-generation-current';
    const stampedCaller = {
      pluginId: caller.pluginId,
      immutableGenerationId,
      materialization: caller,
    } as const;
    const revalidateCaller = vi.fn(async () => true);
    const page = AutomationEventStoredDefinitionsReadResultV1Schema.parse({
      kind: 'page',
      revision: '7',
      eventDeclarationRelease,
      scope: durableScopeCurrent,
      definitions: [storedDefinition()],
      nextCursor: null,
    });
    transportMocks.createPublisherHeader.mockResolvedValueOnce('publisher-proof');
    transportMocks.post.mockResolvedValueOnce({ data: page });
    const transport = createAutomationEventStoredDefinitionsHttpTransportV1({
      credentials,
      revalidateCaller,
    });

    await expect(transport.read({
      caller: stampedCaller,
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 1 },
      signal: new AbortController().signal,
    })).resolves.toEqual(page);
    expect(transportMocks.createPublisherHeader).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/automations/events/stored-definitions/read',
      body: {
        v: 1,
        caller: stampedCaller,
        input: { transport: { kind: 'checkpointedPull' }, pageSize: 1 },
      },
    });
    expect(transportMocks.post).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/automations\/events\/stored-definitions\/read$/u),
      expect.objectContaining({ v: 1 }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(revalidateCaller).toHaveBeenCalledWith(stampedCaller, expect.any(AbortSignal));

    transportMocks.createPublisherHeader.mockResolvedValueOnce('publisher-proof');
    transportMocks.post.mockResolvedValueOnce({
      data: { kind: 'unchanged', revision: '7', sourceConfig: { forbidden: true } },
    });
    await expect(transport.read({
      caller: stampedCaller,
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 1, knownRevision: '7' },
    })).rejects.toThrow();
  });

  it('composes one current generation-local adopted set and fails closed when encrypted definition material is unavailable', async () => {
    const page: AutomationEventStoredDefinitionsReadResultV1 = {
      kind: 'page',
      revision: '7',
      eventDeclarationRelease,
      definitions: [storedDefinition()],
      nextCursor: null,
    };
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({
      credentials,
      caller,
      immutableGenerationId,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateCallerImmutableGeneration: async () => true,
      readStoredDefinitions: async ({ input }) => input.knownRevision === '7'
        ? { kind: 'unchanged', revision: '7', eventDeclarationRelease }
        : page,
      resolveAccountEncryptionCurrentness: plainCurrentness,
      resolveAccountEncryptionMaterial: async () => null,
    });

    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '7' });
    const prepared = await owner.prepareAdmission({
      caller: actionCaller,
      input: {
        eventRef: { pluginId: caller.pluginId, localId: 'repository-event' },
        occurrenceId: 'delivery-1',
        occurredAt: 1,
        observationReceivedAt: 2,
        payload: { action: 'opened' },
        definitions: [{
          automationId: 'automation-1',
          triggerId,
          triggerRevision,
          sourceSelectorId,
        }],
      },
      accountId: 'account-1',
      randomBytes: (length) => new Uint8Array(length),
      signal: new AbortController().signal,
    });
    await expect(collectPreparedAdmissionRequests(prepared)).resolves.toEqual([{
      v: 1,
      caller: actionCaller,
      input: {
        eventRef: { pluginId: caller.pluginId, localId: 'repository-event' },
        occurrenceId: 'delivery-1',
        occurredAt: 1,
        observationReceivedAt: 2,
        payload: { action: 'opened' },
        definitions: [{ automationId: 'automation-1', triggerId, triggerRevision, sourceSelectorId }],
      },
      hostEvidence: {
        v: 1,
        t: 'plain',
        accountCurrentness: { mode: 'plain', version: 7, contentKeyFingerprint: null },
      },
    }]);

    const encryptedOwner = createAutomationEventAdoptedDefinitionSetHostV1({
      credentials,
      caller,
      immutableGenerationId,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateCallerImmutableGeneration: async () => true,
      readStoredDefinitions: async () => ({
        kind: 'page',
        revision: '8',
        eventDeclarationRelease,
        definitions: [{
          ...storedDefinition(),
          storedDefinitionEnvelope: { t: 'encrypted', c: 'opaque-ciphertext' },
        }],
        nextCursor: null,
      }),
      resolveAccountEncryptionCurrentness: async () => ({
        mode: 'e2ee',
        version: 8,
        signingKeyFingerprint: 'aemk1_signing',
        contentKeyFingerprint: 'aemk1_content_key',
        updatedAt: 9,
      }),
      resolveAccountEncryptionMaterial: async () => null,
    });

    await expect(encryptedOwner.refresh()).resolves.toEqual({
      kind: 'discarded',
      reason: 'notCurrent',
    });
    expect(encryptedOwner.readPublicProjection()).toEqual({ kind: 'initializing' });
  });

  it('revalidates the exact checkpointed source before exposing its host-only recovery config', async () => {
    let sourceStillCurrent = true;
    const readStoredDefinitions = vi.fn(async ({ input }: Readonly<{
      input: { knownRevision?: string };
    }>) => {
      if (input.knownRevision === '7') {
        return sourceStillCurrent
          ? { kind: 'unchanged' as const, revision: '7', eventDeclarationRelease }
          : {
            kind: 'page' as const,
            revision: '8',
            eventDeclarationRelease,
            definitions: [],
            nextCursor: null,
          };
      }
      return {
        kind: 'page' as const,
        revision: '7',
        eventDeclarationRelease,
        definitions: [storedDefinition()],
        nextCursor: null,
      };
    });
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({
      credentials,
      caller,
      immutableGenerationId,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateCallerImmutableGeneration: async () => true,
      readStoredDefinitions,
      resolveAccountEncryptionCurrentness: plainCurrentness,
      resolveAccountEncryptionMaterial: async () => null,
    });

    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '7' });
    await expect(owner.readCurrentCheckpointedPullSource({
      reset: {
        automationId: 'automation-1',
        triggerId,
        triggerRevision,
        sourceSelectorId,
      },
    })).resolves.toMatchObject({
      automationId: 'automation-1',
      triggerId,
      triggerRevision,
      sourceSelectorId,
      sourceConfig: { repositoryId: 42 },
      observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: caller },
    });
    expect(readStoredDefinitions).toHaveBeenLastCalledWith(expect.objectContaining({
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 500, knownRevision: '7' },
    }));

    await expect(owner.readCurrentCheckpointedPullSource({
      reset: {
        automationId: 'automation-1',
        triggerId,
        triggerRevision,
        sourceSelectorId: secondSourceSelectorId,
      },
    })).resolves.toBeNull();

    sourceStillCurrent = false;
    await expect(owner.readCurrentCheckpointedPullSource({
      reset: {
        automationId: 'automation-1',
        triggerId,
        triggerRevision,
        sourceSelectorId,
      },
    })).resolves.toBeNull();
  });

  it('partitions a plain semantic Action into complete private calls without exposing a cursor', async () => {
    const definitions = Array.from(
      { length: MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_CALL + 1 },
      (_, index) => storedDefinition({
        automationId: `automation-plain-${index}`,
        sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(
          `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        ),
      }),
    );
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({
      credentials,
      caller,
      immutableGenerationId,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateCallerImmutableGeneration: async () => true,
      readStoredDefinitions: async ({ input }) => input.knownRevision === '11'
        ? { kind: 'unchanged', revision: '11', eventDeclarationRelease }
        : { kind: 'page', revision: '11', eventDeclarationRelease, definitions, nextCursor: null },
      resolveAccountEncryptionCurrentness: plainCurrentness,
      resolveAccountEncryptionMaterial: async () => null,
    });
    const input = {
      eventRef: { pluginId: caller.pluginId, localId: 'repository-event' },
      occurrenceId: 'delivery-plain-many',
      occurredAt: 1,
      observationReceivedAt: 2,
      payload: { action: 'opened' },
      definitions: definitions.map((definition) => ({
        automationId: definition.automationId,
        triggerId: definition.triggerId,
        triggerRevision: definition.triggerRevision,
        sourceSelectorId: definition.sourceSelectorId,
      })),
    } as const;

    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '11' });
    const prepare = () => owner.prepareAdmission({
      accountId: 'account-1',
      caller: actionCaller,
      input,
      randomBytes: (length) => new Uint8Array(length),
    });
    const withoutSuccessor = await prepare();
    if (withoutSuccessor === null) throw new Error('plain admission sequence was unavailable');
    const withoutSuccessorFirst = await withoutSuccessor.next();
    if (withoutSuccessorFirst.done) throw new Error('plain admission sequence ended before its first batch');
    expect((await withoutSuccessor.next()).done).toBe(true);

    const sequence = await prepare();
    if (sequence === null) throw new Error('plain admission sequence was unavailable');
    const first = await sequence.next();
    if (first.done) throw new Error('plain admission sequence ended before its first batch');
    const successor = { mode: 'plain' as const, version: 8, contentKeyFingerprint: null };
    const second = await sequence.next(successor);
    if (second.done) throw new Error('plain admission sequence ended before its second batch');
    const requests = [first.value, second.value];

    expect(requests).toHaveLength(2);
    expect(requests.every((request) => 'input' in request)).toBe(true);
    expect(requests.map((request) => (
      'input' in request ? request.input.definitions : []
    ))).toEqual([
      input.definitions.slice(0, MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_CALL),
      input.definitions.slice(MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_CALL),
    ]);
    expect(requests.map((request) => (
      request.hostEvidence.accountCurrentness
    ))).toEqual([
      { mode: 'plain', version: 7, contentKeyFingerprint: null },
      successor,
    ]);
    expect(requests.every((request) => (
      readAutomationEventAdmitHttpRequestCanonicalUtf8ByteLengthV1(request)
        <= MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES
    ))).toBe(true);
  });

  it('adopts a durable-push definition at its selected transport without exposing endpoint routing identity', async () => {
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({
      credentials,
      caller,
      immutableGenerationId,
      transport: { kind: 'durablePush' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateCallerImmutableGeneration: async () => true,
      readStoredDefinitions: async ({ input }) => {
        expect(input.transport).toEqual({ kind: 'durablePush' });
        if (input.knownRevision === '9') {
          return {
            kind: 'unchanged',
            revision: '9',
            eventDeclarationRelease,
            scope: durableScopeCurrent,
          };
        }
        return {
          kind: 'page',
          revision: '9',
          eventDeclarationRelease,
          scope: durableScopeCurrent,
          definitions: [durablePushStoredDefinition()],
          nextCursor: null,
        };
      },
      resolveAccountEncryptionCurrentness: plainCurrentness,
      resolveAccountEncryptionMaterial: async () => null,
    });

    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '9' });
    expect(owner.readPublicProjection()).toEqual({
      kind: 'available',
      revision: '9',
      definitions: [expect.not.objectContaining({
        webhookRoutingSourceInstanceId: expect.anything(),
      })],
    });
  });

  it('re-adopts the full durable snapshot when its endpoint target moves without a catalog revision', async () => {
    let endpointTargetsCaller = true;
    const readStoredDefinitions = vi.fn(async ({ input }: Readonly<{
      input: { knownRevision?: string };
    }>) => {
      if (input.knownRevision === '9') {
        return {
          kind: 'unchanged' as const,
          revision: '9',
          eventDeclarationRelease,
          scope: endpointTargetsCaller ? durableScopeCurrent : durableScopeMoved,
        };
      }
      return {
        kind: 'page' as const,
        revision: '9',
        eventDeclarationRelease,
        scope: endpointTargetsCaller ? durableScopeCurrent : durableScopeMoved,
        definitions: endpointTargetsCaller ? [durablePushStoredDefinition()] : [],
        nextCursor: null,
      };
    });
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({
      credentials,
      caller,
      immutableGenerationId,
      transport: { kind: 'durablePush' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateCallerImmutableGeneration: async () => true,
      readStoredDefinitions,
      resolveAccountEncryptionCurrentness: plainCurrentness,
      resolveAccountEncryptionMaterial: async () => null,
    });

    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '9' });
    endpointTargetsCaller = false;

    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '9' });
    expect(owner.readPublicProjection()).toEqual({
      kind: 'available',
      revision: '9',
      definitions: [],
    });
    expect(readStoredDefinitions).toHaveBeenLastCalledWith(expect.objectContaining({
      caller: actionCaller,
      input: { transport: { kind: 'durablePush' }, pageSize: 500 },
    }));
  });

  it('fails closed for a durable-push public cursor when its invocation target moves without a catalog revision', async () => {
    let endpointTargetsCaller = true;
    const readStoredDefinitions = vi.fn(async ({ input, webhookInvocationReference }: Readonly<{
      input: { knownRevision?: string };
      webhookInvocationReference?: PluginWebhookInvocationReferenceV1;
    }>) => {
      if (webhookInvocationReference !== undefined) {
        expect(webhookInvocationReference).toEqual(durableWebhookInvocationReference);
        if (!endpointTargetsCaller) {
          throw new Error('durable_push_endpoint_context_unavailable');
        }
      }
      const scope = endpointTargetsCaller ? durableScopeCurrent : durableScopeMoved;
      if (input.knownRevision === '9') {
        return { kind: 'unchanged' as const, revision: '9', eventDeclarationRelease, scope };
      }
      return {
        kind: 'page' as const,
        revision: '9',
        eventDeclarationRelease,
        scope,
        definitions: endpointTargetsCaller
          ? [
            durablePushStoredDefinition(),
            durablePushStoredDefinition({
              automationId: 'automation-2',
              sourceSelectorId: secondSourceSelectorId,
            }),
          ]
          : [],
        nextCursor: null,
      };
    });
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({
      credentials,
      caller,
      immutableGenerationId,
      transport: { kind: 'durablePush' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateCallerImmutableGeneration: async () => true,
      readStoredDefinitions,
      resolveAccountEncryptionCurrentness: plainCurrentness,
      resolveAccountEncryptionMaterial: async () => null,
    });

    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '9' });
    const first = await owner.listPublicProjection({
      accountId: 'account-1',
      input: { transport: { kind: 'durablePush' }, pageSize: 1 },
      webhookInvocationReference: durableWebhookInvocationReference,
    });
    expect(first).toMatchObject({
      kind: 'page',
      revision: '9',
      definitions: [expect.objectContaining({ automationId: 'automation-1' })],
      nextCursor: expect.any(String),
    });
    if (first.kind !== 'page' || typeof first.nextCursor !== 'string') {
      throw new Error('Expected a durable-push public cursor');
    }

    endpointTargetsCaller = false;

    await expect(owner.listPublicProjection({
      accountId: 'account-1',
      input: {
        transport: { kind: 'durablePush' },
        pageSize: 1,
        cursor: first.nextCursor,
      },
      webhookInvocationReference: durableWebhookInvocationReference,
    })).resolves.toEqual({ kind: 'unavailable' });
  });

  it('exposes one ordered encrypted sequence of complete Protocol-bounded requests', async () => {
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: credentials.encryption.secret },
    });
    const definitions = Array.from({ length: 70 }, (_, index) => {
      const automationId = `automation-large-${index}`;
      return {
        ...storedDefinition(),
        automationId,
        storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({
          mode: 'e2ee',
          material: snapshot.material,
          randomBytes: (length) => new Uint8Array(length).fill(4),
          binding: {
            v: 1,
            automationId,
            triggerId,
            triggerRevision,
            triggerKind: 'pluginEvent',
            eventRef: { pluginId: caller.pluginId, localId: 'repository-event' },
            sourceSelectorId,
          },
          definition: {
            v: 1,
            sourceInstanceId: `repository-${index}`,
            sourceConfig: { repositoryId: index },
            displayLabel: `Repository ${index}`,
            filter: null,
            maximumObservationAgeMs: null,
          },
        }),
      };
    });
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({
      credentials,
      caller,
      immutableGenerationId,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateCallerImmutableGeneration: async () => true,
      readStoredDefinitions: async ({ input }) => input.knownRevision === '9'
        ? { kind: 'unchanged', revision: '9', eventDeclarationRelease }
        : {
          kind: 'page',
          revision: '9',
          eventDeclarationRelease,
          definitions,
          nextCursor: null,
        },
      resolveAccountEncryptionCurrentness: async () => ({
        mode: 'e2ee',
        version: 8,
        signingKeyFingerprint: 'aemk1_signing',
        contentKeyFingerprint:
          convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            snapshot.contentPublicKeyFingerprint,
          ),
        updatedAt: 9,
      }),
      resolveAccountEncryptionMaterial: async () => snapshot,
    });
    const input = {
      eventRef: { pluginId: caller.pluginId, localId: 'repository-event' },
      occurrenceId: 'delivery-large-1',
      occurredAt: 1,
      observationReceivedAt: 2,
      payload: { action: 'opened' },
      definitions: definitions.map((definition) => ({
        automationId: definition.automationId,
        triggerId: definition.triggerId,
        triggerRevision: definition.triggerRevision,
        sourceSelectorId: definition.sourceSelectorId,
      })),
    } as const;

    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '9' });
    const prepare = () => owner.prepareAdmission({
      accountId: 'account-1',
      caller: actionCaller,
      input,
      randomBytes: (length) => new Uint8Array(length),
    });
    const withoutSuccessor = await prepare();
    if (withoutSuccessor === null) throw new Error('encrypted admission sequence was unavailable');
    const withoutSuccessorFirst = await withoutSuccessor.next();
    if (withoutSuccessorFirst.done) throw new Error('encrypted admission sequence ended before its first batch');
    expect((await withoutSuccessor.next()).done).toBe(true);

    const sequence = await prepare();
    if (sequence === null) throw new Error('encrypted admission sequence was unavailable');
    const first = await sequence.next();
    if (first.done) throw new Error('encrypted admission sequence ended before its first batch');
    const successor = {
      mode: 'e2ee' as const,
      version: 9,
      contentKeyFingerprint:
        convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
          snapshot.contentPublicKeyFingerprint,
        ),
    };
    const second = await sequence.next(successor);
    if (second.done) throw new Error('encrypted admission sequence ended before its second batch');
    const requests = [first.value, second.value];
    while (true) {
      const next = await sequence.next(successor);
      if (next.done) break;
      requests.push(next.value);
    }

    expect(requests).toHaveLength(Math.ceil(input.definitions.length / MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_CALL));
    expect(requests.every((request) => !('input' in request))).toBe(true);
    expect(requests.every((request) => (
      readAutomationEventAdmitHttpRequestCanonicalUtf8ByteLengthV1(request)
        <= MAX_AUTOMATION_EVENT_ADMIT_HTTP_REQUEST_UTF8_BYTES
    ))).toBe(true);
    expect(requests.every((request) => (
      !('input' in request)
      && request.hostEvidence.definitions.length <= MAX_AUTOMATION_EVENT_ADMIT_DEFINITIONS_PER_CALL
    ))).toBe(true);
    expect(requests.slice(0, 2).map((request) => (
      'input' in request ? null : request.hostEvidence.accountCurrentness
    ))).toEqual([
      {
        mode: 'e2ee',
        version: 8,
        contentKeyFingerprint: successor.contentKeyFingerprint,
      },
      successor,
    ]);
    expect(requests.flatMap((request) => (
      'input' in request
        ? request.input.definitions
        : request.hostEvidence.definitions.map((definition) => ({
          automationId: definition.automationId,
          triggerId: definition.triggerId,
          triggerRevision: definition.triggerRevision,
          sourceSelectorId: definition.sourceSelectorId,
        }))
    ))).toEqual(input.definitions);
  });

  it('opens one byte-20 encrypted definition through the exact current Account material', async () => {
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: credentials.encryption.secret },
    });
    const plain = storedDefinition();
    const encrypted = {
      ...plain,
      storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({
        mode: 'e2ee',
        material: snapshot.material,
        randomBytes: (length) => new Uint8Array(length).fill(4),
        binding: {
          v: 1,
          automationId: plain.automationId,
          triggerId: plain.triggerId,
          triggerRevision: plain.triggerRevision,
          triggerKind: 'pluginEvent',
          eventRef: plain.eventRef,
          sourceSelectorId: plain.sourceSelectorId,
        },
        definition: {
          v: 1,
          sourceInstanceId: 'repository-1',
          sourceConfig: { repositoryId: 42 },
          displayLabel: 'Repository 42',
          filter: null,
          maximumObservationAgeMs: null,
        },
      }),
    };
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({
      credentials,
      caller,
      immutableGenerationId,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateCallerImmutableGeneration: async () => true,
      readStoredDefinitions: async ({ input }) => input.knownRevision === '8'
        ? { kind: 'unchanged', revision: '8', eventDeclarationRelease }
        : {
          kind: 'page',
          revision: '8',
          eventDeclarationRelease,
          definitions: [encrypted],
          nextCursor: null,
        },
      resolveAccountEncryptionCurrentness: async () => ({
        mode: 'e2ee',
        version: 8,
        signingKeyFingerprint: 'aemk1_signing',
        contentKeyFingerprint:
          convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            snapshot.contentPublicKeyFingerprint,
          ),
        updatedAt: 9,
      }),
      resolveAccountEncryptionMaterial: async () => snapshot,
    });

    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '8' });
    const prepared = await owner.prepareAdmission({
      accountId: 'account-1',
      caller: actionCaller,
      input: {
        eventRef: plain.eventRef,
        occurrenceId: 'delivery-1',
        occurredAt: 1,
        observationReceivedAt: 2,
        payload: { action: 'opened' },
        definitions: [{
          automationId: plain.automationId,
          triggerId: plain.triggerId,
          triggerRevision: plain.triggerRevision,
          sourceSelectorId: plain.sourceSelectorId,
        }],
      },
      randomBytes: (length) => new Uint8Array(length),
    });
    await expect(collectPreparedAdmissionRequests(prepared)).resolves.toMatchObject([{
      hostEvidence: { t: 'encrypted', eventDeclarationRelease },
    }]);
  });
});

describe('adopted definition set Account-currentness cost', () => {
  /**
   * The adopted catalog publishes atomically, so nothing is observable while it
   * is built. One Account crypto/currentness snapshot therefore covers the
   * whole attempt: the per-definition reads that made adoption O(N) remote
   * round trips buy no observable guarantee the boundary rechecks do not.
   */
  it('reads Account currentness a constant number of times per refresh attempt', async () => {
    const measure = async (definitionCount: number) => {
      let currentnessReads = 0;
      const definitions = Array.from({ length: definitionCount }, (_unused, index) => (
        storedDefinition({ automationId: `automation-${index + 1}` })
      ));
      const owner = createAutomationEventAdoptedDefinitionSetHostV1({
        credentials,
        caller,
        immutableGenerationId,
        transport: { kind: 'checkpointedPull' },
        generationSignal: new AbortController().signal,
        isGenerationCurrent: () => true,
        revalidateCallerMaterialization: async () => true,
        revalidateCallerImmutableGeneration: async () => true,
        readStoredDefinitions: async (): Promise<AutomationEventStoredDefinitionsReadResultV1> => ({
          kind: 'page',
          revision: '7',
          eventDeclarationRelease,
          definitions,
          nextCursor: null,
        }),
        resolveAccountEncryptionCurrentness: async () => {
          currentnessReads += 1;
          return await plainCurrentness();
        },
        resolveAccountEncryptionMaterial: async () => null,
      });
      await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '7' });
      return currentnessReads;
    };

    const oneDefinition = await measure(1);
    const twentyDefinitions = await measure(20);
    expect(twentyDefinitions).toBe(oneDefinition);
    // Attempt snapshot, page boundary, closing boundary.
    expect(oneDefinition).toBe(3);
  });
});
