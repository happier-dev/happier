import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import type { TriageGetInputV1, TriageGetResultV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import { reobserveTriageEntry } from './reobserveEntry.js';

const fixture = createTriageSourceV1Fixture();

describe('reobserveTriageEntry', () => {
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
        outcome: { kind: 'present' },
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
