import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import type { TriageGetInputV1, TriageGetResultV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import { CORPUS_SOURCE_INSTANCES_COLLECTION_ID, CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { createTriageReobserveEntryActionHandler, reobserveTriageEntry } from './reobserveEntry.js';
import { TriageReobserveEntryInputV1Schema, TriageReobserveEntryResultV1Schema } from './reobserveEntryProtocol.js';
import { reobserveTriagePostMutationRow, type TriageExactEntryReadV1 } from '../ui/detail/postMutationReobservation.js';

const fixture = createTriageSourceV1Fixture();

describe('reobserveTriageEntry', () => {
  it('keeps the source investigation default transient through an exact read', async () => {
    const result = await reobserveTriageEntry({
      entryRef: fixture.detailInput.observation.entryRef,
      sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
    }, {
      readConfiguredInstance: async () => fixture.configuredInstance,
      readSourceSnapshot: async () => ({ contributions: [{
        contributor: { pluginId: fixture.detailInput.observation.entryRef.source.pluginId,
          contributionId: fixture.detailInput.observation.entryRef.source.localId, immutableGenerationId: 'generation-1' },
        protocol: { id: 'happier.triage/sources', version: 1 }, descriptor: fixture.descriptor,
        operations: { get: {} as never }, surfaces: {},
      }] }),
      executeGet: async () => ({ ...fixture.getResult, investigationDefaults: { permissionMode: 'default' as const } }),
      nowMs: () => 1_760_000_800_000,
    });
    expect(result).toMatchObject({ kind: 'observed', investigationDefaults: { permissionMode: 'default' } });
    if (result.kind !== 'observed') throw new Error('Expected exact observation');
    expect(result.observation).not.toHaveProperty('investigationDefaults');
    expect(result.observation).not.toHaveProperty('outcome.investigationDefaults');
  });

  it.each(['plugin_manifest_invalid', 'plugin_disabled'])(
    'retains source admission cause %s through exact-read failure', async (code) => {
      const { collections, control } = createTestkitCorpusCollections();
      const source = fixture.detailInput.observation.entryRef.source;
      control.sourceInstances.seed(toCorpusStoredValue({ instanceTag: `a${'0'.repeat(42)}`,
        sourceQualifiedId: `${source.pluginId}/${source.localId}`, lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
        configuredAtMs: 1, configured: fixture.configuredInstance,
      }));
      const context = { surface: 'cli', services: {
        storage: { account: { collection: () => collections.sourceInstances } },
        targetedContributions: { observeForSelf: () => ({
          readCurrent: async () => ({ contributions: [], unavailablePlugins: [{ pluginId: source.pluginId, code }] }),
          dispose: () => {},
        }) },
        actions: { executeAdmittedTargetedOperation: async () => { throw new Error('Unavailable source invoked'); } },
      } } as unknown as PluginInvocationContext;
      const onReadFailure = vi.fn();
      const row = await reobserveTriagePostMutationRow({
        executeAction: async (_action, input) => createTriageReobserveEntryActionHandler()(
          TriageReobserveEntryInputV1Schema.parse(input), context),
      }, { entryRef: fixture.detailInput.observation.entryRef }, [], fixture.configuredInstance.instance.sourceInstanceId,
      { onReadFailure });
      expect(row).toBeNull();
      expect(onReadFailure).toHaveBeenCalledWith(expect.objectContaining({ code, message: source.pluginId }));
      expect(onReadFailure.mock.calls[0]?.[0]).not.toHaveProperty('details.requestId');
    },
  );

  it.each([undefined, {}, { assigneeIds: [] }, {
    assigneeIds: Array.from({ length: 250 }, (_, i) => ({ id: `person-${i}`, label: `Person ${i}` })),
    labelIds: Array.from({ length: 250 }, (_, i) => ({ id: `label-${i}`, label: `Label ${i}` })),
  }])('preserves the source directory through the Action producer and opened-detail reader (case %#)', async (taskFieldChoices) => {
    const { collections, control } = createTestkitCorpusCollections();
    const source = fixture.detailInput.observation.entryRef.source;
    control.sourceInstances.seed(toCorpusStoredValue({
      instanceTag: `a${'0'.repeat(42)}`,
      sourceQualifiedId: `${source.pluginId}/${source.localId}`,
      lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
      configuredAtMs: 1,
      configured: fixture.configuredInstance,
    }));
    // Only host storage, contribution delivery and source dispatch are boundaries.
    // The real Action handler and UI protocol reader must carry the directory together.
    const executeGet = vi.fn(async (_operation: unknown, input: TriageGetInputV1) => {
      expect(input.includeTaskFieldChoices).toBe(true);
      return { ...fixture.getResult, ...(taskFieldChoices === undefined ? {} : { taskFieldChoices }) };
    });
    const context = { surface: 'cli', services: {
      storage: { account: { collection: (definition: { id: string }) => definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID
        ? collections.sourceInstances : collections.userMarks } },
      targetedContributions: { observeForSelf: () => ({
        readCurrent: async () => ({ contributions: [{
          contributor: { pluginId: source.pluginId, contributionId: source.localId },
          descriptor: fixture.descriptor, operations: { get: {} },
        }] }), dispose: () => {},
      }) },
      actions: { executeAdmittedTargetedOperation: executeGet },
    } } as unknown as PluginInvocationContext;
    const onExactRead = vi.fn<(read: TriageExactEntryReadV1) => void>();
    const row = await reobserveTriagePostMutationRow({
      executeAction: async (_action, input) => createTriageReobserveEntryActionHandler()(
        TriageReobserveEntryInputV1Schema.parse(input), context),
    }, { entryRef: fixture.detailInput.observation.entryRef }, [], fixture.configuredInstance.instance.sourceInstanceId,
    { includeTaskFieldChoices: true, onExactRead });
    expect(row).not.toBeNull();
    expect(executeGet).toHaveBeenCalledTimes(1);
    expect(onExactRead).toHaveBeenCalledTimes(1);
    const read = onExactRead.mock.calls[0]![0];
    if (taskFieldChoices === undefined) expect(read).not.toHaveProperty('taskFieldChoices');
    else expect(read.taskFieldChoices).toEqual(taskFieldChoices);
    if (taskFieldChoices?.assigneeIds?.length === 250) {
      expect(read.taskFieldChoices?.assigneeIds).toHaveLength(250);
      expect(read.taskFieldChoices?.labelIds).toHaveLength(250);
    }
    expect(row).not.toHaveProperty('taskFieldChoices');
  });

  it.each(['host', 'otherPlugin', 'exactRow', 'wrongId', 'retiredRow', 'wrongSource', 'missingRow'] as const)('publishes an authoritative source reread through the strict Action result contract for %s', async (reader) => {
    const { collections, control } = createTestkitCorpusCollections();
    const source = fixture.detailInput.observation.entryRef.source;
    const sourceInstanceRowId = `a${'0'.repeat(42)}`;
    if (reader !== 'missingRow') control.sourceInstances.seed(toCorpusStoredValue({
      instanceTag: `a${'0'.repeat(42)}`,
      sourceQualifiedId: `${source.pluginId}/${source.localId}`,
      lifecycle: reader === 'retiredRow' ? CORPUS_SOURCE_INSTANCE_LIFECYCLE.retired : CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
      configuredAtMs: 1,
      configured: { ...fixture.configuredInstance, instance: { ...fixture.configuredInstance.instance,
        ...(reader === 'wrongId' ? { sourceInstanceId: '33333333-3333-4333-8333-333333333333' } : {}),
        ...(reader === 'wrongSource' ? { source: { pluginId: 'happier.unrelated', localId: 'source' } } : {}) } },
    }));
    const configuredGets = vi.spyOn(collections.sourceInstances, 'get');
    const configuredQueries = vi.spyOn(collections.sourceInstances, 'query');
    const exact = reader !== 'host' && reader !== 'otherPlugin';
    const getHandle = {};
    const executeGet = vi.fn(async (operation: unknown, input: TriageGetInputV1) => {
      expect(operation).toBe(getHandle);
      expect(input).toEqual(fixture.getInput);
      return { ...fixture.getResult, taskFields: { title: 'Confirmed title', body: 'Exact notes' } };
    });
    // The host's Collection transport, admitted handle and external-source dispatch
    // are the boundaries; qualification and Action result production stay real.
    const context = {
      surface: 'cli',
      ...(reader === 'otherPlugin' ? { caller: { kind: 'plugin', pluginId: 'example.other-plugin' } } : {}),
      signal: new AbortController().signal,
      services: {
        storage: { account: { collection: (definition: { id: string }) => (
          definition.id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID
            ? collections.sourceInstances : collections.userMarks
        ) } },
        targetedContributions: { observeForSelf: () => ({
          readCurrent: async () => ({ contributions: [{
            contributor: { pluginId: source.pluginId, contributionId: source.localId },
            descriptor: fixture.descriptor,
            operations: { get: getHandle },
          }] }),
          dispose: () => {},
        }) },
        actions: { executeAdmittedTargetedOperation: executeGet },
      },
    } as unknown as PluginInvocationContext;
    const result = await createTriageReobserveEntryActionHandler()({
      v: 1,
      entryRef: fixture.detailInput.observation.entryRef,
      sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
      ...(exact ? { sourceInstanceRowId } : {}),
      lastKnownLocator: fixture.detailInput.observation.locator,
      includeTaskFields: true,
    }, context);

    if (exact) {
      expect(configuredGets).toHaveBeenCalledTimes(1);
      expect(configuredQueries).not.toHaveBeenCalled();
      if (reader !== 'exactRow') {
        expect(result).toEqual({ kind: 'unavailable' });
        expect(executeGet).not.toHaveBeenCalled();
        return;
      }
    }

    expect(fixture.getResult).toHaveProperty('nativeRevision');
    expect(result).toMatchObject({ kind: 'observed', observation: { outcome: { kind: 'present' } } });
    expect(result).toHaveProperty('observation.outcome.snapshot', fixture.detailInput.observation.snapshot);
    expect(result).not.toHaveProperty('observation.outcome.nativeRevision');
    expect(result).toHaveProperty('taskFields', { title: 'Confirmed title', body: 'Exact notes' });
    expect(result).not.toHaveProperty('observation.outcome.taskFields');
    expect(TriageReobserveEntryResultV1Schema.safeParse(result)).toMatchObject({ success: true });
  });

  it('asks the source for its field directory and hands it back only for the detail that requested it', async () => {
    const taskFieldChoices = { assigneeIds: [{ id: 'ada', label: 'ada' }] };
    const executeGet = vi.fn(async (_operation: unknown, _input: TriageGetInputV1) => ({ ...fixture.getResult, taskFieldChoices }));
    const read = (includeTaskFieldChoices?: true) => reobserveTriageEntry({
      entryRef: fixture.detailInput.observation.entryRef,
      sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
      ...(includeTaskFieldChoices === undefined ? {} : { includeTaskFieldChoices }),
    }, {
      readConfiguredInstance: async () => fixture.configuredInstance,
      readSourceSnapshot: async () => ({ contributions: [{
        contributor: {
          pluginId: fixture.detailInput.observation.entryRef.source.pluginId,
          contributionId: fixture.detailInput.observation.entryRef.source.localId,
          immutableGenerationId: 'generation-1',
        },
        protocol: { id: 'happier.triage/sources', version: 1 },
        descriptor: fixture.descriptor,
        operations: { get: {} as never },
        surfaces: {},
      }] }),
      executeGet,
      nowMs: () => 1_760_000_800_000,
    });
    const asked = await read(true);
    expect(executeGet.mock.calls[0]![1]).toMatchObject({ includeTaskFieldChoices: true });
    expect(asked).toMatchObject({ kind: 'observed', taskFieldChoices });
    const plain = await read();
    expect(executeGet.mock.calls[1]![1]).not.toHaveProperty('includeTaskFieldChoices');
    expect(plain).not.toHaveProperty('taskFieldChoices');
  });

  it('uses the exact configured instance and locator, then qualifies the authoritative get once', async () => {
    const executeGet = vi.fn(async (_operation: unknown, _input: TriageGetInputV1) => fixture.getResult);

    const result = await reobserveTriageEntry({
      entryRef: fixture.detailInput.observation.entryRef,
      sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
      lastKnownLocator: fixture.detailInput.observation.locator,
    }, {
      readConfiguredInstance: async () => fixture.configuredInstance,
      readSourceSnapshot: async () => ({ contributions: [{
        contributor: {
          pluginId: fixture.detailInput.observation.entryRef.source.pluginId,
          contributionId: fixture.detailInput.observation.entryRef.source.localId,
          immutableGenerationId: 'generation-1',
        },
        protocol: { id: 'happier.triage/sources', version: 1 },
        descriptor: fixture.descriptor,
        operations: { get: {} as never },
        surfaces: {},
      }] }),
      executeGet,
      nowMs: () => 1_760_000_800_000,
    });

    expect(executeGet).toHaveBeenCalledTimes(1);
    expect(executeGet.mock.calls[0]?.[1]).toEqual(fixture.getInput);
    expect(result).toMatchObject({
      kind: 'observed',
      observation: {
        entryRef: fixture.detailInput.observation.entryRef,
        sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
        observedAtMs: 1_760_000_800_000,
        outcome: { kind: 'present', nativeRevision: 'b3f1c0a9d2e4' },
      },
    });
  });

  it('rejects a source answer about a different entry instead of folding it', async () => {
    const result = await reobserveTriageEntry({
      entryRef: fixture.detailInput.observation.entryRef,
      sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
      lastKnownLocator: fixture.detailInput.observation.locator,
    }, {
      readConfiguredInstance: async () => fixture.configuredInstance,
      readSourceSnapshot: async () => ({ contributions: [{
        contributor: {
          pluginId: fixture.detailInput.observation.entryRef.source.pluginId,
          contributionId: fixture.detailInput.observation.entryRef.source.localId,
          immutableGenerationId: 'generation-1',
        },
        protocol: { id: 'happier.triage/sources', version: 1 },
        descriptor: fixture.descriptor,
        operations: { get: {} as never },
        surfaces: {},
      }] }),
      executeGet: async () => ({
        ...fixture.getResult,
        localRef: { ...fixture.getResult.localRef, entryId: '18' },
      }),
      nowMs: () => 1_760_000_800_000,
    });

    expect(result).toEqual({ kind: 'rejected', reason: 'refMismatch' });
  });

  it('cancels a held source get when its caller aborts and ignores its late answer', async () => {
    const caller = new AbortController();
    let started!: () => void;
    const sourceStarted = new Promise<void>((resolve) => { started = resolve; });
    let sourceSignal: AbortSignal | undefined;
    let resolveLate: ((result: TriageGetResultV1) => void) | undefined;

    const result = reobserveTriageEntry({
      entryRef: fixture.detailInput.observation.entryRef,
      sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
      lastKnownLocator: fixture.detailInput.observation.locator,
    }, {
      readConfiguredInstance: async () => fixture.configuredInstance,
      readSourceSnapshot: async () => ({ contributions: [{
        contributor: {
          pluginId: fixture.detailInput.observation.entryRef.source.pluginId,
          contributionId: fixture.detailInput.observation.entryRef.source.localId,
          immutableGenerationId: 'generation-1',
        },
        protocol: { id: 'happier.triage/sources', version: 1 },
        descriptor: fixture.descriptor,
        operations: { get: {} as never },
        surfaces: {},
      }] }),
      executeGet: async (_operation, _input, options) => {
        sourceSignal = options?.signal;
        return await new Promise<TriageGetResultV1>((resolve, reject) => {
          resolveLate = resolve;
          sourceSignal?.addEventListener('abort', () => reject(sourceSignal?.reason), { once: true });
          started();
        });
      },
      nowMs: () => 1_760_000_800_000,
      signal: caller.signal,
    });

    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await sourceStarted;
    caller.abort();
    await rejected;
    expect(sourceSignal?.aborted).toBe(true);

    resolveLate?.(fixture.getResult);
    await Promise.resolve();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancels held configuration discovery before dispatching a source read', async () => {
    const caller = new AbortController();
    const executeGet = vi.fn(async () => fixture.getResult);
    const result = reobserveTriageEntry({
      entryRef: fixture.detailInput.observation.entryRef,
      sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
    }, {
      readConfiguredInstance: async (_id, options) => await new Promise<null>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      }),
      readSourceSnapshot: async () => ({ contributions: [] }),
      executeGet,
      nowMs: () => 1_760_000_800_000,
      signal: caller.signal,
    });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    caller.abort();
    await rejected;
    expect(executeGet).not.toHaveBeenCalled();
  });
});
