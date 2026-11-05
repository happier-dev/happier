import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import type { TriageGetInputV1, TriageGetResultV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import { CORPUS_SOURCE_INSTANCES_COLLECTION_ID, CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { toCorpusStoredValue } from '../corpus/collections/rowCodec.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { createTriageReobserveEntryActionHandler, reobserveTriageEntry } from './reobserveEntry.js';
import { TriageReobserveEntryResultV1Schema } from './reobserveEntryProtocol.js';

const fixture = createTriageSourceV1Fixture();

describe('reobserveTriageEntry', () => {
  it.each(['host', 'otherPlugin'] as const)('publishes an authoritative source reread through the strict Action result contract for %s', async (reader) => {
    const { collections, control } = createTestkitCorpusCollections();
    const source = fixture.detailInput.observation.entryRef.source;
    control.sourceInstances.seed(toCorpusStoredValue({
      instanceTag: `a${'0'.repeat(42)}`,
      sourceQualifiedId: `${source.pluginId}/${source.localId}`,
      lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active,
      configuredAtMs: 1,
      configured: fixture.configuredInstance,
    }));
    const getHandle = {};
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
        actions: { executeAdmittedTargetedOperation: async (operation: unknown, input: TriageGetInputV1) => {
          expect(operation).toBe(getHandle);
          expect(input).toEqual(fixture.getInput);
          return fixture.getResult;
        } },
      },
    } as unknown as PluginInvocationContext;
    const result = await createTriageReobserveEntryActionHandler()({
      v: 1,
      entryRef: fixture.detailInput.observation.entryRef,
      sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
      lastKnownLocator: fixture.detailInput.observation.locator,
    }, context);

    expect(fixture.getResult).toHaveProperty('nativeRevision');
    expect(result).toMatchObject({ kind: 'observed', observation: { outcome: { kind: 'present' } } });
    expect(result).toHaveProperty('observation.outcome.snapshot', fixture.detailInput.observation.snapshot);
    expect(result).not.toHaveProperty('observation.outcome.nativeRevision');
    expect(TriageReobserveEntryResultV1Schema.safeParse(result)).toMatchObject({ success: true });
  });

  it('uses the exact configured instance and locator, then qualifies the authoritative get once', async () => {
    const executeGet = vi.fn(async (_operation: unknown, _input: TriageGetInputV1) => fixture.getResult);

    const result = await reobserveTriageEntry({
      entryRef: fixture.detailInput.observation.entryRef,
      sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
      lastKnownLocator: fixture.detailInput.observation.locator,
    }, {
      readConfiguredInstance: async () => fixture.configuredInstance,
      readAdmittedSources: async () => [{
        contributor: {
          pluginId: fixture.detailInput.observation.entryRef.source.pluginId,
          contributionId: fixture.detailInput.observation.entryRef.source.localId,
          immutableGenerationId: 'generation-1',
        },
        protocol: { id: 'happier.triage/sources', version: 1 },
        descriptor: fixture.descriptor,
        operations: { get: {} as never },
        surfaces: {},
      }],
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
      readAdmittedSources: async () => [{
        contributor: {
          pluginId: fixture.detailInput.observation.entryRef.source.pluginId,
          contributionId: fixture.detailInput.observation.entryRef.source.localId,
          immutableGenerationId: 'generation-1',
        },
        protocol: { id: 'happier.triage/sources', version: 1 },
        descriptor: fixture.descriptor,
        operations: { get: {} as never },
        surfaces: {},
      }],
      executeGet: async () => ({
        ...fixture.getResult,
        localRef: { ...fixture.getResult.localRef, entryId: '18' },
      }),
      nowMs: () => 1_760_000_800_000,
    });

    expect(result).toEqual({ kind: 'rejected', reason: 'refMismatch' });
  });

  it('settles an unanswered get at the Triage deadline and ignores its late answer', async () => {
    let sourceSignal: AbortSignal | undefined;
    let resolveLate: ((result: TriageGetResultV1) => void) | undefined;

    const result = await reobserveTriageEntry({
      entryRef: fixture.detailInput.observation.entryRef,
      sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
      lastKnownLocator: fixture.detailInput.observation.locator,
    }, {
      readConfiguredInstance: async () => fixture.configuredInstance,
      readAdmittedSources: async () => [{
        contributor: {
          pluginId: fixture.detailInput.observation.entryRef.source.pluginId,
          contributionId: fixture.detailInput.observation.entryRef.source.localId,
          immutableGenerationId: 'generation-1',
        },
        protocol: { id: 'happier.triage/sources', version: 1 },
        descriptor: fixture.descriptor,
        operations: { get: {} as never },
        surfaces: {},
      }],
      executeGet: async (_operation, _input, options) => {
        sourceSignal = options?.signal;
        return await new Promise<TriageGetResultV1>((resolve) => {
          resolveLate = resolve;
        });
      },
      nowMs: () => 1_760_000_800_000,
      getDeadlineMs: 5,
    });

    expect(result).toEqual({ kind: 'unavailable' });
    expect(sourceSignal?.aborted).toBe(true);

    resolveLate?.(fixture.getResult);
    await Promise.resolve();
    expect(result).toEqual({ kind: 'unavailable' });
  });

  it('includes configured-instance and contribution discovery in the one invocation deadline', async () => {
    const result = await Promise.race([
      reobserveTriageEntry({
        entryRef: fixture.detailInput.observation.entryRef,
        sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
      }, {
        readConfiguredInstance: async () => await new Promise<null>(() => {}),
        readAdmittedSources: async () => [],
        executeGet: async () => fixture.getResult,
        nowMs: () => 1_760_000_800_000,
        getDeadlineMs: 5,
      }),
      new Promise<'test-timeout'>((resolve) => setTimeout(() => resolve('test-timeout'), 50)),
    ]);

    expect(result).toEqual({ kind: 'unavailable' });
  }, 1_000);
});
