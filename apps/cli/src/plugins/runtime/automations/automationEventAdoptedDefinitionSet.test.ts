import { describe, expect, it, vi } from 'vitest';
import {
  AutomationSourceSelectorIdV1Schema,
  type AutomationSourceSelectorIdV1,
} from '@happier-dev/protocol';
import type {
  AutomationEventDeclarationReleaseV1,
  AutomationEventSourceDefinitionV1,
  AutomationEventSourceObservationTransportV1,
  AutomationEventStoredDefinitionProjectionV1,
  AutomationEventStoredDefinitionsReadResultV1,
  AutomationEventSourcesListInputV1,
  AutomationStoredContentEnvelopeV1,
  PluginMachineMaterializationRefV1,
  PluginWebhookInvocationReferenceV1,
} from '@happier-dev/protocol';

import {
  createAutomationEventAdoptedDefinitionSetV1,
} from './automationEventAdoptedDefinitionSet';

const caller = {
  pluginId: 'com.acme.github',
  machineId: 'machine-current',
  materializationId: 'materialization-current',
} as const satisfies PluginMachineMaterializationRefV1;

function sourceSelector(index: number): AutomationSourceSelectorIdV1 {
  return AutomationSourceSelectorIdV1Schema.parse(
    `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  );
}

function storedDefinition(index: number): AutomationEventStoredDefinitionProjectionV1 {
  const observationTransport: AutomationEventSourceObservationTransportV1 = {
    kind: 'checkpointedPull',
    watcherMaterializationRef: caller,
  };
  const storedDefinitionEnvelope: AutomationStoredContentEnvelopeV1 = {
    t: 'plain',
    v: {
      v: 1,
      sourceInstanceId: `repository-${index}`,
      sourceConfig: { repositoryId: index },
      filter: null,
      maximumObservationAgeMs: null,
    },
  };
  return {
    automationId: `automation-${String(index).padStart(4, '0')}`,
    templateVersion: index,
    eventRef: { pluginId: caller.pluginId, localId: 'repository-event' },
    sourceSelectorId: sourceSelector(index),
    sourceContractVersion: 1,
    observationTransport,
    storedDefinitionEnvelope,
    executionRecipe: 'serialized-definition-recipe',
    payloadSchema: { type: 'object' },
  };
}

function durableStoredDefinition(params: Readonly<{
  index: number;
  webhookEndpointId: string;
  webhookRoutingSourceInstanceId: string;
}>): AutomationEventStoredDefinitionProjectionV1 {
  return {
    ...storedDefinition(params.index),
    observationTransport: {
      kind: 'durablePush',
      webhookEndpointId: params.webhookEndpointId,
      endpointMaterializationRef: caller,
      observationStartsAt: 1,
    },
    storedDefinitionEnvelope: {
      t: 'plain',
      v: {
        v: 1,
        sourceInstanceId: `repository-${params.index}`,
        webhookRoutingSourceInstanceId: params.webhookRoutingSourceInstanceId,
        sourceConfig: { repositoryId: params.index },
        filter: null,
        maximumObservationAgeMs: null,
      },
    },
  };
}

function projectStoredDefinition(
  stored: AutomationEventStoredDefinitionProjectionV1,
): AutomationEventSourceDefinitionV1 | null {
  if (stored.storedDefinitionEnvelope.t !== 'plain') return null;
  const payload = stored.storedDefinitionEnvelope.v;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const values = payload as Readonly<{
    sourceInstanceId?: unknown;
    sourceConfig?: unknown;
    filter?: unknown;
    maximumObservationAgeMs?: unknown;
  }>;
  if (
    typeof values.sourceInstanceId !== 'string'
    || values.sourceConfig === undefined
    || values.filter === undefined
    || values.maximumObservationAgeMs === undefined
  ) {
    return null;
  }
  return {
    automationId: stored.automationId,
    templateVersion: stored.templateVersion,
    eventRef: stored.eventRef,
    sourceInstanceId: values.sourceInstanceId,
    sourceSelectorId: stored.sourceSelectorId,
    sourceContractVersion: stored.sourceContractVersion,
    sourceConfig: values.sourceConfig as AutomationEventSourceDefinitionV1['sourceConfig'],
    observationTransport: stored.observationTransport,
    filter: values.filter as AutomationEventSourceDefinitionV1['filter'],
    maximumObservationAgeMs: values.maximumObservationAgeMs as AutomationEventSourceDefinitionV1['maximumObservationAgeMs'],
  };
}

function projectDurableStoredDefinition(
  stored: AutomationEventStoredDefinitionProjectionV1,
): AutomationEventSourceDefinitionV1 & Readonly<{ webhookRoutingSourceInstanceId?: string }> | null {
  const projected = projectStoredDefinition(stored);
  if (projected === null || stored.storedDefinitionEnvelope.t !== 'plain') return null;
  const value = stored.storedDefinitionEnvelope.v;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const webhookRoutingSourceInstanceId = (value as Readonly<{
    webhookRoutingSourceInstanceId?: unknown;
  }>).webhookRoutingSourceInstanceId;
  return typeof webhookRoutingSourceInstanceId === 'string'
    ? { ...projected, webhookRoutingSourceInstanceId }
    : null;
}

const durableWebhookInvocationReference = {
  v: 1,
  deliveryId: 'delivery-1',
  endpoint: {
    webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
    revision: 3,
    webhookContribution: { pluginId: caller.pluginId, localId: 'repository-events' },
    handlerActionLocalId: 'receive-repository-events',
    sourceInstanceId: 'routing-source-a',
  },
  target: {
    materialization: caller,
    machineInstallationId: 'installation-current',
  },
  lease: { leaseId: 'wh_lease_AAECAwQFBgcICQoLDA0ODw', revision: 5 },
} as const satisfies PluginWebhookInvocationReferenceV1;

const durableAllEndpointsScope = 'a'.repeat(43);
const durableEndpointScope = 'b'.repeat(43);
const eventDeclarationRelease = {
  release: { pluginId: caller.pluginId, version: '1.0.0' },
  archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
} as const satisfies AutomationEventDeclarationReleaseV1;

function page(
  revision: string,
  definitions: readonly AutomationEventStoredDefinitionProjectionV1[],
  nextCursor: string | null,
  release: AutomationEventDeclarationReleaseV1 = eventDeclarationRelease,
): AutomationEventStoredDefinitionsReadResultV1 {
  return {
    kind: 'page',
    revision,
    eventDeclarationRelease: release,
    definitions: [...definitions],
    nextCursor,
  };
}

function unchanged(
  revision: string,
  release: AutomationEventDeclarationReleaseV1 = eventDeclarationRelease,
): AutomationEventStoredDefinitionsReadResultV1 {
  return { kind: 'unchanged', revision, eventDeclarationRelease: release };
}

describe('createAutomationEventAdoptedDefinitionSetV1', () => {
  it('pages only the adopted public projection with a revision- and caller-scoped continuation', async () => {
    const definitions = [storedDefinition(1), storedDefinition(2), storedDefinition(3)];
    let revision = '7';
    const readStoredDefinitions = vi.fn(async (): Promise<AutomationEventStoredDefinitionsReadResultV1> => (
      page(revision, definitions, null)
    ));
    const owner = createAutomationEventAdoptedDefinitionSetV1({
      caller,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateAccountContent: async () => true,
      readStoredDefinitions,
      projectStoredDefinition: async ({ storedDefinition: stored }) => projectStoredDefinition(stored),
    });

    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '7' });
    const listPublicProjection = Reflect.get(owner, 'listPublicProjection');
    expect(listPublicProjection).toBeTypeOf('function');
    if (typeof listPublicProjection !== 'function') return;

    const first = await Reflect.apply(listPublicProjection, owner, [{
      accountId: 'account-1',
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 2 },
    }]);
    expect(first).toMatchObject({
      kind: 'page',
      revision: '7',
      definitions: [
        { automationId: definitions[0]!.automationId },
        { automationId: definitions[1]!.automationId },
      ],
      nextCursor: expect.any(String),
    });
    if (!first || typeof first !== 'object' || !('nextCursor' in first) || typeof first.nextCursor !== 'string') {
      return;
    }

    const second = await Reflect.apply(listPublicProjection, owner, [{
      accountId: 'account-1',
      input: {
        transport: { kind: 'checkpointedPull' },
        pageSize: 2,
        cursor: first.nextCursor,
      },
    }]);
    expect(second).toEqual({
      kind: 'page',
      revision: '7',
      definitions: [expect.objectContaining({ automationId: definitions[2]!.automationId })],
      nextCursor: null,
    });
    expect(readStoredDefinitions).toHaveBeenCalledTimes(1);

    revision = '8';
    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '8' });
    await expect(Reflect.apply(listPublicProjection, owner, [{
      accountId: 'account-1',
      input: {
        transport: { kind: 'checkpointedPull' },
        pageSize: 2,
        cursor: first.nextCursor,
      },
    }])).resolves.toEqual({ kind: 'cursorStale', currentRevision: '8' });
  });

  it('rebuilds one current adopted snapshot for concurrent checkpointed-pull source reads after a catalog revision changes', async () => {
    const previousDefinition = storedDefinition(1);
    const currentDefinition = storedDefinition(2);
    let revision = '7';
    let definitions: readonly AutomationEventStoredDefinitionProjectionV1[] = [previousDefinition];
    const readStoredDefinitions = vi.fn(async ({ input }: Readonly<{
      input: AutomationEventSourcesListInputV1;
    }>): Promise<AutomationEventStoredDefinitionsReadResultV1> => {
      if (input.knownRevision === revision) return unchanged(revision);
      return page(revision, definitions, null);
    });
    const owner = createAutomationEventAdoptedDefinitionSetV1({
      caller,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateAccountContent: async () => true,
      readStoredDefinitions,
      projectStoredDefinition: async ({ storedDefinition: stored }) => projectStoredDefinition(stored),
    });

    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '7' });
    revision = '8';
    definitions = [currentDefinition];

    const [first, second] = await Promise.all([
      owner.listPublicProjection({
        accountId: 'account-1',
        input: { transport: { kind: 'checkpointedPull' }, pageSize: 500, knownRevision: '7' },
      }),
      owner.listPublicProjection({
        accountId: 'account-1',
        input: { transport: { kind: 'checkpointedPull' }, pageSize: 500, knownRevision: '7' },
      }),
    ]);

    expect(first).toMatchObject({
      kind: 'page',
      revision: '8',
      definitions: [{ automationId: currentDefinition.automationId }],
      nextCursor: null,
    });
    expect(second).toMatchObject({
      kind: 'page',
      revision: '8',
      definitions: [{ automationId: currentDefinition.automationId }],
      nextCursor: null,
    });
    expect(readStoredDefinitions).toHaveBeenCalledTimes(2);
    expect(readStoredDefinitions).toHaveBeenNthCalledWith(2, expect.objectContaining({
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 500, knownRevision: '7' },
    }));
    expect(owner.readPublicProjection()).toMatchObject({
      kind: 'available',
      revision: '8',
      definitions: [{ automationId: currentDefinition.automationId }],
    });
  });

  it('re-adopts a same-revision snapshot when the Event payload-validator release changes', async () => {
    const definition = storedDefinition(1);
    const releaseA = eventDeclarationRelease;
    const releaseB = {
      release: { pluginId: caller.pluginId, version: '1.0.1' },
      archiveDigestSha256: `sha256:${'b'.repeat(64)}`,
    } as const satisfies AutomationEventDeclarationReleaseV1;
    let fullReads = 0;
    const projectPrivateDefinition = vi.fn(async ({
      storedDefinition: stored,
    }: Readonly<{
      storedDefinition: AutomationEventStoredDefinitionProjectionV1;
      eventDeclarationRelease: AutomationEventDeclarationReleaseV1;
      signal?: AbortSignal;
    }>) => projectStoredDefinition(stored));
    const readStoredDefinitions = vi.fn(async ({ input }: Readonly<{
      input: AutomationEventSourcesListInputV1;
    }>): Promise<AutomationEventStoredDefinitionsReadResultV1> => {
      if (input.knownRevision === '7') return unchanged('7', releaseB);
      fullReads += 1;
      return page('7', [definition], null, fullReads === 1 ? releaseA : releaseB);
    });
    const owner = createAutomationEventAdoptedDefinitionSetV1({
      caller,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateAccountContent: async () => true,
      readStoredDefinitions,
      projectStoredDefinition: projectPrivateDefinition,
    });

    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '7' });
    await expect(owner.listPublicProjection({
      accountId: 'account-1',
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 500, knownRevision: '7' },
    })).resolves.toEqual({ kind: 'unchanged', revision: '7' });

    expect(readStoredDefinitions).toHaveBeenCalledTimes(3);
    expect(readStoredDefinitions).toHaveBeenNthCalledWith(2, expect.objectContaining({
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 500, knownRevision: '7' },
    }));
    expect(readStoredDefinitions).toHaveBeenNthCalledWith(3, expect.objectContaining({
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 500 },
    }));
    expect(projectPrivateDefinition).toHaveBeenNthCalledWith(1, expect.objectContaining({
      eventDeclarationRelease: releaseA,
    }));
    expect(projectPrivateDefinition).toHaveBeenNthCalledWith(2, expect.objectContaining({
      eventDeclarationRelease: releaseB,
    }));
  });

  it('returns only the exact current durable webhook endpoint and private routing source for a host invocation', async () => {
    const endpointA = durableWebhookInvocationReference.endpoint.webhookEndpointId;
    const definitions = [
      durableStoredDefinition({
        index: 1,
        webhookEndpointId: endpointA,
        webhookRoutingSourceInstanceId: 'routing-source-a',
      }),
      durableStoredDefinition({
        index: 2,
        webhookEndpointId: endpointA,
        webhookRoutingSourceInstanceId: 'routing-source-b',
      }),
      durableStoredDefinition({
        index: 3,
        webhookEndpointId: 'wh_ep_AQIDBAUGBwgJCgsMDQ4PEA',
        webhookRoutingSourceInstanceId: 'routing-source-a',
      }),
    ];
    const readStoredDefinitions = vi.fn(async (request: Readonly<{
      input: AutomationEventSourcesListInputV1;
      webhookInvocationReference?: PluginWebhookInvocationReferenceV1;
    }>): Promise<AutomationEventStoredDefinitionsReadResultV1> => {
      if (request.webhookInvocationReference) {
        expect(request.webhookInvocationReference).toEqual(durableWebhookInvocationReference);
        return {
          kind: 'unchanged',
          revision: '7',
          eventDeclarationRelease,
          scope: durableEndpointScope,
        };
      }
      if (request.input.knownRevision === '7') {
        return {
          kind: 'unchanged',
          revision: '7',
          eventDeclarationRelease,
          scope: durableAllEndpointsScope,
        };
      }
      return {
        kind: 'page',
        revision: '7',
        eventDeclarationRelease,
        scope: durableAllEndpointsScope,
        definitions,
        nextCursor: null,
      };
    });
    const owner = createAutomationEventAdoptedDefinitionSetV1({
      caller,
      transport: { kind: 'durablePush' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateAccountContent: async () => true,
      readStoredDefinitions,
      projectStoredDefinition: async ({ storedDefinition: stored }) => projectDurableStoredDefinition(stored),
    });

    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '7' });
    await expect(owner.listPublicProjection({
      accountId: 'account-1',
      input: { transport: { kind: 'durablePush' }, pageSize: 500 },
      webhookInvocationReference: durableWebhookInvocationReference,
    })).resolves.toMatchObject({
      kind: 'page',
      revision: '7',
      definitions: [{ automationId: definitions[0]!.automationId }],
      nextCursor: null,
    });
    expect(readStoredDefinitions).toHaveBeenLastCalledWith(expect.objectContaining({
      caller,
      input: {
        transport: { kind: 'durablePush' },
        pageSize: 500,
        knownRevision: '7',
      },
      webhookInvocationReference: durableWebhookInvocationReference,
    }));
  });

  it('exhausts a 501-definition private scan before atomically publishing one public projection', async () => {
    const definitions = Array.from({ length: 501 }, (_, index) => storedDefinition(index + 1));
    const readStoredDefinitions = vi.fn(async ({ input }: Readonly<{
      input: AutomationEventSourcesListInputV1;
    }>): Promise<AutomationEventStoredDefinitionsReadResultV1> => {
      if (input.knownRevision === '7') return unchanged('7');
      if (input.cursor === undefined) return page('7', definitions.slice(0, 500), 'next-500');
      if (input.cursor === 'next-500') return page('7', definitions.slice(500), null);
      throw new Error(`unexpected cursor ${input.cursor}`);
    });
    const owner = createAutomationEventAdoptedDefinitionSetV1({
      caller,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateAccountContent: async () => true,
      readStoredDefinitions,
      projectStoredDefinition: async ({ storedDefinition: stored }) => projectStoredDefinition(stored),
    });

    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '7' });
    expect(readStoredDefinitions).toHaveBeenNthCalledWith(1, expect.objectContaining({
      caller,
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 500 },
    }));
    expect(readStoredDefinitions).toHaveBeenNthCalledWith(2, expect.objectContaining({
      caller,
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 500, cursor: 'next-500' },
    }));

    const publicProjection = owner.readPublicProjection();
    expect(publicProjection).toMatchObject({ kind: 'available', revision: '7' });
    if (publicProjection.kind !== 'available') return;
    expect(publicProjection.definitions).toHaveLength(501);
    const pluginCopy = publicProjection.definitions[500]!;
    pluginCopy.sourceConfig = { repositoryId: 'plugin-mutated' };
    const reReadProjection = owner.readPublicProjection();
    expect(reReadProjection).toMatchObject({ kind: 'available', revision: '7' });
    if (reReadProjection.kind !== 'available') return;
    expect(reReadProjection.definitions[500]).toMatchObject({
      automationId: definitions[500]!.automationId,
      sourceConfig: { repositoryId: 501 },
    });
  });

  it('retains the prior complete observation set until a later live source read adopts a valid replacement', async () => {
    const first = storedDefinition(1);
    const duplicate = storedDefinition(2);
    let phase: 'initial' | 'mixed' | 'verify' = 'initial';
    const readStoredDefinitions = vi.fn(async ({ input }: Readonly<{
      input: AutomationEventSourcesListInputV1;
    }>): Promise<AutomationEventStoredDefinitionsReadResultV1> => {
      if (phase === 'initial') {
        if (input.cursor === undefined) return page('7', [first], null);
        throw new Error('initial scan must have one page');
      }
      if (phase === 'mixed') {
        if (input.cursor === undefined) return page('8', [duplicate], 'cursor-2');
        if (input.cursor === 'cursor-2') return page('8', [duplicate, first], null);
        throw new Error('unexpected mixed cursor');
      }
      return page('8', [duplicate], null);
    });
    const owner = createAutomationEventAdoptedDefinitionSetV1({
      caller,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateAccountContent: async () => true,
      readStoredDefinitions,
      projectStoredDefinition: async ({ storedDefinition: stored }) => projectStoredDefinition(stored),
    });

    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '7' });
    phase = 'mixed';
    await expect(owner.refresh()).resolves.toEqual({ kind: 'discarded', reason: 'invalidPage' });
    expect(owner.readPublicProjection()).toMatchObject({
      kind: 'available',
      revision: '7',
      definitions: [{ automationId: first.automationId }],
    });

    phase = 'verify';
    await expect(owner.listPublicProjection({
      accountId: 'account-1',
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 500, knownRevision: '7' },
    })).resolves.toMatchObject({
      kind: 'page',
      revision: '8',
      definitions: [{ automationId: duplicate.automationId }],
    });
  });

  it('rejects a repeating continuation cursor rather than mistaking a missing page for a complete set', async () => {
    const first = storedDefinition(1);
    const second = storedDefinition(2);
    const readStoredDefinitions = vi.fn(async ({ input }: Readonly<{
      input: AutomationEventSourcesListInputV1;
    }>): Promise<AutomationEventStoredDefinitionsReadResultV1> => {
      if (input.cursor === undefined) return page('7', [first], 'cursor-loop');
      if (input.cursor === 'cursor-loop' && readStoredDefinitions.mock.calls.length === 2) {
        return page('7', [second], 'cursor-loop');
      }
      throw new Error('the owner requested a repeated cursor');
    });
    const owner = createAutomationEventAdoptedDefinitionSetV1({
      caller,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateAccountContent: async () => true,
      readStoredDefinitions,
      projectStoredDefinition: async ({ storedDefinition: stored }) => projectStoredDefinition(stored),
    });

    await expect(owner.refresh()).resolves.toEqual({ kind: 'discarded', reason: 'invalidPage' });
    expect(readStoredDefinitions).toHaveBeenCalledTimes(2);
    expect(owner.readPublicProjection()).toEqual({ kind: 'initializing' });
  });

  it('rejects a malformed private projection before it can become the adopted E2 authority', async () => {
    const malformed = {
      ...storedDefinition(1),
      sourceInstanceId: 'server-readable-leak',
    };
    const owner = createAutomationEventAdoptedDefinitionSetV1({
      caller,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateAccountContent: async () => true,
      readStoredDefinitions: async () => page('7', [malformed], null),
      projectStoredDefinition: async ({ storedDefinition: stored }) => projectStoredDefinition(stored),
    });

    await expect(owner.refresh()).resolves.toEqual({ kind: 'discarded', reason: 'invalidPage' });
    expect(owner.readPublicProjection()).toEqual({ kind: 'initializing' });
  });

  it('treats malformed private transport bytes as unavailable on a revision-confirming source read', async () => {
    const definition = storedDefinition(1);
    const malformedUnchanged = {
      kind: 'unchanged' as const,
      revision: '7',
      storedDefinitionEnvelope: { t: 'plain', v: { sourceInstanceId: 'forbidden' } },
    };
    const owner = createAutomationEventAdoptedDefinitionSetV1({
      caller,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateAccountContent: async () => true,
      readStoredDefinitions: async ({ input }) => input.knownRevision === '7'
        ? malformedUnchanged
        : page('7', [definition], null),
      projectStoredDefinition: async ({ storedDefinition: stored }) => projectStoredDefinition(stored),
    });

    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '7' });
    await expect(owner.listPublicProjection({
      accountId: 'account-1',
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 500, knownRevision: '7' },
    })).resolves.toEqual({ kind: 'unavailable' });
  });

  it('rejects an oversized private page before it can become an adopted snapshot', async () => {
    const oversizedPage = {
      kind: 'page' as const,
      revision: '7',
      eventDeclarationRelease,
      definitions: Array.from({ length: 501 }, (_, index) => storedDefinition(index + 1)),
      nextCursor: null,
    };
    const owner = createAutomationEventAdoptedDefinitionSetV1({
      caller,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateAccountContent: async () => true,
      readStoredDefinitions: async () => oversizedPage,
      projectStoredDefinition: async ({ storedDefinition: stored }) => projectStoredDefinition(stored),
    });

    await expect(owner.refresh()).resolves.toEqual({ kind: 'discarded', reason: 'invalidPage' });
    expect(owner.readPublicProjection()).toEqual({ kind: 'initializing' });
  });

  it('forwards cancellation into the private read and refuses to publish the aborted candidate', async () => {
    const definition = storedDefinition(1);
    const refreshAbort = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const owner = createAutomationEventAdoptedDefinitionSetV1({
      caller,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateAccountContent: async () => true,
      readStoredDefinitions: async ({ signal }) => {
        observedSignal = signal;
        refreshAbort.abort();
        return page('7', [definition], null);
      },
      projectStoredDefinition: async ({ storedDefinition: stored }) => projectStoredDefinition(stored),
    });

    await expect(owner.refresh(refreshAbort.signal)).resolves.toEqual({
      kind: 'discarded',
      reason: 'notCurrent',
    });
    expect(observedSignal?.aborted).toBe(true);
    expect(owner.readPublicProjection()).toEqual({ kind: 'initializing' });
  });

  it('cancels a sole revision-confirming checkpointed-pull source read when its caller aborts', async () => {
    const definition = storedDefinition(1);
    const operation = new AbortController();
    let markRevisionReadStarted: (() => void) | undefined;
    const revisionReadStarted = new Promise<void>((resolve) => {
      markRevisionReadStarted = resolve;
    });
    let privateReadAborted = false;
    const owner = createAutomationEventAdoptedDefinitionSetV1({
      caller,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateAccountContent: async () => true,
      readStoredDefinitions: async ({ input, signal }) => {
        if (input.knownRevision === undefined) return page('7', [definition], null);
        if (input.knownRevision !== '7') throw new Error('unexpected revision check');
        return await new Promise<AutomationEventStoredDefinitionsReadResultV1>((_resolve, reject) => {
          if (!signal) {
            reject(new Error('private source read requires an operation signal'));
            return;
          }
          markRevisionReadStarted?.();
          signal.addEventListener('abort', () => {
            privateReadAborted = true;
            reject(signal.reason);
          }, { once: true });
        });
      },
      projectStoredDefinition: async ({ storedDefinition: stored }) => projectStoredDefinition(stored),
    });

    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '7' });
    const sourceRead = owner.listPublicProjection({
      accountId: 'account-1',
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 500, knownRevision: '7' },
      signal: operation.signal,
    });
    await revisionReadStarted;
    try {
      operation.abort();
      await Promise.resolve();

      expect(privateReadAborted).toBe(true);
      await expect(sourceRead).resolves.toEqual({ kind: 'unavailable' });
    } finally {
      operation.abort();
      await sourceRead;
    }
    expect(owner.readPublicProjection()).toMatchObject({
      kind: 'available',
      revision: '7',
      definitions: [{ automationId: definition.automationId }],
    });
  });

  it('cancels an in-flight private refresh read when its generation retires', async () => {
    const definition = storedDefinition(1);
    const generation = new AbortController();
    const operation = new AbortController();
    let markReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let privateReadAborted = false;
    const owner = createAutomationEventAdoptedDefinitionSetV1({
      caller,
      transport: { kind: 'checkpointedPull' },
      generationSignal: generation.signal,
      isGenerationCurrent: () => !generation.signal.aborted,
      revalidateCallerMaterialization: async () => true,
      revalidateAccountContent: async () => true,
      readStoredDefinitions: async ({ signal }) => await new Promise<AutomationEventStoredDefinitionsReadResultV1>(
        (_resolve, reject) => {
          if (!signal) {
            reject(new Error('private refresh read requires an operation signal'));
            return;
          }
          markReadStarted?.();
          signal.addEventListener('abort', () => {
            privateReadAborted = true;
            reject(signal.reason);
          }, { once: true });
        },
      ),
      projectStoredDefinition: async ({ storedDefinition: stored }) => projectStoredDefinition(stored),
    });

    const refresh = owner.refresh(operation.signal);
    await readStarted;
    try {
      generation.abort();
      await Promise.resolve();

      expect(privateReadAborted).toBe(true);
      await expect(refresh).resolves.toEqual({ kind: 'discarded', reason: 'notCurrent' });
    } finally {
      operation.abort();
      await refresh;
    }
    expect(owner.readPublicProjection()).toEqual({ kind: 'initializing' });
  });

  it('does not let a delayed older complete refresh regress a newer adopted revision beyond Number precision', async () => {
    const olderDefinition = storedDefinition(1);
    const newerDefinition = storedDefinition(2);
    const olderRevision = '9007199254740992';
    const newerRevision = '9007199254740993';
    let releaseOlderRead: ((value: AutomationEventStoredDefinitionsReadResultV1) => void) | undefined;
    const olderRead = new Promise<AutomationEventStoredDefinitionsReadResultV1>((resolve) => {
      releaseOlderRead = resolve;
    });
    let markOlderReadStarted: (() => void) | undefined;
    const olderReadStarted = new Promise<void>((resolve) => {
      markOlderReadStarted = resolve;
    });
    let reads = 0;
    const owner = createAutomationEventAdoptedDefinitionSetV1({
      caller,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateAccountContent: async () => true,
      readStoredDefinitions: async () => {
        reads += 1;
        if (reads === 1) {
          markOlderReadStarted?.();
          return await olderRead;
        }
        if (reads === 2) return page(newerRevision, [newerDefinition], null);
        throw new Error(`unexpected read ${reads}`);
      },
      projectStoredDefinition: async ({ storedDefinition: stored }) => projectStoredDefinition(stored),
    });

    const olderRefresh = owner.refresh();
    await olderReadStarted;
    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: newerRevision });
    releaseOlderRead?.(page(olderRevision, [olderDefinition], null));

    await expect(olderRefresh).resolves.toEqual({ kind: 'discarded', reason: 'cursorStale' });
    expect(owner.readPublicProjection()).toMatchObject({
      kind: 'available',
      revision: newerRevision,
      definitions: [{ automationId: newerDefinition.automationId }],
    });
  });

  it('allows a delayed complete refresh at the already adopted revision', async () => {
    const definition = storedDefinition(1);
    let releaseFirstRead: ((value: AutomationEventStoredDefinitionsReadResultV1) => void) | undefined;
    const firstRead = new Promise<AutomationEventStoredDefinitionsReadResultV1>((resolve) => {
      releaseFirstRead = resolve;
    });
    let markFirstReadStarted: (() => void) | undefined;
    const firstReadStarted = new Promise<void>((resolve) => {
      markFirstReadStarted = resolve;
    });
    let reads = 0;
    const owner = createAutomationEventAdoptedDefinitionSetV1({
      caller,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateAccountContent: async () => true,
      readStoredDefinitions: async () => {
        reads += 1;
        if (reads === 1) {
          markFirstReadStarted?.();
          return await firstRead;
        }
        if (reads === 2) return page('8', [definition], null);
        throw new Error(`unexpected read ${reads}`);
      },
      projectStoredDefinition: async ({ storedDefinition: stored }) => projectStoredDefinition(stored),
    });

    const firstRefresh = owner.refresh();
    await firstReadStarted;
    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '8' });
    releaseFirstRead?.(page('8', [definition], null));

    await expect(firstRefresh).resolves.toEqual({ kind: 'adopted', revision: '8' });
    expect(owner.readPublicProjection()).toMatchObject({
      kind: 'available',
      revision: '8',
      definitions: [{ automationId: definition.automationId }],
    });
  });

  it('does not publish a candidate when current caller, Account content, or generation retires during the scan', async () => {
    const definition = storedDefinition(1);
    const generation = new AbortController();
    let callerCurrent = true;
    let accountCurrent = true;
    const owner = createAutomationEventAdoptedDefinitionSetV1({
      caller,
      transport: { kind: 'checkpointedPull' },
      generationSignal: generation.signal,
      isGenerationCurrent: () => !generation.signal.aborted,
      revalidateCallerMaterialization: async () => callerCurrent,
      revalidateAccountContent: async () => accountCurrent,
      readStoredDefinitions: async () => {
        callerCurrent = false;
        return page('7', [definition], null);
      },
      projectStoredDefinition: async ({ storedDefinition: stored }) => projectStoredDefinition(stored),
    });

    await expect(owner.refresh()).resolves.toEqual({ kind: 'discarded', reason: 'notCurrent' });
    expect(owner.readPublicProjection()).toEqual({ kind: 'initializing' });

    callerCurrent = true;
    accountCurrent = true;
    const accountRetiringOwner = createAutomationEventAdoptedDefinitionSetV1({
      caller,
      transport: { kind: 'checkpointedPull' },
      generationSignal: generation.signal,
      isGenerationCurrent: () => !generation.signal.aborted,
      revalidateCallerMaterialization: async () => callerCurrent,
      revalidateAccountContent: async () => accountCurrent,
      readStoredDefinitions: async () => {
        accountCurrent = false;
        return page('7', [definition], null);
      },
      projectStoredDefinition: async ({ storedDefinition: stored }) => projectStoredDefinition(stored),
    });
    await expect(accountRetiringOwner.refresh()).resolves.toEqual({ kind: 'discarded', reason: 'notCurrent' });
    generation.abort();
    await expect(accountRetiringOwner.refresh()).resolves.toEqual({ kind: 'discarded', reason: 'notCurrent' });
  });

  it('keeps adoption generation-local: a moved materialization serves only its own adopted catalog', async () => {
    const first = storedDefinition(1);
    let originalCallerCurrent = true;
    const original = createAutomationEventAdoptedDefinitionSetV1({
      caller,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => originalCallerCurrent,
      revalidateAccountContent: async () => true,
      readStoredDefinitions: async ({ input }) => input.knownRevision === '7'
        ? unchanged('7')
        : page('7', [first], null),
      projectStoredDefinition: async ({ storedDefinition: stored }) => projectStoredDefinition(stored),
    });
    await expect(original.refresh()).resolves.toEqual({ kind: 'adopted', revision: '7' });

    const movedCaller = {
      ...caller,
      machineId: 'machine-moved',
      materializationId: 'materialization-moved',
    } as const satisfies PluginMachineMaterializationRefV1;
    const replacement = createAutomationEventAdoptedDefinitionSetV1({
      caller: movedCaller,
      transport: { kind: 'checkpointedPull' },
      generationSignal: new AbortController().signal,
      isGenerationCurrent: () => true,
      revalidateCallerMaterialization: async () => true,
      revalidateAccountContent: async () => true,
      readStoredDefinitions: async () => page('9', [], null),
      projectStoredDefinition: async ({ storedDefinition: stored }) => projectStoredDefinition(stored),
    });
    expect(replacement.readPublicProjection()).toEqual({ kind: 'initializing' });

    originalCallerCurrent = false;
    await expect(original.listPublicProjection({
      accountId: 'account-1',
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 500 },
    })).resolves.toEqual({ kind: 'unavailable' });
    // The replacement is current for its own materialization, so it adopts its
    // own caller-scoped catalog on first use. What it must never do is inherit
    // the predecessor's snapshot: the revision and definitions are its own.
    await expect(replacement.listPublicProjection({
      accountId: 'account-1',
      input: { transport: { kind: 'checkpointedPull' }, pageSize: 500 },
    })).resolves.toEqual({ kind: 'page', revision: '9', definitions: [], nextCursor: null });
  });

  it('does not retain a public projection after the generation is retired for reload', async () => {
    const definition = storedDefinition(1);
    const generation = new AbortController();
    const owner = createAutomationEventAdoptedDefinitionSetV1({
      caller,
      transport: { kind: 'checkpointedPull' },
      generationSignal: generation.signal,
      isGenerationCurrent: () => !generation.signal.aborted,
      revalidateCallerMaterialization: async () => true,
      revalidateAccountContent: async () => true,
      readStoredDefinitions: async () => page('7', [definition], null),
      projectStoredDefinition: async ({ storedDefinition: stored }) => projectStoredDefinition(stored),
    });

    await expect(owner.refresh()).resolves.toEqual({ kind: 'adopted', revision: '7' });
    generation.abort();
    expect(owner.readPublicProjection()).toEqual({ kind: 'initializing' });
  });
});
