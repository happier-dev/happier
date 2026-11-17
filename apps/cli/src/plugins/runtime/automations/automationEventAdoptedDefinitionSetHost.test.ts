import { describe, expect, it, vi } from 'vitest';
import {
  AutomationEventStoredDefinitionsReadResultV1Schema,
  AutomationSourceSelectorIdV1Schema,
  AutomationTriggerIdSchema,
  AUTOMATION_TRIGGER_EVIDENCE_ACCOUNT_SCOPED_BLOB_KIND_V1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  createAccountScopedCryptoMaterialSnapshotV1,
  openAccountScopedBlobCiphertext,
  sealAutomationTriggerDefinitionStoredEnvelopeV1,
  type AccountEncryptionCurrentnessResponse,
  type AutomationEventStoredDefinitionProjectionV1,
  type AutomationEventDeclarationReleaseV1,
  type AutomationEventStoredDefinitionsReadResultV1,
  type AutomationEventAdmitHttpRequestV1,
  type PluginMachineMaterializationRefV1,
  type PluginWebhookInvocationReferenceV1,
  MAX_AUTOMATION_EVENT_PAYLOAD_UTF8_BYTES,
  MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE,
  SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1,
  readServerHttpRequestBodyUtf8ByteLengthV1,
} from '@happier-dev/protocol';

const transportMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  createPublisherHeader: vi.fn(),
}));

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, get: transportMocks.get, post: transportMocks.post } };
});
vi.mock('@/plugins/installations/publisherProof', () => ({
  createDefaultPluginInstallationPublisherHeader: transportMocks.createPublisherHeader,
}));

import {
  createAutomationEventAdoptedDefinitionSetHostV1,
  createAutomationEventStoredDefinitionsHttpTransportV1,
} from './automationEventAdoptedDefinitionSetHost';
import { readAdoptedHealthCheckBatch } from '@/deployments/healthChecks/readAdoptedHealthCheckBatch';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import type { AutomationSubjectContextV1 } from '@happier-dev/protocol/automations/automationSubjectV1';

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
const occurrenceId = 'github-occurrence-current';
const sourceCustody = {
  kind: 'managed' as const,
  immutableGenerationId,
  installSource: 'archive' as const,
};
const actionCaller = {
  pluginId: caller.pluginId,
  occurrenceId,
  sourceCustody,
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
  triggerId?: AutomationEventStoredDefinitionProjectionV1['triggerId'];
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
        retired: true,
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
  triggerId?: AutomationEventStoredDefinitionProjectionV1['triggerId'];
  sourceSelectorId?: typeof sourceSelectorId;
}> = {}): AutomationEventStoredDefinitionProjectionV1 {
  const automationId = options.automationId ?? 'automation-1';
  const selectedTriggerId = options.triggerId ?? triggerId;
  const selectedSourceSelectorId = options.sourceSelectorId ?? sourceSelectorId;
  return {
    ...storedDefinition(),
    automationId,
    triggerId: selectedTriggerId,
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
        triggerId: selectedTriggerId,
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
  recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
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
  it.each([
    { observedMachineId: 'private-source-machine', observedHome: 'home-1', matched: true },
    { observedMachineId: 'different-machine', observedHome: 'home-1', matched: false },
    { observedMachineId: 'private-source-machine', observedHome: 'other-home', matched: false },
  ])('matches encrypted Event subjects at the host for $observedMachineId on $observedHome', async testCase => {
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: credentials.encryption.secret } });
    const definition = storedDefinition();
    definition.storedDefinitionEnvelope = sealAutomationTriggerDefinitionStoredEnvelopeV1({
      mode: 'e2ee', material: snapshot.material, randomBytes: length => new Uint8Array(length).fill(4),
      binding: { v: 1, automationId: definition.automationId, triggerId, triggerRevision,
        triggerKind: 'pluginEvent', eventRef: definition.eventRef, sourceSelectorId },
      definition: { v: 1, sourceInstanceId: 'repository-1', sourceConfig: {}, displayLabel: 'Repository',
        filter: null, maximumObservationAgeMs: null,
        subject: { kind: 'machine', serverId: 'home-1', machineId: 'private-source-machine' } },
    });
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({ credentials, caller, occurrenceId, sourceCustody,
      transport: { kind: 'checkpointedPull' }, occurrenceSignal: new AbortController().signal,
      isOccurrenceCurrent: () => true, revalidateCallerMaterialization: async () => true,
      revalidateCallerOccurrence: async () => true,
      readStoredDefinitions: async () => ({ kind: 'page', revision: '9', eventDeclarationRelease,
        definitions: [definition], nextCursor: null }),
      resolveAccountEncryptionCurrentness: async () => ({ mode: 'e2ee', version: 8,
        signingKeyFingerprint: 'aemk1_signing', contentKeyFingerprint:
          convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint),
        updatedAt: 9, recipientEnvelopeReadiness: { status: 'available' } }),
      resolveAccountEncryptionMaterial: async () => snapshot,
    });
    expect(await owner.refresh()).toEqual({ kind: 'adopted', revision: '9' });
    const subjectContexts: AutomationSubjectContextV1[] = [{ role: 'context', subject: {
      kind: 'machine', serverId: testCase.observedHome, machineId: testCase.observedMachineId,
    } }];
    const input = { eventRef: definition.eventRef, occurrenceId: 'subject-delivery-1', occurredAt: 1,
      observationReceivedAt: 2, payload: {},
      definitions: [{ automationId: definition.automationId, triggerId, triggerRevision, sourceSelectorId }] };
    const beforeEnrichment = await collectPreparedAdmissionRequests(await owner.prepareAdmission({
      accountId: 'account-1', caller: actionCaller, input,
      randomBytes: length => new Uint8Array(length).fill(5),
    }));
    const requests = await collectPreparedAdmissionRequests(await owner.prepareAdmission({
      accountId: 'account-1', caller: actionCaller,
      input: { ...input, subjectContexts },
      randomBytes: length => new Uint8Array(length).fill(5),
    }));
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    if ('input' in request) throw new Error('Expected encrypted admission');
    const priorRequest = beforeEnrichment[0]!;
    if ('input' in priorRequest) throw new Error('Expected encrypted admission before enrichment');
    expect(priorRequest.hostEvidence.definitions[0]!.outcome).toEqual({ kind: 'skipped', reason: 'filtered' });
    expect(request.hostEvidence.definitions[0]!.occurrenceKey)
      .toBe(priorRequest.hostEvidence.definitions[0]!.occurrenceKey);
    expect(request.hostEvidence.definitions[0]!.occurrenceEvidenceEqualityTag)
      .toBe(priorRequest.hostEvidence.definitions[0]!.occurrenceEvidenceEqualityTag);
    expect(request.hostEvidence.definitions[0]!.outcome).toEqual(testCase.matched
      ? { kind: 'matched' } : { kind: 'skipped', reason: 'filtered' });
    if (testCase.matched) {
      expect(openAccountScopedBlobCiphertext({
        kind: AUTOMATION_TRIGGER_EVIDENCE_ACCOUNT_SCOPED_BLOB_KIND_V1, material: snapshot.material,
        ciphertext: request.hostEvidence.definitions[0]!.triggerEvidenceEnvelope.c,
      })).toMatchObject({ value: { subjectContexts } });
    }
    expect(JSON.stringify(request)).not.toContain('private-source-machine');
  });
  it('lends one admitted saved health batch without another stored-source scan', async () => {
    const sourceConfig = { v: 1, subject: { kind: 'machineService', machineId: 'service-machine', serviceId: 'service-a' },
      checks: ['first', 'second'].map(checkId => ({ checkId,
        kind: { pluginId: caller.pluginId, localId: 'http' }, binding: { kind: 'healthCheck' },
        config: { endpoint: 'http://127.0.0.1/health', expectStatus: 200 },
        periodMs: 60_000, consecutiveFailuresBeforeAlerting: 1 })) } as const;
    const initial = storedDefinition();
    const stored = { ...initial, storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({
      mode: 'plain', binding: { v: 1, automationId: initial.automationId, triggerId: initial.triggerId,
        triggerRevision: initial.triggerRevision, triggerKind: 'pluginEvent', eventRef: initial.eventRef,
        sourceSelectorId: initial.sourceSelectorId },
      definition: { v: 1, sourceInstanceId: 'health:service-a', sourceConfig, displayLabel: 'Service checks',
        filter: null, maximumObservationAgeMs: null },
    }) };
    const readStoredDefinitions = vi.fn(async () => ({ kind: 'page' as const, revision: '7',
      eventDeclarationRelease, definitions: [stored, storedDefinition({ automationId: 'automation-2',
        triggerId: AutomationTriggerIdSchema.parse('trigger-unrelated'), sourceSelectorId: secondSourceSelectorId })], nextCursor: null }));
    const signal = new AbortController().signal;
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({ credentials, caller, occurrenceId, sourceCustody,
      transport: { kind: 'checkpointedPull' }, occurrenceSignal: signal, isOccurrenceCurrent: () => true,
      revalidateCallerMaterialization: async () => true, revalidateCallerOccurrence: async () => true,
      readStoredDefinitions, resolveAccountEncryptionCurrentness: plainCurrentness,
      resolveAccountEncryptionMaterial: async () => null });
    expect(readAdoptedHealthCheckBatch({ resolveAdoptedDefinitionSet: () => owner, caller, occurrenceId,
      sourceInstanceId: 'health:service-a', signal })).toEqual({ kind: 'unavailable', reason: 'source_unavailable' });
    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '7' });
    expect(readAdoptedHealthCheckBatch({ resolveAdoptedDefinitionSet: () => owner, caller, occurrenceId,
      sourceInstanceId: 'health:service-a', signal })).toEqual({ kind: 'available', revision: '7', source: sourceConfig });
    expect(readStoredDefinitions).toHaveBeenCalledTimes(1);
    expect(readAdoptedHealthCheckBatch({ resolveAdoptedDefinitionSet: () => owner,
      caller: { ...caller, machineId: 'another-machine' }, occurrenceId,
      sourceInstanceId: 'health:service-a', signal })).toEqual({ kind: 'unavailable', reason: 'source_unavailable' });
  });
  it('uses the incumbent private Event route and rejects malformed response bytes at the HTTP boundary', async () => {
    const immutableGenerationId = 'github-generation-current';
    const stampedCaller = {
      pluginId: caller.pluginId,
      occurrenceId,
  sourceCustody,
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
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 500 },
      signal: new AbortController().signal,
    })).resolves.toEqual(page);
    expect(transportMocks.createPublisherHeader).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/automations/events/stored-definitions/read',
      body: {
        v: 1,
        caller: stampedCaller,
        input: { transport: { kind: 'checkpointedPull' }, pageSize: 500 },
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
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 500, knownRevision: '7' },
    })).rejects.toThrow();
  });

  it('drops retired stored definition fields in one current generation-local adopted set and fails closed without encrypted material', async () => {
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
      occurrenceId,
  sourceCustody,
      transport: { kind: 'checkpointedPull' },
      occurrenceSignal: new AbortController().signal,
      isOccurrenceCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateCallerOccurrence: async () => true,
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
      occurrenceId,
  sourceCustody,
      transport: { kind: 'checkpointedPull' },
      occurrenceSignal: new AbortController().signal,
      isOccurrenceCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateCallerOccurrence: async () => true,
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
        recipientEnvelopeReadiness: { status: 'available' },
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
        definitions: [{ ...storedDefinition(), observationOnly: { kind: 'observationOnly' as const } }],
        nextCursor: null,
      };
    });
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({
      credentials,
      caller,
      occurrenceId,
  sourceCustody,
      transport: { kind: 'checkpointedPull' },
      occurrenceSignal: new AbortController().signal,
      isOccurrenceCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateCallerOccurrence: async () => true,
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
      observationOnly: { kind: 'observationOnly' },
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

  it('keeps a whole plain snapshot that fits the transport ceiling in one request, without exposing a cursor', async () => {
    // The snapshot cardinality below is the current source-LIST page maximum.
    // It is read pagination, never an admission bound: a plain snapshot this
    // size serializes far below the server transport ceiling, so the ordered
    // sequence is one complete request and no definition count splits it.
    const definitions = Array.from(
      { length: MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE },
      (_, index) => storedDefinition({
        automationId: `automation-plain-${index}`,
        triggerId: AutomationTriggerIdSchema.parse(`trigger-plain-${index}`),
        sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(
          `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        ),
      }),
    );
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({
      credentials,
      caller,
      occurrenceId,
  sourceCustody,
      transport: { kind: 'checkpointedPull' },
      occurrenceSignal: new AbortController().signal,
      isOccurrenceCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateCallerOccurrence: async () => true,
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
    const sequence = await prepare();
    if (sequence === null) throw new Error('plain admission sequence was unavailable');
    const first = await sequence.next();
    if (first.done) throw new Error('plain admission sequence ended before its first request');
    const requests = [first.value];
    while (true) {
      const next = await sequence.next();
      if (next.done) break;
      requests.push(next.value);
    }

    expect(requests).toHaveLength(1);
    expect(requests.every((request) => 'input' in request)).toBe(true);
    expect(requests.map((request) => (
      'input' in request ? request.input.definitions : []
    ))).toEqual([input.definitions]);
    expect(requests.map((request) => (
      request.hostEvidence.accountCurrentness
    ))).toEqual([
      { mode: 'plain', version: 7, contentKeyFingerprint: null },
    ]);
  });

  it('adopts a durable-push definition at its selected transport without exposing endpoint routing identity', async () => {
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({
      credentials,
      caller,
      occurrenceId,
  sourceCustody,
      transport: { kind: 'durablePush' },
      occurrenceSignal: new AbortController().signal,
      isOccurrenceCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateCallerOccurrence: async () => true,
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
    await expect(owner.listPublicProjection({
      accountId: 'account-1',
      input: { transport: { kind: 'durablePush' }, pageSize: 500 },
    })).resolves.toMatchObject({
      kind: 'page', revision: '9',
      definitions: [expect.objectContaining({ observationTransport: expect.objectContaining({ kind: 'durablePush' }) })],
      nextCursor: null,
    });
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
        definitions: endpointTargetsCaller ? [durablePushStoredDefinition(), durablePushStoredDefinition({
          automationId: 'automation-2', triggerId: AutomationTriggerIdSchema.parse('trigger-durable-2'),
          sourceSelectorId: secondSourceSelectorId,
        })] : [],
        nextCursor: null,
      };
    });
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({
      credentials,
      caller,
      occurrenceId,
  sourceCustody,
      transport: { kind: 'durablePush' },
      occurrenceSignal: new AbortController().signal,
      isOccurrenceCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateCallerOccurrence: async () => true,
      readStoredDefinitions,
      resolveAccountEncryptionCurrentness: plainCurrentness,
      resolveAccountEncryptionMaterial: async () => null,
    });

    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '9' });
    const firstPage = await owner.listPublicProjection({
      accountId: 'account-1', input: { transport: { kind: 'durablePush' }, pageSize: 1 },
    });
    expect(firstPage).toMatchObject({ kind: 'page', nextCursor: expect.any(String) });
    if (firstPage.kind !== 'page' || firstPage.nextCursor === null) throw new Error('Expected monitoring cursor');
    endpointTargetsCaller = false;

    await expect(owner.listPublicProjection({
      accountId: 'account-1',
      input: { transport: { kind: 'durablePush' }, pageSize: 1, cursor: firstPage.nextCursor },
    })).resolves.toEqual({ kind: 'cursorStale', currentRevision: '9' });
    endpointTargetsCaller = true;
    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '9' });
    endpointTargetsCaller = false;
    await expect(owner.listPublicProjection({
      accountId: 'account-1',
      input: { transport: { kind: 'durablePush' }, pageSize: 500, knownRevision: '9' },
    })).resolves.toEqual({ kind: 'page', revision: '9', definitions: [], nextCursor: null });
    await expect(owner.listPublicProjection({
      accountId: 'account-1',
      input: { transport: { kind: 'durablePush' }, pageSize: 500, knownRevision: '9' },
    })).resolves.toEqual({ kind: 'unchanged', revision: '9' });
    expect(owner.readPublicProjection()).toEqual({
      kind: 'available',
      revision: '9',
      definitions: [],
    });
    expect(readStoredDefinitions).toHaveBeenLastCalledWith(expect.objectContaining({
      caller: actionCaller,
      input: { transport: { kind: 'durablePush' }, pageSize: 500, knownRevision: '9' },
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
              triggerId: AutomationTriggerIdSchema.parse('trigger-durable-2'),
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
      occurrenceId,
  sourceCustody,
      transport: { kind: 'durablePush' },
      occurrenceSignal: new AbortController().signal,
      isOccurrenceCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateCallerOccurrence: async () => true,
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

  it('drops retired encrypted stored definition fields and exposes one ordered sequence of complete transport-bounded requests', async () => {
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: credentials.encryption.secret },
    });
    const definitions = Array.from({ length: 70 }, (_, index) => {
      const automationId = `automation-large-${index}`;
      return {
        ...storedDefinition(),
        automationId,
        triggerId: AutomationTriggerIdSchema.parse(`trigger-large-${index}`),
        storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({
          mode: 'e2ee',
          material: snapshot.material,
          randomBytes: (length) => new Uint8Array(length).fill(4),
          binding: {
            v: 1,
            automationId,
            triggerId: AutomationTriggerIdSchema.parse(`trigger-large-${index}`),
            triggerRevision,
            triggerKind: 'pluginEvent',
            eventRef: { pluginId: caller.pluginId, localId: 'repository-event' },
            sourceSelectorId,
          },
          definition: {
            v: 1,
            retired: true,
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
      occurrenceId,
  sourceCustody,
      transport: { kind: 'checkpointedPull' },
      occurrenceSignal: new AbortController().signal,
      isOccurrenceCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateCallerOccurrence: async () => true,
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
        recipientEnvelopeReadiness: { status: 'available' },
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
    const sequence = await prepare();
    if (sequence === null) throw new Error('encrypted admission sequence was unavailable');
    const first = await sequence.next();
    if (first.done) throw new Error('encrypted admission sequence ended before its first request');
    const contentKeyFingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
      snapshot.contentPublicKeyFingerprint,
    );
    const requests = [first.value];
    while (true) {
      const next = await sequence.next();
      if (next.done) break;
      requests.push(next.value);
    }

    expect(requests).toHaveLength(1);
    expect(requests.every((request) => !('input' in request))).toBe(true);
    expect(requests.map((request) => (
      'input' in request ? null : request.hostEvidence.accountCurrentness
    ))).toEqual([
      {
        mode: 'e2ee',
        version: 8,
        contentKeyFingerprint,
      },
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

  it('splits a multi-page adopted snapshot at the server transport ceiling without successor witnesses', async () => {
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: credentials.encryption.secret },
    });
    // Every sealed definition carries the occurrence payload, so a maximal
    // payload plus a catalog spanning several source-list pages is the smallest
    // realistic snapshot whose single request body would exceed the transport
    // ceiling this host must never reach.
    const CURSOR_PREFIX = 'oversized-page-';
    const payload = {
      action: 'opened',
      blob: 'x'.repeat(
        MAX_AUTOMATION_EVENT_PAYLOAD_UTF8_BYTES
          - JSON.stringify({ action: 'opened', blob: '' }).length,
      ),
    };
    const definitions = Array.from(
      { length: MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE * 3 },
      (_, index) => {
        const automationId = `automation-oversized-${index}`;
        const definitionTriggerId = AutomationTriggerIdSchema.parse(`trigger-oversized-${index}`);
        return {
          ...storedDefinition({ automationId, triggerId: definitionTriggerId }),
          storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: 'e2ee',
            material: snapshot.material,
            randomBytes: (length) => new Uint8Array(length).fill(4),
            binding: {
              v: 1,
              automationId,
              triggerId: definitionTriggerId,
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
      },
    );
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({
      credentials,
      caller,
      occurrenceId,
  sourceCustody,
      transport: { kind: 'checkpointedPull' },
      occurrenceSignal: new AbortController().signal,
      isOccurrenceCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateCallerOccurrence: async () => true,
      // The catalog is served exactly as the canonical page contract allows:
      // three progressing pages at the page maximum, one stable revision, and
      // distinct opaque cursors.
      readStoredDefinitions: async ({ input: readInput }) => {
        if (readInput.knownRevision === '9') {
          return { kind: 'unchanged', revision: '9', eventDeclarationRelease };
        }
        const pageIndex = readInput.cursor === undefined
          ? 0
          : Number.parseInt(readInput.cursor.slice(CURSOR_PREFIX.length), 10);
        const start = pageIndex * MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE;
        const pageDefinitions = definitions.slice(
          start,
          start + MAX_AUTOMATION_EVENT_SOURCE_DEFINITIONS_PER_PAGE,
        );
        return {
          kind: 'page',
          revision: '9',
          eventDeclarationRelease,
          definitions: pageDefinitions,
          nextCursor: start + pageDefinitions.length < definitions.length
            ? `${CURSOR_PREFIX}${pageIndex + 1}`
            : null,
        };
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
        recipientEnvelopeReadiness: { status: 'available' },
      }),
      resolveAccountEncryptionMaterial: async () => snapshot,
    });
    const input = {
      eventRef: { pluginId: caller.pluginId, localId: 'repository-event' },
      occurrenceId: 'delivery-oversized-1',
      occurredAt: 1,
      observationReceivedAt: 2,
      payload,
      definitions: definitions.map((definition) => ({
        automationId: definition.automationId,
        triggerId: definition.triggerId,
        triggerRevision: definition.triggerRevision,
        sourceSelectorId: definition.sourceSelectorId,
      })),
    } as const;

    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '9' });
    const sequence = await owner.prepareAdmission({
      accountId: 'account-1',
      caller: actionCaller,
      input,
      randomBytes: (length) => new Uint8Array(length),
    });
    if (sequence === null) throw new Error('encrypted admission sequence was unavailable');
    // Each request is summarized and released so the assertions never retain
    // the whole catalog's sealed evidence at once.
    const observed: Array<Readonly<{
      bodyBytes: number;
      firstDefinitionBytes: number;
      selectors: readonly unknown[];
    }>> = [];
    while (true) {
      const next = await sequence.next();
      if (next.done) break;
      const request = next.value;
      if ('input' in request) throw new Error('an E2EE snapshot must not yield a plain request');
      const definitionEvidence = request.hostEvidence.definitions;
      observed.push({
        bodyBytes: readServerHttpRequestBodyUtf8ByteLengthV1(request),
        firstDefinitionBytes: readServerHttpRequestBodyUtf8ByteLengthV1(definitionEvidence[0]),
        selectors: definitionEvidence.map((definition) => ({
          automationId: definition.automationId,
          triggerId: definition.triggerId,
          triggerRevision: definition.triggerRevision,
          sourceSelectorId: definition.sourceSelectorId,
        })),
      });
    }

    expect(observed.length).toBeGreaterThan(1);
    expect(observed.every((request) => (
      request.bodyBytes <= SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1
    ))).toBe(true);
    // The split lands on the transport boundary itself: the first position of
    // the following request could not have been carried by its predecessor.
    expect(observed[0]!.bodyBytes + observed[1]!.firstDefinitionBytes + 1)
      .toBeGreaterThan(SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1);
    expect(observed.flatMap((request) => request.selectors)).toEqual(input.definitions);
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
      occurrenceId,
  sourceCustody,
      transport: { kind: 'checkpointedPull' },
      occurrenceSignal: new AbortController().signal,
      isOccurrenceCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateCallerOccurrence: async () => true,
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
        recipientEnvelopeReadiness: { status: 'available' },
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
        storedDefinition({
          automationId: `automation-${index + 1}`,
          triggerId: AutomationTriggerIdSchema.parse(`trigger-cost-${index + 1}`),
        })
      ));
      const owner = createAutomationEventAdoptedDefinitionSetHostV1({
        credentials,
        caller,
        occurrenceId,
  sourceCustody,
        transport: { kind: 'checkpointedPull' },
        occurrenceSignal: new AbortController().signal,
        isOccurrenceCurrent: () => true,
        revalidateCallerMaterialization: async () => true,
        revalidateCallerOccurrence: async () => true,
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
    // One opening snapshot and one final admission, independent of pages.
    expect(oneDefinition).toBe(2);
  });

  it('reads fresh Account authority only at unchanged refresh and public disclosure boundaries', async () => {
    // This path exercises credential-aware HTTP admission for a Plain Account.
    const plainCredentials = { token: credentials.token, encryption: null };
    let currentness = await plainCurrentness();
    transportMocks.get.mockReset().mockImplementation(async () => ({ status: 200, data: currentness }));
    transportMocks.createPublisherHeader.mockResolvedValue('publisher-proof');
    let heldRead: (() => void) | undefined;
    let releaseRead: (() => void) | undefined;
    transportMocks.post.mockImplementation(async (_url, body: { input: { knownRevision?: string } }) => {
      if (body.input.knownRevision === '7') {
        if (heldRead) {
          heldRead();
          await new Promise<void>(resolve => { releaseRead = resolve; });
        }
        return { data: { kind: 'unchanged', revision: '7', eventDeclarationRelease } };
      }
      return { data: { kind: 'page', revision: '7', eventDeclarationRelease,
        definitions: [storedDefinition()], nextCursor: null } };
    });
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({
      credentials: plainCredentials, caller, occurrenceId, sourceCustody,
      transport: { kind: 'checkpointedPull' }, occurrenceSignal: new AbortController().signal,
      isOccurrenceCurrent: () => true, revalidateCallerMaterialization: async () => true,
      revalidateCallerOccurrence: async () => true,
    });
    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '7' });
    transportMocks.get.mockClear();
    await expect(owner.refresh()).resolves.toEqual({ kind: 'unchanged', revision: '7' });
    expect(transportMocks.get).toHaveBeenCalledTimes(1);
    transportMocks.get.mockClear();
    await expect(owner.listPublicProjection({ accountId: 'account-1', input: {
      transport: { kind: 'checkpointedPull' }, pageSize: 500, knownRevision: '7',
    } })).resolves.toEqual({ kind: 'unchanged', revision: '7' });
    expect(transportMocks.get).toHaveBeenCalledTimes(2);

    const reading = new Promise<void>(resolve => { heldRead = resolve; });
    const pending = owner.listPublicProjection({ accountId: 'account-1', input: {
      transport: { kind: 'checkpointedPull' }, pageSize: 500, knownRevision: '7',
    } });
    await reading;
    // The stale adopted Plain snapshot must not authorize disclosure after a
    // Home mode change, even before its socket publication reaches the host.
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
      material: { type: 'legacy', secret: credentials.encryption.secret } });
    currentness = { ...currentness, mode: 'e2ee', version: 8,
      signingKeyFingerprint: 'aemk1_signing', contentKeyFingerprint:
        convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint),
      updatedAt: 8, recipientEnvelopeReadiness: { status: 'available' } };
    releaseRead?.();
    await expect(pending).resolves.toEqual({ kind: 'unavailable' });

    const changedCurrentness = currentness;
    currentness = await plainCurrentness();
    let startedAuthority!: () => void;
    let releaseAuthority!: () => void;
    const authorityStarted = new Promise<void>(resolve => { startedAuthority = resolve; });
    const authorityResponse = new Promise<void>(resolve => { releaseAuthority = resolve; });
    transportMocks.get.mockClear().mockImplementation(async () => {
      startedAuthority();
      await authorityResponse;
      return { status: 200, data: currentness };
    });
    // An already adopted page does not refresh the stored definitions. Its
    // own final HTTP admission must still observe an unpublished mode change.
    const cachedPage = owner.listPublicProjection({ accountId: 'account-1', input: {
      transport: { kind: 'checkpointedPull' }, pageSize: 500,
    } });
    await authorityStarted;
    currentness = changedCurrentness;
    releaseAuthority();
    await expect(cachedPage).resolves.toEqual({ kind: 'unavailable' });
    expect(transportMocks.get).toHaveBeenCalledTimes(1);
  });

  // P03 R3 / review F1: refreshes borrow the held observation, but event
  // admission seals or posts payloads and must observe a committed switch.
  it('refuses event admission after a plain-to-E2EE switch the held observation has not yet received', async () => {
    const channel = await createRequesterCurrentnessSocketHarness();
    const serverBaseUrl = 'https://f1-admission.test';
    const plainCredentials = { token: credentials.token, encryption: null };
    let currentness = await plainCurrentness();
    let currentnessReads = 0;
    transportMocks.get.mockReset().mockImplementation(async (url: string) => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) { currentnessReads += 1; return { status: 200, data: currentness }; }
      throw new Error(`Unexpected GET ${url}`);
    });
    const holder = acquireRequesterAccountEncryptionCurrentness({ accountId: 'account-1', token: credentials.token, serverBaseUrl });
    try {
      await runWithServerHttpBaseUrl(serverBaseUrl, async () => {
        await holder.read();
        const owner = createAutomationEventAdoptedDefinitionSetHostV1({
          credentials: plainCredentials, caller, occurrenceId, sourceCustody,
          transport: { kind: 'checkpointedPull' }, occurrenceSignal: new AbortController().signal,
          isOccurrenceCurrent: () => true, revalidateCallerMaterialization: async () => true,
          revalidateCallerOccurrence: async () => true,
          readStoredDefinitions: async () => ({ kind: 'page', revision: '7', eventDeclarationRelease,
            definitions: [storedDefinition()], nextCursor: null }),
        });
        const readsBeforeRefresh = currentnessReads;
        await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '7' });
        expect(currentnessReads - readsBeforeRefresh).toBe(0);
        // The Home commits plain→E2EE; its socket publication has not arrived.
        const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
          material: { type: 'legacy', secret: credentials.encryption.secret } });
        currentness = { ...currentness, mode: 'e2ee', version: 8, signingKeyFingerprint: 'aemk1_signing',
          contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint),
          updatedAt: 8, recipientEnvelopeReadiness: { status: 'available' } };
        const prepared = await owner.prepareAdmission({
          caller: actionCaller,
          input: { eventRef: { pluginId: caller.pluginId, localId: 'repository-event' }, occurrenceId: 'delivery-1',
            occurredAt: 1, observationReceivedAt: 2, payload: { action: 'opened' },
            definitions: [{ automationId: 'automation-1', triggerId, triggerRevision, sourceSelectorId }] },
          accountId: 'account-1', randomBytes: length => new Uint8Array(length), signal: new AbortController().signal,
        });
        const sent = prepared === null ? [] : await collectPreparedAdmissionRequests(prepared);
        expect(sent).toEqual([]);
      });
    } finally { await holder.dispose(); await channel.close(); }
  });
});
